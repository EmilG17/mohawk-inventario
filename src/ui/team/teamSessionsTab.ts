import {
  closeSession,
  deleteSession,
  reopenSession,
  setActiveSession,
  type CountEntry,
  type Product,
  type Session,
} from '../../db/db';
import { L } from '../../i18n/i18n';
import { buildCountFile, safeFileName, type CountFile } from '../../io/exportResults';
import { mergeCountFiles, parseTechnicianReportFile } from '../../io/mergeCounts';
import {
  archiveSessionToCloud,
  fetchCloudArchivedSession,
  listCloudArchivedSessions,
  type CloudArchivedSessionSummary,
} from '../../sync/cloudSync';
import { isSupervisorModeEnabled } from '../catalogMode';
import {
  clear,
  confirmDialog,
  fmtDateTime,
  fmtNum,
  h,
  icon,
  MIME,
  pickFiles,
  shareOrDownload,
  toast,
} from '../dom';
import { newSessionFlow } from '../home';
import { navigate } from '../router';
import { openUnifyReportsDialog } from '../unifyReportsDialog';
import { openReceiveQrDialog, openShowMyQrDialog } from './teamQrDialogs';

let cachedArchiveList: CloudArchivedSessionSummary[] | null = null;
let cachedArchiveRoom = '';

