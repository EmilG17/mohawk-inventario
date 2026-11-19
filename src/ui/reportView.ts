import {
  allProducts, allSessions, closeSession, countsForSession, getActiveSession, getDeviceId, getSession,
  reopenSession, setActiveSession, type CountEntry, type Product, type Session,
} from '../db/db';
import {
  getIdealLevels,
  getMovementSummariesBySku,
  listMovements,
} from '../db/movements';
import {
  buildCountFile, buildReportCsv, buildReportWorkbook, safeFileName,
} from '../io/exportResults';
import { L, getLocaleTag } from '../i18n/i18n';
import { displayBarcode, normalizeBarcode } from '../io/normalize';
import { buildReport, summarize, type ReportRow, type RowStatus } from '../report';
import { loadSettings } from '../settings';

function statusLabel(status: RowStatus): string {
  switch (status) {
    case 'ok':
      return L('Correcto', 'Match');
    case 'faltante':
      return L('Faltante', 'Short');
    case 'sobrante':
      return L('Sobrante', 'Over');
    case 'no_contado':
      return L('No contado', 'Not counted');
    case 'no_catalogado':
      return L('No catalogado', 'Uncataloged');
  }
}
import {
  clear, confirmDialog, downloadFile, fmtDateTime, fmtMoney, fmtNum, h, icon, MIME, openDialog, shareOrDownload, toast,
} from './dom';
import { editProductDialog } from './productDialog';
import { isMobileCatalogReadOnly, isStrictTechnicianClient } from './catalogMode';
import { openBarcodeSheetDialog } from './barcodeSheet';
import { createBrandLogo } from './logo';
import { openUnifyReportsDialog } from './unifyReportsDialog';
import { navigate, type View } from './router';
import { archiveSessionToCloud, onCloudRoomUpdate } from '../sync/cloudSync';
import { computeRoomDataSig } from './cloudSignal';

let selectedSessionId: string | null = null;
let filter: 'todos' | 'por_pedir' | RowStatus = 'todos';
let query = '';
let includeNotCounted = true;
let unbindCloudSync: (() => void) | null = null;
let reportMounted = false;
let reportRenderSeq = 0;
let reportSyncTimer: ReturnType<typeof setTimeout> | null = null;
let lastReportDataFp = '';

