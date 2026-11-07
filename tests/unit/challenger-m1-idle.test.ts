import { beforeAll, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  addCount,
  closeSession,
  countsForSession,
  createSession,
  getActiveSession,
  getDB,
  getMeta,
  getSession,
  listSessions,
  putProduct,
  reopenSession,
  setActiveSession,
  type Product,
} from '../../src/db/db';
import { buildReportCsv, buildReportWorkbook } from '../../src/io/exportResults';
import { buildReport, summarize } from '../../src/report';

describe('Challenger Tier 5: Idle State & Closed Sessions Consistency', () => {
  let processCode: (raw: string, origin: 'camara' | 'teclado' | 'manual') => Promise<void>;

  beforeAll(async () => {
    if (typeof window === 'undefined') {
      (globalThis as any).window = globalThis;
    }
    if (typeof document === 'undefined') {
      (globalThis as any).document = {
        addEventListener: () => {},
        removeEventListener: () => {},
        querySelector: () => null,
      };
    }
    const countModule = await import('../../src/ui/count');
    processCode = countModule.processCode;
  });

  const sampleProducts: Product[] = [
    { barcode: '00071153000108', sku: 'MHK-001', description: 'Guantes M', unit: 'CJA', expectedQty: 10, unitCost: 50, source: 'catalogo' },
    { barcode: '00071153000115', sku: 'MHK-002', description: 'Guantes L', unit: 'CJA', expectedQty: 20, unitCost: 100, source: 'catalogo' },
    { barcode: '00079567011003', sku: 'MHK-010', description: 'WD-40', unit: 'PZA', expectedQty: 5, unitCost: 200, source: 'catalogo' },
  ];

  it('calculates reports and summaries accurately for multiple closed sessions without activeSession', async () => {
    for (const p of sampleProducts) {
      await putProduct(p);
    }

    // Create 3 sessions
    const s1 = await createSession('Zona A', 'Alicia');
    await addCount({ sessionId: s1.id, barcode: '00071153000108', qty: 10, counter: 'Alicia' }); // exact
    await addCount({ sessionId: s1.id, barcode: '00071153000115', qty: 15, counter: 'Alicia' }); // short 5 (-500)
    await closeSession(s1.id);

    const s2 = await createSession('Zona B', 'Bob');
    await addCount({ sessionId: s2.id, barcode: '00071153000108', qty: 12, counter: 'Bob' }); // over 2 (+100)
    await addCount({ sessionId: s2.id, barcode: '00071153000115', qty: 20, counter: 'Bob' }); // exact
    await addCount({ sessionId: s2.id, barcode: '00079567011003', qty: 10, counter: 'Bob' }); // over 5 (+1000)
    await closeSession(s2.id);

    const s3 = await createSession('Zona C', 'Charlie');
    // 0 counts in s3
    await closeSession(s3.id);

    // Verify all sessions are closed and activeSession is null
    expect(await getActiveSession()).toBeUndefined();
    expect(await getMeta('activeSession')).toBeNull();

    const allSess = await listSessions();
    expect(allSess).toHaveLength(3);
    for (const s of allSess) {
      expect(s.closed).toBe(true);
      expect(s.closedAt).toBeDefined();
    }

    // Test S1 Report Calculation
    const countsS1 = await countsForSession(s1.id);
    expect(countsS1).toHaveLength(2);
    const rowsS1 = buildReport(sampleProducts, countsS1, true);
    const summaryS1 = summarize(rowsS1);

    expect(summaryS1.ok).toBe(1);
    expect(summaryS1.short).toBe(1);
    expect(summaryS1.notCounted).toBe(1);
    expect(summaryS1.shortValue).toBe(-500);
    expect(summaryS1.overValue).toBe(0);
    expect(summaryS1.netValue).toBe(-500);

    // Test S2 Report Calculation
    const countsS2 = await countsForSession(s2.id);
    expect(countsS2).toHaveLength(3);
    const rowsS2 = buildReport(sampleProducts, countsS2, true);
    const summaryS2 = summarize(rowsS2);

    expect(summaryS2.ok).toBe(1);
    expect(summaryS2.over).toBe(2);
    expect(summaryS2.short).toBe(0);
    expect(summaryS2.notCounted).toBe(0);
    expect(summaryS2.overValue).toBe(1100);
    expect(summaryS2.netValue).toBe(1100);

    // Test S3 Report Calculation (empty session)
    const countsS3 = await countsForSession(s3.id);
    expect(countsS3).toHaveLength(0);
    const rowsS3 = buildReport(sampleProducts, countsS3, true);
    const summaryS3 = summarize(rowsS3);

    expect(summaryS3.totalProducts).toBe(3);
    expect(summaryS3.counted).toBe(0);
    expect(summaryS3.notCounted).toBe(3);
    expect(summaryS3.accuracy).toBe(0);
  });

  it('generates compliant Excel (.xlsx) and CSV exports for closed sessions when activeSession is null', async () => {
    for (const p of sampleProducts) {
      await putProduct(p);
    }
    const session = await createSession('Inventario Cerrado 2026', 'Operador');
    await addCount({ sessionId: session.id, barcode: '00071153000108', qty: 10, counter: 'Operador' });
    await addCount({ sessionId: session.id, barcode: '00079567011003', qty: 2, counter: 'Operador' });
    await closeSession(session.id);

    const closed = (await getSession(session.id))!;
    expect(closed.closed).toBe(true);
    expect(await getActiveSession()).toBeUndefined();

    const counts = await countsForSession(closed.id);
    const rows = buildReport(sampleProducts, counts, true);
    const summary = summarize(rows);

    // Generate Excel
    const xlsxBytes = buildReportWorkbook({
      session: closed,
      rows,
      summary,
      counts,
      products: sampleProducts,
    });

    expect(xlsxBytes).toBeInstanceOf(Uint8Array);
    expect(xlsxBytes.length).toBeGreaterThan(500);

    // Inspect Excel structure
    const wb = XLSX.read(xlsxBytes, { type: 'array' });
    expect(wb.SheetNames).toEqual([
      'Resumen',
      'Conteo completo',
      'Diferencias',
      'No catalogados',
      'Detalle de escaneos',
    ]);

    const resumen = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Resumen'], { header: 1 });
    expect(resumen[1][1]).toBe('Inventario Cerrado 2026');
    expect(resumen[2][1]).toBe('Operador');

    const diferencias = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Diferencias']);
    expect(diferencias.length).toBeGreaterThanOrEqual(1);

    // Generate CSV
    const csv = buildReportCsv(rows);
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(csv).toContain('Código de barras');
    expect(csv).toContain('071153000108');
    expect(csv).toContain('Guantes M');

    // Verify activeSession is STILL null
    expect(await getActiveSession()).toBeUndefined();
  });

  it('switching between multiple closed sessions and reopening preserves isolation', async () => {
    const s1 = await createSession('Sesión Alfa', 'User A');
    await closeSession(s1.id);
    const s2 = await createSession('Sesión Beta', 'User B');
    await closeSession(s2.id);

    expect(await getActiveSession()).toBeUndefined();

    // Reopen s1
    await reopenSession(s1.id);
    let active = await getActiveSession();
    expect(active?.id).toBe(s1.id);
    expect(active?.closed).toBe(false);

    // s2 must remain closed
    const s2Check = await getSession(s2.id);
    expect(s2Check?.closed).toBe(true);

    // Switch active to s2 without reopening (simulate setActiveSession)
    await setActiveSession(s2.id);
    active = await getActiveSession();
    expect(active?.id).toBe(s2.id);

    // Close s2
    await closeSession(s2.id);
    expect(await getActiveSession()).toBeUndefined();
  });

  it('hardware wedge or scanner inputs while idle (no active session) MUST NOT corrupt database', async () => {
    // Reset and ensure no active session
    await setActiveSession(null);
    expect(await getActiveSession()).toBeUndefined();

    const db = await getDB();
    const initialCounts = await db.getAll('counts');
    expect(initialCounts).toHaveLength(0);

    // Attempt hardware wedge input
    await processCode('00071153000108', 'teclado');

    // Attempt camera scan input
    await processCode('00071153000115', 'camara');

    // Attempt manual search input
    await processCode('00079567011003', 'manual');

    // Attempt uncataloged barcode
    await processCode('750105531234', 'teclado');

    // Attempt SKU-prefixed input
    await processCode('SKU:TEST-ITEM', 'manual');

    // Empirically verify counts store in IndexedDB
    const finalCounts = await db.getAll('counts');
    expect(finalCounts).toHaveLength(0);

    // Empirically verify sessions store was not modified
    const sessions = await db.getAll('sessions');
    expect(sessions).toHaveLength(0);

    // Empirically verify activeSession metadata remains null
    expect(await getMeta('activeSession')).toBeNull();
  });
});
