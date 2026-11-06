import {
  allProducts, countsForSession, getActiveSession, getDeviceId, type CountEntry, type Product, type Session,
} from '../db/db';
import {
  buildCountFile, buildReportCsv, buildReportWorkbook, safeFileName,
} from '../io/exportResults';
import { displayBarcode } from '../io/normalize';
import { buildReport, STATUS_LABEL, summarize, type ReportRow, type RowStatus } from '../report';
import {
  clear, downloadFile, fmtMoney, fmtNum, h, icon, MIME, openDialog, shareOrDownload, toast,
} from './dom';
import { editProductDialog } from './productDialog';
import { navigate, type View } from './router';

let filter: 'todos' | RowStatus = 'todos';
let query = '';
let includeNotCounted = true;

export const reportView: View = {
  title: 'Reporte',
  async render(root) {
    const session = await getActiveSession();
    if (!session) {
      clear(root, h('section', { class: 'card' },
        h('h2', null, 'Sin sesión activa'),
        h('p', { class: 'muted' }, 'Selecciona o inicia una sesión para ver resultados.'),
        h('button', { class: 'btn primary', onclick: () => navigate('/') }, 'Ir al inicio'),
      ));
      return;
    }
    const [counts, products, deviceId] = await Promise.all([
      countsForSession(session.id), allProducts(), getDeviceId(),
    ]);
    const allRows = buildReport(products, counts, includeNotCounted);
    const summary = summarize(allRows);

    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const list = h('ul', { class: 'rlist' });
    const countEl = h('span', { class: 'muted small' });

    const drawList = () => {
      const words = norm(query).split(/\s+/).filter(Boolean);
      const rows = allRows
        .filter((r) => filter === 'todos' || r.status === filter)
        .filter((r) => {
          if (!words.length) return true;
          const hay = norm(`${r.description} ${r.sku} ${displayBarcode(r.barcode)} ${r.counters.join(' ')}`);
          return words.every((w) => hay.includes(w));
        });
      countEl.textContent = `${rows.length} de ${allRows.length}`;
      clear(list,
        rows.length === 0 ? h('li', { class: 'empty' }, 'No hay productos con este filtro.') : null,
        rows.slice(0, 150).map((r) => {
          const badgeClass = r.status === 'ok' ? 'badge ok' : r.status === 'faltante' ? 'badge error' : r.status === 'sobrante' ? 'badge info' : 'badge warn';
          const diffText = r.diff === undefined ? '' : r.diff > 0 ? `+${fmtNum(r.diff)}` : fmtNum(r.diff);
          return h('li', {
            class: `r-item ${r.status}`,
            onclick: () => rowDetailDialog(r, counts.filter((c) => c.barcode === r.barcode)),
          },
          h('div', { class: 'r-head' },
            h('div', { class: 'grow' },
              h('div', { class: 'rec-desc' }, r.description || h('i', { class: 'muted' }, 'Sin descripción')),
              h('div', { class: 'rec-meta' },
                r.barcode.startsWith('SKU:') ? '' : h('code', null, displayBarcode(r.barcode)),
                r.sku ? ` · ${r.sku}` : '',
                r.unit ? ` · ${r.unit}` : '',
              ),
            ),
            h('span', { class: badgeClass }, STATUS_LABEL[r.status]),
          ),
          h('div', { class: 'r-nums' },
            h('span', null, 'Teórico: ', h('b', null, fmtNum(r.expected))),
            h('span', null, 'Contado: ', h('b', null, fmtNum(r.counted))),
            r.diff !== undefined ? h('span', { class: `diff ${r.diff < 0 ? 'neg' : r.diff > 0 ? 'pos' : ''}` }, 'Dif: ', h('b', null, diffText)) : null,
            r.diffValue !== undefined && r.diffValue !== 0 ? h('span', { class: 'muted small' }, fmtMoney(r.diffValue)) : null,
          ),
          );
        }),
        rows.length > 150 ? h('li', { class: 'empty' }, `Mostrando 150 de ${rows.length}. Usa el buscador.`) : null,
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
        chip('todos', 'Todos', allRows.length),
        chip('faltante', 'Faltantes', summary.short),
        chip('sobrante', 'Sobrantes', summary.over),
        chip('no_contado', 'No contados', summary.notCounted),
        chip('no_catalogado', 'No catalogados', summary.uncataloged),
        chip('ok', 'Correctos', summary.ok),
      );
    };
    updateChips();

    // Exportar
    const baseName = `inventario_${safeFileName(session.name)}_${new Date().toISOString().slice(0, 10)}`;
    const doExportXlsx = () => {
      const bytes = buildReportWorkbook({ session, rows: allRows, summary, counts, products });
      downloadFile(bytes, `${baseName}.xlsx`, MIME.xlsx);
      toast('Excel generado', 'ok');
    };
    const doExportCsv = () => {
      const csv = buildReportCsv(allRows);
      downloadFile(csv, `${baseName}.csv`, MIME.csv);
      toast('CSV generado', 'ok');
    };
    const doShareCount = async () => {
      const cf = buildCountFile(session, counts, products, deviceId);
      await shareOrDownload(JSON.stringify(cf, null, 2), `${baseName}.conteo.json`, MIME.json, `Conteo ${session.name}`);
    };

    clear(root,
      h('section', { class: 'card' },
        h('div', { class: 'card-head' },
          h('div', null,
            h('div', { class: 'muted small' }, 'Sesión'),
            h('h2', null, session.name),
          ),
          countEl,
        ),
        h('div', { class: 'kpis' },
          kpi(`${summary.accuracy}%`, 'Exactitud', summary.accuracy >= 95 ? 'good' : summary.accuracy >= 80 ? 'warn' : 'bad'),
          kpi(fmtNum(summary.counted), 'Contados'),
          kpi(fmtNum(summary.short), 'Faltantes', summary.short ? 'bad' : ''),
          kpi(fmtNum(summary.over), 'Sobrantes', summary.over ? 'warn' : ''),
          kpi(fmtNum(summary.notCounted), 'No contados'),
          kpi(fmtNum(summary.uncataloged), 'No catalogados', summary.uncataloged ? 'warn' : ''),
        ),
        summary.shortValue || summary.overValue
          ? h('div', { class: 'row values-row' },
            h('span', { class: 'small' }, 'Faltante: ', h('b', { class: 'neg' }, fmtMoney(summary.shortValue))),
            h('span', { class: 'small' }, 'Sobrante: ', h('b', { class: 'pos' }, fmtMoney(summary.overValue))),
            h('span', { class: 'small' }, 'Neto: ', h('b', null, fmtMoney(summary.netValue))),
          )
          : null,
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn primary', onclick: doExportXlsx }, icon('download'), 'Exportar Excel (.xlsx)'),
          h('button', { class: 'btn', onclick: doExportCsv }, icon('download'), 'CSV'),
          h('button', { class: 'btn', onclick: doShareCount }, icon('share'), 'Compartir conteo'),
        ),
        h('label', { class: 'check-inline small muted' },
          h('input', {
            type: 'checkbox', checked: includeNotCounted,
            onchange: (e: Event) => {
              includeNotCounted = (e.target as HTMLInputElement).checked;
              navigate('/reporte');
            },
          }),
          h('span', null, 'Incluir productos del catálogo no contados'),
        ),
      ),
      h('input', {
        class: 'input', type: 'search', placeholder: 'Buscar por descripción, código o responsable', value: query,
        oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; drawList(); },
      }),
      chipsWrap,
      list,
    );
    drawList();
  },
};

