import { allProducts, bulkPutProducts, clearProducts, type Product } from '../db/db';
import { buildCatalogFile, buildCatalogWorkbook } from '../io/exportResults';
import {
  detectHeaderRow, FIELD_LABELS, guessMapping, readWorkbook, rowsToProducts, type Field, type Mapping, type Workbook,
} from '../io/importCatalog';
import { importCatalogFile, parseAppFile } from '../io/mergeCounts';
import { displayBarcode } from '../io/normalize';
import { processPending } from '../lookup/pendingQueue';
import {
  clear, confirmDialog, fmtNum, h, icon, MIME, openDialog, pickFiles, shareOrDownload, toast, downloadFile,
} from './dom';
import { editProductDialog, sourceBadge } from './productDialog';
import type { View } from './router';
import { navigate } from './router';

let filter: 'todos' | 'sin_desc' | 'no_cat' = 'todos';
let query = '';

export async function importCatalogFlow(): Promise<void> {
  const [file] = await pickFiles('.xlsx,.xls,.csv,.txt,.json,application/json');
  if (!file) return;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (/\.json$/i.test(file.name)) {
      const f = parseAppFile(new TextDecoder().decode(buf));
      if (f.kind !== 'catalogo') {
        toast('Ese es un archivo de conteo; impórtalo en la pestaña Equipo.', 'warn', 4000);
        return;
      }
      const replace = await confirmDialog('Importar catálogo',
        `El archivo trae ${f.products.length} productos. ¿Reemplazar el catálogo actual? (Cancelar = combinar)`, 'Reemplazar');
      const n = await importCatalogFile(f, replace ? 'replace' : 'merge');
      toast(`${n} productos importados`, 'ok');
      navigate('/catalogo');
      return;
    }
    const wb = readWorkbook(buf, file.name);
    mappingDialog(wb, file.name);
  } catch (e) {
    console.error(e);
    toast('No se pudo leer el archivo: ' + (e as Error).message, 'error', 5000);
  }
}

function mappingDialog(wb: Workbook, fileName: string) {
  let sheet = wb.sheetNames[0];
  let rows = wb.rows(sheet);
  let headerRow = detectHeaderRow(rows);
  let mapping: Mapping = guessMapping(rows[headerRow] ?? []);
  let mode: 'merge' | 'replace' = 'replace';
  const body = h('div', { class: 'form' });

  const render = () => {
    const headers = (rows[headerRow] ?? []).map((x, i) => String(x || `Columna ${i + 1}`));
    const fieldSel = (f: Field) =>
      h('label', { class: 'field' }, h('span', null, FIELD_LABELS[f], f === 'barcode' || f === 'description' ? ' *' : ''),
        h('select', {
          class: 'input',
          onchange: (e: Event) => { mapping[f] = Number((e.target as HTMLSelectElement).value); render(); },
        },
        h('option', { value: '-1', selected: mapping[f] < 0 }, '— No usar —'),
        headers.map((t, i) => h('option', { value: String(i), selected: mapping[f] === i }, t))));
    let preview: Product[] = [];
    let warnings: string[] = [];
    let skipped = 0;
    let error = '';
    try {
      const r = rowsToProducts(rows, headerRow, mapping);
      preview = r.products;
      warnings = r.warnings;
      skipped = r.skipped;
    } catch (e) {
      error = (e as Error).message;
    }
    clear(body,
      h('p', { class: 'muted small' }, fileName),
      wb.sheetNames.length > 1
        ? h('label', { class: 'field' }, h('span', null, 'Hoja'),
          h('select', {
            class: 'input',
            onchange: (e: Event) => {
              sheet = (e.target as HTMLSelectElement).value;
              rows = wb.rows(sheet);
              headerRow = detectHeaderRow(rows);
              mapping = guessMapping(rows[headerRow] ?? []);
              render();
            },
          }, wb.sheetNames.map((s) => h('option', { value: s, selected: s === sheet }, s))))
        : null,
      h('label', { class: 'field' }, h('span', null, 'Fila de encabezados'),
        h('input', {
          class: 'input', type: 'number', min: 1, max: Math.max(1, rows.length), value: String(headerRow + 1),
          onchange: (e: Event) => {
            headerRow = Math.max(0, Math.min(rows.length - 1, Number((e.target as HTMLInputElement).value) - 1));
            mapping = guessMapping(rows[headerRow] ?? []);
            render();
          },
        })),
      h('div', { class: 'grid2' }, (Object.keys(FIELD_LABELS) as Field[]).map(fieldSel)),
      error ? h('p', { class: 'error-text' }, error) : h('p', null, h('b', null, `${preview.length} productos`), ' listos para importar', skipped ? ` · ${skipped} filas vacías omitidas` : ''),
      preview.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, h('th', null, 'Código'), h('th', null, 'Descripción'), h('th', null, 'Teórico'))),
          h('tbody', null, preview.slice(0, 5).map((p) => h('tr', null,
            h('td', null, p.barcode.startsWith('SKU:') ? p.sku : displayBarcode(p.barcode)),
            h('td', null, p.description || '—'),
            h('td', null, fmtNum(p.expectedQty))))),
        ))
        : null,
      warnings.length
        ? h('details', { class: 'warn-box' }, h('summary', null, `${warnings.length} advertencia(s)`),
          h('ul', null, warnings.slice(0, 50).map((w) => h('li', { class: 'small' }, w))))
        : null,
      h('div', { class: 'radio-row' },
        h('label', null, h('input', { type: 'radio', name: 'mode', checked: mode === 'replace', onchange: () => (mode = 'replace') }), ' Reemplazar catálogo'),
        h('label', null, h('input', { type: 'radio', name: 'mode', checked: mode === 'merge', onchange: () => (mode = 'merge') }), ' Combinar / actualizar'),
      ),
      h('p', { class: 'muted small' }, 'Reemplazar conserva los productos no catalogados ya escaneados y sus descripciones.'),
    );
  };
  render();

  openDialog('Importar catálogo', body, [
    { label: 'Cancelar' },
    {
      label: 'Importar', kind: 'primary',
      onClick: async () => {
        try {
          const r = rowsToProducts(rows, headerRow, mapping);
          if (!r.products.length) { toast('No hay productos para importar', 'warn'); return true; }
          if (mode === 'replace') {
            // conservar no catalogados y descripciones obtenidas antes
            const keep = (await allProducts()).filter((p) => p.uncataloged);
            await bulkPutProducts(r.products, 'replace');
            const imported = new Set(r.products.map((p) => p.barcode));
            await bulkPutProducts(keep.filter((p) => !imported.has(p.barcode)));
          } else {
            await bulkPutProducts(r.products, 'merge');
          }
          toast(`${r.products.length} productos importados`, 'ok');
          void processPending();
          navigate('/catalogo');
        } catch (e) {
          toast((e as Error).message, 'error', 5000);
          return true;
        }
      },
    },
  ]);
}

