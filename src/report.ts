import type { CountEntry, Product } from './db/db';
import type { Movement } from './db/movements';

export type RowStatus = 'ok' | 'faltante' | 'sobrante' | 'no_contado' | 'no_catalogado';
export type IdealStatus = 'optimal' | 'deficit' | 'critical' | 'excess';

export interface ReportRow {
  barcode: string;
  sku: string;
  description: string;
  unit: string;
  expected: number | undefined;
  // Extended Movement Integration:
  totalIn?: number;
  totalOut?: number;
  netMovements?: number;
  dynamicExpected?: number;
  dynamicDiff?: number;
  // Extended Ideal Inventory Integration:
  idealQty?: number;
  idealGap?: number;
  idealStatus?: IdealStatus;
  // Existing fields:
  minQty?: number;
  maxQty?: number;
  counted: number;
  diff: number | undefined;
  unitCost: number | undefined;
  diffValue: number | undefined;
  needsReorder?: boolean;
  suggestedOrderQty?: number;
  estimatedOrderCost?: number;
  status: RowStatus;
  counters: string[];
  scans: number;
  source: Product['source'] | undefined;
}

export interface ReportSummary {
  totalProducts: number;
  counted: number;
  notCounted: number;
  ok: number;
  short: number;
  over: number;
  uncataloged: number;
  totalUnitsCounted: number;
  shortValue: number;
  overValue: number;
  netValue: number;
  accuracy: number; // % de productos contados sin diferencia
  reorderCount: number;
  reorderValue: number;
}

export interface BuildReportOptions {
  includeNotCounted?: boolean;
  movementsBySku?: Map<string, { totalIn: number; totalOut: number }>;
  idealLevels?: Record<string, number>;
}

export interface MovementsKpiSummary {
  // Movements Ledger KPIs
  totalMovements: number;
  totalEntriesCount: number;
  totalExitsCount: number;
  totalUnitsIn: number;
  totalUnitsOut: number;
  netMovementUnits: number;
  totalValueIn: number;
  totalValueOut: number;
  netMovementValue: number;

  // Ideal Inventory KPIs
  totalSkusTracked: number;
  optimalCount: number;
  deficitCount: number;
  criticalCount: number;
  excessCount: number;
  idealFulfillmentRate: number; // 0 - 100%
  totalIdealUnitsGap: number;   // Missing units across deficit & critical items
  totalExcessUnits: number;     // Excess units across surplus items
  estimatedRestockCost: number; // Investment required to bring all items to ideal
}

/**
 * Determina el estado operacional respecto al inventario ideal:
 * - critical: stock agotado o en/bajo umbral crítico (<= minQty o <= 25% de ideal)
 * - deficit: stock menor a la cantidad ideal objetivo
 * - excess: stock mayor al umbral máximo permitido (maxQty ?? idealQty)
 * - optimal: stock equilibrado en el rango ideal
 */
export function computeIdealStatus(params: {
  currentStock: number;
  idealQty: number;
  minQty?: number;
  maxQty?: number;
}): IdealStatus {
  const { currentStock, idealQty, minQty, maxQty } = params;
  if (idealQty <= 0 && currentStock === 0) return 'optimal';

  // 1. Critical: stockout o bajo umbral mínimo de seguridad (<= minQty o <= 25% de ideal)
  const criticalThreshold = minQty !== undefined ? minQty : 0.25 * idealQty;
  if (currentStock <= 0 || currentStock <= criticalThreshold) {
    return 'critical';
  }

  // 2. Deficit: por debajo del inventario ideal objetivo
  if (currentStock < idealQty) {
    return 'deficit';
  }

  // 3. Excess: por encima del nivel máximo o del nivel ideal
  const excessThreshold = maxQty !== undefined && maxQty >= idealQty ? maxQty : idealQty;
  if (currentStock > excessThreshold) {
    return 'excess';
  }

  // 4. Optimal: dentro de los límites ideales
  return 'optimal';
}

/**
 * Cruza catálogo, conteos físicos y opcionalmente movimientos y niveles ideales.
 * @param optionsOrIncludeNotCounted booleano para compatibilidad previa o BuildReportOptions
 */
