import {
  allProducts, bulkModifyProducts, bulkPutProducts, clearProducts, deleteProducts,
  type MassProductPatch, type Product,
} from '../db/db';
import { buildCatalogFile, buildCatalogWorkbook } from '../io/exportResults';
import {
  detectHeaderRow, FIELD_LABELS, guessMapping, readWorkbook, rowsToProducts, type Field, type Mapping, type Workbook,
} from '../io/importCatalog';
import { importCatalogFile, parseAppFile, reconcileCatalogProducts } from '../io/mergeCounts';
import { displayBarcode, parseNumber } from '../io/normalize';
import { processPending } from '../lookup/pendingQueue';
import { onCloudRoomUpdate, syncCatalogWithDb, triggerBackgroundSync } from '../sync/cloudSync';
import {
  clear, confirmDialog, downloadFile, fmtNum, h, icon, MIME, openDialog, pickFiles, shareOrDownload, toast,
} from './dom';
import { isMobileCatalogReadOnly } from './catalogMode';
import { editProductDialog, sourceBadge } from './productDialog';
import { openBarcodeSheetDialog } from './barcodeSheet';
import { addToPrintQueue, getPrintQueueTotalCount } from '../barcode/printQueue';
import type { View } from './router';
import { navigate } from './router';

let filter: 'todos' | 'sin_desc' | 'no_cat' = 'todos';
let query = '';
let unsubscribeCatalogCloud: (() => void) | null = null;
let unsubscribeCatalogResize: (() => void) | null = null;

export async function syncCatalogWithDbFlow(onCompleted?: () => void): Promise<void> {
  try {
    toast('Sincronizando catálogo con la BD…', 'info', 2000);
    const res = await syncCatalogWithDb();
    toast(
      `Catálogo sincronizado (${res.totalLocalProducts} productos · ${res.transport === 'remote' ? 'Firebase' : 'Sala local'})`,
      'ok',
      3500,
    );
    if (onCompleted) onCompleted();
  } catch (err) {
    const msg = (err as Error).message || 'No se pudo sincronizar con la BD';
    if (/Código de Sala/i.test(msg)) {
      toast('Configura primero un Código de Sala en Ajustes para sincronizar con la BD.', 'warn', 4000);
    } else {
      toast(msg, 'error', 4000);
    }
  }
}

export async function importCatalogFlow(onCompleted?: () => void): Promise<void> {
  if (isMobileCatalogReadOnly()) {
    toast('La importación o edición del catálogo está restringida a PC. Usa "Sincronizar con BD" en móvil.', 'warn', 4000);
    return;
  }
  const [file] = await pickFiles('.xlsx,.xls,.csv,.txt,.json,application/json');
  if (!file) return;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (/\.json$/i.test(file.name)) {
      const f = parseAppFile(new TextDecoder().decode(buf));
      if (f.kind !== 'catalogo') {
        toast('Ese es un archivo de conteo; impórtalo en la pestaña Supervisor.', 'warn', 4000);
        return;
      }
      const replace = await confirmDialog('Importar catálogo',
        `El archivo trae ${f.products.length} productos. ¿Reemplazar el catálogo actual? (Cancelar = combinar y conciliar)`, 'Reemplazar');
      const now = Date.now();
      const stampedProducts = f.products.map((p) => ({ ...p, updatedAt: now }));
      let n = 0;
      if (replace) {
        const keep = (await allProducts()).filter((p) => p.uncataloged);
        n = await importCatalogFile({ ...f, products: stampedProducts }, 'replace');
        if (keep.length) await bulkPutProducts(keep, 'merge');
        await reconcileCatalogProducts(stampedProducts);
      } else {
        const rec = await reconcileCatalogProducts(stampedProducts);
        n = rec.added + rec.updated;
      }
      triggerBackgroundSync();
      toast(`${n || stampedProducts.length} productos importados y conciliados`, 'ok');
      if (onCompleted) onCompleted();
      else navigate('/catalogo');
      return;
    }
    const wb = readWorkbook(buf, file.name);
    mappingDialog(wb, file.name, onCompleted);
  } catch (e) {
    console.error(e);
    toast('No se pudo leer el archivo: ' + (e as Error).message, 'error', 5000);
  }
}

