import { describe, expect, it } from 'vitest';
import type { CountEntry, Product } from '../../src/db/db';
import { buildReport, summarize } from '../../src/report';

describe('buildReport y summarize', () => {
  const products: Product[] = [
    { barcode: '00071153000108', sku: 'MHK-001', description: 'Guantes M', unit: 'CJA', expectedQty: 45, unitCost: 185, source: 'catalogo' },
    { barcode: '00071153000115', sku: 'MHK-002', description: 'Guantes L', unit: 'CJA', expectedQty: 30, unitCost: 185, source: 'catalogo' },
    { barcode: '00079567011003', sku: 'MHK-010', description: 'WD-40', unit: 'PZA', expectedQty: 24, unitCost: 115.5, source: 'catalogo' },
    { barcode: '00051131069008', sku: 'MHK-020', description: 'Cinta 3M', unit: 'PZA', expectedQty: 100, unitCost: 32, source: 'catalogo' },
  ];

  it('clasifica productos en ok, faltante, sobrante, no contado y no catalogado', () => {
    const counts: CountEntry[] = [
      // Exacto: 45
      { id: '1', sessionId: 's1', barcode: '00071153000108', qty: 40, counter: 'Juan', deviceId: 'd1', timestamp: 1 },
      { id: '2', sessionId: 's1', barcode: '00071153000108', qty: 5, counter: 'Pedro', deviceId: 'd2', timestamp: 2 },
      // Faltante: 25 vs 30 (-5)
      { id: '3', sessionId: 's1', barcode: '00071153000115', qty: 25, counter: 'Juan', deviceId: 'd1', timestamp: 3 },
      // Sobrante: 30 vs 24 (+6)
      { id: '4', sessionId: 's1', barcode: '00079567011003', qty: 30, counter: 'Pedro', deviceId: 'd2', timestamp: 4 },
      // Cinta (MHK-020) no se contó
      // Producto nuevo escaneado pero no en catálogo
      { id: '5', sessionId: 's1', barcode: '99999999999999', qty: 2, counter: 'Juan', deviceId: 'd1', timestamp: 5 },
    ];

    const rows = buildReport(products, counts, true);

    const guantesM = rows.find((r) => r.sku === 'MHK-001')!;
    expect(guantesM.status).toBe('ok');
    expect(guantesM.counted).toBe(45);
    expect(guantesM.diff).toBe(0);
    expect(guantesM.counters).toEqual(['Juan', 'Pedro']);
    expect(guantesM.scans).toBe(2);

    const guantesL = rows.find((r) => r.sku === 'MHK-002')!;
    expect(guantesL.status).toBe('faltante');
    expect(guantesL.diff).toBe(-5);
    expect(guantesL.diffValue).toBe(-5 * 185);

    const wd40 = rows.find((r) => r.sku === 'MHK-010')!;
    expect(wd40.status).toBe('sobrante');
    expect(wd40.diff).toBe(6);
    expect(wd40.diffValue).toBe(6 * 115.5);

    const cinta = rows.find((r) => r.sku === 'MHK-020')!;
    expect(cinta.status).toBe('no_contado');
    expect(cinta.counted).toBe(0);
    expect(cinta.diff).toBe(-100);

    const extra = rows.find((r) => r.barcode === '99999999999999')!;
    expect(extra.status).toBe('no_catalogado');
    expect(extra.counted).toBe(2);

    const s = summarize(rows);
    expect(s.totalProducts).toBe(5);
    expect(s.counted).toBe(4);
    expect(s.notCounted).toBe(1);
    expect(s.ok).toBe(1);
    expect(s.short).toBe(1);
    expect(s.over).toBe(1);
    expect(s.uncataloged).toBe(1);
    expect(s.shortValue).toBe(-925);
    expect(s.overValue).toBe(693);
    expect(s.netValue).toBe(-232);
    // Exactitud: 1 ok de 3 evaluados = 33.3%
    expect(s.accuracy).toBe(33.3);
  });

  it('permite omitir productos no contados cuando se cuenta solo una zona', () => {
    const counts: CountEntry[] = [
      { id: '1', sessionId: 's1', barcode: '00071153000108', qty: 45, counter: 'Juan', deviceId: 'd1', timestamp: 1 },
    ];
    const rows = buildReport(products, counts, false);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ok');
  });

  it('calcula alertas de stock mínimo (needsReorder), cantidad sugerida a pedir y costo estimado', () => {
    const prodsWithMinMax: Product[] = [
      {
        barcode: '00071153000108',
        sku: 'MHK-001',
        description: 'Guantes M',
        unit: 'CJA',
        expectedQty: 45,
        minQty: 15,
        maxQty: 60,
        unitCost: 100,
        source: 'catalogo',
      },
      {
        barcode: '00071153000115',
        sku: 'MHK-002',
        description: 'Guantes L',
        unit: 'CJA',
        expectedQty: 30,
        minQty: 10,
        maxQty: 40,
        unitCost: 200,
        source: 'catalogo',
      },
    ];
    const counts: CountEntry[] = [
      // MHK-001 tiene 10 <= minQty(15) -> debe pedir (60 - 10) = 50 cajas ($5,000)
      { id: 'c1', sessionId: 's1', barcode: '00071153000108', qty: 10, counter: 'Juan', deviceId: 'd1', timestamp: 1 },
      // MHK-002 tiene 25 > minQty(10) -> no requiere pedido
      { id: 'c2', sessionId: 's1', barcode: '00071153000115', qty: 25, counter: 'Pedro', deviceId: 'd2', timestamp: 2 },
    ];

    const rows = buildReport(prodsWithMinMax, counts, true);
    const r1 = rows.find((r) => r.sku === 'MHK-001')!;
    const r2 = rows.find((r) => r.sku === 'MHK-002')!;

    expect(r1.needsReorder).toBe(true);
    expect(r1.suggestedOrderQty).toBe(50);
    expect(r1.estimatedOrderCost).toBe(5000);

    expect(r2.needsReorder).toBe(false);
    expect(r2.suggestedOrderQty).toBe(0);

    const summary = summarize(rows);
    expect(summary.reorderCount).toBe(1);
    expect(summary.reorderValue).toBe(5000);
  });
});