export function buildReport(
  products: Product[],
  counts: CountEntry[],
  optionsOrIncludeNotCounted: boolean | BuildReportOptions = true,
): ReportRow[] {
  const opts: BuildReportOptions =
    typeof optionsOrIncludeNotCounted === 'boolean'
      ? { includeNotCounted: optionsOrIncludeNotCounted }
      : optionsOrIncludeNotCounted;

  const includeNotCounted = opts.includeNotCounted ?? true;
  const movementsBySku = opts.movementsBySku;
  const idealLevels = opts.idealLevels;

  const pMap = new Map<string, Product>();
  const aliasToCanonical = new Map<string, string>();

  // Registrar primero productos catalogados oficiales para que tengan prioridad de conciliación
  const sortedProds = [...products].sort((a, b) => Number(Boolean(a.uncataloged)) - Number(Boolean(b.uncataloged)));
  for (const p of sortedProds) {
    pMap.set(p.barcode, p);
    aliasToCanonical.set(p.barcode, p.barcode);
    aliasToCanonical.set(p.barcode.toUpperCase(), p.barcode);
    const noZeros = p.barcode.replace(/^0+/, '');
    if (noZeros && !aliasToCanonical.has(noZeros)) {
      aliasToCanonical.set(noZeros, p.barcode);
    }
    if (p.sku) {
      const upperSku = p.sku.trim().toUpperCase();
      if (upperSku) {
        if (!aliasToCanonical.has(upperSku)) aliasToCanonical.set(upperSku, p.barcode);
        if (!aliasToCanonical.has(`SKU:${upperSku}`)) aliasToCanonical.set(`SKU:${upperSku}`, p.barcode);
      }
    }
  }

  const resolveCanonicalCode = (raw: string): string => {
    const clean = (raw || '').trim();
    if (!clean) return raw;
    if (aliasToCanonical.has(clean)) return aliasToCanonical.get(clean)!;
    const upper = clean.toUpperCase();
    if (aliasToCanonical.has(upper)) return aliasToCanonical.get(upper)!;
    const noZeros = clean.replace(/^0+/, '');
    if (noZeros && aliasToCanonical.has(noZeros)) return aliasToCanonical.get(noZeros)!;
    if (upper.startsWith('SKU:')) {
      const bare = upper.slice(4).trim();
      if (aliasToCanonical.has(bare)) return aliasToCanonical.get(bare)!;
    }
    return clean;
  };

  const byCode = new Map<string, { qty: number; counters: Set<string>; scans: number }>();
  for (const c of counts) {
    const code = resolveCanonicalCode(c.barcode);
    const a = byCode.get(code) ?? { qty: 0, counters: new Set<string>(), scans: 0 };
    a.qty += c.qty;
    a.scans++;
    if (c.counter) a.counters.add(c.counter);
    byCode.set(code, a);
  }

  const codes = new Set<string>([...byCode.keys()]);
  if (includeNotCounted) {
    for (const p of products) {
      if (!p.uncataloged) {
        codes.add(p.barcode);
      }
    }
  }

  // Normalizar mapas de movimientos y niveles ideales a mayúsculas para búsqueda resiliente
  const normMovMap = new Map<string, { totalIn: number; totalOut: number }>();
  if (movementsBySku) {
    for (const [k, v] of movementsBySku.entries()) {
      normMovMap.set(k.trim().toUpperCase(), v);
    }
  }
  const normIdealMap: Record<string, number> = {};
  if (idealLevels) {
    for (const [k, v] of Object.entries(idealLevels)) {
      normIdealMap[k.trim().toUpperCase()] = v;
    }
  }

  const rows: ReportRow[] = [];
  for (const code of codes) {
    const p = pMap.get(code);
    const a = byCode.get(code);
    const counted = round(a?.qty ?? 0);
    const expected = p?.expectedQty;
    const minQty = p?.minQty;
    const maxQty = p?.maxQty;
    const diff = expected !== undefined ? round(counted - expected) : undefined;
    const unitCost = p?.unitCost;
    const needsReorder = minQty !== undefined && counted <= minQty;
    let suggestedOrderQty = 0;
    if (needsReorder && minQty !== undefined) {
      const target =
        maxQty !== undefined && maxQty > minQty
          ? maxQty
          : expected !== undefined && expected > minQty
            ? expected
            : Math.max(minQty * 2, minQty + 1);
      suggestedOrderQty = Math.max(1, round(target - counted));
    }
    const estimatedOrderCost =
      needsReorder && unitCost !== undefined ? round(suggestedOrderQty * unitCost) : undefined;

    let status: RowStatus;
    if (!p || p.uncataloged) status = 'no_catalogado';
    else if (!a) status = 'no_contado';
    else if (diff === undefined || diff === 0) status = 'ok';
    else status = diff < 0 ? 'faltante' : 'sobrante';

    // ---------------- Movements Integration ----------------
    const sku = p?.sku ?? '';
    const skuUpper = sku.trim().toUpperCase();
    const codeUpper = code.trim().toUpperCase();
    const mov =
      (skuUpper ? normMovMap.get(skuUpper) : undefined) ??
      (codeUpper ? normMovMap.get(codeUpper) : undefined);

    const totalIn = mov ? round(mov.totalIn) : undefined;
    const totalOut = mov ? round(mov.totalOut) : undefined;
    const netMovements = mov ? round(mov.totalIn - mov.totalOut) : undefined;

    let dynamicExpected: number | undefined;
    let dynamicDiff: number | undefined;
    if (mov !== undefined || expected !== undefined) {
      const baseExpected = expected ?? 0;
      const inQty = totalIn ?? 0;
      const outQty = totalOut ?? 0;
      dynamicExpected = round(baseExpected + inQty - outQty);
      dynamicDiff = round(counted - dynamicExpected);
    }

    // ---------------- Ideal Inventory Integration ----------------
    const configuredIdeal =
      skuUpper && normIdealMap[skuUpper] !== undefined
        ? normIdealMap[skuUpper]
        : codeUpper && normIdealMap[codeUpper] !== undefined
          ? normIdealMap[codeUpper]
          : undefined;

    const idealQty =
      configuredIdeal !== undefined
        ? configuredIdeal
        : maxQty !== undefined
          ? maxQty
          : expected;

    let idealGap: number | undefined;
    let idealStatus: IdealStatus | undefined;
    if (idealQty !== undefined) {
      idealGap = round(counted - idealQty);
      idealStatus = computeIdealStatus({
        currentStock: counted,
        idealQty,
        minQty,
        maxQty,
      });
    }

    rows.push({
      barcode: code,
      sku,
      description: p?.description ?? '',
      unit: p?.unit ?? '',
      expected,
      totalIn,
      totalOut,
      netMovements,
      dynamicExpected,
      dynamicDiff,
      idealQty,
      idealGap,
      idealStatus,
      ...(minQty !== undefined ? { minQty } : {}),
      ...(maxQty !== undefined ? { maxQty } : {}),
      counted,
      diff,
      unitCost,
      diffValue: diff !== undefined && unitCost !== undefined ? round(diff * unitCost) : undefined,
      needsReorder,
      suggestedOrderQty,
      ...(estimatedOrderCost !== undefined ? { estimatedOrderCost } : {}),
      status,
      counters: a ? [...a.counters].sort() : [],
      scans: a?.scans ?? 0,
      source: p?.source,
    });
  }

  const order: Record<RowStatus, number> = { faltante: 0, sobrante: 1, no_catalogado: 2, no_contado: 3, ok: 4 };
  return rows.sort(
    (x, y) => order[x.status] - order[y.status] || Math.abs(y.diffValue ?? 0) - Math.abs(x.diffValue ?? 0) ||
      x.description.localeCompare(y.description),
  );
}