function mappingDialog(wb: Workbook, fileName: string, onCompleted?: () => void) {
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
        h('option', { value: '-1', selected: (mapping[f] ?? -1) < 0 }, '— No usar —'),
        headers.map((t, i) => h('option', { value: String(i), selected: (mapping[f] ?? -1) === i }, t))));
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
        h('label', null, h('input', { type: 'radio', name: 'mode', checked: mode === 'merge', onchange: () => (mode = 'merge') }), ' Combinar / conciliar'),
      ),
      h('p', { class: 'muted small' }, 'Concilia automáticamente los productos escaneados previamente por código de barras o SKU.'),
    );
  };
  render();

  openDialog('Importar catálogo', body, [
    { label: 'Cancelar' },
    {
      label: 'Importar y Conciliar', kind: 'primary',
      onClick: async () => {
        try {
          const r = rowsToProducts(rows, headerRow, mapping);
          if (!r.products.length) { toast('No hay productos para importar', 'warn'); return true; }
          const now = Date.now();
          const stampedProducts = r.products.map((p) => ({ ...p, updatedAt: now }));
          if (mode === 'replace') {
            const keep = (await allProducts()).filter((p) => p.uncataloged);
            await bulkPutProducts(stampedProducts, 'replace');
            if (keep.length) await bulkPutProducts(keep, 'merge');
            await reconcileCatalogProducts(stampedProducts);
          } else {
            await reconcileCatalogProducts(stampedProducts);
          }
          triggerBackgroundSync();
          toast(`${stampedProducts.length} productos importados y conciliados`, 'ok');
          void processPending();
          if (onCompleted) onCompleted();
          else navigate('/catalogo');
        } catch (e) {
          toast((e as Error).message, 'error', 5000);
          return true;
        }
      },
    },
  ]);
}

