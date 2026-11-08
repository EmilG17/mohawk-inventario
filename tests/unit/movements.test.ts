import { beforeEach, describe, expect, it } from 'vitest';
import type { CountEntry, Product } from '../../src/db/db';
import {
  clearIdealLevels,
  clearMovements,
  deleteMovement,
  getAllMovements,
  getIdealLevels,
  getIdealQtyForSku,
  getMovement,
  getMovementSummariesBySku,
  getMovementSummary,
  importMovements,
  listMovements,
  recordEntry,
  recordExit,
  recordMovement,
  saveAllMovements,
  setIdealLevel,
  setIdealLevels,
  type Movement,
} from '../../src/db/movements';
import {
  buildReport,
  computeIdealStatus,
  computeMovementsKpis,
  round,
} from '../../src/report';

describe('Movements DB Ledger (src/db/movements.ts)', () => {
  beforeEach(async () => {
    await clearMovements();
    await clearIdealLevels();
  });

  describe('Validation & Error Handling', () => {
    it('throws error when quantity is zero, negative, or not a number', async () => {
      await expect(
        recordMovement({ sku: 'MHK-001', type: 'IN', quantity: 0, technicianOrSupplier: 'Acme', machineOrArea: 'A1', folio: 'F1' }),
      ).rejects.toThrow('La cantidad del movimiento debe ser un número positivo mayor a 0');

      await expect(
        recordMovement({ sku: 'MHK-001', type: 'IN', quantity: -5, technicianOrSupplier: 'Acme', machineOrArea: 'A1', folio: 'F1' }),
      ).rejects.toThrow('La cantidad del movimiento debe ser un número positivo mayor a 0');

      await expect(
        recordMovement({ sku: 'MHK-001', type: 'IN', quantity: NaN, technicianOrSupplier: 'Acme', machineOrArea: 'A1', folio: 'F1' }),
      ).rejects.toThrow('La cantidad del movimiento debe ser un número positivo mayor a 0');
    });

    it('throws error when SKU is empty or whitespace only', async () => {
      await expect(
        recordMovement({ sku: '', type: 'IN', quantity: 10, technicianOrSupplier: 'Acme', machineOrArea: 'A1', folio: 'F1' }),
      ).rejects.toThrow('El movimiento requiere un SKU válido');

      await expect(
        recordMovement({ sku: '   ', type: 'OUT', quantity: 5, technicianOrSupplier: 'Tech1', machineOrArea: 'A1', folio: 'F1' }),
      ).rejects.toThrow('El movimiento requiere un SKU válido');
    });

    it('throws error when movement type is invalid', async () => {
      await expect(
        recordMovement({
          sku: 'MHK-001',
          // @ts-expect-error testing invalid type
          type: 'TRANSFER',
          quantity: 10,
          technicianOrSupplier: 'Acme',
          machineOrArea: 'A1',
          folio: 'F1',
        }),
      ).rejects.toThrow('El tipo de movimiento debe ser IN o OUT');
    });
  });

  describe('recordEntry & recordExit', () => {
    it('records entry with default machineOrArea "Almacén Central" and normalizes SKU', async () => {
      const entry = await recordEntry({
        sku: '  mhk-001  ',
        quantity: 15.1234,
        supplier: 'Proveedor Mohawk S.A.',
        folio: 'FAC-9081',
        cost: 45.6789,
        barcode: '00071153000108',
      });

      expect(entry.id).toBeDefined();
      expect(entry.sku).toBe('MHK-001');
      expect(entry.type).toBe('IN');
      expect(entry.quantity).toBe(15.123);
      expect(entry.cost).toBe(45.679);
      expect(entry.technicianOrSupplier).toBe('Proveedor Mohawk S.A.');
      expect(entry.machineOrArea).toBe('Almacén Central');
      expect(entry.folio).toBe('FAC-9081');
      expect(entry.barcode).toBe('00071153000108');
      expect(entry.deviceId).toBeDefined();

      const all = await getAllMovements();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(entry.id);
    });

    it('records exit with default machineOrArea "Línea de Producción" and custom technician', async () => {
      const exit = await recordExit({
        sku: 'MHK-002',
        quantity: 4,
        technician: 'Carlos Gómez',
        folio: 'VALE-100',
        machineOrArea: 'Torno CNC #3',
        notes: 'Urgente por paro de línea',
      });

      expect(exit.sku).toBe('MHK-002');
      expect(exit.type).toBe('OUT');
      expect(exit.quantity).toBe(4);
      expect(exit.technicianOrSupplier).toBe('Carlos Gómez');
      expect(exit.machineOrArea).toBe('Torno CNC #3');
      expect(exit.notes).toBe('Urgente por paro de línea');

      const all = await getAllMovements();
      expect(all).toHaveLength(1);
      expect(all[0].type).toBe('OUT');
    });

    it('supports technicianOrSupplier alias in recordEntry and recordExit', async () => {
      const e = await recordEntry({
        sku: 'MHK-010',
        quantity: 5,
        technicianOrSupplier: 'Ferretería Industrial',
      });
      expect(e.technicianOrSupplier).toBe('Ferretería Industrial');

      const x = await recordExit({
        sku: 'MHK-010',
        quantity: 2,
        technicianOrSupplier: 'María López',
      });
      expect(x.technicianOrSupplier).toBe('María López');
    });
  });

  describe('CRUD Operations', () => {
    it('returns empty array when ledger is empty', async () => {
      const all = await getAllMovements();
      expect(all).toEqual([]);
    });

    it('fetches single movement by id', async () => {
      const m = await recordEntry({ sku: 'MHK-001', quantity: 10 });
      const found = await getMovement(m.id);
      expect(found).toBeDefined();
      expect(found?.sku).toBe('MHK-001');

      const missing = await getMovement('non-existent-id');
      expect(missing).toBeUndefined();
    });

    it('deletes movement by id and updates ledger', async () => {
      const m1 = await recordEntry({ sku: 'MHK-001', quantity: 10 });
      const m2 = await recordExit({ sku: 'MHK-002', quantity: 2 });

      expect(await deleteMovement(m1.id)).toBe(true);
      expect(await deleteMovement('not-found')).toBe(false);

      const all = await getAllMovements();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(m2.id);
    });

    it('clears all movements', async () => {
      await recordEntry({ sku: 'MHK-001', quantity: 10 });
      await recordExit({ sku: 'MHK-002', quantity: 5 });
      expect(await getAllMovements()).toHaveLength(2);

      await clearMovements();
      expect(await getAllMovements()).toHaveLength(0);
    });

    it('saveAllMovements completely overwrites the ledger', async () => {
      await recordEntry({ sku: 'MHK-001', quantity: 10 });
      const custom: Movement[] = [
        {
          id: 'custom-1',
          sku: 'MHK-999',
          type: 'IN',
          quantity: 100,
          timestamp: 1234567890,
          technicianOrSupplier: 'Vendor X',
          machineOrArea: 'Área B',
          folio: 'F-1',
        },
      ];
      await saveAllMovements(custom);

      const all = await getAllMovements();
      expect(all).toEqual(custom);
    });
  });

  describe('listMovements & Advanced Filtering', () => {
    beforeEach(async () => {
      await recordMovement({
        id: 'm1',
        sku: 'MHK-001',
        barcode: '111111111111',
        type: 'IN',
        quantity: 50,
        timestamp: 1000,
        technicianOrSupplier: 'Grainger México',
        machineOrArea: 'Bodega Principal',
        folio: 'OC-1001',
        notes: 'Lote A1',
      });
      await recordMovement({
        id: 'm2',
        sku: 'MHK-001',
        barcode: '111111111111',
        type: 'OUT',
        quantity: 10,
        timestamp: 2000,
        technicianOrSupplier: 'Juan Pérez',
        machineOrArea: 'Ensamble 1',
        folio: 'VALE-501',
        notes: 'Mantenimiento preventivo',
      });
      await recordMovement({
        id: 'm3',
        sku: 'MHK-002',
        barcode: '222222222222',
        type: 'IN',
        quantity: 20,
        timestamp: 3000,
        technicianOrSupplier: '3M Directo',
        machineOrArea: 'Bodega Principal',
        folio: 'OC-1002',
        notes: 'Cintas industriales',
      });
      await recordMovement({
        id: 'm4',
        sku: 'MHK-002',
        barcode: '222222222222',
        type: 'OUT',
        quantity: 5,
        timestamp: 4000,
        technicianOrSupplier: 'Carlos Ruiz',
        machineOrArea: 'Troquelado 2',
        folio: 'VALE-502',
      });
    });

    it('returns all movements sorted by timestamp descending by default', async () => {
      const list = await listMovements();
      expect(list).toHaveLength(4);
      expect(list[0].id).toBe('m4');
      expect(list[1].id).toBe('m3');
      expect(list[2].id).toBe('m2');
      expect(list[3].id).toBe('m1');
    });

    it('filters by SKU', async () => {
      const list = await listMovements({ sku: 'mhk-001' });
      expect(list).toHaveLength(2);
      expect(list.map((m) => m.id)).toEqual(['m2', 'm1']);
    });

    it('filters by type IN or OUT', async () => {
      const ins = await listMovements({ type: 'IN' });
      expect(ins).toHaveLength(2);
      expect(ins.map((m) => m.id)).toEqual(['m3', 'm1']);

      const outs = await listMovements({ type: 'OUT' });
      expect(outs).toHaveLength(2);
      expect(outs.map((m) => m.id)).toEqual(['m4', 'm2']);
    });

    it('filters by technicianOrSupplier (case-insensitive substring)', async () => {
      const list = await listMovements({ technicianOrSupplier: 'grainger' });
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('m1');

      const tech = await listMovements({ technicianOrSupplier: 'pÉrEz' });
      expect(tech).toHaveLength(1);
      expect(tech[0].id).toBe('m2');
    });

    it('filters by machineOrArea', async () => {
      const list = await listMovements({ machineOrArea: 'bodega' });
      expect(list).toHaveLength(2);
      expect(list.map((m) => m.id)).toEqual(['m3', 'm1']);
    });

    it('filters by folio', async () => {
      const list = await listMovements({ folio: 'vale' });
      expect(list).toHaveLength(2);
      expect(list.map((m) => m.id)).toEqual(['m4', 'm2']);
    });

    it('filters by startDate and endDate range', async () => {
      const range = await listMovements({ startDate: 1500, endDate: 3500 });
      expect(range).toHaveLength(2);
      expect(range.map((m) => m.id)).toEqual(['m3', 'm2']);
    });

    it('filters by universal search query across multiple fields', async () => {
      // By notes
      const byNotes = await listMovements({ search: 'preventivo' });
      expect(byNotes).toHaveLength(1);
      expect(byNotes[0].id).toBe('m2');

      // By barcode
      const byBarcode = await listMovements({ search: '222222222222' });
      expect(byBarcode).toHaveLength(2);
      expect(byBarcode.map((m) => m.id)).toEqual(['m4', 'm3']);

      // By folio
      const byFolio = await listMovements({ search: 'oc-1001' });
      expect(byFolio).toHaveLength(1);
      expect(byFolio[0].id).toBe('m1');
    });

    it('combines multiple filter parameters simultaneously', async () => {
      const combined = await listMovements({
        sku: 'MHK-001',
        type: 'OUT',
        machineOrArea: 'Ensamble',
      });
      expect(combined).toHaveLength(1);
      expect(combined[0].id).toBe('m2');
    });
  });

  describe('importMovements', () => {
    it('appends movements avoiding duplicate IDs and skipping invalid records', async () => {
      await recordMovement({
        id: 'dup-1',
        sku: 'MHK-001',
        type: 'IN',
        quantity: 10,
        technicianOrSupplier: 'A',
        machineOrArea: 'B',
        folio: 'F',
      });

      const incoming: Movement[] = [
        // Duplicate ID
        { id: 'dup-1', sku: 'MHK-001', type: 'IN', quantity: 99, timestamp: 1, technicianOrSupplier: 'A', machineOrArea: 'B', folio: 'F' },
        // Valid new item
        { id: 'new-2', sku: 'MHK-002', type: 'OUT', quantity: 5, timestamp: 2, technicianOrSupplier: 'A', machineOrArea: 'B', folio: 'F' },
        // Invalid item (quantity 0)
        { id: 'inv-3', sku: 'MHK-003', type: 'IN', quantity: 0, timestamp: 3, technicianOrSupplier: 'A', machineOrArea: 'B', folio: 'F' },
      ];

      const res = await importMovements(incoming, 'append');
      expect(res.added).toBe(1);
      expect(res.duplicates).toBe(1);

      const all = await getAllMovements();
      expect(all).toHaveLength(2);
      expect(all.map((m) => m.id).sort()).toEqual(['dup-1', 'new-2']);
      // Original dup-1 was not overwritten
      expect(all.find((m) => m.id === 'dup-1')?.quantity).toBe(10);
    });

    it('replaces all movements in replace mode and ignores invalid records', async () => {
      await recordMovement({ id: 'old-1', sku: 'MHK-001', type: 'IN', quantity: 10, technicianOrSupplier: 'A', machineOrArea: 'B', folio: 'F' });

      const incoming: Movement[] = [
        { id: 'rep-1', sku: 'MHK-010', type: 'IN', quantity: 30, timestamp: 1, technicianOrSupplier: 'A', machineOrArea: 'B', folio: 'F' },
        { id: 'rep-2', sku: 'MHK-020', type: 'OUT', quantity: 12, timestamp: 2, technicianOrSupplier: 'A', machineOrArea: 'B', folio: 'F' },
        { id: 'invalid', sku: '', type: 'IN', quantity: 5, timestamp: 3, technicianOrSupplier: 'A', machineOrArea: 'B', folio: 'F' },
      ];

      const res = await importMovements(incoming, 'replace');
      expect(res.added).toBe(2);
      expect(res.duplicates).toBe(0);

      const all = await getAllMovements();
      expect(all).toHaveLength(2);
      expect(all.map((m) => m.id)).toEqual(['rep-1', 'rep-2']);
    });
  });

  describe('Summaries & Aggregations', () => {
    beforeEach(async () => {
      await recordMovement({
        sku: 'MHK-001',
        type: 'IN',
        quantity: 20.5,
        timestamp: 100,
        technicianOrSupplier: 'A',
        machineOrArea: 'B',
        folio: 'F1',
      });
      await recordMovement({
        sku: 'MHK-001',
        type: 'IN',
        quantity: 10.25,
        timestamp: 200,
        technicianOrSupplier: 'A',
        machineOrArea: 'B',
        folio: 'F2',
      });
      await recordMovement({
        sku: 'MHK-001',
        type: 'OUT',
        quantity: 5.75,
        timestamp: 300,
        technicianOrSupplier: 'A',
        machineOrArea: 'B',
        folio: 'F3',
      });

      await recordMovement({
        sku: 'MHK-002',
        type: 'IN',
        quantity: 50,
        timestamp: 150,
        technicianOrSupplier: 'A',
        machineOrArea: 'B',
        folio: 'F4',
      });
      await recordMovement({
        sku: 'MHK-002',
        type: 'OUT',
        quantity: 60,
        timestamp: 250,
        technicianOrSupplier: 'A',
        machineOrArea: 'B',
        folio: 'F5',
      });
    });

    it('computes summary for a specific SKU', async () => {
      const summary = await getMovementSummary('mhk-001');
      expect(summary.totalIn).toBe(30.75);
      expect(summary.totalOut).toBe(5.75);
      expect(summary.netMovements).toBe(25);
      expect(summary.movementCount).toBe(3);
      expect(summary.inCount).toBe(2);
      expect(summary.outCount).toBe(1);
      expect(summary.lastMovementTimestamp).toBe(300);
    });

    it('computes global summary across all SKUs when sku is omitted', async () => {
      const globalSummary = await getMovementSummary();
      expect(globalSummary.totalIn).toBe(80.75);
      expect(globalSummary.totalOut).toBe(65.75);
      expect(globalSummary.netMovements).toBe(15);
      expect(globalSummary.movementCount).toBe(5);
      expect(globalSummary.inCount).toBe(3);
      expect(globalSummary.outCount).toBe(2);
      expect(globalSummary.lastMovementTimestamp).toBe(300);
    });

    it('returns empty summary when SKU has no movements', async () => {
      const s = await getMovementSummary('NON-EXISTENT');
      expect(s.totalIn).toBe(0);
      expect(s.totalOut).toBe(0);
      expect(s.netMovements).toBe(0);
      expect(s.movementCount).toBe(0);
      expect(s.lastMovementTimestamp).toBeUndefined();
    });

    it('aggregates summaries by SKU in a Map (O(N) operation)', async () => {
      const map = await getMovementSummariesBySku();
      expect(map.size).toBe(2);

      const m1 = map.get('MHK-001')!;
      expect(m1.totalIn).toBe(30.75);
      expect(m1.totalOut).toBe(5.75);
      expect(m1.netMovements).toBe(25);

      const m2 = map.get('MHK-002')!;
      expect(m2.totalIn).toBe(50);
      expect(m2.totalOut).toBe(60);
      expect(m2.netMovements).toBe(-10);
      expect(m2.movementCount).toBe(2);
    });
  });

  describe('Ideal Inventory Levels Storage', () => {
    it('gets, sets, and deletes ideal level for a SKU', async () => {
      expect(await getIdealLevels()).toEqual({});
      expect(await getIdealQtyForSku('MHK-001')).toBeUndefined();

      await setIdealLevel('mhk-001', 50.5);
      expect(await getIdealQtyForSku('MHK-001')).toBe(50.5);
      expect(await getIdealQtyForSku('mhk-001')).toBe(50.5);

      // Negative or NaN deletes level
      await setIdealLevel('MHK-001', -1);
      expect(await getIdealQtyForSku('MHK-001')).toBeUndefined();
    });

    it('throws error when setting ideal level with empty SKU', async () => {
      await expect(setIdealLevel('', 10)).rejects.toThrow('SKU requerido');
      await expect(setIdealLevel('   ', 10)).rejects.toThrow('SKU requerido');
    });

    it('sets multiple ideal levels in batch and clears all', async () => {
      await setIdealLevels({
        'MHK-001': 100,
        'mhk-002': 45.2,
        'MHK-003': -5, // Ignored / deleted
      });

      const levels = await getIdealLevels();
      expect(levels['MHK-001']).toBe(100);
      expect(levels['MHK-002']).toBe(45.2);
      expect(levels['MHK-003']).toBeUndefined();

      await clearIdealLevels();
      expect(await getIdealLevels()).toEqual({});
    });
  });
});