export function summarize(rows: ReportRow[]): ReportSummary {
  const s: ReportSummary = {
    totalProducts: rows.length, counted: 0, notCounted: 0, ok: 0, short: 0, over: 0, uncataloged: 0,
    totalUnitsCounted: 0, shortValue: 0, overValue: 0, netValue: 0, accuracy: 0,
    reorderCount: 0, reorderValue: 0,
  };
  for (const r of rows) {
    if (r.scans > 0) s.counted++;
    s.totalUnitsCounted += r.counted;
    if (r.status === 'no_contado') s.notCounted++;
    if (r.status === 'ok') s.ok++;
    if (r.status === 'faltante') { s.short++; s.shortValue += r.diffValue ?? 0; }
    if (r.status === 'sobrante') { s.over++; s.overValue += r.diffValue ?? 0; }
    if (r.status === 'no_catalogado') s.uncataloged++;
    if (r.needsReorder) {
      s.reorderCount++;
      s.reorderValue += r.estimatedOrderCost ?? 0;
    }
  }
  s.netValue = round(s.shortValue + s.overValue);
  s.shortValue = round(s.shortValue);
  s.overValue = round(s.overValue);
  s.reorderValue = round(s.reorderValue);
  s.totalUnitsCounted = round(s.totalUnitsCounted);
  const evaluated = s.ok + s.short + s.over;
  s.accuracy = evaluated ? Math.round((s.ok / evaluated) * 1000) / 10 : 0;
  return s;
}