export const catalogView: View = {
  title: 'Catálogo',
  async render(root) {
    const products = await allProducts();
    const list = h('ul', { class: 'plist' });
    const countEl = h('span', { class: 'muted small' });
    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const draw = () => {
      const words = norm(query).split(/\s+/).filter(Boolean);
      const items = products
        .filter((p) => filter === 'todos' || (filter === 'sin_desc' ? !p.description : p.uncataloged))
        .filter((p) => {
          if (!words.length) return true;
          const hay = norm(`${p.description} ${p.sku} ${displayBarcode(p.barcode)} ${p.brand ?? ''}`);
          return words.every((w) => hay.includes(w));
        })
        .sort((a, b) => (a.description || '~').localeCompare(b.description || '~'));
      countEl.textContent = `${items.length} de ${products.length}`;
      clear(list,
        items.length === 0 ? h('li', { class: 'empty' }, products.length ? 'Sin coincidencias' : 'Catálogo vacío') : null,
        items.slice(0, 200).map((p) => h('li', {
          onclick: async () => {
            const saved = await editProductDialog(p.barcode, p);
            if (saved) { Object.assign(p, saved); draw(); }
          },
        },
        h('div', { class: 'grow' },
          h('div', { class: 'rec-desc' }, p.description || h('i', { class: 'muted' }, 'Sin descripción')),
          h('div', { class: 'rec-meta' },
            p.barcode.startsWith('SKU:') ? '' : h('code', null, displayBarcode(p.barcode)),
            p.sku ? ` · ${p.sku}` : '', p.unit ? ` · ${p.unit}` : ''),
          h('div', { class: 'pc-badges' }, sourceBadge(p), p.uncataloged ? h('span', { class: 'badge warn' }, 'No catalogado') : null),
        ),
        p.expectedQty !== undefined ? h('div', { class: 'rec-qty small' }, fmtNum(p.expectedQty)) : null,
        )),
        items.length > 200 ? h('li', { class: 'empty' }, `Mostrando 200 de ${items.length}. Usa la búsqueda.`) : null,
      );
    };

    const chip = (id: typeof filter, label: string) =>
      h('button', { class: `chip ${filter === id ? 'active' : ''}`, onclick: () => { filter = id; navigate('/catalogo'); } }, label);
    const noDesc = products.filter((p) => !p.description).length;

    clear(root,
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'Catálogo'), countEl),
        h('p', { class: 'muted small' }, 'Importa el Excel o CSV de consumibles. Columnas sugeridas: Código de barras, No. de parte, Descripción, Unidad, Existencia teórica, Costo unitario.'),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn primary', onclick: importCatalogFlow }, icon('upload'), 'Importar Excel/CSV'),
          h('button', {
            class: 'btn', disabled: !products.length,
            onclick: () => downloadFile(buildCatalogWorkbook(products), 'catalogo_consumibles.xlsx', MIME.xlsx),
          }, icon('download'), 'Excel'),
          h('button', {
            class: 'btn', disabled: !products.length,
            onclick: () => shareOrDownload(JSON.stringify(buildCatalogFile(products)), 'catalogo_inventario.json', MIME.json, 'Catálogo de inventario'),
          }, icon('share'), 'Compartir'),
        ),
        noDesc
          ? h('button', {
            class: 'btn sm', onclick: async () => {
              toast('Buscando descripciones…');
              const n = await processPending();
              toast(`${n} descripción(es) encontradas`, n ? 'ok' : 'warn');
              navigate('/catalogo');
            },
          }, icon('globe'), `Buscar en internet ${noDesc} sin descripción`)
          : null,
      ),
      h('input', {
        class: 'input', type: 'search', placeholder: 'Buscar por descripción, código o No. de parte', value: query,
        oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; draw(); },
      }),
      h('div', { class: 'chips' }, chip('todos', 'Todos'), chip('sin_desc', `Sin descripción (${noDesc})`), chip('no_cat', 'No catalogados')),
      list,
      products.length
        ? h('button', {
          class: 'btn danger ghost sm', onclick: async () => {
            if (await confirmDialog('Borrar catálogo', 'Se eliminarán todos los productos (los conteos no se borran). ¿Continuar?', 'Borrar', true)) {
              await clearProducts();
              toast('Catálogo borrado');
              navigate('/catalogo');
            }
          },
        }, icon('trash'), 'Borrar catálogo')
        : null,
    );
    draw();
  },
};