async function drawReportContent(root: HTMLElement, params: URLSearchParams, seq: number): Promise<void> {
  if (isStrictTechnicianClient()) {
    clear(root, h('section', { class: 'card' },
      h('div', { class: 'badge warn', style: 'margin-bottom: 8px; display: inline-block;' }, L('Acceso restringido', 'Restricted access')),
      h('h2', null, L('Reporte reservado para Supervisores', 'Report reserved for Supervisors')),
      h('p', { class: 'muted' }, L('Tu dispositivo está configurado como Cliente-Técnico. Consulta el avance o captura tus conteos desde la terminal.', 'Your device is configured as a Technician Client. View progress or capture counts from your terminal.')),
      h('div', { class: 'row wrap', style: 'gap: 8px; margin-top: 10px;' },
        h('button', { class: 'btn primary', onclick: () => navigate('/contar') }, L('Ir a Contar', 'Go to Count')),
        h('button', { class: 'btn', onclick: () => navigate('/') }, L('Ir al inicio', 'Go to home')),
      ),
    ));
    return;
  }
  if (params?.get('session')) {
    selectedSessionId = params.get('session');
  }
  const [allSess, activeSession, products, deviceId, movementSummaries, idealLevels] = await Promise.all([
    allSessions(), getActiveSession(), allProducts(), getDeviceId(), getMovementSummariesBySku(), getIdealLevels(),
  ]);
  if (!reportMounted || seq !== reportRenderSeq) return;

  let session: Session | undefined;
  if (selectedSessionId) {
    session = allSess.find((s) => s.id === selectedSessionId) ?? (await getSession(selectedSessionId));
    if (!reportMounted || seq !== reportRenderSeq) return;
  }
  if (!session && activeSession) {
    session = activeSession;
  }
  if (!session && allSess.length > 0) {
    session = allSess[0];
  }

  if (!session) {
    clear(root, h('section', { class: 'card' },
      h('div', { class: 'badge warn', style: 'margin-bottom: 8px; display: inline-block;' }, L('Sin sesiones', 'No sessions')),
      h('h2', null, L('No hay sesiones', 'No sessions')),
      h('p', { class: 'muted' }, L('Aún no se ha registrado ninguna sesión de conteo.', 'No counting session has been recorded yet.')),
      h('button', { class: 'btn primary', onclick: () => navigate('/') }, L('Ir al inicio', 'Go to home')),
    ));
    return;
  }

  selectedSessionId = session.id;
  const isCur = activeSession?.id === session.id;
  const isClosed = session.closed;
  const counts = await countsForSession(session.id);
  if (!reportMounted || seq !== reportRenderSeq) return;

  const countsByBarcode = new Map<string, CountEntry[]>();
  const addCountToMap = (key: string, entry: CountEntry) => {
    const arr = countsByBarcode.get(key);
    if (arr) {
      if (!arr.includes(entry)) arr.push(entry);
    } else {
      countsByBarcode.set(key, [entry]);
    }
  };
  for (const c of counts) {
    addCountToMap(c.barcode, c);
    const normBc = normalizeBarcode(c.barcode);
    if (normBc && normBc !== c.barcode) addCountToMap(normBc, c);
  }

  const allRows = buildReport(products, counts, {
    includeNotCounted,
    movementsBySku: movementSummaries,
    idealLevels,
  });
  const summary = summarize(allRows);

  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const list = h('ul', { class: 'rlist' });
  const countEl = h('span', { class: 'muted small' });

  const drawList = () => {
    const words = norm(query).split(/\s+/).filter(Boolean);
    const rows = allRows
      .filter((r) =>
        filter === 'todos'
          ? true
          : filter === 'por_pedir'
            ? Boolean(r.needsReorder)
            : r.status === filter,
      )
      .filter((r) => {
        if (!words.length) return true;
        const hay = norm(`${r.description} ${r.sku} ${displayBarcode(r.barcode)} ${r.counters.join(' ')}`);
        return words.every((w) => hay.includes(w));
      });
    countEl.textContent = `${rows.length} ${L('de', 'of')} ${allRows.length}`;
    clear(list,
      rows.length === 0 ? h('li', { class: 'empty' }, L('No hay productos con este filtro.', 'No products match this filter.')) : null,
      rows.slice(0, 150).map((r) => {
        const badgeClass = r.status === 'ok' ? 'badge ok' : r.status === 'faltante' ? 'badge error' : r.status === 'sobrante' ? 'badge info' : 'badge warn';
        const idealVal = r.idealQty ?? r.expected;
        const idealDiff = idealVal !== undefined ? Math.round((r.counted - idealVal) * 1000) / 1000 : r.diff;
        const idealDiffText = idealDiff === undefined ? '' : idealDiff > 0 ? `+${fmtNum(idealDiff)}` : fmtNum(idealDiff);
        return h('li', {
          class: `r-item ${r.status}`,
          onclick: () => rowDetailDialog(r, countsByBarcode.get(r.barcode) ?? []),
        },
        h('div', { class: 'r-head' },
          h('div', { class: 'grow' },
            h('div', { class: 'rec-desc' }, r.description || h('i', { class: 'muted' }, L('Sin descripción', 'No description'))),
            h('div', { class: 'rec-meta' },
              r.barcode.startsWith('SKU:') ? '' : h('code', null, displayBarcode(r.barcode)),
              r.sku ? ` · ${r.sku}` : '',
              r.unit ? ` · ${r.unit}` : '',
            ),
          ),
          h(
            'div',
            { class: 'row', style: 'gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end;' },
            r.needsReorder
              ? h(
                  'span',
                  { class: 'badge warn', title: `${L('Bajo stock mínimo', 'Below min stock')} (${fmtNum(r.minQty)})` },
                  `${L('Pedir', 'Order')} +${fmtNum(r.suggestedOrderQty)}`,
                )
              : null,
            h('span', { class: badgeClass }, statusLabel(r.status)),
          ),
        ),
        h('div', { class: 'r-nums' },
          h('span', null, 'Ideal: ', h('b', null, fmtNum(idealVal))),
          h('span', null, L('Contado: ', 'Counted: '), h('b', null, fmtNum(r.counted))),
          idealDiff !== undefined ? h('span', { class: `diff ${idealDiff < 0 ? 'neg' : idealDiff > 0 ? 'pos' : ''}` }, L('Dif: ', 'Diff: '), h('b', null, idealDiffText)) : null,
          r.diffValue !== undefined && r.diffValue !== 0 ? h('span', { class: 'muted small' }, fmtMoney(r.diffValue)) : null,
        ),
        );
      }),
      rows.length > 150 ? h('li', { class: 'empty' }, L(`Mostrando 150 de ${rows.length}. Usa el buscador.`, `Showing 150 of ${rows.length}. Use search.`)) : null,
    );
  };

  const chip = (id: typeof filter, label: string, count: number) =>
    h('button', {
      class: `chip ${filter === id ? 'active' : ''}`,
      onclick: () => { filter = id; drawList(); updateChips(); },
    }, `${label} (${count})`);

  const chipsWrap = h('div', { class: 'chips' });
  const updateChips = () => {
    clear(chipsWrap,
      chip('todos', L('Todos', 'All'), allRows.length),
      chip('por_pedir', L('Por pedir', 'Reorder'), summary.reorderCount),
      chip('faltante', L('Faltantes', 'Short'), summary.short),
      chip('sobrante', L('Sobrantes', 'Over'), summary.over),
      chip('no_contado', L('No contados', 'Not counted'), summary.notCounted),
      chip('no_catalogado', L('No catalogados', 'Uncataloged'), summary.uncataloged),
      chip('ok', L('Correctos', 'Match'), summary.ok),
    );
  };
  updateChips();

  // Exportar
  const baseName = `inventario_${safeFileName(session.name)}_${new Date().toISOString().slice(0, 10)}`;
  const doExportXlsx = async () => {
    const [currentMovements, currentIdealLevels] = await Promise.all([
      listMovements(),
      getIdealLevels(),
    ]);
    const bytes = buildReportWorkbook({
      session,
      rows: allRows,
      summary,
      counts,
      products,
      movements: currentMovements,
      idealLevels: currentIdealLevels,
    });
    downloadFile(bytes, `${baseName}.xlsx`, MIME.xlsx);
    toast(L('Excel generado', 'Excel generated'), 'ok');
  };
  const doExportCsv = () => {
    const csv = buildReportCsv(allRows);
    downloadFile(csv, `${baseName}.csv`, MIME.csv);
    toast(L('CSV generado', 'CSV generated'), 'ok');
  };
  const doShareCount = async () => {
    const cf = buildCountFile(session, counts, products, deviceId);
    await shareOrDownload(JSON.stringify(cf, null, 2), `${baseName}.conteo.json`, MIME.json, `${L('Conteo', 'Count')} ${session.name}`);
  };

  const sessionSelect = h('select', {
    id: 'session-select',
    'data-testid': 'report-session-select',
    class: 'input sm session-picker',
    style: 'max-width: 310px; font-weight: normal;',
    onchange: (e: Event) => {
      const val = (e.target as HTMLSelectElement).value;
      selectedSessionId = val;
      navigate(`/reporte?session=${val}`);
    },
  },
    allSess.map((s) =>
      h('option', {
        value: s.id,
        selected: s.id === session!.id,
      }, `${s.name} (${s.closed ? L('Cerrada', 'Closed') : activeSession?.id === s.id ? L('Activa', 'Active') : L('Abierta', 'Open')})`),
    ),
  );

  const statusBadge = isCur
    ? h('span', { class: 'badge ok' }, L('Activa', 'Active'))
    : isClosed
      ? h('span', { class: 'badge info' }, L('Cerrada', 'Closed'))
      : h('span', { class: 'badge warn' }, L('Abierta', 'Open'));

  const secondaryItems: (HTMLElement | null)[] = [
    summary.shortValue || summary.overValue || summary.reorderValue
      ? h('div', { class: 'row values-row wrap', style: 'margin: 0;' },
        h('span', { class: 'small' }, L('Faltante: ', 'Shortage: '), h('b', { class: 'neg' }, fmtMoney(summary.shortValue))),
        h('span', { class: 'small' }, L('Sobrante: ', 'Overage: '), h('b', { class: 'pos' }, fmtMoney(summary.overValue))),
        h('span', { class: 'small' }, L('Neto: ', 'Net: '), h('b', null, fmtMoney(summary.netValue))),
        summary.reorderValue ? h('span', { class: 'small' }, L('Est. Compra: ', 'Est. Purchase: '), h('b', null, fmtMoney(summary.reorderValue))) : null,
      )
      : null,
    (() => {
      const techStats = new Map<string, { scans: number; units: number; products: Set<string> }>();
      for (const c of counts) {
        const name = c.counter?.trim() || session.counter || L('Técnico', 'Technician');
        const st = techStats.get(name) ?? { scans: 0, units: 0, products: new Set<string>() };
        st.scans++;
        st.units += c.qty;
        st.products.add(c.barcode);
        techStats.set(name, st);
      }
      if (techStats.size === 0) return null;
      return h(
        'div',
        null,
        h('div', { class: 'muted xsmall bold uppercase', style: 'margin-bottom: 4px;' }, L(`Participación (${techStats.size} participante${techStats.size === 1 ? '' : 's'})`, `Participation (${techStats.size} contributor${techStats.size === 1 ? '' : 's'})`)),
        h(
          'ul',
          { class: 'contributor-list' },
          [...techStats.entries()].map(([name, info]) =>
            h(
              'li',
              null,
              h('span', null, h('b', null, name)),
              h(
                'span',
                { class: 'muted small' },
                `${info.products.size} ${L('prod.', 'items')} · ${info.scans} ${L('escaneo(s)', 'scan(s)')} · ${fmtNum(info.units)} ${L('u.', 'u.')}`,
              ),
            ),
          ),
        ),
      );
    })(),
    h('label', { class: 'check-inline small muted' },
      h('input', {
        type: 'checkbox', checked: includeNotCounted,
        onchange: (e: Event) => {
          includeNotCounted = (e.target as HTMLInputElement).checked;
          navigate(`/reporte?session=${session.id}`);
        },
      }),
      h('span', null, L('Incluir productos del catálogo no contados', 'Include uncounted catalog products')),
    ),
  ];

  clear(root,
    h('section', { class: 'card' },
      h('div', { class: 'card-head wrap', style: 'align-items: center; gap: 10px;' },
        createBrandLogo(32, 'brand-mark report-brand-mark'),
        h('div', { class: 'grow' },
          h('div', { class: 'row wrap', style: 'gap: 8px; align-items: center;' },
            h('h2', { style: 'margin: 0;' }, session.name),
            statusBadge,
            countEl,
          ),
          h('div', { class: 'muted xsmall' },
            `${session.counter} · ${fmtDateTime(session.createdAt)}`,
            session.closed && session.closedAt ? ` · ${L('Finalizada:', 'Closed:')} ${fmtDateTime(session.closedAt)}` : '',
          ),
        ),
        sessionSelect,
      ),
      h('div', { class: 'kpis' },
        kpi(`${summary.accuracy}%`, L('Exactitud', 'Accuracy'), summary.accuracy >= 95 ? 'good' : summary.accuracy >= 80 ? 'warn' : 'bad'),
        kpi(fmtNum(summary.counted), L('Contados', 'Counted')),
        kpi(fmtNum(summary.short), L('Faltantes', 'Short'), summary.short ? 'bad' : ''),
        kpi(fmtNum(summary.over), L('Sobrantes', 'Over'), summary.over ? 'warn' : ''),
        kpi(fmtNum(summary.notCounted), L('No contados', 'Not counted')),
        kpi(fmtNum(summary.reorderCount), L('Por pedir', 'Reorder'), summary.reorderCount ? 'warn' : ''),
      ),
      h('div', { class: 'row wrap rep-actions-row', style: 'gap: 6px;' },
        h('button', { class: 'btn primary sm', 'data-testid': 'report-export-xlsx', onclick: doExportXlsx }, icon('download'), L('Exportar Excel (.xlsx)', 'Export Excel (.xlsx)')),
        h('button', { class: 'btn sm', 'data-testid': 'report-export-csv', onclick: doExportCsv }, icon('download'), 'CSV'),
        h('button', {
          class: 'btn sm',
          'data-testid': 'report-unify-btn',
          onclick: () => void openUnifyReportsDialog((sid) => {
            selectedSessionId = sid;
            navigate(`/reporte?session=${sid}`);
          }),
        }, icon('users'), L('Unificar reportes de técnicos', 'Merge technician reports')),
        h('button', {
          class: 'btn sm',
          'data-testid': 'report-print-labels',
          onclick: () => {
            const sessionProducts = products.filter((p) => countsByBarcode.has(p.barcode));
            const initialQuantities: Record<string, number> = {};
            for (const c of counts) {
              initialQuantities[c.barcode] = (initialQuantities[c.barcode] || 0) + (c.qty || 1);
            }
            openBarcodeSheetDialog({
              products: sessionProducts.length ? sessionProducts : products,
              initialQuantities,
              defaultTitle: `${L('Etiquetas de sesión', 'Session labels')}: ${session.name}`,
            });
          },
        }, icon('scan'), L('Imprimir etiquetas de sesión', 'Print session labels')),
        h('button', { class: 'btn ghost sm', 'data-testid': 'report-share-count', onclick: doShareCount }, icon('share'), L('Compartir conteo', 'Share count')),
        isClosed
          ? h('button', {
            class: 'btn sm',
            onclick: async () => {
              await reopenSession(session.id);
              toast(L('Sesión reabierta y activada', 'Session reopened and activated'), 'ok');
              navigate(`/reporte?session=${session.id}`);
            },
          }, L('Reabrir sesión', 'Reopen session'))
          : isCur
            ? h('button', {
              class: 'btn danger ghost sm',
              onclick: async () => {
                const ok = await confirmDialog(L('Finalizar sesión', 'Close session'), L(`¿Deseas finalizar la sesión "${session.name}"?`, `Finish session "${session.name}"?`), L('Finalizar', 'Close'), true);
                if (ok) {
                  await closeSession(session.id);
                  void archiveSessionToCloud(session.id).catch(() => {});
                  toast(L('Sesión finalizada con éxito', 'Session closed'), 'ok');
                  navigate(`/reporte?session=${session.id}`);
                }
              },
            }, L('Finalizar sesión', 'Close session'))
            : h('button', {
              class: 'btn sm',
              onclick: async () => {
                await setActiveSession(session.id);
                toast(`${L('Sesión activa', 'Active session')}: ${session.name}`, 'ok');
                navigate(`/reporte?session=${session.id}`);
              },
            }, L('Activar sesión', 'Activate session')),
      ),
      h('details', { class: 'ui-disclosure' },
        h('summary', { class: 'ui-disclosure-summary' }, L('Desglose financiero, técnicos y opciones', 'Financial breakdown, technicians & options')),
        h('div', { class: 'ui-disclosure-body' }, ...secondaryItems),
      ),
    ),
    h('section', { class: 'card list-card' },
      h('div', { class: 'filter-bar-row' },
        h('input', {
          class: 'input', type: 'search', placeholder: L('Buscar por descripción, código o responsable', 'Search by description, code, or counter'), value: query,
          oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; drawList(); },
        }),
        chipsWrap,
      ),
      h('div', { class: 'rlist-table-head', 'aria-hidden': 'true' },
        h('span', null, L('Producto / Estado', 'Product / Status')),
        h('span', null, L('Ideal · Contado · Diferencia', 'Ideal · Counted · Variance')),
      ),
      list,
    ),
  );
  drawList();
}