export function computeMovementsKpis(
  movements: Movement[],
  rows: ReportRow[],
): MovementsKpiSummary {
  const costMap = new Map<string, number>();
  for (const r of rows) {
    if (r.sku && r.unitCost !== undefined) {
      costMap.set(r.sku, r.unitCost);
    }
    if (r.barcode && r.unitCost !== undefined) {
      costMap.set(r.barcode, r.unitCost);
    }
  }

  let totalEntriesCount = 0;
  let totalExitsCount = 0;
  let totalUnitsIn = 0;
  let totalUnitsOut = 0;
  let totalValueIn = 0;
  let totalValueOut = 0;

  for (const m of movements) {
    const cost = m.cost ?? costMap.get(m.sku) ?? (m.barcode ? costMap.get(m.barcode) : undefined) ?? 0;
    if (m.type === 'IN') {
      totalEntriesCount++;
      totalUnitsIn += m.quantity;
      totalValueIn += m.quantity * cost;
    } else if (m.type === 'OUT') {
      totalExitsCount++;
      totalUnitsOut += m.quantity;
      totalValueOut += m.quantity * cost;
    }
  }

  let optimalCount = 0;
  let deficitCount = 0;
  let criticalCount = 0;
  let excessCount = 0;
  let totalIdealUnitsGap = 0;
  let totalExcessUnits = 0;
  let estimatedRestockCost = 0;
  let totalSkusTracked = 0;

  for (const r of rows) {
    if (r.idealQty === undefined) continue;
    totalSkusTracked++;
    const gap = r.idealGap ?? 0;
    const cost = r.unitCost ?? 0;

    if (r.idealStatus === 'critical') {
      criticalCount++;
      const needed = Math.max(0, -gap);
      totalIdealUnitsGap += needed;
      estimatedRestockCost += needed * cost;
    } else if (r.idealStatus === 'deficit') {
      deficitCount++;
      const needed = Math.max(0, -gap);
      totalIdealUnitsGap += needed;
      estimatedRestockCost += needed * cost;
    } else if (r.idealStatus === 'optimal') {
      optimalCount++;
    } else if (r.idealStatus === 'excess') {
      excessCount++;
      totalExcessUnits += Math.max(0, gap);
    }
  }

  const idealFulfillmentRate =
    totalSkusTracked > 0 ? Math.round((optimalCount / totalSkusTracked) * 1000) / 10 : 0;

  return {
    totalMovements: movements.length,
    totalEntriesCount,
    totalExitsCount,
    totalUnitsIn: round(totalUnitsIn),
    totalUnitsOut: round(totalUnitsOut),
    netMovementUnits: round(totalUnitsIn - totalUnitsOut),
    totalValueIn: Math.round(totalValueIn * 100) / 100,
    totalValueOut: Math.round(totalValueOut * 100) / 100,
    netMovementValue: Math.round((totalValueIn - totalValueOut) * 100) / 100,
    totalSkusTracked,
    optimalCount,
    deficitCount,
    criticalCount,
    excessCount,
    idealFulfillmentRate,
    totalIdealUnitsGap: round(totalIdealUnitsGap),
    totalExcessUnits: round(totalExcessUnits),
    estimatedRestockCost: Math.round(estimatedRestockCost * 100) / 100,
  };
}

export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export const STATUS_LABEL: Record<RowStatus, string> = {
  ok: 'Correcto',
  faltante: 'Faltante',
  sobrante: 'Sobrante',
  no_contado: 'No contado',
  no_catalogado: 'No catalogado',
};