export function renderSessionsTab(opts: {
  container: HTMLElement;
  sessions: Session[];
  current: Session | undefined;
  curCounts: CountEntry[];
  products: Product[];
  deviceId: string;
  syncRoomCode: string;
  syncEndpointUrl: string;
  onRefresh: () => void;
}): void {
  const {
    container,
    sessions,
    current,
    curCounts,
    products,
    deviceId,
    syncRoomCode,
    syncEndpointUrl,
    onRefresh,
  } = opts;

  const confirmAndReopen = async (sess: Session) => {
    const ok = await confirmDialog(
      L('Reabrir sesión cerrada', 'Reopen closed session'),
      L(
        `La sesión "${sess.name}" ya está cerrada. ¿Deseas reabrirla y activarla para seguir agregando conteos?`,
        `Session "${sess.name}" is currently closed. Do you want to reopen and activate it to keep adding counts?`,
      ),
      L('Reabrir sesión', 'Reopen session'),
    );
    if (!ok) return;
    await reopenSession(sess.id);
    toast(`${L('Sesión reabierta', 'Session reopened')}: ${sess.name}`, 'ok');
    onRefresh();
  };

  const shareMyCount = async () => {
    if (!current) return;
    const file = buildCountFile(current, curCounts, products, deviceId);
    const name = `conteo_${safeFileName(current.name)}_${safeFileName(current.counter)}.json`;
    await shareOrDownload(JSON.stringify(file, null, 2), name, MIME.json, `${L('Conteo de', 'Count by')} ${current.counter}`);
  };

  const importOthers = async () => {
    if (!current) {
      toast(L('Selecciona una sesión activa primero', 'Select an active session first'), 'warn');
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
    const ok = await confirmDialog(
      L('Consolidar conteos', 'Merge counts'),
      L(
        `Se importarán ${totalScans} registros de ${countFiles.length} archivo(s) (${who}) en la sesión "${current.name}". Los registros ya existentes no se duplicarán.`,
        `${totalScans} record(s) from ${countFiles.length} file(s) (${who}) will be imported into "${current.name}". Existing records won't be duplicated.`,
      ),
      L('Consolidar', 'Merge'),
    );
    if (!ok) return;

    const res = await mergeCountFiles(current.id, countFiles);
    toast(
      L(
        `Listo: ${res.added} registros agregados (${res.duplicates} duplicados ignorados, ${res.productsAdded} productos nuevos)`,
        `Done: ${res.added} added (${res.duplicates} duplicates skipped, ${res.productsAdded} new products)`,
      ),
      'ok',
      5000,
    );
    onRefresh();
  };

  if (cachedArchiveRoom !== syncRoomCode) {
    cachedArchiveRoom = syncRoomCode;
    cachedArchiveList = null;
  }

  const archiveListBox = h('div', { style: 'margin-top: 8px;' });
  const renderArchiveItems = (items: CloudArchivedSessionSummary[]) => {
    if (items.length === 0) {
      clear(
        archiveListBox,
        h('div', { class: 'muted small' }, L('No hay sesiones archivadas en esta sala todavía.', 'No archived sessions in this room yet.')),
      );
      return;
    }
    clear(
      archiveListBox,
      h(
        'ul',
        { class: 'session-list' },
        items.map((item) =>
          h(
            'li',
            { class: 's-item' },
            h(
              'div',
              { class: 'grow' },
              h('div', { class: 's-name' }, item.name),
              h(
                'div',
                { class: 'muted small' },
                `${item.counter} · ${fmtNum(item.totalCounts)} ${L('lecturas', 'scans')} (${fmtNum(item.totalUnits)} ${L('u.', 'pcs')}) · ${fmtDateTime(item.closedAt)}`,
              ),
            ),
            h(
              'button',
              {
                class: 'btn sm ghost',
                type: 'button',
                onclick: async () => {
                  const detail = await fetchCloudArchivedSession(item.id, {
                    roomCode: syncRoomCode,
                    endpointUrl: syncEndpointUrl,
                  });
                  if (!detail) {
                    toast(L('No se pudo descargar el detalle de la sesión archivada.', 'Could not download archived session detail.'), 'error');
                    return;
                  }
                  const exportObj: CountFile = buildCountFile(
                    {
                      id: detail.id,
                      name: detail.name,
                      counter: detail.counter,
                      createdAt: detail.createdAt,
                      closed: true,
                      closedAt: detail.closedAt,
                    },
                    detail.counts,
                    products,
                    deviceId,
                  );
                  await shareOrDownload(
                    JSON.stringify(exportObj, null, 2),
                    `archivo_${safeFileName(detail.name)}.json`,
                    MIME.json,
                    detail.name,
                  );
                },
              },
              icon('download'),
              L('Descargar', 'Download'),
            ),
          ),
        ),
      ),
    );
  };

  if (cachedArchiveList) {
    renderArchiveItems(cachedArchiveList);
  }

  const canQueryArchives = Boolean(syncRoomCode && syncEndpointUrl && isSupervisorModeEnabled());

  clear(
    container,
    current
      ? h(
          'section',
          { class: 'card' },
          h(
            'div',
            { class: 'toolbar-compact-row' },
            h('h3', { style: 'margin: 0;' }, `${L('Sesión Activa:', 'Active Session:')} ${current.name}`),
            h(
              'button',
              {
                class: 'btn primary sm',
                onclick: () => void openUnifyReportsDialog((sid) => navigate(`/reporte?session=${sid}`)),
              },
              icon('users'),
              L('Unificar reportes de técnicos (Excel / CSV / JSON)', 'Merge technician reports (Excel / CSV / JSON)'),
            ),
          ),
          h(
            'details',
            { class: 'ui-disclosure' },
            h('summary', { class: 'ui-disclosure-summary' }, L('Herramientas de archivo y transferencia QR', 'File tools & QR transfer')),
            h(
              'div',
              { class: 'ui-disclosure-body' },
              h(
                'div',
                { class: 'row wrap', style: 'gap: 8px;' },
                h('button', { class: 'btn sm', onclick: importOthers }, icon('upload'), L('Importar archivos a esta sesión', 'Import files into this session')),
                h('button', { class: 'btn sm', onclick: shareMyCount, disabled: !curCounts.length }, icon('share'), L('Compartir mi conteo', 'Share my count')),
                h(
                  'button',
                  {
                    class: 'btn sm',
                    disabled: !curCounts.length,
                    onclick: () => openShowMyQrDialog(current, curCounts),
                  },
                  icon('scan'),
                  L('Mostrar QR de mi conteo', 'Show my count QR'),
                ),
                h(
                  'button',
                  {
                    class: 'btn sm',
                    onclick: () => openReceiveQrDialog(current, onRefresh),
                  },
                  icon('scan'),
                  L('Recibir por QR', 'Receive via QR'),
                ),
              ),
            ),
          ),
        )
      : null,
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h3', null, L('Sesiones de inventario guardadas', 'Saved Inventory Sessions')),
        h(
          'button',
          {
            class: 'btn primary sm',
            onclick: async () => {
              if (await newSessionFlow()) navigate('/contar');
            },
          },
          L('Nueva sesión', 'New session'),
        ),
      ),
      h(
        'ul',
        { class: 'session-list' },
        sessions.length === 0 ? h('li', { class: 'empty' }, L('No hay sesiones registradas.', 'No sessions recorded.')) : null,
        sessions.map((sess) => {
          const isCur = current?.id === sess.id;
          const statusBadge = isCur
            ? h('span', { class: 'badge ok' }, L('Activa', 'Active'))
            : sess.closed
              ? h('span', { class: 'badge info' }, L('Cerrada', 'Closed'))
              : h('span', { class: 'badge warn' }, L('Abierta', 'Open'));

          return h(
            'li',
            { class: `s-item ${isCur ? 'active' : ''}` },
            h(
              'div',
              {
                class: 'grow',
                onclick: async () => {
                  if (sess.closed) {
                    await confirmAndReopen(sess);
                    return;
                  }
                  await setActiveSession(sess.id);
                  toast(`${L('Sesión activa:', 'Active session:')} ${sess.name}`, 'ok');
                  onRefresh();
                },
              },
              h('div', { class: 's-name' }, sess.name, ' ', statusBadge),
              h(
                'div',
                { class: 'muted small' },
                `${sess.counter} · ${fmtDateTime(sess.createdAt)}`,
                sess.closed && sess.closedAt ? ` · ${L('Cerrada', 'Closed')} ${fmtDateTime(sess.closedAt)}` : '',
              ),
            ),
            h(
              'div',
              { class: 'row', style: 'gap: 6px; flex-shrink: 0;' },
              h(
                'button',
                {
                  class: 'btn sm ghost',
                  title: L('Ver reporte', 'View report'),
                  onclick: (e: Event) => {
                    e.stopPropagation();
                    navigate(`/reporte?session=${sess.id}`);
                  },
                },
                icon('chart'),
              ),
              isCur
                ? h(
                    'button',
                    {
                      class: 'btn sm danger ghost',
                      onclick: async (e: Event) => {
                        e.stopPropagation();
                        if (
                          await confirmDialog(
                            L('Finalizar sesión', 'Close session'),
                            L(`¿Deseas finalizar la sesión "${sess.name}"?`, `Finish session "${sess.name}"?`),
                            L('Finalizar sesión', 'Close session'),
                            true,
                          )
                        ) {
                          await closeSession(sess.id);
                          void archiveSessionToCloud(sess.id).catch(() => {});
                          toast(L('Sesión finalizada con éxito', 'Session closed'), 'ok');
                          onRefresh();
                        }
                      },
                    },
                    L('Finalizar', 'Close'),
                  )
                : sess.closed
                  ? h(
                      'button',
                      {
                        class: 'btn sm',
                        onclick: async (e: Event) => {
                          e.stopPropagation();
                          await reopenSession(sess.id);
                          toast(`${L('Sesión reabierta', 'Session reopened')}: ${sess.name}`, 'ok');
                          onRefresh();
                        },
                      },
                      L('Reabrir', 'Reopen'),
                    )
                  : h(
                      'button',
                      {
                        class: 'btn sm',
                        onclick: async (e: Event) => {
                          e.stopPropagation();
                          await setActiveSession(sess.id);
                          toast(`${L('Sesión activa:', 'Active session:')} ${sess.name}`, 'ok');
                          onRefresh();
                        },
                      },
                      L('Activar', 'Activate'),
                    ),
              h(
                'button',
                {
                  class: 'btn ghost sm danger',
                  'aria-label': L('Eliminar sesión', 'Delete session'),
                  onclick: async (e: Event) => {
                    e.stopPropagation();
                    if (
                      await confirmDialog(
                        L('Eliminar sesión', 'Delete session'),
                        L(`¿Eliminar "${sess.name}" y todos sus conteos?`, `Delete "${sess.name}" and all its counts?`),
                        L('Eliminar', 'Delete'),
                        true,
                      )
                    ) {
                      await deleteSession(sess.id);
                      if (isCur) await setActiveSession(null);
                      toast(L('Sesión eliminada', 'Session deleted'));
                      onRefresh();
                    }
                  },
                },
                icon('trash'),
              ),
            ),
          );
        }),
      ),
    ),
    canQueryArchives
      ? h(
          'section',
          { class: 'card', 'data-testid': 'team-cloud-archives' },
          h(
            'div',
            { class: 'card-head wrap' },
            h('h3', { style: 'margin: 0;' }, L('Historial Archivado en la Nube', 'Cloud Archived History')),
            h(
              'button',
              {
                class: 'btn sm',
                type: 'button',
                'data-testid': 'team-load-archives-btn',
                onclick: async () => {
                  clear(archiveListBox, h('div', { class: 'muted small' }, L('Consultando historial en Firebase...', 'Loading Firebase archive...')));
                  const items = await listCloudArchivedSessions({
                    roomCode: syncRoomCode,
                    endpointUrl: syncEndpointUrl,
                  });
                  cachedArchiveList = items;
                  renderArchiveItems(items);
                },
              },
              icon('refresh'),
              L('Consultar historial en la nube', 'Load cloud history'),
            ),
          ),
          archiveListBox,
        )
      : null,
  );
}