export const reportView: View = {
  title: () => L('Reporte', 'Report'),
  async render(root, params) {
    reportMounted = true;
    const seq = ++reportRenderSeq;
    lastReportDataFp = '';

    await loadSettings();
    if (!reportMounted || seq !== reportRenderSeq) return;

    if (unbindCloudSync) {
      unbindCloudSync();
      unbindCloudSync = null;
    }
    if (reportSyncTimer) {
      clearTimeout(reportSyncTimer);
      reportSyncTimer = null;
    }

    unbindCloudSync = onCloudRoomUpdate((roomState) => {
      if (!reportMounted) return;
      // Ignorar ráfagas de telemetría solo de cámara/escáner que no alteran el reporte
      if (roomState) {
        const nextFp = computeRoomDataSig(roomState);
        if (nextFp && nextFp === lastReportDataFp) return;
        lastReportDataFp = nextFp;
      }
      if (reportSyncTimer) clearTimeout(reportSyncTimer);
      reportSyncTimer = setTimeout(() => {
        reportSyncTimer = null;
        if (!reportMounted) return;
        const refreshSeq = ++reportRenderSeq;
        void drawReportContent(root, params, refreshSeq);
      }, 0);
    });

    await drawReportContent(root, params, seq);
  },
  destroy() {
    reportMounted = false;
    reportRenderSeq++;
    if (reportSyncTimer) {
      clearTimeout(reportSyncTimer);
      reportSyncTimer = null;
    }
    if (unbindCloudSync) {
      unbindCloudSync();
      unbindCloudSync = null;
    }
  },
};

