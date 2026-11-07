import {
  allProducts, allSessions, closeSession, countsForSession, createSession, getActiveSession, reopenSession,
} from '../db/db';
import { pendingCount } from '../lookup/pendingQueue';
import { loadSettings, saveSettings } from '../settings';
import { clear, confirmDialog, fmtDateTime, h, icon, promptDialog, toast } from './dom';
import { installState, promptInstall } from './install';
import type { View } from './router';
import { navigate } from './router';

export async function askCounterName(force = false): Promise<string | null> {
  const s = await loadSettings();
  if (s.counterName && !force) return s.counterName;
  const name = await promptDialog('¿Quién está contando?', 'Tu nombre', s.counterName, {
    autocomplete: 'name', maxlength: 40, placeholder: 'Ej. Juan Pérez',
  });
  if (name && name.trim()) {
    await saveSettings({ counterName: name.trim() });
    return name.trim();
  }
  return s.counterName || null;
}

export async function newSessionFlow(): Promise<boolean> {
  const counter = await askCounterName();
  if (!counter) {
    toast('Captura tu nombre para iniciar', 'warn');
    return false;
  }
  const d = new Date();
  const def = `Inventario ${d.toLocaleDateString('es-MX')} ${counter.split(' ')[0]}`;
  const name = await promptDialog('Nueva sesión de conteo', 'Nombre de la sesión', def, { maxlength: 60 });
  if (!name) return false;
  await createSession(name.trim() || def, counter);
  toast('Sesión creada', 'ok');
  return true;
}

