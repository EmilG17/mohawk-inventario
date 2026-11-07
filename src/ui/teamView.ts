import {
  allProducts, allSessions, closeSession, countsForSession, deleteSession, getActiveSession, getDeviceId,
  reopenSession, setActiveSession, type Session,
} from '../db/db';
import { buildCountFile, safeFileName, type CountFile } from '../io/exportResults';
import { mergeCountFiles, parseTechnicianReportFile } from '../io/mergeCounts';
import {
  clear, confirmDialog, fmtDateTime, fmtNum, h, icon, MIME, openDialog, pickFiles, shareOrDownload, toast,
} from './dom';
import { askCounterName, newSessionFlow } from './home';
import { navigate, type View } from './router';
import { openUnifyReportsDialog } from './unifyReportsDialog';

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

    // Importar conteos o reportes de otros (.xlsx, .csv, .json)
    const importOthers = async () => {
      if (!current) {
        toast('Selecciona una sesión activa primero', 'warn');
        return;
      }
      const picked = await pickFiles(
        '.json,.xlsx,.xls,.csv,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        true,
      );
      if (!picked.length) return;
      const countFiles: CountFile[] = [];
      const errors: string[] = [];
      for (const f of picked) {
        try {
          const parsed = await parseTechnicianReportFile(f);
          countFiles.push(parsed);
        } catch (e) {
          errors.push((e as Error).message);
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
            h('button', {
              class: 'btn primary',
              onclick: () => void openUnifyReportsDialog((sid) => navigate(`/reporte?session=${sid}`)),
            }, icon('users'), 'Unificar reportes de técnicos'),
            h('button', { class: 'btn', onclick: importOthers }, icon('upload'), 'Importar archivos de otros'),
            h('button', { class: 'btn', onclick: shareMyCount, disabled: !curCounts.length }, icon('share'), 'Compartir mi conteo'),
            h('button', {
              class: 'btn danger ghost',
              onclick: async () => {
                const ok = await confirmDialog('Finalizar sesión', `¿Deseas finalizar la sesión activa "${current.name}"?`, 'Finalizar sesión', true);
                if (ok) {
                  await closeSession(current.id);
                  toast('Sesión finalizada con éxito', 'ok');
                  navigate('/equipo');
                }
              },
            }, 'Finalizar sesión'),
          ),
          h('details', { class: 'help-box' },
            h('summary', null, '¿Cómo contar en equipo y unificar reportes de técnicos?'),
            h('ol', { class: 'small' },
              h('li', null, 'Cada técnico abre la app en su teléfono y pone su nombre.'),
              h('li', null, 'Todos importan el mismo Excel de catálogo (o el supervisor se los comparte en JSON desde Catálogo → Compartir).'),
              h('li', null, 'Cada quien cuenta en su zona sin necesidad de internet.'),
              h('li', null, 'Al terminar, cada técnico envía su reporte (puede ser el archivo ', h('b', null, 'Excel (.xlsx)'), ', ', h('b', null, 'CSV (.csv)'), ' o ', h('b', null, 'Compartir mi conteo (.json)'), ').'),
              h('li', null, 'El supervisor toca ', h('b', null, 'Unificar reportes de técnicos'), ', selecciona todos los archivos recibidos y genera al instante el ', h('b', null, 'Reporte Maestro Unificado'), ' con desglose por técnico.'),
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
        : h('section', { class: 'card' },
          h('div', { class: 'badge warn', style: 'margin-bottom: 8px; display: inline-block;' }, 'Sin sesión activa'),
          h('h2', null, 'Sin sesión activa'),
          h('p', { class: 'muted' }, 'No hay ninguna sesión activa seleccionada. Puedes unificar los reportes enviados por los técnicos, seleccionar una sesión guardada abajo o iniciar una nueva.'),
          h('div', { class: 'row wrap' },
            h('button', {
              class: 'btn primary',
              onclick: () => void openUnifyReportsDialog((sid) => navigate(`/reporte?session=${sid}`)),
            }, icon('users'), 'Unificar reportes de técnicos'),
            h('button', { class: 'btn', onclick: async () => { if (await newSessionFlow()) navigate('/contar'); } }, icon('scan'), 'Iniciar nueva sesión'),
          ),
        ),

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
            const statusBadge = isCur
              ? h('span', { class: 'badge ok' }, 'Activa')
              : s.closed
                ? h('span', { class: 'badge info' }, 'Cerrada')
                : h('span', { class: 'badge warn' }, 'Abierta');

            return h('li', { class: `s-item ${isCur ? 'active' : ''}` },
              h('div', {
                class: 'grow',
                onclick: async () => {
                  if (s.closed) {
                    await reopenSession(s.id);
                    toast(`Sesión reabierta y activada: ${s.name}`, 'ok');
                  } else {
                    await setActiveSession(s.id);
                    toast(`Sesión activa: ${s.name}`, 'ok');
                  }
                  navigate('/equipo');
                },
              },
                h('div', { class: 's-name' }, s.name, ' ', statusBadge),
                h('div', { class: 'muted small' },
                  `${s.counter} · ${fmtDateTime(s.createdAt)}`,
                  s.closed && s.closedAt ? ` · Cerrada ${fmtDateTime(s.closedAt)}` : '',
                ),
              ),
              h('div', { class: 'row', style: 'gap: 6px; flex-shrink: 0;' },
                h('button', {
                  class: 'btn sm ghost',
                  title: 'Ver reporte',
                  onclick: (e: Event) => {
                    e.stopPropagation();
                    navigate(`/reporte?session=${s.id}`);
                  },
                }, icon('chart')),
                isCur
                  ? h('button', {
                    class: 'btn sm danger ghost',
                    onclick: async (e: Event) => {
                      e.stopPropagation();
                      if (await confirmDialog('Finalizar sesión', `¿Deseas finalizar la sesión "${s.name}"?`, 'Finalizar sesión', true)) {
                        await closeSession(s.id);
                        toast('Sesión finalizada con éxito', 'ok');
                        navigate('/equipo');
                      }
                    },
                  }, 'Finalizar')
                  : s.closed
                    ? h('button', {
                      class: 'btn sm',
                      onclick: async (e: Event) => {
                        e.stopPropagation();
                        await reopenSession(s.id);
                        toast(`Sesión reabierta y activada: ${s.name}`, 'ok');
                        navigate('/equipo');
                      },
                    }, 'Reabrir')
                    : h('button', {
                      class: 'btn sm',
                      onclick: async (e: Event) => {
                        e.stopPropagation();
                        await setActiveSession(s.id);
                        toast(`Sesión activa: ${s.name}`, 'ok');
                        navigate('/equipo');
                      },
                    }, 'Activar'),
                h('button', {
                  class: 'btn ghost sm danger',
                  'aria-label': 'Eliminar sesión',
                  onclick: async (e: Event) => {
                    e.stopPropagation();
                    if (await confirmDialog('Eliminar sesión', `¿Eliminar "${s.name}" y todos sus conteos?`, 'Eliminar', true)) {
                      await deleteSession(s.id);
                      if (isCur) await setActiveSession(null);
                      toast('Sesión eliminada');
                      navigate('/equipo');
                    }
                  },
                }, icon('trash')),
              ),
            );
          }),
        ),
      ),
    );
  },
};