export function openMassModifyDialog(barcodes: string[], onDone: () => void): void {
  if (isMobileCatalogReadOnly()) {
    toast('El catálogo es de solo lectura en la versión móvil. Usa una PC para modificar productos.', 'warn');
    return;
  }
  if (!barcodes.length) {
    toast('No hay productos para modificar', 'warn');
    return;
  }
  const chkUnit = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const inputUnit = h('input', { class: 'input sm', type: 'text', placeholder: 'PZA, CJA, ROLLO, LT, M...', disabled: true }) as HTMLInputElement;
  chkUnit.onchange = () => (inputUnit.disabled = !chkUnit.checked);

  const chkBrand = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const inputBrand = h('input', { class: 'input sm', type: 'text', placeholder: 'Ej. 3M, Mohawk, Ansell, Truper...', disabled: true }) as HTMLInputElement;
  chkBrand.onchange = () => (inputBrand.disabled = !chkBrand.checked);

  const chkExpected = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const expValRadio = h('input', { type: 'radio', name: 'expMode', checked: true, disabled: true }) as HTMLInputElement;
  const expZeroRadio = h('input', { type: 'radio', name: 'expMode', disabled: true }) as HTMLInputElement;
  const expClearRadio = h('input', { type: 'radio', name: 'expMode', disabled: true }) as HTMLInputElement;
  const inputExpected = h('input', { class: 'input sm qty', type: 'text', inputmode: 'decimal', placeholder: '0', disabled: true }) as HTMLInputElement;

  chkExpected.onchange = () => {
    const dis = !chkExpected.checked;
    expValRadio.disabled = dis;
    expZeroRadio.disabled = dis;
    expClearRadio.disabled = dis;
    inputExpected.disabled = dis || !expValRadio.checked;
  };
  expValRadio.onchange = () => (inputExpected.disabled = !chkExpected.checked || !expValRadio.checked);
  expZeroRadio.onchange = () => (inputExpected.disabled = true);
  expClearRadio.onchange = () => (inputExpected.disabled = true);

  const chkCost = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const costValRadio = h('input', { type: 'radio', name: 'costMode', checked: true, disabled: true }) as HTMLInputElement;
  const costClearRadio = h('input', { type: 'radio', name: 'costMode', disabled: true }) as HTMLInputElement;
  const inputCost = h('input', { class: 'input sm', type: 'text', inputmode: 'decimal', placeholder: '0.00', disabled: true }) as HTMLInputElement;

  chkCost.onchange = () => {
    const dis = !chkCost.checked;
    costValRadio.disabled = dis;
    costClearRadio.disabled = dis;
    inputCost.disabled = dis || !costValRadio.checked;
  };
  costValRadio.onchange = () => (inputCost.disabled = !chkCost.checked || !costValRadio.checked);
  costClearRadio.onchange = () => (inputCost.disabled = true);

  const chkUncat = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const selUncat = h('select', { class: 'input sm', disabled: true },
    h('option', { value: 'cataloged' }, 'Marcar como "Catalogado" (oficial)'),
    h('option', { value: 'uncataloged' }, 'Marcar como "No catalogado"'),
  ) as HTMLSelectElement;
  chkUncat.onchange = () => (selUncat.disabled = !chkUncat.checked);

  const chkAffix = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const inputPrefix = h('input', { class: 'input sm', type: 'text', placeholder: 'Prefijo (ej. [MHK])', disabled: true }) as HTMLInputElement;
  const inputSuffix = h('input', { class: 'input sm', type: 'text', placeholder: 'Sufijo (ej. - Planta 2)', disabled: true }) as HTMLInputElement;
  chkAffix.onchange = () => {
    inputPrefix.disabled = !chkAffix.checked;
    inputSuffix.disabled = !chkAffix.checked;
  };

  const body = h('div', { class: 'form mass-form' },
    h('p', { class: 'muted small' }, `Se actualizarán ${barcodes.length} producto(s). Activa las casillas de los campos que deseas cambiar:`),
    h('div', { class: 'mass-field-block' },
      h('label', { class: 'check-inline bold' }, chkUnit, h('span', null, 'Unidad de medida')),
      inputUnit,
    ),
    h('div', { class: 'mass-field-block' },
      h('label', { class: 'check-inline bold' }, chkBrand, h('span', null, 'Marca / Fabricante')),
      inputBrand,
    ),
    h('div', { class: 'mass-field-block' },
      h('label', { class: 'check-inline bold' }, chkExpected, h('span', null, 'Existencia teórica')),
      h('div', { class: 'row' }, h('label', { class: 'radio-inline' }, expValRadio, 'Asignar cantidad:'), inputExpected),
      h('label', { class: 'radio-inline' }, expZeroRadio, 'Poner en 0 (cero)'),
      h('label', { class: 'radio-inline' }, expClearRadio, 'Quitar existencia teórica (conteo libre)'),
    ),
    h('div', { class: 'mass-field-block' },
      h('label', { class: 'check-inline bold' }, chkCost, h('span', null, 'Costo unitario')),
      h('div', { class: 'row' }, h('label', { class: 'radio-inline' }, costValRadio, 'Asignar costo:'), inputCost),
      h('label', { class: 'radio-inline' }, costClearRadio, 'Quitar costo unitario'),
    ),
    h('div', { class: 'mass-field-block' },
      h('label', { class: 'check-inline bold' }, chkUncat, h('span', null, 'Estado de catalogación')),
      selUncat,
    ),
    h('div', { class: 'mass-field-block' },
      h('label', { class: 'check-inline bold' }, chkAffix, h('span', null, 'Agregar texto a descripciones')),
      h('div', { class: 'grid2' }, inputPrefix, inputSuffix),
    ),
  );

  openDialog(`Modificación masiva (${barcodes.length})`, body, [
    { label: 'Cancelar' },
    {
      label: 'Aplicar cambios', kind: 'primary',
      onClick: async () => {
        if (!chkUnit.checked && !chkBrand.checked && !chkExpected.checked && !chkCost.checked && !chkUncat.checked && !chkAffix.checked) {
          toast('Selecciona al menos un campo para modificar', 'warn');
          return true;
        }
        const patch: MassProductPatch = {};
        if (chkUnit.checked) patch.unit = inputUnit.value.trim();
        if (chkBrand.checked) patch.brand = inputBrand.value.trim();
        if (chkExpected.checked) {
          if (expZeroRadio.checked) patch.expectedQty = 0;
          else if (expClearRadio.checked) patch.expectedQty = null;
          else {
            const n = parseNumber(inputExpected.value);
            if (n === undefined || n < 0) { toast('Existencia teórica inválida', 'error'); return true; }
            patch.expectedQty = n;
          }
        }
        if (chkCost.checked) {
          if (costClearRadio.checked) patch.unitCost = null;
          else {
            const c = parseNumber(inputCost.value);
            if (c === undefined || c < 0) { toast('Costo unitario inválido', 'error'); return true; }
            patch.unitCost = c;
          }
        }
        if (chkUncat.checked) {
          patch.uncataloged = selUncat.value === 'uncataloged';
        }
        if (chkAffix.checked) {
          if (inputPrefix.value.trim()) patch.descriptionPrefix = inputPrefix.value.trim();
          if (inputSuffix.value.trim()) patch.descriptionSuffix = inputSuffix.value.trim();
        }

        const count = await bulkModifyProducts(barcodes, patch);
        triggerBackgroundSync();
        toast(`✓ ${count} producto(s) actualizados con éxito`, 'ok');
        onDone();
      },
    },
  ]);
}

