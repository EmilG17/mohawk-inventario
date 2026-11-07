import { deleteProduct, getProduct, putProduct, type Product } from '../db/db';
import { resolveDescription } from '../lookup/lookup';
import { displayBarcode, parseNumber } from '../io/normalize';
import { generateInternalCode, renderCode128Svg } from '../barcode/code128';
import { downloadPng, downloadSvg, printLabel } from '../barcode/barcodeExport';
import { openBarcodeSheetDialog } from './barcodeSheet';
import { addToPrintQueue, getPrintQueueTotalCount } from '../barcode/printQueue';
import { confirmDialog, h, icon, openDialog, toast } from './dom';

export const SOURCE_LABEL: Record<Product['source'], string> = {
  catalogo: 'Catálogo',
  UPCitemdb: 'Internet (UPCitemdb)',
  OpenFacts: 'Internet (Open Facts)',
  manual: 'Captura manual',
  pendiente: 'Sin descripción',
};

export function sourceBadge(p: Product) {
  const cls = p.source === 'pendiente' ? 'badge warn' : p.source === 'catalogo' ? 'badge ok' : 'badge info';
  return h('span', { class: cls }, SOURCE_LABEL[p.source]);
}

export type EditProductResult = Product | 'deleted' | null;

/** Abre el editor del producto. Resuelve con el producto guardado, 'deleted' si se eliminó, o null si se canceló. */
export function editProductDialog(code: string, initial?: Product): Promise<EditProductResult> {
  return new Promise(async (resolve) => {
    let p: Product = initial ?? (code ? await getProduct(code) : undefined) ?? {
      barcode: code || generateInternalCode(),
      sku: '',
      description: '',
      unit: '',
      uncataloged: true,
      source: 'pendiente',
    };
    let result: EditProductResult = null;

    const initialCodeVal = code
      ? (code.startsWith('SKU:') ? p.sku || code.slice(4) : displayBarcode(code))
      : p.barcode;

    const barcodeInput = h('input', {
      class: 'input',
      name: 'barcode',
      id: 'p-barcode',
      value: initialCodeVal,
      placeholder: 'Ej. 079567011002 o MHK-123456',
    }) as HTMLInputElement;

    const barcodePreview = h('div', { class: 'barcode-preview' });

    const getCurrentSvg = (): string => {
      const txt = barcodeInput.value.trim() || p.barcode || 'MHK-000000';
      return renderCode128Svg(txt, txt, { height: 42, includeText: true });
    };

    const updatePreview = () => {
      try {
        const svg = getCurrentSvg();
        barcodePreview.innerHTML = svg;
        const svgEl = barcodePreview.querySelector('svg');
        if (svgEl) svgEl.classList.add('barcode');
      } catch {
        barcodePreview.innerHTML = '<span class="muted small">Código no compatible</span>';
      }
    };

    barcodeInput.oninput = () => updatePreview();
    updatePreview();

    const f = {
      description: h('textarea', { class: 'input', rows: 2, maxlength: 200, placeholder: 'Ej. Guantes de nitrilo talla M, caja 100 pzas' }),
      sku: h('input', { class: 'input', maxlength: 40 }),
      unit: h('input', { class: 'input', maxlength: 15, placeholder: 'PZA, CJA, LT…' }),
      expected: h('input', { class: 'input', inputmode: 'decimal', type: 'text' }),
      cost: h('input', { class: 'input', inputmode: 'decimal', type: 'text' }),
    };
    const fill = () => {
      f.description.value = p.description;
      f.sku.value = p.sku;
      f.unit.value = p.unit;
      f.expected.value = p.expectedQty?.toString() ?? '';
      f.cost.value = p.unitCost?.toString() ?? '';
    };
    fill();

    const genBtn = h('button', {
      class: 'btn sm',
      type: 'button',
      onclick: () => {
        const newCode = generateInternalCode();
        barcodeInput.value = newCode;
        updatePreview();
        toast(`Código generado: ${newCode}`, 'ok');
      },
    }, icon('scan'), 'Generar código interno');

    const printSingleBtn = h('button', {
      class: 'btn sm primary',
      type: 'button',
      onclick: () => {
        printLabel(getCurrentSvg(), f.description.value.trim() || p.description || barcodeInput.value, {
          sku: f.sku.value.trim() || p.sku,
          unit: f.unit.value.trim() || p.unit,
          brand: p.brand,
          pageSize: '4in 2in landscape',
        });
      },
    }, icon('scan'), 'Imprimir etiqueta');

    const dlSvgBtn = h('button', {
      class: 'btn sm ghost',
      type: 'button',
      onclick: () => {
        const c = barcodeInput.value.trim() || p.barcode;
        downloadSvg(getCurrentSvg(), `${c}_etiqueta`);
        toast('SVG descargado', 'ok');
      },
    }, icon('download'), 'Descargar SVG');

    const dlPngBtn = h('button', {
      class: 'btn sm ghost',
      type: 'button',
      onclick: async () => {
        const c = barcodeInput.value.trim() || p.barcode;
        await downloadPng(getCurrentSvg(), `${c}_etiqueta`, 3);
        toast('PNG (300 DPI) descargado', 'ok');
      },
    }, icon('download'), 'Descargar PNG');

    const addQueueBtn = h('button', {
      class: 'btn sm ghost',
      type: 'button',
      title: 'Añadir este producto a la cola para imprimirlo junto con otros productos en la misma hoja',
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
        toast(`Añadido a la cola (${total} etiquetas en cola)`, 'ok');
      },
    }, icon('plus'), 'Añadir a cola');

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
        openBarcodeSheetDialog([tempProd], `Hoja de etiquetas`);
      },
    }, '🏷️ Hoja de etiquetas / Cola');

    const status = h('div', { class: 'muted small' }, sourceBadge(p), p.brand ? ` · Marca: ${p.brand}` : '');
    const lookupBtn = h('button', {
      class: 'btn sm', type: 'button',
      onclick: async () => {
        lookupBtn.disabled = true;
        lookupBtn.textContent = 'Buscando…';
        try {
          const currentCode = barcodeInput.value.trim() || code;
          const r = await resolveDescription(currentCode, { forceOnline: true });
          if (r.status === 'encontrado') {
            p = { ...p, description: r.product.description, brand: r.product.brand, imageUrl: r.product.imageUrl, source: r.product.source };
            f.description.value = p.description;
            status.replaceChildren(sourceBadge(p), p.brand ? ` · Marca: ${p.brand}` : '');
            toast('Descripción encontrada', 'ok');
          } else {
            toast(r.status === 'sin_conexion' ? 'Sin conexión: se intentará más tarde' : 'No se encontró en las bases públicas', 'warn');
          }
        } finally {
          lookupBtn.disabled = false;
          lookupBtn.textContent = 'Buscar descripción en internet';
        }
      },
    }, 'Buscar descripción en internet');

    const body = h('div', { class: 'form' },
      h('label', { class: 'field' },
        h('span', null, 'Código de barras'),
        h('div', { class: 'row' }, barcodeInput, genBtn),
      ),
      barcodePreview,
      h('div', { class: 'barcode-actions' }, printSingleBtn, dlSvgBtn, dlPngBtn, addQueueBtn, sheetBtn),
      status,
      h('label', { class: 'field' }, h('span', null, 'Descripción'), f.description),
      lookupBtn,
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, 'No. de parte / SKU'), f.sku),
        h('label', { class: 'field' }, h('span', null, 'Unidad'), f.unit),
        h('label', { class: 'field' }, h('span', null, 'Existencia teórica'), f.expected),
        h('label', { class: 'field' }, h('span', null, 'Costo unitario'), f.cost),
      ),
    );

    const dlg = openDialog('Producto', body, [
      {
        label: 'Eliminar', kind: 'danger',
        onClick: async () => {
          if (code && await confirmDialog('Eliminar del catálogo', `¿Eliminar "${p.description || code}" del catálogo?`, 'Eliminar', true)) {
            await deleteProduct(code);
            result = 'deleted';
            toast('Producto eliminado');
          } else if (!code) {
            result = 'deleted';
          } else {
            return true;
          }
        },
      },
      { label: 'Cancelar' },
      {
        label: 'Guardar', kind: 'primary',
        onClick: async () => {
          const newBarcode = barcodeInput.value.trim() || code || p.barcode;
          if (!newBarcode) {
            toast('El producto debe tener un código de barras', 'error');
            return true;
          }
          const desc = f.description.value.trim();
          const next: Product = {
            ...p,
            barcode: newBarcode,
            description: desc,
            sku: f.sku.value.trim(),
            unit: f.unit.value.trim(),
            expectedQty: parseNumber(f.expected.value),
            unitCost: parseNumber(f.cost.value),
          };
          if (desc !== p.description) next.source = desc ? 'manual' : 'pendiente';
          else if (!desc) next.source = 'pendiente';

          if (code && newBarcode !== code) {
            await deleteProduct(code);
          }
          await putProduct(next);
          result = next;
          toast('Producto guardado', 'ok');
        },
      },
    ]);
    dlg.addEventListener('close', () => resolve(result));
  });
}
