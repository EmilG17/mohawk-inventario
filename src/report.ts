import type { CountEntry, Product } from './db/db';

export type RowStatus = 'ok' | 'faltante' | 'sobrante' | 'no_contado' | 'no_catalogado';

export interface ReportRow {
  barcode: string;
  sku: string;
  description: string;
  unit: string;
  expected: number | undefined;
  counted: number;
  diff: number | undefined;
  unitCost: number | undefined;
  diffValue: number | undefined;
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
}

/**
 * Cruza catálogo y conteos.
 * @param includeNotCounted incluir productos del catálogo que no se contaron (diferencia = -teórico)
 */
export function buildReport(products: Product[], counts: CountEntry[], includeNotCounted = true): ReportRow[] {
  const byCode = new Map<string, { qty: number; counters: Set<string>; scans: number }>();
  for (const c of counts) {
    const a = byCode.get(c.barcode) ?? { qty: 0, counters: new Set<string>(), scans: 0 };
    a.qty += c.qty;
    a.scans++;
    if (c.counter) a.counters.add(c.counter);
    byCode.set(c.barcode, a);
  }
  const pMap = new Map(products.map((p) => [p.barcode, p]));
  const codes = new Set<string>([...byCode.keys()]);
  if (includeNotCounted) for (const p of products) if (!p.uncataloged) codes.add(p.barcode);

  const rows: ReportRow[] = [];
  for (const code of codes) {
    const p = pMap.get(code);
    const a = byCode.get(code);
    const counted = round(a?.qty ?? 0);
    const expected = p?.expectedQty;
    const diff = expected !== undefined ? round(counted - expected) : undefined;
    const unitCost = p?.unitCost;
    let status: RowStatus;
    if (!p || p.uncataloged) status = 'no_catalogado';
    else if (!a) status = 'no_contado';
    else if (diff === undefined || diff === 0) status = 'ok';
    else status = diff < 0 ? 'faltante' : 'sobrante';
    rows.push({
      barcode: code,
      sku: p?.sku ?? '',
      description: p?.description ?? '',
      unit: p?.unit ?? '',
      expected,
      counted,
      diff,
      unitCost,
      diffValue: diff !== undefined && unitCost !== undefined ? round(diff * unitCost) : undefined,
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
  };
  for (const r of rows) {
    if (r.scans > 0) s.counted++;
    s.totalUnitsCounted += r.counted;
    if (r.status === 'no_contado') s.notCounted++;
    if (r.status === 'ok') s.ok++;
    if (r.status === 'faltante') { s.short++; s.shortValue += r.diffValue ?? 0; }
    if (r.status === 'sobrante') { s.over++; s.overValue += r.diffValue ?? 0; }
    if (r.status === 'no_catalogado') s.uncataloged++;
  }
  s.netValue = round(s.shortValue + s.overValue);
  s.shortValue = round(s.shortValue);
  s.overValue = round(s.overValue);
  s.totalUnitsCounted = round(s.totalUnitsCounted);
  const evaluated = s.ok + s.short + s.over;
  s.accuracy = evaluated ? Math.round((s.ok / evaluated) * 1000) / 10 : 0;
  return s;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export const STATUS_LABEL: Record<RowStatus, string> = {
  ok: 'Correcto',
  faltante: 'Faltante',
  sobrante: 'Sobrante',
  no_contado: 'No contado',
  no_catalogado: 'No catalogado',
};
