import * as XLSX from 'xlsx';
import type { CountEntry, Product, Session } from '../db/db';
import type { Movement } from '../db/movements';
import { displayBarcode } from './normalize';
import { STATUS_LABEL, round, computeIdealStatus, type IdealStatus, type ReportRow, type ReportSummary } from '../report';

export const APP_ID = 'mohawk-inventario';

export const IDEAL_STATUS_LABEL: Record<IdealStatus, string> = {
  optimal: 'Óptimo',
  deficit: 'Déficit',
  critical: 'Crítico',
  excess: 'Exceso',
};

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
    'Existencia teórica inicial': r.expected ?? '',
    'Entradas (+)': r.totalIn ?? 0,
    'Salidas (-)': r.totalOut ?? 0,
    'Stock dinámico': r.dynamicExpected ?? (r.expected ?? ''),
    'Contado físico': r.counted,
    'Diferencia': r.diff ?? '',
    'Inventario ideal': r.idealQty ?? '',
    'Brecha vs Ideal': r.idealGap ?? '',
    'Estado ideal': r.idealStatus ? (IDEAL_STATUS_LABEL[r.idealStatus] ?? r.idealStatus) : '',
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
  if (!ws['!ref']) return;
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    const ref = XLSX.utils.encode_cell({ r, c: col });
    const c = ws[ref];
    if (c && c.v !== undefined && c.v !== null && c.v !== '') {
      c.t = 's';
      c.v = String(c.v);
      c.z = '@';
    }
  }
}

function autoWidth(ws: XLSX.WorkSheet, rows: Record<string, unknown>[], header?: string[]) {
  if (!rows.length) {
    if (header && header.length) {
      ws['!cols'] = header.map((h) => ({ wch: Math.max(h.length + 3, 14) }));
    }
    return;
  }
  const keys = header && header.length ? header : Object.keys(rows[0]);
  ws['!cols'] = keys.map((k) => ({
    wch: Math.min(60, Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)) + 2),
  }));
}

function addSheet(
  wb: XLSX.WorkBook,
  name: string,
  rows: Record<string, unknown>[],
  header?: string[],
  textCols: number[] = [0],
) {
  const ws = XLSX.utils.json_to_sheet(rows, header ? { header } : undefined);
  for (const c of textCols) {
    codeColumnAsText(ws, c);
  }
  autoWidth(ws, rows, header);
  XLSX.utils.book_append_sheet(wb, ws, name);
}