export function openMassDeleteDialog(
  visibleItems: Product[],
  selectedBarcodes: string[],
  all: Product[],
  onDone: () => void,
): void {
  if (isMobileCatalogReadOnly()) {
    toast('El catálogo es de solo lectura en la versión móvil. Usa una PC para eliminar productos.', 'warn');
    return;
  }
  const uncataloged = all.filter((p) => p.uncataloged);
  const noDesc = all.filter((p) => !p.description);

  let dlg: { close(): void };

  const actions = h('div', { class: 'mass-delete-actions' },
    selectedBarcodes.length > 0
      ? h('div', { class: 'mass-del-card' },
        h('div', null,
          h('b', null, `Eliminar los ${selectedBarcodes.length} seleccionados`),
          h('div', { class: 'muted small' }, 'Borra únicamente los productos marcados con casilla.'),
        ),
        h('button', {
          class: 'btn danger sm',
          onclick: async () => {
            dlg.close();
            if (await confirmDialog('Eliminar seleccionados', `¿Eliminar los ${selectedBarcodes.length} productos seleccionados del catálogo?`, 'Eliminar', true)) {
              const n = await deleteProducts(selectedBarcodes);
              triggerBackgroundSync();
              toast(`${n} productos eliminados del catálogo`, 'ok');
              onDone();
            }
          },
        }, icon('trash'), `Eliminar (${selectedBarcodes.length})`),
      )
      : null,

    visibleItems.length > 0 && visibleItems.length < all.length
      ? h('div', { class: 'mass-del-card' },
        h('div', null,
          h('b', null, `Eliminar los ${visibleItems.length} filtrados`),
          h('div', { class: 'muted small' }, 'Borra todos los productos del filtro o búsqueda actual.'),
        ),
        h('button', {
          class: 'btn danger sm',
          onclick: async () => {
            dlg.close();
            if (await confirmDialog('Eliminar filtrados', `¿Eliminar los ${visibleItems.length} productos filtrados?`, 'Eliminar', true)) {
              const n = await deleteProducts(visibleItems.map((p) => p.barcode));
              triggerBackgroundSync();
              toast(`${n} productos eliminados del catálogo`, 'ok');
              onDone();
            }
          },
        }, icon('trash'), `Eliminar (${visibleItems.length})`),
      )
      : null,

    uncataloged.length > 0
      ? h('div', { class: 'mass-del-card' },
        h('div', null,
          h('b', null, `Eliminar No Catalogados (${uncataloged.length})`),
          h('div', { class: 'muted small' }, 'Limpia códigos escaneados que no estaban en el catálogo oficial.'),
        ),
        h('button', {
          class: 'btn danger ghost sm',
          onclick: async () => {
            dlg.close();
            if (await confirmDialog('Eliminar no catalogados', `¿Eliminar los ${uncataloged.length} productos no catalogados?`, 'Eliminar', true)) {
              const n = await deleteProducts(uncataloged.map((p) => p.barcode));
              triggerBackgroundSync();
              toast(`${n} productos no catalogados eliminados`, 'ok');
              onDone();
            }
          },
        }, icon('trash'), 'Eliminar'),
      )
      : null,

    noDesc.length > 0
      ? h('div', { class: 'mass-del-card' },
        h('div', null,
          h('b', null, `Eliminar sin descripción (${noDesc.length})`),
          h('div', { class: 'muted small' }, 'Borra artículos incompletos sin nombre ni descripción.'),
        ),
        h('button', {
          class: 'btn danger ghost sm',
          onclick: async () => {
            dlg.close();
            if (await confirmDialog('Eliminar sin descripción', `¿Eliminar los ${noDesc.length} productos sin descripción?`, 'Eliminar', true)) {
              const n = await deleteProducts(noDesc.map((p) => p.barcode));
              triggerBackgroundSync();
              toast(`${n} productos sin descripción eliminados`, 'ok');
              onDone();
            }
          },
        }, icon('trash'), 'Eliminar'),
      )
      : null,

    all.length > 0
      ? h('div', { class: 'mass-del-card danger-zone' },
        h('div', null,
          h('b', { class: 'danger-text' }, `Vaciar todo el catálogo (${all.length} productos)`),
          h('div', { class: 'muted small' }, 'Elimina permanentemente todos los productos. Los conteos y sesiones realizadas NO se pierden.'),
        ),
        h('button', {
          class: 'btn danger sm',
          onclick: async () => {
            dlg.close();
            if (await confirmDialog('Vaciar catálogo completo', `⚠️ ¿Estás seguro de eliminar TODOS los ${all.length} productos del catálogo?`, 'Vaciar catálogo', true)) {
              await clearProducts();
              triggerBackgroundSync();
              toast('Catálogo vaciado completamente', 'ok');
              onDone();
            }
          },
        }, icon('trash'), 'Vaciar todo'),
      )
      : null,
  );

  dlg = openDialog('Eliminación masiva del catálogo', actions, [{ label: 'Cerrar' }]);
}

