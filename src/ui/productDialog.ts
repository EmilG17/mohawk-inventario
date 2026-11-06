import { getProduct, putProduct, type Product } from '../db/db';
import { resolveDescription } from '../lookup/lookup';
import { displayBarcode, parseNumber } from '../io/normalize';
import { h, openDialog, toast } from './dom';

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

/** Abre el editor del producto. Resuelve con el producto guardado o null si se canceló. */
export function editProductDialog(code: string, initial?: Product): Promise<Product | null> {
  return new Promise(async (resolve) => {
    let p: Product = initial ?? (await getProduct(code)) ?? {
      barcode: code, sku: '', description: '', unit: '', uncataloged: true, source: 'pendiente',
    };
    let saved: Product | null = null;
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
    const status = h('div', { class: 'muted small' }, sourceBadge(p), p.brand ? ` · Marca: ${p.brand}` : '');
    const lookupBtn = h('button', {
      class: 'btn sm', type: 'button',
      onclick: async () => {
        lookupBtn.disabled = true;
        lookupBtn.textContent = 'Buscando…';
        try {
          const r = await resolveDescription(code, { forceOnline: true });
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
      h('div', { class: 'code-line' }, h('code', null, code.startsWith('SKU:') ? code : displayBarcode(code))),
      status,
      h('label', { class: 'field' }, h('span', null, 'Descripción'), f.description),
      code.startsWith('SKU:') ? null : lookupBtn,
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', null, 'No. de parte / SKU'), f.sku),
        h('label', { class: 'field' }, h('span', null, 'Unidad'), f.unit),
        h('label', { class: 'field' }, h('span', null, 'Existencia teórica'), f.expected),
        h('label', { class: 'field' }, h('span', null, 'Costo unitario'), f.cost),
      ),
    );
    const dlg = openDialog('Producto', body, [
      { label: 'Cancelar' },
      {
        label: 'Guardar', kind: 'primary',
        onClick: async () => {
          const desc = f.description.value.trim();
          const next: Product = {
            ...p,
            description: desc,
            sku: f.sku.value.trim(),
            unit: f.unit.value.trim(),
            expectedQty: parseNumber(f.expected.value),
            unitCost: parseNumber(f.cost.value),
          };
          if (desc !== p.description) next.source = desc ? 'manual' : 'pendiente';
          else if (!desc) next.source = 'pendiente';
          await putProduct(next);
          saved = next;
          toast('Producto guardado', 'ok');
        },
      },
    ]);
    dlg.addEventListener('close', () => resolve(saved));
  });
}