function kpi(val: string, label: string, tone = '') {
  return h('div', { class: `kpi ${tone}` }, h('div', { class: 'kpi-v' }, val), h('div', { class: 'kpi-l' }, label));
}

function rowDetailDialog(r: ReportRow, rowCounts: CountEntry[]) {
  const body = h('div', { class: 'form' },
    h('div', null, h('b', null, r.description || L('Sin descripción', 'No description'))),
    h('div', { class: 'muted small' },
      r.barcode.startsWith('SKU:') ? '' : h('code', null, displayBarcode(r.barcode)),
      r.sku ? ` · ${L('No. parte:', 'Part #:')} ${r.sku}` : '',
      r.unit ? ` · ${L('Unidad:', 'Unit:')} ${r.unit}` : '',
    ),
    h('div', { class: 'grid2' },
      infoBox(L('Inventario ideal', 'Ideal stock'), fmtNum(r.idealQty ?? r.expected)),
      infoBox(L('Físico contado', 'Physical counted'), fmtNum(r.counted)),
      infoBox(L('Diferencia', 'Variance'), r.diff === undefined ? '—' : (r.diff > 0 ? `+${fmtNum(r.diff)}` : fmtNum(r.diff))),
      infoBox(L('Valor diferencia', 'Variance value'), fmtMoney(r.diffValue)),
    ),
    h('h4', null, `${L('Escaneos registrados', 'Recorded scans')} (${rowCounts.length})`),
    h('ul', { class: 'rec-sub' },
      rowCounts.length === 0 ? h('li', { class: 'empty' }, L('No fue escaneado', 'Not scanned')) : null,
      rowCounts.map((c) => h('li', null,
        h('span', null, `${fmtNum(c.qty)} · ${c.counter}`),
        h('span', { class: 'muted small' }, new Date(c.timestamp).toLocaleTimeString(getLocaleTag(), { hour12: false })),
      )),
    ),
  );
  openDialog(L('Detalle del producto', 'Product details'), body, [
    { label: L('Cerrar', 'Close') },
    {
      label: isMobileCatalogReadOnly() ? L('Ver etiqueta / Producto', 'View label / Product') : L('Editar producto', 'Edit product'),
      onClick: async () => {
        const saved = await editProductDialog(r.barcode);
        if (saved) navigate(selectedSessionId ? `/reporte?session=${selectedSessionId}` : '/reporte');
      },
    },
  ]);
}

function infoBox(title: string, value: string) {
  return h('div', { class: 'stat' }, h('div', { class: 'muted small' }, title), h('b', null, value));
}
