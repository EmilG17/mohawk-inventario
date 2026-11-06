import * as XLSX from 'xlsx';
import type { CountEntry, Product, Session } from '../db/db';
import { displayBarcode } from './normalize';
import { STATUS_LABEL, type ReportRow, type ReportSummary } from '../report';

export const APP_ID = 'mohawk-inventario';

export interface CountFile {
  app: typeof APP_ID;
  version: 1;
  kind: 'conteo';
  exportedAt: string;
  deviceId: string;
  session: Session;
  counts: CountEntry[];
  /** Productos involucrados que no vienen en el catálogo maestro o con descripción obtenida en línea/manual */
  products: Product[];
}

export interface CatalogFile {
  app: typeof APP_ID;
  version: 1;
  kind: 'catalogo';
  exportedAt: string;
  products: Product[];
}

const fmtDate = (t: number) => new Date(t).toLocaleString('es-MX', { hour12: false });

function reportSheetRows(rows: ReportRow[]) {
  return rows.map((r) => ({
    'Código de barras': displayBarcode(r.barcode),
    'No. de parte': r.sku,
    'Descripción': r.description,
    'Unidad': r.unit,
    'Existencia teórica': r.expected ?? '',
    'Contado': r.counted,
    'Diferencia': r.diff ?? '',
    'Costo unitario': r.unitCost ?? '',
    'Valor diferencia': r.diffValue ?? '',
    'Estado': STATUS_LABEL[r.status],
    'Contadores': r.counters.join(', '),
    'Escaneos': r.scans,
    'Origen descripción': r.source ?? '',
  }));
}

/** Fuerza que la columna de código sea texto para que Excel no elimine ceros a la izquierda. */
function codeColumnAsText(ws: XLSX.WorkSheet, col = 0) {
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const ref = XLSX.utils.encode_cell({ r, c: col });
    const c = ws[ref];
    if (c) { c.t = 's'; c.v = String(c.v); c.z = '@'; }
  }
}

function autoWidth(ws: XLSX.WorkSheet, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  ws['!cols'] = Object.keys(rows[0]).map((k) => ({
    wch: Math.min(60, Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)) + 2),
  }));
}

function addSheet(wb: XLSX.WorkBook, name: string, rows: Record<string, unknown>[], header?: string[]) {
  const ws = XLSX.utils.json_to_sheet(rows, header ? { header } : undefined);
  codeColumnAsText(ws);
  autoWidth(ws, rows);
  XLSX.utils.book_append_sheet(wb, ws, name);
}

export function buildReportWorkbook(opts: {
  session: Session;
  rows: ReportRow[];
  summary: ReportSummary;
  counts: CountEntry[];
  products: Product[];
}): Uint8Array {
  const { session, rows, summary, counts, products } = opts;
  const wb = XLSX.utils.book_new();
  const pMap = new Map(products.map((p) => [p.barcode, p]));

  const resumen = [
    ['Inventario de consumibles – Mohawk'],
    ['Sesión', session.name],
    ['Responsable', session.counter],
    ['Inicio', fmtDate(session.createdAt)],
    ['Generado', fmtDate(Date.now())],
    [],
    ['Productos en reporte', summary.totalProducts],
    ['Productos contados', summary.counted],
    ['Correctos', summary.ok],
    ['Faltantes', summary.short],
    ['Sobrantes', summary.over],
    ['No contados', summary.notCounted],
    ['No catalogados', summary.uncataloged],
    ['Unidades contadas', summary.totalUnitsCounted],
    ['Valor faltante', summary.shortValue],
    ['Valor sobrante', summary.overValue],
    ['Valor neto diferencia', summary.netValue],
    ['Exactitud (%)', summary.accuracy],
  ];
  const wsR = XLSX.utils.aoa_to_sheet(resumen);
  wsR['!cols'] = [{ wch: 26 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, wsR, 'Resumen');

  const headers = Object.keys(reportSheetRows([{ barcode: '', sku: '', description: '', unit: '', expected: 0, counted: 0,
    diff: 0, unitCost: 0, diffValue: 0, status: 'ok', counters: [], scans: 0, source: undefined }])[0]);
  addSheet(wb, 'Conteo completo', reportSheetRows(rows), headers);
  addSheet(wb, 'Diferencias', reportSheetRows(rows.filter((r) => r.status === 'faltante' || r.status === 'sobrante')), headers);
  addSheet(wb, 'No catalogados', reportSheetRows(rows.filter((r) => r.status === 'no_catalogado')), headers);

  const detail = [...counts].sort((a, b) => a.timestamp - b.timestamp).map((c) => ({
    'Código de barras': displayBarcode(c.barcode),
    'Descripción': pMap.get(c.barcode)?.description ?? '',
    'Cantidad': c.qty,
    'Contador': c.counter,
    'Fecha/hora': fmtDate(c.timestamp),
    'Dispositivo': c.deviceId.slice(0, 8),
  }));
  addSheet(wb, 'Detalle de escaneos', detail,
    ['Código de barras', 'Descripción', 'Cantidad', 'Contador', 'Fecha/hora', 'Dispositivo']);

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
}

export function buildReportCsv(rows: ReportRow[]): string {
  const data = reportSheetRows(rows);
  const ws = XLSX.utils.json_to_sheet(data);
  // BOM para que Excel abra correctamente los acentos
  return '\ufeff' + XLSX.utils.sheet_to_csv(ws);
}

export function buildCountFile(session: Session, counts: CountEntry[], products: Product[], deviceId: string): CountFile {
  const codes = new Set(counts.map((c) => c.barcode));
  return {
    app: APP_ID,
    version: 1,
    kind: 'conteo',
    exportedAt: new Date().toISOString(),
    deviceId,
    session,
    counts,
    products: products.filter((p) => codes.has(p.barcode) && (p.uncataloged || p.source !== 'catalogo')),
  };
}

export function buildCatalogFile(products: Product[]): CatalogFile {
  return { app: APP_ID, version: 1, kind: 'catalogo', exportedAt: new Date().toISOString(), products };
}

/** Catálogo como Excel (para editar/compartir). */
export function buildCatalogWorkbook(products: Product[]): Uint8Array {
  const rows = products
    .filter((p) => !p.barcode.startsWith('SKU:') || p.sku)
    .map((p) => ({
      'Código de barras': p.barcode.startsWith('SKU:') ? '' : displayBarcode(p.barcode),
      'No. de parte': p.sku,
      'Descripción': p.description,
      'Unidad': p.unit,
      'Existencia teórica': p.expectedQty ?? '',
      'Costo unitario': p.unitCost ?? '',
      'Marca': p.brand ?? '',
      'Origen descripción': p.source,
    }));
  const wb = XLSX.utils.book_new();
  addSheet(wb, 'Catalogo', rows,
    ['Código de barras', 'No. de parte', 'Descripción', 'Unidad', 'Existencia teórica', 'Costo unitario', 'Marca', 'Origen descripción']);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
}

export function safeFileName(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'inventario';
}
