import {
  allProducts, allSessions, countsForSession, deleteSession, getActiveSession, getDeviceId,
  setActiveSession, type Session,
} from '../db/db';
import { buildCountFile, safeFileName, type CountFile } from '../io/exportResults';
import { mergeCountFiles, parseAppFile } from '../io/mergeCounts';
import {
  clear, confirmDialog, fmtDateTime, fmtNum, h, icon, MIME, openDialog, pickFiles, shareOrDownload, toast,
} from './dom';
import { askCounterName, newSessionFlow } from './home';
import { navigate, type View } from './router';

export const teamView: View = {
  title: 'Equipo',
  async render(root) {
    const [sessions, current, deviceId] = await Promise.all([
      allSessions(), getActiveSession(), getDeviceId(),
    ]);

    const curCounts = current ? await countsForSession(current.id) : [];
    const products = await allProducts();

    // Contadores que participaron en la sesión activa
    const contributors = new Map<string, { qty: number; scans: number }>();
    for (const c of curCounts) {
      const name = c.counter || 'Sin nombre';
      const a = contributors.get(name) ?? { qty: 0, scans: 0 };
      a.qty += c.qty;
      a.scans++;
      contributors.set(name, a);
    }

    // Compartir mi conteo
    const shareMyCount = async () => {
      if (!current) return;
      const file = buildCountFile(current, curCounts, products, deviceId);
      const name = `conteo_${safeFileName(current.name)}_${safeFileName(current.counter)}.json`;
      await shareOrDownload(JSON.stringify(file, null, 2), name, MIME.json, `Conteo de ${current.counter}`);
    };

    // Importar conteos de otros
    const importOthers = async () => {
      if (!current) {
        toast('Selecciona una sesión activa primero', 'warn');
        return;
      }
      const picked = await pickFiles('.json,application/json', true);
      if (!picked.length) return;
      const countFiles: CountFile[] = [];
      const errors: string[] = [];
      for (const f of picked) {
        try {
          const text = await f.text();
          const parsed = parseAppFile(text);
          if (parsed.kind !== 'conteo') {
            errors.push(`${f.name}: no es un archivo de conteo`);
            continue;
          }
          countFiles.push(parsed);
        } catch (e) {
          errors.push(`${f.name}: ${(e as Error).message}`);
        }
      }
      if (errors.length) toast(errors.join('\n'), 'warn', 5000);
      if (!countFiles.length) return;

      const totalScans = countFiles.reduce((a, f) => a + f.counts.length, 0);
      const who = [...new Set(countFiles.map((f) => f.session.counter))].join(', ');
      const ok = await confirmDialog('Consolidar conteos',
        `Se importarán ${totalScans} registros de ${countFiles.length} archivo(s) (${who}) en la sesión "${current.name}". Los registros ya existentes no se duplicarán.`,
        'Consolidar');
      if (!ok) return;

      const res = await mergeCountFiles(current.id, countFiles);
      toast(`Listo: ${res.added} registros agregados (${res.duplicates} duplicados ignorados, ${res.productsAdded} productos nuevos)`, 'ok', 5000);
      navigate('/equipo');
    };

    clear(root,
      // Panel sesión actual y multiusuario
      current
        ? h('section', { class: 'card' },
          h('div', { class: 'muted small' }, 'Sesión activa para consolidar'),
          h('h2', null, current.name),
          h('p', { class: 'muted small' }, `Responsable: ${current.counter} · Iniciada ${fmtDateTime(current.createdAt)}`),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn primary', onclick: importOthers }, icon('upload'), 'Importar archivos de otros'),
            h('button', { class: 'btn', onclick: shareMyCount, disabled: !curCounts.length }, icon('share'), 'Compartir mi conteo'),
          ),
          h('details', { class: 'help-box' },
            h('summary', null, '¿Cómo contar en equipo sin servidor?'),
            h('ol', { class: 'small' },
              h('li', null, 'Cada contador abre la app en su teléfono y pone su nombre.'),
              h('li', null, 'Todos importan el mismo Excel de catálogo (o el supervisor se los comparte en JSON desde Catálogo → Compartir).'),
              h('li', null, 'Cada quien cuenta en su zona. No se requiere internet.'),
              h('li', null, 'Al terminar, cada uno entra aquí y toca ', h('b', null, 'Compartir mi conteo'), ' (por WhatsApp, correo, etc.).'),
              h('li', null, 'El supervisor recibe los archivos en su teléfono o PC, entra aquí y toca ', h('b', null, 'Importar archivos de otros'), '. Todos los conteos se suman automáticamente.'),
            ),
          ),
          contributors.size > 0
            ? [
              h('h3', { class: 'section-title' }, 'Participantes en esta sesión'),
              h('ul', { class: 'contributor-list' },
                [...contributors.entries()].map(([name, data]) => h('li', null,
                  h('span', null, h('b', null, name)),
                  h('span', { class: 'muted small' }, `${fmtNum(data.qty)} u. en ${data.scans} escaneo(s)`),
                )),
              ),
            ]
            : null,
        )
        : null,

      // Lista de sesiones
      h('section', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h3', null, 'Sesiones guardadas'),
          h('button', { class: 'btn primary sm', onclick: async () => { if (await newSessionFlow()) navigate('/contar'); } }, 'Nueva sesión'),
        ),
        h('ul', { class: 'session-list' },
          sessions.length === 0 ? h('li', { class: 'empty' }, 'No hay sesiones registradas.') : null,
          sessions.map((s) => {
            const isCur = current?.id === s.id;
            return h('li', { class: `s-item ${isCur ? 'active' : ''}` },
              h('div', { class: 'grow', onclick: async () => { await setActiveSession(s.id); navigate('/equipo'); } },
                h('div', { class: 's-name' }, s.name, isCur ? h('span', { class: 'badge ok' }, 'Activa') : null),
                h('div', { class: 'muted small' }, `${s.counter} · ${fmtDateTime(s.createdAt)}`),
              ),
              h('button', {
                class: 'btn ghost sm danger',
                'aria-label': 'Eliminar sesión',
                onclick: async () => {
                  if (await confirmDialog('Eliminar sesión', `¿Eliminar "${s.name}" y todos sus conteos?`, 'Eliminar', true)) {
                    await deleteSession(s.id);
                    if (isCur) await setActiveSession(null);
                    toast('Sesión eliminada');
                    navigate('/equipo');
                  }
                },
              }, icon('trash')),
            );
          }),
        ),
      ),
    );
  },
};
