import * as XLSX from 'xlsx';
import type { Product } from '../db/db';
import { looksScientific, normalizeBarcode, parseNumber } from './normalize';

export type Field = 'barcode' | 'sku' | 'description' | 'unit' | 'expectedQty' | 'unitCost';
export type Mapping = Record<Field, number>; // índice de columna, -1 = no asignada

export const FIELD_LABELS: Record<Field, string> = {
  barcode: 'Código de barras',
  sku: 'No. de parte / SKU',
  description: 'Descripción',
  unit: 'Unidad',
  expectedQty: 'Existencia teórica',
  unitCost: 'Costo unitario',
};

const SYNONYMS: Record<Field, string[]> = {
  barcode: ['codigo de barras', 'cod barras', 'barcode', 'upc', 'ean', 'gtin', 'codigo barra', 'bar code', 'cb', 'codigo', 'cod'],
  sku: ['sku', 'no parte', 'no de parte', 'num de parte', 'numero de parte', 'num parte', 'part number', 'part no', 'pn', 'item', 'articulo',
    'material', 'clave'],
  description: ['descripcion', 'description', 'desc', 'nombre', 'producto', 'name', 'item description', 'texto breve'],
  unit: ['unidad', 'um', 'uom', 'unit', 'unidad de medida', 'u m'],
  expectedQty: ['existencia', 'existencia teorica', 'stock', 'cantidad', 'qty', 'on hand', 'saldo', 'inventario',
    'cantidad sistema', 'libre utilizacion', 'teorico'],
  unitCost: ['costo', 'costo unitario', 'precio', 'unit cost', 'cost', 'price', 'precio unitario'],
};

function norm(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[._#/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Workbook {
  sheetNames: string[];
  rows(sheet: string): unknown[][];
}

export function readWorkbook(data: ArrayBuffer | Uint8Array, fileName = ''): Workbook {
  const isCsv = /\.(csv|txt)$/i.test(fileName);
  const wb = isCsv
    ? XLSX.read(new TextDecoder('utf-8').decode(data), { type: 'string', raw: true })
    : XLSX.read(data, { type: 'array' });
  return {
    sheetNames: wb.SheetNames,
    rows: (sheet) =>
      XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1, raw: true, defval: '', blankrows: false }),
  };
}

/** Busca, en las primeras 20 filas, la que más se parece a una fila de encabezados. */
export function detectHeaderRow(rows: unknown[][]): number {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const m = guessMapping(rows[i]);
    const score = Object.values(m).filter((v) => v >= 0).length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export function guessMapping(headers: unknown[]): Mapping {
  const h = headers.map(norm);
  const m: Mapping = { barcode: -1, sku: -1, description: -1, unit: -1, expectedQty: -1, unitCost: -1 };
  const used = new Set<number>();
  // Primero coincidencias exactas, luego parciales; en orden de prioridad de campos
  const order: Field[] = ['barcode', 'description', 'sku', 'unit', 'expectedQty', 'unitCost'];
  for (const pass of ['exact', 'partial'] as const) {
    for (const f of order) {
      if (m[f] >= 0) continue;
      const idx = h.findIndex(
        (col, i) =>
          !used.has(i) &&
          col !== '' &&
          SYNONYMS[f].some((syn) => (pass === 'exact' ? col === syn : col.includes(syn) && syn.length >= 3)),
      );
      if (idx >= 0) {
        m[f] = idx;
        used.add(idx);
      }
    }
  }
  return m;
}

export interface ImportResult {
  products: Product[];
  warnings: string[];
  skipped: number;
}

export function rowsToProducts(rows: unknown[][], headerRow: number, mapping: Mapping): ImportResult {
  const warnings: string[] = [];
  const seen = new Map<string, number>();
  const products: Product[] = [];
  let skipped = 0;
  if (mapping.barcode < 0 && mapping.sku < 0) {
    throw new Error('Debe asignar al menos la columna de código de barras o la de SKU.');
  }
  const cell = (r: unknown[], f: Field) => (mapping[f] >= 0 ? r[mapping[f]] : undefined);

  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = i + 1;
    const rawCode = cell(r, 'barcode');
    const sku = String(cell(r, 'sku') ?? '').trim();
    if (looksScientific(rawCode)) {
      warnings.push(`Fila ${rowNo}: el código "${rawCode}" está en notación científica (Excel lo dañó). Formatee la columna como Texto.`);
    }
    let barcode = normalizeBarcode(rawCode);
    if (!barcode && sku) barcode = 'SKU:' + sku.toUpperCase();
    if (!barcode) {
      skipped++;
      continue;
    }
    const description = String(cell(r, 'description') ?? '').trim();
    const p: Product = {
      barcode,
      sku,
      description,
      unit: String(cell(r, 'unit') ?? '').trim(),
      expectedQty: parseNumber(cell(r, 'expectedQty')),
      unitCost: parseNumber(cell(r, 'unitCost')),
      source: description ? 'catalogo' : 'pendiente',
      uncataloged: false,
    };
    if (seen.has(barcode)) {
      warnings.push(`Fila ${rowNo}: código duplicado (también en fila ${seen.get(barcode)}). Se sumó la existencia teórica.`);
      const prev = products.find((x) => x.barcode === barcode)!;
      if (p.expectedQty !== undefined) prev.expectedQty = (prev.expectedQty ?? 0) + p.expectedQty;
      continue;
    }
    seen.set(barcode, rowNo);
    products.push(p);
  }
  return { products, warnings, skipped };
}