export function buildReportWorkbook(opts: {
  session: Session;
  rows: ReportRow[];
  summary: ReportSummary;
  counts: CountEntry[];
  products: Product[];
  movements?: Movement[];
  idealLevels?: Record<string, number>;
}): Uint8Array {
  const { session, rows, summary, counts, products } = opts;
  const wb = XLSX.utils.book_new();
  const pMap = new Map(products.map((p) => [p.barcode, p]));
  const pBySku = new Map(products.filter((p) => p.sku).map((p) => [p.sku, p]));

  const techMap = new Map<string, { scans: number; units: number; barcodes: Set<string> }>();
  for (const c of counts) {
    const name = c.counter?.trim() || session.counter || 'Técnico';
    const cur = techMap.get(name) ?? { scans: 0, units: 0, barcodes: new Set<string>() };
    cur.scans += 1;
    cur.units += c.qty;
    cur.barcodes.add(c.barcode);
    techMap.set(name, cur);
  }
  const techList = [...techMap.keys()].join(', ') || session.counter;

  const resumen = [
    ['Inventario de consumibles – Mohawk'],
    ['Sesión', session.name],
    ['Responsable', session.counter],
    ['Técnicos participantes', techList],
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
    ...(summary.reorderCount > 0
      ? [
          ['Productos por pedir (Bajo stock)', summary.reorderCount],
          ['Costo estimado de compra', summary.reorderValue],
        ]
      : []),
  ];
  const wsR = XLSX.utils.aoa_to_sheet(resumen);
  wsR['!cols'] = [{ wch: 26 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, wsR, 'Resumen');

  const headers = Object.keys(reportSheetRows([{ barcode: '', sku: '', description: '', unit: '', expected: 0, counted: 0,
    diff: 0, unitCost: 0, diffValue: 0, status: 'ok', counters: [], scans: 0, source: undefined }])[0]);
  addSheet(wb, 'Conteo completo', reportSheetRows(rows), headers, [0, 1]);
  addSheet(wb, 'Diferencias', reportSheetRows(rows.filter((r) => r.status === 'faltante' || r.status === 'sobrante')), headers, [0, 1]);
  addSheet(wb, 'No catalogados', reportSheetRows(rows.filter((r) => r.status === 'no_catalogado')), headers, [0, 1]);

  const reorderRows = rows.filter((r) => r.needsReorder);
  if (reorderRows.length > 0) {
    const orderSheetRows = reorderRows.map((r) => ({
      'Código de barras': displayBarcode(r.barcode),
      'No. de parte': r.sku,
      'Descripción': r.description,
      'Unidad': r.unit,
      'Contado físico': r.counted,
      'Stock mínimo': r.minQty ?? '',
      'Stock máximo': r.maxQty ?? r.expected ?? '',
      'Cantidad a pedir': r.suggestedOrderQty ?? 0,
      'Costo unitario': r.unitCost ?? '',
      'Costo estimado compra': r.estimatedOrderCost ?? '',
      'Marca': pMap.get(r.barcode)?.brand ?? '',
    }));
    addSheet(
      wb,
      'Por pedir',
      orderSheetRows,
      [
        'Código de barras',
        'No. de parte',
        'Descripción',
        'Unidad',
        'Contado físico',
        'Stock mínimo',
        'Stock máximo',
        'Cantidad a pedir',
        'Costo unitario',
        'Costo estimado compra',
        'Marca',
      ],
      [0, 1],
    );
  }

  if (techMap.size > 1) {
    const techRows = [...techMap.entries()].map(([name, info]) => ({
      'Técnico / Contador': name,
      'Productos distintos': info.barcodes.size,
      'Escaneos registrados': info.scans,
      'Unidades contadas': info.units,
    }));
    addSheet(
      wb,
      'Por técnico',
      techRows,
      ['Técnico / Contador', 'Productos distintos', 'Escaneos registrados', 'Unidades contadas'],
      [],
    );
  }

  if (opts.movements !== undefined || opts.idealLevels !== undefined) {
    // ----------------- HOJA: Entradas y Salidas (Kardex) -----------------
    const movementsList = [...(opts.movements ?? [])].sort((a, b) => a.timestamp - b.timestamp);
    const kardexRows = movementsList.map((m) => {
      const prod = (m.barcode ? pMap.get(m.barcode) : undefined) ?? pBySku.get(m.sku);
      return {
        'Fecha/Hora': fmtDate(m.timestamp),
        'Folio/Ref': m.folio || '-',
        'Tipo': m.type === 'IN' ? 'ENTRADA' : 'SALIDA',
        'SKU': m.sku,
        'Código de barras': m.barcode ? displayBarcode(m.barcode) : '',
        'Descripción': prod?.description ?? '',
        'Cantidad': m.quantity,
        'Unidad': prod?.unit ?? 'PZA',
        'Técnico/Proveedor': m.technicianOrSupplier || '-',
        'Máquina/Área': m.machineOrArea || '-',
        'Notas': m.notes ?? '',
      };
    });
    const kardexHeaders = [
      'Fecha/Hora',
      'Folio/Ref',
      'Tipo',
      'SKU',
      'Código de barras',
      'Descripción',
      'Cantidad',
      'Unidad',
      'Técnico/Proveedor',
      'Máquina/Área',
      'Notas',
    ];
    addSheet(wb, 'Entradas y Salidas (Kardex)', kardexRows, kardexHeaders, [3, 4]);

    // ----------------- HOJA: Inventario Ideal -----------------
    const idealRows = rows.map((r) => {
      const prod = pMap.get(r.barcode) ?? pBySku.get(r.sku);
      const initialExpected = r.expected ?? 0;
      const totalIn = r.totalIn ?? 0;
      const totalOut = r.totalOut ?? 0;
      const dynamicStock = r.dynamicExpected ?? round(initialExpected + totalIn - totalOut);
      const counted = r.counted;

      const configuredIdeal =
        (opts.idealLevels && r.sku && opts.idealLevels[r.sku] !== undefined)
          ? opts.idealLevels[r.sku]
          : r.idealQty;

      const idealQty = configuredIdeal !== undefined ? configuredIdeal : (prod?.maxQty ?? r.expected ?? '');
      const idealNum = typeof idealQty === 'number' ? idealQty : undefined;
      const gap = idealNum !== undefined ? round(counted - idealNum) : (r.idealGap ?? '');
      const gapNum = typeof gap === 'number' ? gap : undefined;

      let statusLabel = '';
      if (r.idealStatus) {
        statusLabel = IDEAL_STATUS_LABEL[r.idealStatus] ?? r.idealStatus;
      } else if (idealNum !== undefined) {
        statusLabel = IDEAL_STATUS_LABEL[computeIdealStatus({
          currentStock: counted,
          idealQty: idealNum,
          minQty: r.minQty,
          maxQty: r.maxQty,
        })];
      }

      const unitCost = r.unitCost ?? prod?.unitCost ?? '';
      const gapValue =
        typeof gapNum === 'number' && typeof unitCost === 'number'
          ? Math.round(gapNum * unitCost * 100) / 100
          : '';

      let alertLabel = 'Óptimo';
      if (r.idealStatus === 'critical' || (typeof gapNum === 'number' && idealNum !== undefined && counted <= 0.25 * idealNum)) {
        alertLabel = 'Crítico (Stockout / Muy bajo)';
      } else if (r.idealStatus === 'deficit' || r.needsReorder || (typeof gapNum === 'number' && gapNum < 0)) {
        alertLabel = 'Reposición Requerida';
      } else if (r.idealStatus === 'excess' || (typeof gapNum === 'number' && gapNum > 0)) {
        alertLabel = 'Exceso de Stock';
      }

      return {
        'SKU': r.sku,
        'Código de barras': displayBarcode(r.barcode),
        'Descripción': r.description,
        'Unidad': r.unit,
        'Stock Teórico Inicial': r.expected ?? '',
        'Total Entradas': totalIn,
        'Total Salidas': totalOut,
        'Stock Dinámico': dynamicStock,
        'Último Conteo Físico': counted,
        'Inventario Ideal': idealQty,
        'Brecha vs Ideal': gap,
        'Estado Nivel': statusLabel,
        'Costo Unitario': unitCost,
        'Valor Brecha': gapValue,
        'Alerta de Reposición': alertLabel,
      };
    });

    const idealHeaders = [
      'SKU',
      'Código de barras',
      'Descripción',
      'Unidad',
      'Stock Teórico Inicial',
      'Total Entradas',
      'Total Salidas',
      'Stock Dinámico',
      'Último Conteo Físico',
      'Inventario Ideal',
      'Brecha vs Ideal',
      'Estado Nivel',
      'Costo Unitario',
      'Valor Brecha',
      'Alerta de Reposición',
    ];
    addSheet(wb, 'Inventario Ideal', idealRows, idealHeaders, [0, 1]);
  }

  // ----------------- HOJA: Detalle de escaneos -----------------
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
  const hasMinMax = products.some((p) => p.minQty !== undefined || p.maxQty !== undefined);
  const rows = products
    .filter((p) => !p.barcode.startsWith('SKU:') || p.sku)
    .map((p) => ({
      'Código de barras': p.barcode.startsWith('SKU:') ? '' : displayBarcode(p.barcode),
      'No. de parte': p.sku,
      'Descripción': p.description,
      'Unidad': p.unit,
      'Existencia teórica': p.expectedQty ?? '',
      ...(hasMinMax
        ? {
            'Stock mínimo': p.minQty ?? '',
            'Stock máximo': p.maxQty ?? '',
          }
        : {}),
      'Costo unitario': p.unitCost ?? '',
      'Marca': p.brand ?? '',
      'Origen descripción': p.source,
    }));
  const wb = XLSX.utils.book_new();
  const catHeaders = [
    'Código de barras',
    'No. de parte',
    'Descripción',
    'Unidad',
    'Existencia teórica',
    ...(hasMinMax ? ['Stock mínimo', 'Stock máximo'] : []),
    'Costo unitario',
    'Marca',
    'Origen descripción',
  ];
  addSheet(wb, 'Catalogo', rows, catHeaders);
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
}

export function safeFileName(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'inventario';
}
