import { describe, expect, it } from 'vitest';
import { countsForSession, createSession } from '../../src/db/db';
import {
  buildReportCsv,
  buildReportWorkbook,
  type CountFile,
} from '../../src/io/exportResults';
import {
  mergeCountFiles,
  parseAppFile,
  parseTechnicianReportBuffer,
  unifyTechnicianReports,
} from '../../src/io/mergeCounts';
import { buildReport, summarize } from '../../src/report';

describe('mergeCountFiles & Unificación de Reportes de Técnicos', () => {
  it('combina conteos de varios dispositivos sin duplicar al importar dos veces', async () => {
    const session = await createSession('Inventario Mohawk Consolidado', 'Supervisor');

    const fileA: CountFile = {
      app: 'mohawk-inventario',
      version: 1,
      kind: 'conteo',
      exportedAt: new Date().toISOString(),
      deviceId: 'dev-A',
      session: { id: 'sa', name: 'Sesion A', counter: 'Juan', createdAt: 1, closed: false },
      counts: [
        { id: 'scan-1', sessionId: 'sa', barcode: '00071153000108', qty: 10, counter: 'Juan', deviceId: 'dev-A', timestamp: 100 },
        { id: 'scan-2', sessionId: 'sa', barcode: '00071153000108', qty: 5, counter: 'Juan', deviceId: 'dev-A', timestamp: 110 },
      ],
      products: [],
    };

    const fileB: CountFile = {
      app: 'mohawk-inventario',
      version: 1,
      kind: 'conteo',
      exportedAt: new Date().toISOString(),
      deviceId: 'dev-B',
      session: { id: 'sb', name: 'Sesion B', counter: 'Pedro', createdAt: 2, closed: false },
      counts: [
        { id: 'scan-3', sessionId: 'sb', barcode: '00071153000108', qty: 20, counter: 'Pedro', deviceId: 'dev-B', timestamp: 200 },
        { id: 'scan-4', sessionId: 'sb', barcode: '00079567011003', qty: 12, counter: 'Pedro', deviceId: 'dev-B', timestamp: 210 },
      ],
      products: [
        { barcode: '00079567011003', sku: '', description: 'WD-40 obtenido en línea', unit: '', source: 'UPCitemdb' },
      ],
    };

    // Primera consolidación
    const res1 = await mergeCountFiles(session.id, [fileA, fileB]);
    expect(res1.added).toBe(4);
    expect(res1.duplicates).toBe(0);
    expect(res1.productsAdded).toBe(1);
    expect(res1.counters).toEqual(['Juan', 'Pedro']);

    let saved = await countsForSession(session.id);
    expect(saved).toHaveLength(4);
    const totalGuantes = saved.filter((c) => c.barcode === '00071153000108').reduce((a, c) => a + c.qty, 0);
    expect(totalGuantes).toBe(35); // 10 + 5 + 20

    // Si el supervisor vuelve a importar el archivo A por error
    const res2 = await mergeCountFiles(session.id, [fileA]);
    expect(res2.added).toBe(0);
    expect(res2.duplicates).toBe(2);

    saved = await countsForSession(session.id);
    expect(saved).toHaveLength(4); // sigue siendo 4, no duplicó cantidades
  });

  it('valida el formato del archivo JSON importado', () => {
    expect(() => parseAppFile('not json')).toThrow(/válido/);
    expect(() => parseAppFile(JSON.stringify({ app: 'otro', version: 1 }))).toThrow(/Mohawk/);
    expect(() => parseAppFile(JSON.stringify({ app: 'mohawk-inventario', version: 1, kind: 'desconocido' }))).toThrow(/desconocido/);
  });

  it('unifica reportes de técnicos exportados como Excel (.xlsx) y CSV (.csv) en una nueva sesión unificada', async () => {
    const products = [
      { barcode: '00071153000108', sku: 'MHK-001', description: 'Guantes Nitrilo', unit: 'PAR', expectedQty: 50, source: 'catalogo' as const },
      { barcode: '00079567011003', sku: 'MHK-002', description: 'Lubricante WD-40', unit: 'PZA', expectedQty: 20, source: 'catalogo' as const },
    ];

    // Técnico 1 genera un reporte Excel (.xlsx)
    const sessTech1 = { id: 't1', name: 'Conteo Zona Norte', counter: 'Técnico Carlos', createdAt: 1700000000000, closed: true };
    const countsTech1 = [
      { id: 'c1', sessionId: 't1', barcode: '00071153000108', qty: 18, counter: 'Técnico Carlos', deviceId: 'dev1', timestamp: 1700000001000 },
    ];
    const rowsTech1 = buildReport(products, countsTech1, true);
    const xlsxBytes = buildReportWorkbook({
      session: sessTech1,
      rows: rowsTech1,
      summary: summarize(rowsTech1),
      counts: countsTech1,
      products,
    });

    // Técnico 2 genera un reporte CSV (.csv)
    const countsTech2 = [
      { id: 'c2', sessionId: 't2', barcode: '00071153000108', qty: 12, counter: 'Técnica Elena', deviceId: 'dev2', timestamp: 1700000002000 },
      { id: 'c3', sessionId: 't2', barcode: '00079567011003', qty: 9, counter: 'Técnica Elena', deviceId: 'dev2', timestamp: 1700000003000 },
    ];
    const rowsTech2 = buildReport(products, countsTech2, true);
    const csvText = buildReportCsv(rowsTech2);
    const csvBytes = new TextEncoder().encode(csvText);

    const parsedXlsx = await parseTechnicianReportBuffer(xlsxBytes.buffer as ArrayBuffer, 'reporte_carlos.xlsx');
    const parsedCsv = await parseTechnicianReportBuffer(csvBytes.buffer as ArrayBuffer, 'reporte_elena.csv');

    expect(parsedXlsx.counts).toHaveLength(1);
    expect(parsedXlsx.counts[0].counter).toBe('Técnico Carlos');
    expect(parsedXlsx.counts[0].qty).toBe(18);

    expect(parsedCsv.counts).toHaveLength(2);

    const unified = await unifyTechnicianReports({
      targetMode: 'new',
      newSessionName: 'Reporte Maestro Planta',
      supervisorName: 'Supervisor General',
      files: [parsedXlsx, parsedCsv],
    });

    expect(unified.session.name).toBe('Reporte Maestro Planta');
    expect(unified.added).toBe(3);
    expect(unified.counters).toContain('Técnico Carlos');
    expect(unified.counters).toContain('Técnica Elena');

    const unifiedCounts = await countsForSession(unified.session.id);
    const guantesSum = unifiedCounts
      .filter((c) => c.barcode === '00071153000108')
      .reduce((acc, c) => acc + c.qty, 0);
    expect(guantesSum).toBe(30); // 18 de Carlos + 12 de Elena
  });
});

