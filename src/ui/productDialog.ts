import { L } from '../i18n/i18n';
import { deleteProduct, getProduct, putProduct, type Product } from '../db/db';
import { getIdealLevels, setIdealLevels } from '../db/movements';
import { resolveDescription } from '../lookup/lookup';
import { displayBarcode, parseNumber } from '../io/normalize';
import { generateInternalCode, renderCode128Svg } from '../barcode/code128';
import { downloadPng, downloadSvg, printLabel } from '../barcode/barcodeExport';
import {
  getSavedBartenderProfile,
  parseBartenderFile,
  saveBartenderProfile,
} from '../barcode/bartenderFormat';
import { openBarcodeSheetDialog } from './barcodeSheet';
import { addToPrintQueue, getPrintQueueTotalCount } from '../barcode/printQueue';
import { triggerBackgroundSync } from '../sync/cloudSync';
import { confirmDialog, h, icon, openDialog, toast } from './dom';
import { isMobileCatalogReadOnly } from './catalogMode';

export const SOURCE_LABEL: Record<Product['source'], string> = {
  catalogo: 'Catálogo',
  UPCitemdb: 'Internet (UPCitemdb)',
  OpenFacts: 'Internet (Open Facts)',
  manual: 'Captura manual',
  pendiente: 'Sin descripción',
};

export function sourceBadge(p: Product) {
  const cls = p.source === 'pendiente' ? 'badge warn' : p.source === 'catalogo' ? 'badge ok' : 'badge info';
  const label =
    p.source === 'catalogo'
      ? L('Catálogo', 'Catalog')
      : p.source === 'UPCitemdb'
        ? 'Internet (UPCitemdb)'
        : p.source === 'OpenFacts'
          ? 'Internet (Open Facts)'
          : p.source === 'manual'
            ? L('Captura manual', 'Manual entry')
            : L('Sin descripción', 'No description');
  return h('span', { class: cls }, label);
}

export type EditProductResult = Product | 'deleted' | null;

