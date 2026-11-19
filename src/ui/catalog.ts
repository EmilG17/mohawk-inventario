import { L } from '../i18n/i18n';
import {
  allProducts, bulkModifyProducts, bulkPutProducts, clearProducts, deleteProducts,
  type MassProductPatch, type Product,
} from '../db/db';
import { getIdealLevels, setIdealLevels } from '../db/movements';
import { buildCatalogFile, buildCatalogWorkbook } from '../io/exportResults';
import {
  detectHeaderRow, FIELD_LABELS, guessMapping, readWorkbook, rowsToProducts, type Field, type Mapping, type Workbook,
} from '../io/importCatalog';
import { importCatalogFile, parseAppFile, reconcileCatalogProducts } from '../io/mergeCounts';
import { displayBarcode, parseNumber } from '../io/normalize';
import { processPending } from '../lookup/pendingQueue';
import { loadSettings } from '../settings';
import { onCloudRoomUpdate, syncCatalogWithDb, triggerBackgroundSync } from '../sync/cloudSync';
import { computeRoomDataSig } from './cloudSignal';
import {
  clear, confirmDialog, downloadFile, fmtNum, h, icon, MIME, openDialog, pickFiles, shareOrDownload, toast,
} from './dom';
import { isMobileCatalogReadOnly } from './catalogMode';
import { editProductDialog, sourceBadge } from './productDialog';
import { openBarcodeSheetDialog } from './barcodeSheet';
import { addToPrintQueue, getPrintQueueTotalCount, subscribePrintQueue } from '../barcode/printQueue';
import type { View } from './router';
import { navigate } from './router';

let filter: 'todos' | 'sin_desc' | 'no_cat' = 'todos';
let query = '';
let unsubscribeCatalogCloud: (() => void) | null = null;
let unsubscribeCatalogQueue: (() => void) | null = null;
let unsubscribeCatalogResize: (() => void) | null = null;
let catalogMounted = false;
let catalogRenderSeq = 0;
let catalogCloudTimer: ReturnType<typeof setTimeout> | null = null;
let lastCatalogDataFp = '';

export async function syncCatalogWithDbFlow(onCompleted?: () => void): Promise<void> {
  try {
    toast(L('Sincronizando catálogo con la BD…', 'Syncing catalog with DB…'), 'info', 2000);
    const res = await syncCatalogWithDb();
    toast(
      L(
        `Catálogo sincronizado (${res.totalLocalProducts} productos · ${res.transport === 'remote' ? 'Firebase' : 'Sala local'})`,
        `Catalog synced (${res.totalLocalProducts} products · ${res.transport === 'remote' ? 'Firebase' : 'Local room'})`,
      ),
      'ok',
      3500,
    );
    if (onCompleted) onCompleted();
  } catch (err) {
    const msg = (err as Error).message || L('No se pudo sincronizar con la BD', 'Could not sync with DB');
    if (/Código de Sala/i.test(msg)) {
      toast(L('Configura primero un Código de Sala en Ajustes para sincronizar con la BD.', 'Configure a Room Code in Settings first to sync with DB.'), 'warn', 4000);
    } else {
      toast(msg, 'error', 4000);
    }
  }
}