export const homeView: View = {
  title: 'Inicio',
  async render(root) {
    const [s, session, products, pending, sessions] = await Promise.all([
      loadSettings(), getActiveSession(), allProducts(), pendingCount(), allSessions(),
    ]);
    const counts = session ? await countsForSession(session.id) : [];
    const catalogCount = products.filter((p) => !p.uncataloged).length;
    const withExpected = products.filter((p) => p.expectedQty !== undefined).length;
    const distinct = new Set(counts.map((c) => c.barcode)).size;
    const units = counts.reduce((a, c) => a + c.qty, 0);
    const pastSessions = sessions.slice(0, 3);

    const install = installState();

    clear(root,
      h('section', { class: 'card hello' },
        h('div', null,
          h('div', { class: 'muted small' }, 'Contador'),
          h('div', { class: 'big' }, s.counterName || 'Sin nombre'),
        ),
        h('button', { class: 'btn ghost sm', onclick: async () => { await askCounterName(true); navigate('/'); } }, 'Cambiar'),
      ),

      session
        ? h('section', { class: 'card' },
          h('div', { class: 'muted small' }, 'Sesión activa'),
          h('h2', null, session.name),
          h('div', { class: 'muted small' }, `Iniciada ${fmtDateTime(session.createdAt)} · ${session.counter}`),
          h('div', { class: 'stats' },
            stat(distinct, 'productos'),
            stat(Math.round(units * 100) / 100, 'unidades'),
            stat(counts.length, 'escaneos'),
          ),
          h('button', { class: 'btn primary xl', onclick: () => navigate('/contar') }, icon('scan'), 'Continuar conteo'),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn', onclick: () => navigate('/reporte') }, icon('chart'), 'Ver reporte'),
            h('button', { class: 'btn', onclick: async () => { if (await newSessionFlow()) navigate('/contar'); } }, 'Nueva sesión'),
            h('button', {
              class: 'btn danger ghost',
              onclick: async () => {
                const ok = await confirmDialog(
                  'Finalizar sesión de conteo',
                  `¿Deseas finalizar la sesión "${session.name}"? Los datos quedarán guardados y listos para consulta o reporte.`,
                  'Finalizar sesión',
                  true,
                );
                if (ok) {
                  await closeSession(session.id);
                  toast('Sesión finalizada con éxito', 'ok');
                  navigate('/');
                }
              },
            }, 'Finalizar sesión'),
          ),
        )
        : h('section', { class: 'card' },
          h('div', { class: 'badge warn', style: 'margin-bottom: 8px; display: inline-block;' }, 'Sin sesión activa'),
          h('h2', null, 'Sin sesión activa'),
          h('p', { class: 'muted' }, 'No hay ninguna sesión de conteo en curso. Puedes iniciar una nueva sesión para escanear consumibles o revisar las sesiones anteriores.'),
          h('button', { class: 'btn primary xl', onclick: async () => { if (await newSessionFlow()) navigate('/contar'); } },
            icon('scan'), 'Iniciar nueva sesión'),
          h('div', { class: 'row wrap', style: 'margin-top: 10px;' },
            h('button', { class: 'btn', onclick: () => navigate('/catalogo') }, icon('list'), 'Ver catálogo de productos'),
            h('button', { class: 'btn ghost', onclick: () => navigate('/equipo') }, icon('users'), 'Ver todas las sesiones'),
          ),
          pastSessions.length > 0
            ? [
              h('h3', { class: 'section-title', style: 'margin-top: 20px;' }, 'Sesiones recientes'),
              h('ul', { class: 'session-list' },
                pastSessions.map((ps) =>
                  h('li', { class: 's-item', style: 'cursor: default;' },
                    h('div', { class: 'grow' },
                      h('div', { class: 's-name' },
                        ps.name,
                        ' ',
                        ps.closed
                          ? h('span', { class: 'badge info' }, 'Cerrada')
                          : h('span', { class: 'badge warn' }, 'Abierta'),
                      ),
                      h('div', { class: 'muted small' },
                        `${ps.counter} · ${fmtDateTime(ps.createdAt)}`,
                        ps.closed && ps.closedAt ? ` · Cerrada ${fmtDateTime(ps.closedAt)}` : '',
                      ),
                    ),
                    h('div', { class: 'row', style: 'gap: 6px;' },
                      h('button', {
                        class: 'btn sm',
                        onclick: () => navigate(`/reporte?session=${ps.id}`),
                      }, icon('chart'), 'Ver reporte'),
                      ps.closed
                        ? h('button', {
                          class: 'btn sm ghost',
                          onclick: async () => {
                            await reopenSession(ps.id);
                            toast('Sesión reabierta y activada', 'ok');
                            navigate('/contar');
                          },
                        }, 'Reabrir')
                        : h('button', {
                          class: 'btn sm primary',
                          onclick: async () => {
                            await reopenSession(ps.id);
                            toast(`Sesión activa: ${ps.name}`, 'ok');
                            navigate('/contar');
                          },
                        }, 'Continuar'),
                    ),
                  ),
                ),
              ),
            ]
            : null,
        ),

      h('section', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h3', null, 'Catálogo'),
          h('button', { class: 'btn ghost sm', onclick: () => navigate('/catalogo') }, 'Abrir'),
        ),
        catalogCount
          ? h('p', null, `${catalogCount} productos`, withExpected ? ` · ${withExpected} con existencia teórica` : '')
          : h('p', { class: 'warn-text' }, 'No hay catálogo cargado. Puedes contar igual: la descripción se buscará en internet o se capturará a mano. Para comparar contra existencias, importa tu Excel.'),
        pending ? h('p', { class: 'muted small' }, `${pending} código(s) pendiente(s) de descripción`) : null,
      ),

      install.canPrompt
        ? h('section', { class: 'card accent' },
          h('h3', null, 'Instalar en el teléfono'),
          h('p', { class: 'small' }, 'Agrega la app a tu pantalla de inicio para usarla sin internet.'),
          h('button', { class: 'btn primary', onclick: promptInstall }, 'Instalar app'))
        : install.iosHint
          ? h('section', { class: 'card accent' },
            h('h3', null, 'Instalar en iPhone'),
            h('p', { class: 'small' }, 'En Safari toca ', h('b', null, 'Compartir'), ' y luego ', h('b', null, '“Agregar a pantalla de inicio”'), '.'))
          : null,

      h('p', { class: 'center muted small' }, navigator.onLine ? 'En línea' : 'Sin conexión – los datos se guardan en el teléfono'),
    );
  },
};

function stat(value: number, label: string) {
  return h('div', { class: 'stat' }, h('b', null, String(value)), h('span', null, label));
}