/** Abre el editor del producto. Resuelve con el producto guardado, 'deleted' si se eliminó, o null si se canceló. */
export function editProductDialog(code: string, initial?: Product): Promise<EditProductResult> {
  return new Promise(async (resolve) => {
    const readOnly = isMobileCatalogReadOnly();
    if (readOnly && !code && !initial) {
      toast(L('El catálogo es de solo lectura en la versión móvil. Usa una PC para crear productos.', 'The catalog is read-only on mobile. Use a desktop PC to create products.'), 'warn');
      resolve(null);
      return;
    }

    let p: Product = initial ?? (code ? await getProduct(code) : undefined) ?? {
      barcode: code || generateInternalCode(),
      sku: '',
      description: '',
      unit: '',
      uncataloged: true,
      source: 'pendiente',
    };
    const idealLevels = await getIdealLevels();
    let result: EditProductResult = null;

    const initialCodeVal = code
      ? (code.startsWith('SKU:') ? p.sku || code.slice(4) : displayBarcode(code))
      : p.barcode;

    const barcodeInput = h('input', {
      class: 'input',
      name: 'barcode',
      id: 'p-barcode',
      value: initialCodeVal,
      placeholder: L('Ej. 079567011002 o MHK-123456', 'e.g. 079567011002 or MHK-123456'),
    }) as HTMLInputElement;

    const barcodePreview = h('div', { class: 'barcode-preview' });

    const getCurrentSvg = (): string => {
      const txt = barcodeInput.value.trim() || p.barcode || 'MHK-000000';
      return renderCode128Svg(txt, txt, { height: 34, width: 2.2, fontSize: 10, includeText: true });
    };

    const updatePreview = () => {
      try {
        const svg = getCurrentSvg();
        barcodePreview.innerHTML = svg;
        const svgEl = barcodePreview.querySelector('svg');
        if (svgEl) svgEl.classList.add('barcode');
      } catch {
        barcodePreview.innerHTML = `<span class="muted small">${L('Código no compatible', 'Unsupported barcode')}</span>`;
      }
    };

    barcodeInput.oninput = () => updatePreview();
    updatePreview();

    const f = {
      description: h('textarea', { class: 'input', rows: 2, maxlength: 200, placeholder: L('Ej. Guantes de nitrilo talla M, caja 100 pzas', 'e.g. Nitrile gloves size M, box of 100') }),
      sku: h('input', { class: 'input', maxlength: 40 }),
      unit: h('input', { class: 'input', maxlength: 15, placeholder: L('PZA, CJA, LT…', 'EA, BOX, L…') }),
      expected: h('input', {
        class: 'input',
        inputmode: 'decimal',
        type: 'text',
        'data-testid': 'product-ideal-qty-input',
        placeholder: L('Ej. 50 (meta ideal)', 'e.g. 50 (ideal target)'),
      }),
      cost: h('input', { class: 'input', inputmode: 'decimal', type: 'text' }),
    };
    const skuKey = (p.sku || '').trim().toUpperCase();
    const codeKey = (p.barcode || '').trim().toUpperCase();
    const configuredIdeal =
      (skuKey && idealLevels[skuKey] !== undefined ? idealLevels[skuKey] : undefined) ??
      (codeKey && idealLevels[codeKey] !== undefined ? idealLevels[codeKey] : undefined);
    const initialIdeal = configuredIdeal ?? p.expectedQty ?? p.maxQty;
    const fill = () => {
      f.description.value = p.description;
      f.sku.value = p.sku;
      f.unit.value = p.unit;
      f.expected.value = initialIdeal?.toString() ?? '';
      f.cost.value = p.unitCost?.toString() ?? '';
    };
    fill();

    if (readOnly) {
      barcodeInput.readOnly = true;
      barcodeInput.disabled = true;
      for (const el of Object.values(f)) {
        el.readOnly = true;
        el.disabled = true;
      }
    }

    const genBtn = h('button', {
      class: 'btn sm',
      type: 'button',
      onclick: () => {
        const newCode = generateInternalCode();
        barcodeInput.value = newCode;
        updatePreview();
        toast(`${L('Código generado:', 'Code generated:')} ${newCode}`, 'ok');
      },
    }, icon('scan'), L('Generar código interno', 'Generate internal code'));

    const btProfileInit = getSavedBartenderProfile();
    const savedTplInit = typeof localStorage !== 'undefined' ? localStorage.getItem('mohawk_preferred_label_template') : null;
    const precut3in1Check = h('input', {
      type: 'checkbox',
      id: 'p-precut-3in1',
      checked: savedTplInit ? savedTplInit === 'intermec_composite' : true,
      onchange: (e: Event) => {
        const checked = (e.target as HTMLInputElement).checked;
        if (typeof localStorage !== 'undefined') {
          try {
            localStorage.setItem(
              'mohawk_preferred_label_template',
              checked ? 'intermec_composite' : 'intermec325x2',
            );
          } catch {}
        }
      },
    }) as HTMLInputElement;

    const includeFooterCheck = h('input', {
      type: 'checkbox',
      checked: btProfileInit.includeFooter,
      onchange: (e: Event) => {
        const checked = (e.target as HTMLInputElement).checked;
        saveBartenderProfile({ includeFooter: checked });
      },
    }) as HTMLInputElement;

    const printSingleBtn = h('button', {
      class: 'btn sm primary',
      type: 'button',
      onclick: () => {
        const savedTemplate = (typeof localStorage !== 'undefined' ? localStorage.getItem('mohawk_preferred_label_template') : null);
        const btProfile = getSavedBartenderProfile();
        const txt = barcodeInput.value.trim() || p.barcode || 'MHK-000000';

        if (precut3in1Check.checked || savedTemplate === 'intermec_composite') {
          printLabel('', f.description.value.trim() || p.description || txt, {
            barcode: txt,
            sku: f.sku.value.trim() || p.sku || txt,
            unit: f.unit.value.trim() || p.unit,
            brand: p.brand || 'MOHAWK',
            pageSize: '3.25in 2in portrait',
            precut3in1: true,
          });
          return;
        }

        const pageSize = savedTemplate === 'intermec6x397'
          ? '6in 3.97in landscape'
          : savedTemplate === 'thermal4x2'
            ? '4in 2in landscape'
            : savedTemplate === 'intermec397x6' || savedTemplate === 'intermec397x6_full'
              ? '3.97in 6in portrait'
              : `${btProfile.labelWidthIn}in ${btProfile.labelHeightIn}in portrait`;

        const isIntermec = pageSize.includes('3.25') || pageSize.includes('3.97');
        const svgMarkup = renderCode128Svg(txt, txt, {
          height: isIntermec ? btProfile.barHeightPx : 34,
          fontSize: 10,
          width: isIntermec ? btProfile.moduleWidthPx : 2,
          includeText: isIntermec ? btProfile.includeHumanReadable : true,
          margin: 2,
        });

        const withFooter =
          includeFooterCheck.checked ||
          savedTemplate === 'intermec325x2_full' ||
          savedTemplate === 'intermec397x6_full';
        const sizeClass = pageSize.includes('3.25') ? 'intermec-325x2' : 'intermec-397x6';
        printLabel(svgMarkup, f.description.value.trim() || p.description || barcodeInput.value, {
          barcode: txt,
          sku: f.sku.value.trim() || p.sku,
          unit: f.unit.value.trim() || p.unit,
          brand: p.brand,
          pageSize,
          hideFooter: isIntermec && !withFooter,
          customClass: isIntermec
            ? `${sizeClass} intermec-397x6 bartender-layout ${withFooter ? 'with-footer' : 'compact-only'}`
            : 'thermal-4x2',
        });
      },
    }, icon('scan'), L('Imprimir etiqueta', 'Print label'));

    const dlSvgBtn = h('button', {
      class: 'btn sm ghost',
      type: 'button',
      onclick: () => {
        const c = barcodeInput.value.trim() || p.barcode;
        downloadSvg(getCurrentSvg(), `${c}_etiqueta`);
        toast(L('SVG descargado', 'SVG downloaded'), 'ok');
      },
    }, icon('download'), L('Descargar SVG', 'Download SVG'));

    const dlPngBtn = h('button', {
      class: 'btn sm ghost',
      type: 'button',
      onclick: async () => {
        const c = barcodeInput.value.trim() || p.barcode;
        await downloadPng(getCurrentSvg(), `${c}_etiqueta`, 3);
        toast(L('PNG (300 DPI) descargado', 'PNG (300 DPI) downloaded'), 'ok');
      },
    }, icon('download'), L('Descargar PNG', 'Download PNG'));

    const addQueueBtn = h('button', {
      class: 'btn sm ghost',
      type: 'button',
      title: L('Añadir este producto a la cola para imprimirlo junto con otros productos en la misma hoja', 'Add this product to the queue to print with other products on the same sheet'),
      onclick: () => {
        const tempProd: Product = {
          ...p,
          barcode: barcodeInput.value.trim() || p.barcode,
          description: f.description.value.trim() || p.description,
          sku: f.sku.value.trim() || p.sku,
          unit: f.unit.value.trim() || p.unit,
        };
        addToPrintQueue(tempProd, 1);
        const total = getPrintQueueTotalCount();
        toast(L(`Añadido a la cola (${total} etiquetas en cola)`, `Added to queue (${total} labels queued)`), 'ok');
      },
    }, icon('plus'), L('Añadir a cola', 'Add to queue'));

    const sheetBtn = h('button', {
      class: 'btn sm',
      type: 'button',
      onclick: () => {
        const tempProd: Product = {
          ...p,
          barcode: barcodeInput.value.trim() || p.barcode,
          description: f.description.value.trim() || p.description,
          sku: f.sku.value.trim() || p.sku,
          unit: f.unit.value.trim() || p.unit,
        };
        openBarcodeSheetDialog([tempProd], L('Hoja de etiquetas', 'Label sheet'));
      },
    }, icon('tag'), L('Hoja de etiquetas / Cola', 'Label sheet / Queue'));

    const status = h('div', { class: 'muted small' }, sourceBadge(p), p.brand ? ` · ${L('Marca:', 'Brand:')} ${p.brand}` : '');
    const lookupBtn = h('button', {
      class: 'btn sm', type: 'button',
      onclick: async () => {
        lookupBtn.disabled = true;
        lookupBtn.textContent = L('Buscando…', 'Searching…');
        try {
          const currentCode = barcodeInput.value.trim() || code;
          const r = await resolveDescription(currentCode, { forceOnline: true });
          if (r.status === 'encontrado') {
            p = { ...p, description: r.product.description, brand: r.product.brand, imageUrl: r.product.imageUrl, source: r.product.source };
            f.description.value = p.description;
            status.replaceChildren(sourceBadge(p), p.brand ? ` · ${L('Marca:', 'Brand:')} ${p.brand}` : '');
            toast(L('Descripción encontrada', 'Description found'), 'ok');
          } else {
            toast(r.status === 'sin_conexion' ? L('Sin conexión: se intentará más tarde', 'Offline: will retry later') : L('No se encontró en las bases públicas', 'Not found in public databases'), 'warn');
          }
        } finally {
          lookupBtn.disabled = false;
          lookupBtn.textContent = L('Buscar descripción en internet', 'Look up description online');
        }
      },
    }, L('Buscar descripción en internet', 'Look up description online'));

    const btUploadInput = h('input', {
      type: 'file',
      accept: '.btw,.prn,.ipl,.zpl,.xml,.txt',
      style: 'display: none;',
      onchange: async (e: Event) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        try {
          const profile = await parseBartenderFile(file);
          saveBartenderProfile(profile);
          includeFooterCheck.checked = profile.includeFooter;
          updatePreview();
          toast(L(`Formato BarTender "${file.name}" aplicado (${profile.labelWidthIn}"×${profile.labelHeightIn}")`, `BarTender format "${file.name}" applied (${profile.labelWidthIn}"×${profile.labelHeightIn}")`), 'ok');
        } catch {
          toast(L('No se pudo leer el archivo BarTender', 'Could not read BarTender file'), 'error');
        }
      },
    }) as HTMLInputElement;

    const btUploadBtn = h('button', {
      class: 'btn sm ghost',
      type: 'button',
      title: L('Cargar archivo BarTender (.btw) para calibrar etiqueta', 'Load BarTender (.btw) file to calibrate label'),
      onclick: () => btUploadInput.click(),
    }, icon('upload'), L('Cargar .btw', 'Load .btw'), btUploadInput);

    const body = h('div', { class: 'form' },
      readOnly
        ? h(
            'div',
            { class: 'catalog-readonly-banner', 'data-testid': 'product-dialog-readonly-notice' },
            L(
              'Modo solo lectura en móvil: puedes consultar o imprimir la etiqueta de este producto, pero la edición del catálogo está restringida a PC.',
              'Read-only mode on mobile: you can view or print this product label, but catalog editing is restricted to desktop.',
            ),
          )
        : null,
      h('label', { class: 'field' },
        h('span', null, L('Código de barras', 'Barcode')),
        h('div', { class: 'row' }, barcodeInput, readOnly ? null : genBtn),
      ),
      barcodePreview,
      h('div', { class: 'barcode-actions' }, printSingleBtn, dlSvgBtn, dlPngBtn, addQueueBtn, sheetBtn, btUploadBtn),
      h(
        'label',
        { class: 'check-inline muted small', style: 'margin: 2px 0 2px 0;' },
        precut3in1Check,
        h('span', null, L('Imprimir formato Etiqueta Pre-Cortada 3-en-1 BarTender (Principal + Mini + QR · 3.25" × 2.00")', 'Print BarTender 3-in-1 Pre-Cut Label format (Main + Mini + QR · 3.25" × 2.00")')),
      ),
      h(
        'label',
        { class: 'check-inline muted small', style: 'margin: 0 0 4px 0;' },
        includeFooterCheck,
        h('span', null, L('Incluir SKU, Unidad y Marca debajo del código (para etiquetas simples)', 'Include SKU, Unit, and Brand below barcode (simple labels)')),
      ),
      status,
      h('label', { class: 'field' }, h('span', null, L('Descripción', 'Description')), f.description),
      readOnly ? null : lookupBtn,
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, L('No. de parte / SKU', 'Part # / SKU')), f.sku),
        h('label', { class: 'field' }, h('span', null, L('Unidad', 'Unit')), f.unit),
        h('label', { class: 'field' }, h('span', null, L('Inventario Ideal', 'Ideal Stock')), f.expected),
        h('label', { class: 'field' }, h('span', null, L('Costo unitario', 'Unit cost')), f.cost),
      ),
    );

    const dlg = openDialog(
      readOnly ? L('Detalle de producto (Solo lectura)', 'Product Details (Read-only)') : L('Producto', 'Product'),
      body,
      readOnly
        ? [{ label: L('Cancelar', 'Cancel') }]
        : [
            {
              label: L('Eliminar', 'Delete'), kind: 'danger',
              onClick: async () => {
                if (code && await confirmDialog(L('Eliminar del catálogo', 'Delete from catalog'), L(`¿Eliminar "${p.description || code}" del catálogo?`, `Delete "${p.description || code}" from catalog?`), L('Eliminar', 'Delete'), true)) {
                  await deleteProduct(code);
                  triggerBackgroundSync();
                  result = 'deleted';
                  toast(L('Producto eliminado', 'Product deleted'));
                } else if (!code) {
                  result = 'deleted';
                } else {
                  return true;
                }
              },
            },
            { label: L('Cancelar', 'Cancel') },
            {
              label: L('Guardar', 'Save'), kind: 'primary',
              onClick: async () => {
                const rawBarcodeInput = barcodeInput.value.trim();
                const newBarcode =
                  rawBarcodeInput && rawBarcodeInput === initialCodeVal && (code || p.barcode)
                    ? (code || p.barcode)
                    : (rawBarcodeInput || code || p.barcode);
                if (!newBarcode) {
                  toast(L('El producto debe tener un código de barras', 'Product must have a barcode'), 'error');
                  return true;
                }
                const desc = f.description.value.trim();
                const parsedExpected = parseNumber(f.expected.value);
                const parsedCost = parseNumber(f.cost.value);
                const next: Product = {
                  ...p,
                  barcode: newBarcode,
                  description: desc,
                  sku: f.sku.value.trim(),
                  unit: f.unit.value.trim(),
                  expectedQty: parsedExpected,
                  unitCost: parsedCost,
                  updatedAt: Date.now(),
                };
                if (parsedExpected === undefined) delete next.expectedQty;
                if (parsedCost === undefined) delete next.unitCost;
                if (desc !== p.description) next.source = desc ? 'manual' : 'pendiente';
                else if (!desc) next.source = 'pendiente';

                if (code && newBarcode !== code) {
                  await deleteProduct(code);
                }
                await putProduct(next);
                const idealPatch: Record<string, number> = {};
                const nextSku = next.sku.trim().toUpperCase();
                const nextCode = next.barcode.trim().toUpperCase();
                const targetVal = parsedExpected !== undefined ? parsedExpected : -1;
                if (nextSku) idealPatch[nextSku] = targetVal;
                else if (nextCode) idealPatch[nextCode] = targetVal;
                if (targetVal < 0 && nextCode) idealPatch[nextCode] = -1;
                if (Object.keys(idealPatch).length > 0) {
                  await setIdealLevels(idealPatch);
                }
                triggerBackgroundSync();
                result = next;
                toast(L('Producto guardado', 'Product saved'), 'ok');
              },
            },
          ],
    );
    dlg.addEventListener('close', () => resolve(result));
  });
}