export async function importCatalogFlow(onCompleted?: () => void): Promise<void> {
  if (isMobileCatalogReadOnly()) {
    toast(L('La importación o edición del catálogo está restringida a PC. Usa "Sincronizar con BD" en móvil.', 'Catalog import or editing is restricted to desktop. Use "Sync with DB" on mobile.'), 'warn', 4000);
    return;
  }
  const [file] = await pickFiles('.xlsx,.xls,.csv,.txt,.json,application/json');
  if (!file) return;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (/\.json$/i.test(file.name)) {
      const f = parseAppFile(new TextDecoder().decode(buf));
      if (f.kind !== 'catalogo') {
        toast(L('Ese es un archivo de conteo; impórtalo en la pestaña Supervisor.', 'That is a count file; import it in the Supervisor tab.'), 'warn', 4000);
        return;
      }
      const replace = await confirmDialog(
        L('Importar catálogo', 'Import catalog'),
        L(
          `El archivo trae ${f.products.length} productos. ¿Reemplazar el catálogo actual? (Cancelar = combinar y conciliar)`,
          `File contains ${f.products.length} products. Replace current catalog? (Cancel = merge and reconcile)`,
        ),
        L('Reemplazar', 'Replace'),
      );
      const now = Date.now();
      const stampedProducts = f.products.map((p) => ({ ...p, updatedAt: now }));
      let n = 0;
      if (replace) {
        const keep = (await allProducts()).filter((p) => p.uncataloged);
        n = await importCatalogFile({ ...f, products: stampedProducts }, 'replace');
        const stampedSet = new Set(stampedProducts.map((p) => p.barcode));
        const uncollidedKeep = keep.filter((k) => !stampedSet.has(k.barcode));
        if (uncollidedKeep.length) {
          await bulkPutProducts(uncollidedKeep, 'merge');
          await reconcileCatalogProducts(stampedProducts);
        }
      } else {
        const rec = await reconcileCatalogProducts(stampedProducts);
        n = rec.added + rec.updated;
      }
      triggerBackgroundSync();
      toast(L(`${n || stampedProducts.length} productos importados y conciliados`, `${n || stampedProducts.length} products imported and reconciled`), 'ok');
      if (onCompleted) onCompleted();
      else navigate('/catalogo');
      return;
    }
    const wb = readWorkbook(buf, file.name);
    mappingDialog(wb, file.name, onCompleted);
  } catch (e) {
    console.error(e);
    toast(L('No se pudo leer el archivo: ', 'Could not read file: ') + (e as Error).message, 'error', 5000);
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
    const headers = (rows[headerRow] ?? []).map((x, i) => String(x || `${L('Columna', 'Column')} ${i + 1}`));
    const fieldSel = (f: Field) =>
      h('label', { class: 'field' }, h('span', null, FIELD_LABELS[f], f === 'barcode' || f === 'description' ? ' *' : ''),
        h('select', {
          class: 'input',
          onchange: (e: Event) => { mapping[f] = Number((e.target as HTMLSelectElement).value); render(); },
        },
        h('option', { value: '-1', selected: (mapping[f] ?? -1) < 0 }, L('— No usar —', '— Skip —')),
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
        ? h('label', { class: 'field' }, h('span', null, L('Hoja', 'Sheet')),
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
      h('label', { class: 'field' }, h('span', null, L('Fila de encabezados', 'Header row')),
        h('input', {
          class: 'input', type: 'number', min: 1, max: Math.max(1, rows.length), value: String(headerRow + 1),
          onchange: (e: Event) => {
            headerRow = Math.max(0, Math.min(rows.length - 1, Number((e.target as HTMLInputElement).value) - 1));
            mapping = guessMapping(rows[headerRow] ?? []);
            render();
          },
        })),
      h('div', { class: 'grid2' }, (Object.keys(FIELD_LABELS) as Field[]).map(fieldSel)),
      error ? h('p', { class: 'error-text' }, error) : h('p', null, h('b', null, `${preview.length} ${L('productos', 'products')}`), ` ${L('listos para importar', 'ready to import')}`, skipped ? ` · ${skipped} ${L('filas vacías omitidas', 'empty rows skipped')}` : ''),
      preview.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, h('th', null, L('Código', 'Barcode')), h('th', null, L('Descripción', 'Description')), h('th', null, L('Inventario Ideal', 'Ideal Stock')))),
          h('tbody', null, preview.slice(0, 5).map((p) => h('tr', null,
            h('td', null, p.barcode.startsWith('SKU:') ? p.sku : displayBarcode(p.barcode)),
            h('td', null, p.description || '—'),
            h('td', null, fmtNum(p.expectedQty))))),
        ))
        : null,
      warnings.length
        ? h('details', { class: 'warn-box' }, h('summary', null, `${warnings.length} ${L('advertencia(s)', 'warning(s)')}`),
          h('ul', null, warnings.slice(0, 50).map((w) => h('li', { class: 'small' }, w))))
        : null,
      h('div', { class: 'radio-row' },
        h('label', null, h('input', { type: 'radio', name: 'mode', checked: mode === 'replace', onchange: () => (mode = 'replace') }), ` ${L('Reemplazar catálogo', 'Replace catalog')}`),
        h('label', null, h('input', { type: 'radio', name: 'mode', checked: mode === 'merge', onchange: () => (mode = 'merge') }), ` ${L('Combinar / conciliar', 'Merge / reconcile')}`),
      ),
      h('p', { class: 'muted small' }, L('Concilia automáticamente los productos escaneados previamente por código de barras o SKU.', 'Automatically reconciles previously scanned items by barcode or SKU.')),
    );
  };
  render();

  openDialog(L('Importar catálogo', 'Import catalog'), body, [
    { label: L('Cancelar', 'Cancel') },
    {
      label: L('Importar y Conciliar', 'Import & Reconcile'), kind: 'primary',
      onClick: async () => {
        try {
          const r = rowsToProducts(rows, headerRow, mapping);
          if (!r.products.length) { toast(L('No hay productos para importar', 'No products to import'), 'warn'); return true; }
          const now = Date.now();
          const stampedProducts = r.products.map((p) => ({ ...p, updatedAt: now }));
          if (mode === 'replace') {
            const keep = (await allProducts()).filter((p) => p.uncataloged);
            const stampedSet = new Set(stampedProducts.map((p) => p.barcode));
            const uncollidedKeep = keep.filter((k) => !stampedSet.has(k.barcode));
            await bulkPutProducts(stampedProducts, 'replace');
            if (uncollidedKeep.length) {
              await bulkPutProducts(uncollidedKeep, 'merge');
              await reconcileCatalogProducts(stampedProducts);
            }
          } else {
            await reconcileCatalogProducts(stampedProducts);
          }
          triggerBackgroundSync();
          toast(L(`${stampedProducts.length} productos importados y conciliados`, `${stampedProducts.length} products imported and reconciled`), 'ok');
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
      h('label', { class: 'check-inline bold' }, chkExpected, h('span', null, 'Inventario Ideal')),
      h('div', { class: 'row' }, h('label', { class: 'radio-inline' }, expValRadio, 'Asignar cantidad:'), inputExpected),
      h('label', { class: 'radio-inline' }, expZeroRadio, 'Poner en 0 (cero)'),
      h('label', { class: 'radio-inline' }, expClearRadio, 'Quitar inventario ideal (conteo libre)'),
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
            if (n === undefined || n < 0) { toast('Inventario ideal inválido', 'error'); return true; }
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
        if (chkExpected.checked) {
          const updatedProds = await allProducts();
          const selectedSet = new Set(barcodes);
          const idealPatch: Record<string, number> = {};
          const targetVal = patch.expectedQty === null ? -1 : patch.expectedQty;
          if (targetVal !== undefined) {
            for (const prod of updatedProds) {
              if (!selectedSet.has(prod.barcode)) continue;
              const skuKey = (prod.sku || '').trim().toUpperCase();
              const codeKey = (prod.barcode || '').trim().toUpperCase();
              if (skuKey) idealPatch[skuKey] = targetVal;
              else if (codeKey) idealPatch[codeKey] = targetVal;
              if (targetVal < 0 && codeKey) idealPatch[codeKey] = -1;
            }
            if (Object.keys(idealPatch).length > 0) {
              await setIdealLevels(idealPatch);
            }
          }
        }
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
            if (await confirmDialog('Vaciar catálogo completo', `¿Estás seguro de eliminar TODOS los ${all.length} productos del catálogo?`, 'Vaciar catálogo', true)) {
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
          'Modo solo lectura en móvil: las modificaciones y eliminaciones masivas solo están disponibles en PC.',
        )
      : h('div', { class: 'mass-action-section' },
          h('h4', null, 'Modificación masiva'),
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
          h('h4', null, 'Eliminación masiva'),
          h('p', { class: 'muted small' }, 'Elimina productos seleccionados, por filtro o vacía el catálogo completo.'),
          h('button', {
            class: 'btn danger ghost sm',
            onclick: () => { dlg.close(); openMassDeleteDialog(visibleItems, selectedBarcodes, all, onDone); },
          }, icon('trash'), 'Opciones de eliminación masiva'),
        ),

    h('div', { class: 'mass-action-section' },
      h('h4', null, 'Etiquetas y códigos de barras'),
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
        }, icon('scan'), 'Abrir cola de impresión'),
      ),
    ),

    h('div', { class: 'mass-action-section' },
      h('h4', null, readOnly ? 'Exportación Excel' : 'Edición masiva con Excel / CSV'),
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
  title: () => L('Catálogo', 'Catalog'),
  async render(root, params = new URLSearchParams()) {
    catalogMounted = true;
    const seq = ++catalogRenderSeq;
    lastCatalogDataFp = '';
    await loadSettings();
    if (!catalogMounted || seq !== catalogRenderSeq) return;
    const readOnlyMobile = isMobileCatalogReadOnly();
    let [products, idealLevels] = await Promise.all([allProducts(), getIdealLevels()]);
    if (!catalogMounted || seq !== catalogRenderSeq) return;
    const selected = new Set<string>();
    const list = h('ul', { class: 'plist' });
    const countEl = h('span', { class: 'muted small' });
    const queueBadgeEl = h('span', { class: 'badge info queue-count-badge', hidden: true });
    const noDescChip = h('button', {
      class: `chip ${filter === 'sin_desc' ? 'active' : ''}`,
      onclick: () => { filter = 'sin_desc'; navigate('/catalogo'); },
    });
    const lookupPendingBtn = h('button', {
      class: 'btn sm',
      hidden: readOnlyMobile,
      onclick: async () => {
        toast(L('Buscando descripciones…', 'Looking up descriptions…'));
        const n = await processPending();
        toast(L(`${n} descripción(es) encontradas`, `${n} description(s) found`), n ? 'ok' : 'warn');
        await refreshData();
      },
    }, icon('globe'));
    const updateQueueBadge = () => {
      const total = getPrintQueueTotalCount();
      queueBadgeEl.hidden = total <= 0;
      queueBadgeEl.textContent = String(total);
    };
    const massBar = h('div', { class: 'mass-bar', hidden: true });
    const selectAllCheck = h('input', { type: 'checkbox', class: 'item-check' }) as HTMLInputElement;
    const selectAllLabel = h('span', null, L('Seleccionar visibles', 'Select visible'));
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
      if (!catalogMounted) return;
      if (clearSelection) selected.clear();
      const [nextProds, nextIdeals] = await Promise.all([allProducts(), getIdealLevels()]);
      if (!catalogMounted || seq !== catalogRenderSeq) return;
      products = nextProds;
      idealLevels = nextIdeals;
      draw();
    };

    const draw = () => {
      updateQueueBadge();
      const noDescCount = products.filter((p) => !p.description).length;
      noDescChip.textContent = `${L('Sin descripción', 'No description')} (${noDescCount})`;
      noDescChip.className = `chip ${filter === 'sin_desc' ? 'active' : ''}`;
      lookupPendingBtn.hidden = readOnlyMobile || noDescCount === 0;
      lookupPendingBtn.replaceChildren(icon('globe'), `${L('Buscar en internet', 'Look up online')} (${noDescCount})`);

      const items = visibleProducts()
        .sort((a, b) => (a.description || '~').localeCompare(b.description || '~'));

      const selCount = selected.size;
      countEl.textContent = selCount > 0
        ? `${items.length} ${L('de', 'of')} ${products.length} · ${selCount} ${L('seleccionado(s)', 'selected')}`
        : `${items.length} ${L('de', 'of')} ${products.length}`;

      const allSelected = items.length > 0 && items.every((p) => selected.has(p.barcode));
      selectAllCheck.checked = allSelected;
      selectAllCheck.indeterminate = !allSelected && items.some((p) => selected.has(p.barcode));
      selectAllCheck.disabled = items.length === 0;
      selectAllLabel.textContent = `${L('Seleccionar visibles', 'Select visible')} (${items.length})`;

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
          h('div', { class: 'mass-info' }, icon('check'), `${selCount} ${L('seleccionado(s)', 'selected')}`),
          h('div', { class: 'row wrap' },
            h('button', {
              class: 'btn sm',
              'data-testid': 'catalog-mass-labels-btn',
              onclick: () => {
                const sel = products.filter((p) => selected.has(p.barcode));
                openBarcodeSheetDialog(sel);
              },
            }, icon('scan'), L('Etiquetas', 'Labels')),
            h('button', {
              class: 'btn sm ghost',
              'data-testid': 'catalog-mass-queue-btn',
              title: L('Añadir productos seleccionados a la cola de impresión de etiquetas', 'Add selected products to label print queue'),
              onclick: () => {
                const sel = products.filter((p) => selected.has(p.barcode));
                for (const p of sel) addToPrintQueue(p, 1);
                const total = getPrintQueueTotalCount();
                updateQueueBadge();
                toast(L(`${sel.length} producto(s) añadidos a la cola (${total} etiquetas totales)`, `${sel.length} product(s) added to queue (${total} total labels)`), 'ok');
              },
            }, icon('plus'), L('Añadir a cola', 'Add to queue')),
            readOnlyMobile
              ? null
              : h('button', {
                  class: 'btn primary sm',
                  'data-testid': 'catalog-mass-edit-btn',
                  onclick: () => openMassModifyDialog(Array.from(selected), refreshData),
                }, icon('edit'), L('Modificar', 'Edit')),
            readOnlyMobile
              ? null
              : h('button', {
                  class: 'btn danger sm',
                  'data-testid': 'catalog-mass-delete-btn',
                  onclick: async () => {
                    if (await confirmDialog(L('Eliminar seleccionados', 'Delete selected'), L(`¿Eliminar los ${selCount} productos seleccionados del catálogo?`, `Delete ${selCount} selected products from catalog?`), L('Eliminar', 'Delete'), true)) {
                      const n = await deleteProducts(Array.from(selected));
                      triggerBackgroundSync();
                      toast(L(`${n} productos eliminados`, `${n} products deleted`), 'ok');
                      selected.clear();
                      await refreshData();
                    }
                  },
                }, icon('trash'), L('Eliminar', 'Delete')),
            h('button', {
              class: 'btn ghost sm mass-close-btn',
              'aria-label': L('Cerrar selección', 'Close selection'),
              title: L('Cerrar selección', 'Close selection'),
              onclick: () => { selected.clear(); draw(); },
            }, '✕'),
          ),
        );
      } else {
        massBar.hidden = true;
      }

      clear(list,
        items.length === 0 ? h('li', { class: 'empty' }, products.length ? L('Sin coincidencias', 'No matches') : L('Catálogo vacío', 'Catalog is empty')) : null,
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

          const skuKey = (p.sku || '').trim().toUpperCase();
          const codeKey = (p.barcode || '').trim().toUpperCase();
          const idealVal =
            (skuKey && idealLevels[skuKey] !== undefined ? idealLevels[skuKey] : undefined) ??
            (codeKey && idealLevels[codeKey] !== undefined ? idealLevels[codeKey] : undefined) ??
            p.expectedQty ??
            p.maxQty;

          return h('li', {
            class: isSel ? 'selected' : '',
            onclick: async () => {
              const res = await editProductDialog(p.barcode, p);
              if (res === 'deleted') {
                selected.delete(p.barcode);
                await refreshData();
              } else if (res) {
                if (res.barcode !== p.barcode && selected.has(p.barcode)) {
                  selected.delete(p.barcode);
                  selected.add(res.barcode);
                }
                await refreshData(false);
              }
            },
          },
          chk,
          h('div', { class: 'grow' },
            h('div', { class: 'rec-desc' }, p.description || h('i', { class: 'muted' }, L('Sin descripción', 'No description'))),
            h('div', { class: 'rec-meta' },
              p.barcode.startsWith('SKU:') ? '' : h('code', null, displayBarcode(p.barcode)),
              p.sku ? ` · ${p.sku}` : '', p.unit ? ` · ${p.unit}` : '', p.brand ? ` · ${p.brand}` : ''),
            h('div', { class: 'pc-badges' },
              sourceBadge(p),
              p.uncataloged ? h('span', { class: 'badge warn' }, L('No catalogado', 'Uncataloged')) : null,
              idealVal !== undefined
                ? h(
                    'span',
                    { class: 'badge info', 'data-testid': 'catalog-ideal-badge', title: L('Inventario Ideal', 'Ideal Stock') },
                    `Ideal: ${fmtNum(idealVal)}`,
                  )
                : null,
            ),
          ),
          idealVal !== undefined ? h('div', { class: 'rec-qty small', title: L('Inventario Ideal', 'Ideal Stock') }, fmtNum(idealVal)) : null,
          );
        }),
        items.length > 250 ? h('li', { class: 'empty' }, L(`Mostrando 250 de ${items.length}. Usa la búsqueda para filtrar.`, `Showing 250 of ${items.length}. Use search to filter.`)) : null,
      );
    };

    const chip = (id: typeof filter, label: string) =>
      h('button', { class: `chip ${filter === id ? 'active' : ''}`, onclick: () => { filter = id; navigate('/catalogo'); } }, label);

    const selectToolbar = h('div', { class: 'select-toolbar' },
      h('label', { class: 'check-inline' }, selectAllCheck, selectAllLabel),
      h('button', {
        class: 'btn sm',
        onclick: () => {
          openMassActionsDialog(visibleProducts(), Array.from(selected), products, refreshData);
        },
      }, icon('edit'), L('Acciones masivas', 'Bulk actions')),
    );

    clear(root,
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, L('Catálogo', 'Catalog')), countEl),
        readOnlyMobile
          ? h(
              'div',
              { class: 'catalog-readonly-banner', 'data-testid': 'catalog-mobile-readonly-badge' },
              L('Solo lectura en móvil: sincroniza con BD o imprime etiquetas. Edición disponible en PC.', 'Read-only on mobile: sync with DB or print labels. Editing available on desktop.'),
            )
          : null,
        h('div', { class: 'toolbar-compact-row' },
          h('div', { class: 'row wrap', style: 'gap: 6px;' },
            readOnlyMobile
              ? null
              : h('button', {
                  class: 'btn primary sm',
                  'data-testid': 'catalog-new-btn',
                  onclick: async () => {
                    const res = await editProductDialog('');
                    if (res && res !== 'deleted') {
                      await refreshData();
                    }
                  },
                }, icon('scan'), L('Nuevo producto', 'New product')),
            readOnlyMobile
              ? null
              : h('button', {
                  class: 'btn sm',
                  type: 'button',
                  'data-testid': 'catalog-import-btn',
                  onclick: () => void importCatalogFlow(() => { void refreshData(); }),
                }, icon('upload'), L('Importar Excel / CSV', 'Import Excel / CSV')),
            h('button', {
              class: readOnlyMobile ? 'btn primary sm' : 'btn sm',
              type: 'button',
              'data-testid': 'catalog-sync-db-btn',
              onclick: () => void syncCatalogWithDbFlow(() => { void refreshData(); }),
            }, icon('refresh'), L('Sincronizar con BD', 'Sync with DB')),
            h('button', {
              class: 'btn sm',
              'data-testid': 'catalog-queue-btn',
              title: L('Ver y gestionar la cola de impresión para imprimir distintos productos en la misma hoja', 'View and manage the print queue to print multiple products on one sheet'),
              onclick: () => openBarcodeSheetDialog(),
            }, icon('scan'), L('Cola de rótulos', 'Label queue'), queueBadgeEl),
          ),
        ),
        h('details', { class: 'ui-disclosure' },
          h('summary', { class: 'ui-disclosure-summary' }, L('Más herramientas (rótulos y ajustes)', 'More tools (labels & settings)')),
          h('div', { class: 'ui-disclosure-body' },
            h('div', { class: 'row wrap', style: 'gap: 6px;' },
              h('button', {
                class: 'btn sm',
                disabled: !products.length,
                'data-testid': 'catalog-sheets-btn',
                onclick: () => {
                  const visible = visibleProducts();
                  openBarcodeSheetDialog(visible.length ? visible : products);
                },
              }, icon('scan'), L('Rótulos y hojas', 'Labels & sheets')),
              !readOnlyMobile ? lookupPendingBtn : null,
              h('button', {
                class: 'btn ghost sm',
                'data-testid': 'catalog-settings-link',
                onclick: () => navigate('/ajustes'),
              }, icon('gear'), readOnlyMobile ? L('Ajustes / Sala en la nube', 'Settings / Cloud room') : L('Ajustes de catálogo', 'Catalog settings')),
            ),
          ),
        ),
      ),
      h('section', { class: 'card list-card' },
        h('div', { class: 'filter-bar-row' },
          h('input', {
            class: 'input', type: 'search', 'data-testid': 'catalog-search', placeholder: L('Buscar por descripción, código o No. de parte', 'Search by description, barcode, or Part #'), value: query,
            oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; draw(); },
          }),
          h('div', { class: 'chips' }, chip('todos', L('Todos', 'All')), noDescChip, chip('no_cat', L('No catalogados', 'Uncataloged'))),
        ),
        selectToolbar,
        h('div', { class: 'plist-table-head', 'aria-hidden': 'true' },
          h('span', null),
          h('span', null, L('Producto / Código / SKU', 'Product / Code / SKU')),
          h('span', null, L('Inventario Ideal', 'Ideal Stock')),
        ),
        list,
        massBar,
      ),
    );
    draw();

    if (unsubscribeCatalogQueue) unsubscribeCatalogQueue();
    unsubscribeCatalogQueue = subscribePrintQueue(() => {
      if (catalogMounted && seq === catalogRenderSeq) {
        updateQueueBadge();
      }
    });

    if (unsubscribeCatalogCloud) unsubscribeCatalogCloud();
    if (catalogCloudTimer) {
      clearTimeout(catalogCloudTimer);
      catalogCloudTimer = null;
    }
    unsubscribeCatalogCloud = onCloudRoomUpdate((roomState) => {
      if (!catalogMounted || seq !== catalogRenderSeq) return;
      if (roomState) {
        const nextFp = computeRoomDataSig(roomState);
        if (nextFp && nextFp === lastCatalogDataFp) return;
        lastCatalogDataFp = nextFp;
      }
      if (catalogCloudTimer) clearTimeout(catalogCloudTimer);
      catalogCloudTimer = setTimeout(() => {
        catalogCloudTimer = null;
        if (!catalogMounted || seq !== catalogRenderSeq) return;
        void refreshData(false);
      }, 0);
    });

    if (unsubscribeCatalogResize) {
      unsubscribeCatalogResize();
      unsubscribeCatalogResize = null;
    }
    if (typeof window !== 'undefined') {
      let lastMobile = readOnlyMobile;
      const onResize = () => {
        if (!catalogMounted || seq !== catalogRenderSeq) return;
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
    catalogMounted = false;
    catalogRenderSeq++;
    if (catalogCloudTimer) {
      clearTimeout(catalogCloudTimer);
      catalogCloudTimer = null;
    }
    if (unsubscribeCatalogCloud) {
      unsubscribeCatalogCloud();
      unsubscribeCatalogCloud = null;
    }
    if (unsubscribeCatalogQueue) {
      unsubscribeCatalogQueue();
      unsubscribeCatalogQueue = null;
    }
    if (unsubscribeCatalogResize) {
      unsubscribeCatalogResize();
      unsubscribeCatalogResize = null;
    }
  },
};