export function openMassActionsDialog(
  visibleItems: Product[],
  selectedBarcodes: string[],
  all: Product[],
  onDone: () => void,
): void {
  const readOnly = isMobileCatalogReadOnly();
  let dlg: { close(): void };

  const content = h('div', { class: 'mass-actions-modal' },
    readOnly
      ? h(
          'div',
          { class: 'catalog-readonly-banner' },
          '🔒 Modo solo lectura en móvil: las modificaciones y eliminaciones masivas solo están disponibles en PC.',
        )
      : h('div', { class: 'mass-action-section' },
          h('h4', null, '✏️ Modificación masiva'),
          h('p', { class: 'muted small' }, 'Actualiza unidades, marcas, existencias teóricas o costos en lote.'),
          h('div', { class: 'row wrap' },
            selectedBarcodes.length > 0
              ? h('button', {
                class: 'btn primary sm',
                onclick: () => { dlg.close(); openMassModifyDialog(selectedBarcodes, onDone); },
              }, icon('edit'), `Modificar los ${selectedBarcodes.length} seleccionados`)
              : null,
            visibleItems.length > 0
              ? h('button', {
                class: 'btn sm',
                onclick: () => { dlg.close(); openMassModifyDialog(visibleItems.map((p) => p.barcode), onDone); },
              }, icon('edit'), `Modificar los ${visibleItems.length} visibles`)
              : null,
          ),
        ),

    readOnly
      ? null
      : h('div', { class: 'mass-action-section' },
          h('h4', null, '🗑️ Eliminación masiva'),
          h('p', { class: 'muted small' }, 'Elimina productos seleccionados, por filtro o vacía el catálogo completo.'),
          h('button', {
            class: 'btn danger ghost sm',
            onclick: () => { dlg.close(); openMassDeleteDialog(visibleItems, selectedBarcodes, all, onDone); },
          }, icon('trash'), 'Opciones de eliminación masiva'),
        ),

    h('div', { class: 'mass-action-section' },
      h('h4', null, '🏷️ Etiquetas y códigos de barras'),
      h('p', { class: 'muted small' }, 'Genera e imprime etiquetas con códigos de barras uniformes en hojas Avery o rollo continuo.'),
      h('div', { class: 'row wrap' },
        selectedBarcodes.length > 0
          ? [
            h('button', {
              class: 'btn primary sm',
              onclick: () => {
                dlg.close();
                const sel = all.filter((p) => selectedBarcodes.includes(p.barcode));
                openBarcodeSheetDialog(sel);
              },
            }, icon('scan'), `Etiquetas de los ${selectedBarcodes.length} seleccionados`),
            h('button', {
              class: 'btn sm ghost',
              onclick: () => {
                dlg.close();
                const sel = all.filter((p) => selectedBarcodes.includes(p.barcode));
                for (const p of sel) addToPrintQueue(p, 1);
                toast(`${sel.length} producto(s) añadidos a la cola`, 'ok');
              },
            }, icon('plus'), `Añadir los ${selectedBarcodes.length} a la cola`),
          ]
          : null,
        visibleItems.length > 0
          ? h('button', {
            class: 'btn sm',
            onclick: () => {
              dlg.close();
              openBarcodeSheetDialog(visibleItems);
            },
          }, icon('scan'), `Etiquetas de los ${visibleItems.length} visibles`)
          : null,
        h('button', {
          class: 'btn sm',
          onclick: () => {
            dlg.close();
            openBarcodeSheetDialog(all);
          },
        }, icon('scan'), `Etiquetas de todo el catálogo (${all.length})`),
        h('button', {
          class: 'btn sm',
          onclick: () => {
            dlg.close();
            openBarcodeSheetDialog();
          },
        }, icon('scan'), '🖨️ Abrir cola de impresión'),
      ),
    ),

    h('div', { class: 'mass-action-section' },
      h('h4', null, readOnly ? '📊 Exportación Excel' : '📊 Edición masiva con Excel / CSV'),
      h(
        'p',
        { class: 'muted small' },
        readOnly
          ? 'Descarga una copia del catálogo en formato Excel para consultarlo.'
          : 'Descarga el catálogo a Excel, edita existencias o descripciones en tu computadora y vuelve a subirlo:',
      ),
      h('div', { class: 'row wrap' },
        h('button', {
          class: 'btn sm',
          onclick: () => downloadFile(buildCatalogWorkbook(all), 'catalogo_consumibles.xlsx', MIME.xlsx),
        }, icon('download'), readOnly ? 'Descargar catálogo Excel' : '1. Descargar catálogo Excel'),
        readOnly
          ? null
          : h('button', {
              class: 'btn primary sm',
              onclick: () => { dlg.close(); void importCatalogFlow(); },
            }, icon('upload'), '2. Subir Excel modificado'),
      ),
      readOnly
        ? null
        : h('p', { class: 'muted small' }, 'Tip: Al subirlo, elige "Combinar / actualizar" para preservar los productos existentes.'),
    ),
  );

  dlg = openDialog('Acciones masivas del catálogo', content, [{ label: 'Cerrar' }]);
}