function kpi(val: string, label: string, tone = '') {
  return h('div', { class: `kpi ${tone}` }, h('div', { class: 'kpi-v' }, val), h('div', { class: 'kpi-l' }, label));
}

function rowDetailDialog(r: ReportRow, rowCounts: CountEntry[]) {
  const body = h('div', { class: 'form' },
    h('div', null, h('b', null, r.description || 'Sin descripción')),
    h('div', { class: 'muted small' },
      r.barcode.startsWith('SKU:') ? '' : h('code', null, displayBarcode(r.barcode)),
      r.sku ? ` · No. parte: ${r.sku}` : '',
      r.unit ? ` · Unidad: ${r.unit}` : '',
    ),
    h('div', { class: 'grid2' },
      infoBox('Existencia teórica', fmtNum(r.expected)),
      infoBox('Físico contado', fmtNum(r.counted)),
      infoBox('Diferencia', r.diff === undefined ? '—' : (r.diff > 0 ? `+${fmtNum(r.diff)}` : fmtNum(r.diff))),
      infoBox('Valor diferencia', fmtMoney(r.diffValue)),
    ),
    h('h4', null, `Escaneos registrados (${rowCounts.length})`),
    h('ul', { class: 'rec-sub' },
      rowCounts.length === 0 ? h('li', { class: 'empty' }, 'No fue escaneado') : null,
      rowCounts.map((c) => h('li', null,
        h('span', null, `${fmtNum(c.qty)} · ${c.counter}`),
        h('span', { class: 'muted small' }, new Date(c.timestamp).toLocaleTimeString('es-MX', { hour12: false })),
      )),
    ),
  );
  openDialog('Detalle del producto', body, [
    { label: 'Cerrar' },
    {
      label: 'Editar producto',
      onClick: async () => {
        const saved = await editProductDialog(r.barcode);
        if (saved) navigate('/reporte');
      },
    },
  ]);
}

function infoBox(title: string, value: string) {
  return h('div', { class: 'stat' }, h('div', { class: 'muted small' }, title), h('b', null, value));
}