describe('Reconciliation Engine & Ideal Status (src/report.ts)', () => {
  describe('computeIdealStatus', () => {
    it('classifies stock <= 0 as critical', () => {
      expect(computeIdealStatus({ currentStock: 0, idealQty: 20 })).toBe('critical');
      expect(computeIdealStatus({ currentStock: -2, idealQty: 20 })).toBe('critical');
    });

    it('returns optimal when both idealQty <= 0 and currentStock === 0', () => {
      expect(computeIdealStatus({ currentStock: 0, idealQty: 0 })).toBe('optimal');
    });

    it('uses minQty threshold for critical status if specified', () => {
      // minQty is 8: currentStock 8 is critical, 9 is deficit
      expect(computeIdealStatus({ currentStock: 8, idealQty: 30, minQty: 8 })).toBe('critical');
      expect(computeIdealStatus({ currentStock: 9, idealQty: 30, minQty: 8 })).toBe('deficit');
    });

    it('uses 25% of idealQty for critical status when minQty is not specified', () => {
      // idealQty 40: 25% is 10. currentStock 10 is critical, 11 is deficit
      expect(computeIdealStatus({ currentStock: 10, idealQty: 40 })).toBe('critical');
      expect(computeIdealStatus({ currentStock: 11, idealQty: 40 })).toBe('deficit');
    });

    it('classifies stock < idealQty as deficit', () => {
      expect(computeIdealStatus({ currentStock: 25, idealQty: 30, minQty: 5 })).toBe('deficit');
    });

    it('classifies stock == idealQty as optimal', () => {
      expect(computeIdealStatus({ currentStock: 30, idealQty: 30 })).toBe('optimal');
    });

    it('classifies stock between idealQty and maxQty as optimal', () => {
      expect(computeIdealStatus({ currentStock: 35, idealQty: 30, maxQty: 50 })).toBe('optimal');
      expect(computeIdealStatus({ currentStock: 50, idealQty: 30, maxQty: 50 })).toBe('optimal');
    });

    it('classifies stock > maxQty (or > idealQty if maxQty omitted) as excess', () => {
      expect(computeIdealStatus({ currentStock: 51, idealQty: 30, maxQty: 50 })).toBe('excess');
      expect(computeIdealStatus({ currentStock: 31, idealQty: 30 })).toBe('excess');
      expect(computeIdealStatus({ currentStock: 5, idealQty: 0 })).toBe('excess');
    });
  });

  describe('buildReport backward compatibility and movements integration', () => {
    const products: Product[] = [
      {
        barcode: '00071153000108',
        sku: 'MHK-001',
        description: 'Guantes M',
        unit: 'CJA',
        expectedQty: 40,
        unitCost: 100,
        minQty: 10,
        maxQty: 60,
        source: 'catalogo',
      },
      {
        barcode: '00071153000115',
        sku: 'MHK-002',
        description: 'Guantes L',
        unit: 'CJA',
        expectedQty: 30,
        unitCost: 120,
        source: 'catalogo',
      },
    ];

    const counts: CountEntry[] = [
      { id: 'c1', sessionId: 's1', barcode: '00071153000108', qty: 45, counter: 'Juan', deviceId: 'd1', timestamp: 1 },
      { id: 'c2', sessionId: 's1', barcode: '00071153000115', qty: 25, counter: 'Pedro', deviceId: 'd2', timestamp: 2 },
    ];

    it('supports original signature with boolean parameter', () => {
      const rows = buildReport(products, counts, true);
      expect(rows).toHaveLength(2);
      expect(rows[0].counted).toBeDefined();
    });

    it('integrates movementsBySku and dynamic expected / diff calculations', () => {
      // MHK-001: expected 40, IN 20, OUT 5 -> dynamicExpected = 40 + 20 - 5 = 55
      // counted = 45 -> dynamicDiff = 45 - 55 = -10 (faltante dinámico)
      const movementsMap = new Map<string, { totalIn: number; totalOut: number }>([
        ['MHK-001', { totalIn: 20, totalOut: 5 }],
      ]);

      const rows = buildReport(products, counts, {
        includeNotCounted: true,
        movementsBySku: movementsMap,
      });

      const r1 = rows.find((r) => r.sku === 'MHK-001')!;
      expect(r1.totalIn).toBe(20);
      expect(r1.totalOut).toBe(5);
      expect(r1.netMovements).toBe(15);
      expect(r1.dynamicExpected).toBe(55);
      expect(r1.dynamicDiff).toBe(-10);

      // MHK-002: no movements in map, so dynamicExpected is just expected (30), dynamicDiff = 25 - 30 = -5
      const r2 = rows.find((r) => r.sku === 'MHK-002')!;
      expect(r2.totalIn).toBeUndefined();
      expect(r2.dynamicExpected).toBe(30);
      expect(r2.dynamicDiff).toBe(-5);
    });

    it('integrates idealLevels and calculates idealGap and idealStatus', () => {
      // MHK-001: counted = 45. Configured ideal = 50. idealGap = 45 - 50 = -5. minQty = 10 -> deficit.
      // MHK-002: counted = 25. Configured ideal = 20. maxQty undefined -> excess.
      const idealLevels = {
        'MHK-001': 50,
        'MHK-002': 20,
      };

      const rows = buildReport(products, counts, {
        idealLevels,
      });

      const r1 = rows.find((r) => r.sku === 'MHK-001')!;
      expect(r1.idealQty).toBe(50);
      expect(r1.idealGap).toBe(-5);
      expect(r1.idealStatus).toBe('deficit');

      const r2 = rows.find((r) => r.sku === 'MHK-002')!;
      expect(r2.idealQty).toBe(20);
      expect(r2.idealGap).toBe(5);
      expect(r2.idealStatus).toBe('excess');
    });

    it('falls back to maxQty then expectedQty if idealLevels not provided', () => {
      const rows = buildReport(products, counts, {});
      const r1 = rows.find((r) => r.sku === 'MHK-001')!;
      // MHK-001 has maxQty: 60
      expect(r1.idealQty).toBe(60);
      expect(r1.idealGap).toBe(45 - 60);

      const r2 = rows.find((r) => r.sku === 'MHK-002')!;
      // MHK-002 has no maxQty, falls back to expected: 30
      expect(r2.idealQty).toBe(30);
      expect(r2.idealGap).toBe(25 - 30);
    });
  });

  describe('computeMovementsKpis', () => {
    it('computes complete MovementsKpiSummary accurately', () => {
      const movements: Movement[] = [
        {
          id: '1',
          sku: 'MHK-001',
          type: 'IN',
          quantity: 10,
          cost: 100,
          timestamp: 1,
          technicianOrSupplier: 'Sup1',
          machineOrArea: 'A',
          folio: 'F1',
        },
        {
          id: '2',
          sku: 'MHK-001',
          type: 'OUT',
          quantity: 4,
          timestamp: 2, // No explicit cost -> will resolve from report row ($100)
          technicianOrSupplier: 'Tech1',
          machineOrArea: 'B',
          folio: 'F2',
        },
        {
          id: '3',
          sku: 'MHK-002',
          type: 'IN',
          quantity: 20,
          cost: 50,
          timestamp: 3,
          technicianOrSupplier: 'Sup2',
          machineOrArea: 'C',
          folio: 'F3',
        },
      ];

      const rows = [
        {
          barcode: '00071153000108',
          sku: 'MHK-001',
          description: 'Guantes M',
          unit: 'CJA',
          expected: 40,
          counted: 45,
          unitCost: 100,
          idealQty: 50,
          idealGap: -5,
          idealStatus: 'deficit' as const,
          diff: 5,
          diffValue: 500,
          status: 'sobrante' as const,
          counters: ['Juan'],
          scans: 1,
          source: 'catalogo' as const,
        },
        {
          barcode: '00071153000115',
          sku: 'MHK-002',
          description: 'Guantes L',
          unit: 'CJA',
          expected: 30,
          counted: 2,
          unitCost: 50,
          idealQty: 30,
          idealGap: -28,
          idealStatus: 'critical' as const,
          diff: -28,
          diffValue: -1400,
          status: 'faltante' as const,
          counters: ['Pedro'],
          scans: 1,
          source: 'catalogo' as const,
        },
        {
          barcode: '00079567011003',
          sku: 'MHK-010',
          description: 'WD-40',
          unit: 'PZA',
          expected: 20,
          counted: 20,
          unitCost: 80,
          idealQty: 20,
          idealGap: 0,
          idealStatus: 'optimal' as const,
          diff: 0,
          diffValue: 0,
          status: 'ok' as const,
          counters: ['Juan'],
          scans: 1,
          source: 'catalogo' as const,
        },
        {
          barcode: '00051131069008',
          sku: 'MHK-020',
          description: 'Cinta 3M',
          unit: 'PZA',
          expected: 10,
          counted: 15,
          unitCost: 30,
          idealQty: 10,
          idealGap: 5,
          idealStatus: 'excess' as const,
          diff: 5,
          diffValue: 150,
          status: 'sobrante' as const,
          counters: ['Pedro'],
          scans: 1,
          source: 'catalogo' as const,
        },
      ];

      const kpi = computeMovementsKpis(movements, rows);

      // Movements ledger checks:
      // IN: (10 * 100) + (20 * 50) = 1000 + 1000 = 2000
      // OUT: (4 * 100) = 400
      expect(kpi.totalMovements).toBe(3);
      expect(kpi.totalEntriesCount).toBe(2);
      expect(kpi.totalExitsCount).toBe(1);
      expect(kpi.totalUnitsIn).toBe(30);
      expect(kpi.totalUnitsOut).toBe(4);
      expect(kpi.netMovementUnits).toBe(26);
      expect(kpi.totalValueIn).toBe(2000);
      expect(kpi.totalValueOut).toBe(400);
      expect(kpi.netMovementValue).toBe(1600);

      // Ideal stock checks:
      // Tracked SKUs: 4
      // Optimal: MHK-010 (1)
      // Deficit: MHK-001 (1) -> gap: -5 -> restock cost = 5 * 100 = 500
      // Critical: MHK-002 (1) -> gap: -28 -> restock cost = 28 * 50 = 1400
      // Excess: MHK-020 (1) -> gap: +5
      expect(kpi.totalSkusTracked).toBe(4);
      expect(kpi.optimalCount).toBe(1);
      expect(kpi.deficitCount).toBe(1);
      expect(kpi.criticalCount).toBe(1);
      expect(kpi.excessCount).toBe(1);

      // Fulfillment rate: 1 / 4 = 25.0%
      expect(kpi.idealFulfillmentRate).toBe(25);
      // Total missing units: 5 + 28 = 33
      expect(kpi.totalIdealUnitsGap).toBe(33);
      // Total excess units: 5
      expect(kpi.totalExcessUnits).toBe(5);
      // Restock cost: 500 + 1400 = 1900
      expect(kpi.estimatedRestockCost).toBe(1900);
    });

    it('returns zeroed KPIs when movements and rows are empty', () => {
      const kpi = computeMovementsKpis([], []);
      expect(kpi.totalMovements).toBe(0);
      expect(kpi.totalUnitsIn).toBe(0);
      expect(kpi.totalUnitsOut).toBe(0);
      expect(kpi.totalSkusTracked).toBe(0);
      expect(kpi.idealFulfillmentRate).toBe(0);
      expect(kpi.estimatedRestockCost).toBe(0);
    });
  });

  describe('round utility', () => {
    it('rounds to 3 decimal places', () => {
      expect(round(1.23456)).toBe(1.235);
      expect(round(0.1 + 0.2)).toBe(0.3);
    });
  });
});