export const catalogView: View = {
  title: 'Catálogo',
  async render(root, params = new URLSearchParams()) {
    const readOnlyMobile = isMobileCatalogReadOnly();
    let products = await allProducts();
    const selected = new Set<string>();
    const list = h('ul', { class: 'plist' });
    const countEl = h('span', { class: 'muted small' });
    const queueBadgeEl = h('span', { class: 'badge info queue-count-badge', hidden: true });
    const updateQueueBadge = () => {
      const total = getPrintQueueTotalCount();
      queueBadgeEl.hidden = total <= 0;
      queueBadgeEl.textContent = String(total);
    };
    const massBar = h('div', { class: 'mass-bar', hidden: true });
    const selectAllCheck = h('input', { type: 'checkbox', class: 'item-check' }) as HTMLInputElement;
    const selectAllLabel = h('span', null, 'Seleccionar visibles');
    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const visibleProducts = () => {
      const words = norm(query).split(/\s+/).filter(Boolean);
      return products
        .filter((p) => filter === 'todos' || (filter === 'sin_desc' ? !p.description : p.uncataloged))
        .filter((p) => {
          if (!words.length) return true;
          const hay = norm(`${p.description} ${p.sku} ${displayBarcode(p.barcode)} ${p.brand ?? ''}`);
          return words.every((w) => hay.includes(w));
        });
    };

    const refreshData = async (clearSelection = true) => {
      if (clearSelection) selected.clear();
      products = await allProducts();
      draw();
    };

    const draw = () => {
      updateQueueBadge();
      const items = visibleProducts()
        .sort((a, b) => (a.description || '~').localeCompare(b.description || '~'));

      const selCount = selected.size;
      countEl.textContent = selCount > 0
        ? `${items.length} de ${products.length} · ${selCount} seleccionado(s)`
        : `${items.length} de ${products.length}`;

      const allSelected = items.length > 0 && items.every((p) => selected.has(p.barcode));
      selectAllCheck.checked = allSelected;
      selectAllCheck.indeterminate = !allSelected && items.some((p) => selected.has(p.barcode));
      selectAllCheck.disabled = items.length === 0;
      selectAllLabel.textContent = `Seleccionar visibles (${items.length})`;

      selectAllCheck.onchange = () => {
        if (selectAllCheck.checked) {
          for (const it of items) selected.add(it.barcode);
        } else {
          for (const it of items) selected.delete(it.barcode);
        }
        draw();
      };

      if (selCount > 0) {
        massBar.hidden = false;
        massBar.setAttribute('data-testid', 'catalog-mass-bar');
        clear(massBar,
          h('div', { class: 'mass-info' }, icon('check'), `${selCount} seleccionado(s)`),
          h('div', { class: 'row wrap' },
            h('button', {
              class: 'btn sm',
              'data-testid': 'catalog-mass-labels-btn',
              onclick: () => {
                const sel = products.filter((p) => selected.has(p.barcode));
                openBarcodeSheetDialog(sel);
              },
            }, icon('scan'), 'Etiquetas'),
            h('button', {
              class: 'btn sm ghost',
              'data-testid': 'catalog-mass-queue-btn',
              title: 'Añadir productos seleccionados a la cola de impresión de etiquetas',
              onclick: () => {
                const sel = products.filter((p) => selected.has(p.barcode));
                for (const p of sel) addToPrintQueue(p, 1);
                const total = getPrintQueueTotalCount();
                updateQueueBadge();
                toast(`${sel.length} producto(s) añadidos a la cola (${total} etiquetas totales)`, 'ok');
              },
            }, icon('plus'), 'Añadir a cola'),
            readOnlyMobile
              ? null
              : h('button', {
                  class: 'btn primary sm',
                  'data-testid': 'catalog-mass-edit-btn',
                  onclick: () => openMassModifyDialog(Array.from(selected), refreshData),
                }, icon('edit'), 'Modificar'),
            readOnlyMobile
              ? null
              : h('button', {
                  class: 'btn danger sm',
                  'data-testid': 'catalog-mass-delete-btn',
                  onclick: async () => {
                    if (await confirmDialog('Eliminar seleccionados', `¿Eliminar los ${selCount} productos seleccionados del catálogo?`, 'Eliminar', true)) {
                      const n = await deleteProducts(Array.from(selected));
                      triggerBackgroundSync();
                      toast(`${n} productos eliminados`, 'ok');
                      selected.clear();
                      await refreshData();
                    }
                  },
                }, icon('trash'), 'Eliminar'),
            h('button', { class: 'btn ghost sm', onclick: () => { selected.clear(); draw(); } }, '✕'),
          ),
        );
      } else {
        massBar.hidden = true;
      }

      clear(list,
        items.length === 0 ? h('li', { class: 'empty' }, products.length ? 'Sin coincidencias' : 'Catálogo vacío') : null,
        items.slice(0, 250).map((p) => {
          const isSel = selected.has(p.barcode);
          const chk = h('input', {
            type: 'checkbox',
            class: 'item-check',
            checked: isSel,
            onclick: (e: Event) => {
              e.stopPropagation();
              if (selected.has(p.barcode)) selected.delete(p.barcode);
              else selected.add(p.barcode);
              draw();
            },
          }) as HTMLInputElement;

          return h('li', {
            class: isSel ? 'selected' : '',
            onclick: async () => {
              const res = await editProductDialog(p.barcode, p);
              if (res === 'deleted') {
                selected.delete(p.barcode);
                await refreshData();
              } else if (res) {
                Object.assign(p, res);
                draw();
              }
            },
          },
          chk,
          h('div', { class: 'grow' },
            h('div', { class: 'rec-desc' }, p.description || h('i', { class: 'muted' }, 'Sin descripción')),
            h('div', { class: 'rec-meta' },
              p.barcode.startsWith('SKU:') ? '' : h('code', null, displayBarcode(p.barcode)),
              p.sku ? ` · ${p.sku}` : '', p.unit ? ` · ${p.unit}` : '', p.brand ? ` · ${p.brand}` : ''),
            h('div', { class: 'pc-badges' },
              sourceBadge(p),
              p.uncataloged ? h('span', { class: 'badge warn' }, 'No catalogado') : null,
              p.minQty !== undefined
                ? h(
                    'span',
                    { class: 'badge info', title: 'Punto de reorden / Stock mínimo y máximo' },
                    `Min: ${fmtNum(p.minQty)}${p.maxQty !== undefined ? ` · Máx: ${fmtNum(p.maxQty)}` : ''}`,
                  )
                : null,
            ),
          ),
          p.expectedQty !== undefined ? h('div', { class: 'rec-qty small' }, fmtNum(p.expectedQty)) : null,
          );
        }),
        items.length > 250 ? h('li', { class: 'empty' }, `Mostrando 250 de ${items.length}. Usa la búsqueda para filtrar.`) : null,
      );
    };

    const chip = (id: typeof filter, label: string) =>
      h('button', { class: `chip ${filter === id ? 'active' : ''}`, onclick: () => { filter = id; navigate('/catalogo'); } }, label);
    const noDesc = products.filter((p) => !p.description).length;

    const selectToolbar = h('div', { class: 'select-toolbar' },
      h('label', { class: 'check-inline' }, selectAllCheck, selectAllLabel),
      h('button', {
        class: 'btn sm',
        onclick: () => {
          openMassActionsDialog(visibleProducts(), Array.from(selected), products, refreshData);
        },
      }, icon('edit'), '⚡ Acciones masivas'),
    );

    clear(root,
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'Catálogo'), countEl),
        h(
          'p',
          { class: 'muted small' },
          readOnlyMobile
            ? 'Consulta existencias, sincroniza con la BD o imprime etiquetas. Para editar productos usa una PC.'
            : 'Consulta consumibles, importa hojas Excel/CSV, imprime etiquetas de código de barras o aplica modificaciones en lote.',
        ),
        readOnlyMobile
          ? h(
              'div',
              { class: 'catalog-readonly-banner', 'data-testid': 'catalog-mobile-readonly-badge' },
              '🔒 Catálogo en solo lectura (móvil): la creación, importación y edición están bloqueadas en móvil para proteger la BD.',
            )
          : null,
        h('div', { class: 'catalog-toolbar-group' },
          h('div', { class: 'catalog-toolbar-row' },
            h('span', { class: 'catalog-group-label muted xsmall uppercase' }, readOnlyMobile ? 'Sincronización con BD' : 'Gestión y BD'),
            h('div', { class: 'row wrap' },
              readOnlyMobile
                ? null
                : h('button', {
                    class: 'btn primary',
                    'data-testid': 'catalog-new-btn',
                    onclick: async () => {
                      const res = await editProductDialog('');
                      if (res && res !== 'deleted') {
                        await refreshData();
                      }
                    },
                  }, icon('scan'), 'Nuevo producto'),
              readOnlyMobile
                ? null
                : h('button', {
                    class: 'btn',
                    type: 'button',
                    'data-testid': 'catalog-import-btn',
                    onclick: () => void importCatalogFlow(() => { void refreshData(); }),
                  }, icon('upload'), 'Importar Excel / CSV'),
              h('button', {
                class: readOnlyMobile ? 'btn primary' : 'btn',
                type: 'button',
                'data-testid': 'catalog-sync-db-btn',
                onclick: () => void syncCatalogWithDbFlow(() => { void refreshData(); }),
              }, icon('refresh'), 'Sincronizar con BD'),
              readOnlyMobile
                ? null
                : h('button', {
                    class: 'btn',
                    onclick: () => {
                      openMassActionsDialog(visibleProducts(), Array.from(selected), products, refreshData);
                    },
                  }, icon('edit'), 'Acciones masivas'),
              !readOnlyMobile && noDesc > 0
                ? h('button', {
                    class: 'btn sm',
                    onclick: async () => {
                      toast('Buscando descripciones…');
                      const n = await processPending();
                      toast(`${n} descripción(es) encontradas`, n ? 'ok' : 'warn');
                      await refreshData();
                    },
                  }, icon('globe'), `Buscar en internet ${noDesc} sin descripción`)
                : null,
            ),
          ),
          h('div', { class: 'catalog-toolbar-row' },
            h('span', { class: 'catalog-group-label muted xsmall uppercase' }, 'Etiquetas y Ajustes'),
            h('div', { class: 'row wrap' },
              h('button', {
                class: 'btn',
                disabled: !products.length,
                'data-testid': 'catalog-sheets-btn',
                onclick: () => {
                  const visible = visibleProducts();
                  openBarcodeSheetDialog(visible.length ? visible : products);
                },
              }, icon('scan'), 'Rótulos y hojas'),
              h('button', {
                class: 'btn',
                'data-testid': 'catalog-queue-btn',
                title: 'Ver y gestionar la cola de impresión para imprimir distintos productos en la misma hoja',
                onclick: () => openBarcodeSheetDialog(),
              }, icon('scan'), 'Cola de rótulos', queueBadgeEl),
              h('button', {
                class: 'btn ghost sm',
                'data-testid': 'catalog-settings-link',
                onclick: () => navigate('/ajustes'),
              }, icon('gear'), readOnlyMobile ? 'Ajustes / Sala en la nube' : 'Importar / Compartir en Ajustes'),
            ),
          ),
        ),
      ),
      h('input', {
        class: 'input', type: 'search', 'data-testid': 'catalog-search', placeholder: 'Buscar por descripción, código o No. de parte', value: query,
        oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; draw(); },
      }),
      h('div', { class: 'chips' }, chip('todos', 'Todos'), chip('sin_desc', `Sin descripción (${noDesc})`), chip('no_cat', 'No catalogados')),
      selectToolbar,
      massBar,
      h('div', { class: 'plist-table-head', 'aria-hidden': 'true' },
        h('span', null),
        h('span', null, 'Producto / Código / SKU'),
        h('span', null, 'Teórico'),
      ),
      list,
    );
    draw();

    if (unsubscribeCatalogCloud) unsubscribeCatalogCloud();
    unsubscribeCatalogCloud = onCloudRoomUpdate(() => {
      if (root.isConnected) {
        void refreshData(false);
      }
    });

    if (unsubscribeCatalogResize) {
      unsubscribeCatalogResize();
      unsubscribeCatalogResize = null;
    }
    if (typeof window !== 'undefined') {
      let lastMobile = readOnlyMobile;
      const onResize = () => {
        if (!root.isConnected) return;
        const nextMobile = isMobileCatalogReadOnly();
        if (nextMobile !== lastMobile) {
          lastMobile = nextMobile;
          void catalogView.render(root, params);
        }
      };
      window.addEventListener('resize', onResize);
      unsubscribeCatalogResize = () => window.removeEventListener('resize', onResize);
    }
  },
  destroy() {
    if (unsubscribeCatalogCloud) {
      unsubscribeCatalogCloud();
      unsubscribeCatalogCloud = null;
    }
    if (unsubscribeCatalogResize) {
      unsubscribeCatalogResize();
      unsubscribeCatalogResize = null;
    }
  },
};
