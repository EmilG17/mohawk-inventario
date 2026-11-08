import { beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  addCount,
  createSession,
  getDB,
  putProduct,
  type CountEntry,
  type Product,
  type Session,
} from '../../src/db/db';
import {
  clearIdealLevels,
  clearMovements,
  getAllMovements,
  getIdealLevels,
  getMovementSummary,
  listMovements,
  recordEntry,
  recordExit,
  setIdealLevel,
  type Movement,
} from '../../src/db/movements';
import { buildReportWorkbook } from '../../src/io/exportResults';
import { buildReport, summarize } from '../../src/report';
import {
  _clearMemoryRooms,
  mergeRoomStates,
  syncNow,
} from '../../src/sync/cloudSync';

describe('Movements & Ideal Inventory: Excel Export and Cloud Sync Integration', () => {
  beforeEach(async () => {
    _clearMemoryRooms();
    const db = await getDB();
    await db.clear('products');
    await db.clear('counts');
    await db.clear('sessions');
    await db.clear('meta');
  });

  describe('Enriched Excel Export (src/io/exportResults.ts)', () => {
    const session: Session = {
      id: 'sess-export-01',
      name: 'Auditoría Mohawk Q4',
      counter: 'Carlos Mendoza',
      createdAt: 1710000000000,
      closed: false,
    };

    const products: Product[] = [
      {
        barcode: '00071153000108',
        sku: 'MHK-GLV-01',
        description: 'Guantes de nitrilo resistente Talla L',
        unit: 'CJA',
        expectedQty: 50,
        unitCost: 120,
        minQty: 20,
        maxQty: 80,
        source: 'catalogo',
      },
      {
        barcode: '00079567011003',
        sku: 'MHK-LUB-02',
        description: 'Lubricante industrial multipropósito',
        unit: 'LTO',
        expectedQty: 30,
        unitCost: 250,
        minQty: 10,
        maxQty: 40,
        source: 'catalogo',
      },
    ];

    const counts: CountEntry[] = [
      {
        id: 'cnt-01',
        sessionId: session.id,
        barcode: '00071153000108',
        qty: 65,
        counter: 'Carlos Mendoza',
        deviceId: 'dev-001',
        timestamp: 1710000500000,
      },
      {
        id: 'cnt-02',
        sessionId: session.id,
        barcode: '00079567011003',
        qty: 15,
        counter: 'Elena Ramos',
        deviceId: 'dev-002',
        timestamp: 1710000600000,
      },
    ];

    const movements: Movement[] = [
      {
        id: 'mov-01',
        sku: 'MHK-GLV-01',
        barcode: '00071153000108',
        type: 'IN',
        quantity: 25,
        timestamp: 1710000100000,
        technicianOrSupplier: 'Distribuidora Industrial SA',
        machineOrArea: 'Recepción Almacén',
        folio: 'FAC-9921',
        notes: 'Lote nuevo importado',
      },
      {
        id: 'mov-02',
        sku: 'MHK-GLV-01',
        barcode: '00071153000108',
        type: 'OUT',
        quantity: 10,
        timestamp: 1710000200000,
        technicianOrSupplier: 'Martín Torres',
        machineOrArea: 'Línea de Ensamble 3',
        folio: 'VALE-101',
        notes: 'Uso en turno matutino',
      },
      {
        id: 'mov-03',
        sku: 'MHK-LUB-02',
        barcode: '00079567011003',
        type: 'OUT',
        quantity: 8,
        timestamp: 1710000300000,
        technicianOrSupplier: 'Pedro Sánchez',
        machineOrArea: 'Mantenimiento Preventivo',
        folio: 'VALE-102',
        notes: 'Engrase de rodamientos',
      },
    ];

    const idealLevels: Record<string, number> = {
      'MHK-GLV-01': 70,
      'MHK-LUB-02': 35,
    };

    it('genera todas las hojas requeridas incluyendo Kardex e Inventario Ideal', () => {
      const movementSummaries = new Map();
      movementSummaries.set('MHK-GLV-01', { totalIn: 25, totalOut: 10 });
      movementSummaries.set('MHK-LUB-02', { totalIn: 0, totalOut: 8 });

      const rows = buildReport(products, counts, {
        includeNotCounted: true,
        movementsBySku: movementSummaries,
        idealLevels,
      });
      const summary = summarize(rows);

      const bytes = buildReportWorkbook({
        session,
        rows,
        summary,
        counts,
        products,
        movements,
        idealLevels,
      });

      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(2000);

      const wb = XLSX.read(bytes, { type: 'array' });
      expect(wb.SheetNames).toContain('Resumen');
      expect(wb.SheetNames).toContain('Conteo completo');
      expect(wb.SheetNames).toContain('Diferencias');
      expect(wb.SheetNames).toContain('No catalogados');
      expect(wb.SheetNames).toContain('Entradas y Salidas (Kardex)');
      expect(wb.SheetNames).toContain('Inventario Ideal');
      expect(wb.SheetNames).toContain('Detalle de escaneos');
    });

    it('incluye las nuevas columnas de movimientos y conciliación en Conteo completo', () => {
      const movementSummaries = new Map();
      movementSummaries.set('MHK-GLV-01', { totalIn: 25, totalOut: 10 });
      movementSummaries.set('MHK-LUB-02', { totalIn: 0, totalOut: 8 });

      const rows = buildReport(products, counts, {
        includeNotCounted: true,
        movementsBySku: movementSummaries,
        idealLevels,
      });
      const summary = summarize(rows);

      const bytes = buildReportWorkbook({
        session,
        rows,
        summary,
        counts,
        products,
        movements,
        idealLevels,
      });

      const wb = XLSX.read(bytes, { type: 'array' });
      const ws = wb.Sheets['Conteo completo'];
      const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);

      expect(data).toHaveLength(2);
      const glvRow = data.find((r) => r['No. de parte'] === 'MHK-GLV-01')!;
      expect(glvRow).toBeDefined();
      expect(glvRow['Existencia teórica inicial']).toBe(50);
      expect(glvRow['Entradas (+)']).toBe(25);
      expect(glvRow['Salidas (-)']).toBe(10);
      expect(glvRow['Stock dinámico']).toBe(65); // 50 + 25 - 10
      expect(glvRow['Contado físico']).toBe(65);
      expect(glvRow['Diferencia']).toBe(15); // 65 - 50
      expect(glvRow['Inventario ideal']).toBe(70);
      expect(glvRow['Brecha vs Ideal']).toBe(-5); // 65 - 70
      expect(glvRow['Estado ideal']).toBe('Déficit');
    });

    it('formatea la hoja "Entradas y Salidas (Kardex)" con auditoría histórica completa', () => {
      const rows = buildReport(products, counts, true);
      const summary = summarize(rows);

      const bytes = buildReportWorkbook({
        session,
        rows,
        summary,
        counts,
        products,
        movements,
        idealLevels,
      });

      const wb = XLSX.read(bytes, { type: 'array' });
      const ws = wb.Sheets['Entradas y Salidas (Kardex)'];
      const kardexData = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);

      expect(kardexData).toHaveLength(3);

      // Verificación de columnas requeridas
      const first = kardexData[0];
      expect(first['Tipo']).toBe('ENTRADA');
      expect(first['SKU']).toBe('MHK-GLV-01');
      expect(first['Código de barras']).toBe('071153000108');
      expect(first['Descripción']).toContain('Guantes');
      expect(first['Cantidad']).toBe(25);
      expect(first['Unidad']).toBe('CJA');
      expect(first['Técnico/Proveedor']).toBe('Distribuidora Industrial SA');
      expect(first['Máquina/Área']).toBe('Recepción Almacén');
      expect(first['Folio/Ref']).toBe('FAC-9921');
      expect(first['Notas']).toBe('Lote nuevo importado');

      const second = kardexData[1];
      expect(second['Tipo']).toBe('SALIDA');
      expect(second['Cantidad']).toBe(10);
      expect(second['Técnico/Proveedor']).toBe('Martín Torres');
      expect(second['Máquina/Área']).toBe('Línea de Ensamble 3');
      expect(second['Folio/Ref']).toBe('VALE-101');
    });

    it('formatea la hoja "Inventario Ideal" con KPI y alertas de reposición', () => {
      const movementSummaries = new Map();
      movementSummaries.set('MHK-GLV-01', { totalIn: 25, totalOut: 10 });
      movementSummaries.set('MHK-LUB-02', { totalIn: 0, totalOut: 8 });

      const rows = buildReport(products, counts, {
        includeNotCounted: true,
        movementsBySku: movementSummaries,
        idealLevels,
      });
      const summary = summarize(rows);

      const bytes = buildReportWorkbook({
        session,
        rows,
        summary,
        counts,
        products,
        movements,
        idealLevels,
      });

      const wb = XLSX.read(bytes, { type: 'array' });
      const ws = wb.Sheets['Inventario Ideal'];
      const idealData = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);

      expect(idealData).toHaveLength(2);

      const lubRow = idealData.find((r) => r['SKU'] === 'MHK-LUB-02')!;
      expect(lubRow).toBeDefined();
      expect(lubRow['Código de barras']).toBe('079567011003');
      expect(lubRow['Descripción']).toContain('Lubricante');
      expect(lubRow['Unidad']).toBe('LTO');
      expect(lubRow['Stock Teórico Inicial']).toBe(30);
      expect(lubRow['Total Entradas']).toBe(0);
      expect(lubRow['Total Salidas']).toBe(8);
      expect(lubRow['Stock Dinámico']).toBe(22); // 30 - 8
      expect(lubRow['Último Conteo Físico']).toBe(15);
      expect(lubRow['Inventario Ideal']).toBe(35);
      expect(lubRow['Brecha vs Ideal']).toBe(-20); // 15 - 35
      expect(lubRow['Estado Nivel']).toBe('Déficit');
      expect(lubRow['Costo Unitario']).toBe(250);
      expect(lubRow['Valor Brecha']).toBe(-5000); // -20 * 250
      expect(lubRow['Alerta de Reposición']).toContain('Reposición');
    });

    it('preserva tipo texto en columnas de código en todas las hojas para proteger ceros iniciales', () => {
      const rows = buildReport(products, counts, true);
      const summary = summarize(rows);

      const bytes = buildReportWorkbook({
        session,
        rows,
        summary,
        counts,
        products,
        movements,
        idealLevels,
      });

      const wb = XLSX.read(bytes, { type: 'array' });

      // Verificar en Conteo completo
      const wsCompleto = wb.Sheets['Conteo completo'];
      const cellCompleto = wsCompleto['A2']; // Primer código de barras
      expect(cellCompleto.t).toBe('s');
      expect(['071153000108', '079567011003']).toContain(String(cellCompleto.v));

      // Verificar en Kardex
      const wsKardex = wb.Sheets['Entradas y Salidas (Kardex)'];
      // En kardex, columna D es SKU (col 3), columna E es Código de barras (col 4)
      const cellKardexSku = wsKardex['D2'];
      const cellKardexBc = wsKardex['E2'];
      expect(cellKardexSku.t).toBe('s');
      expect(cellKardexBc.t).toBe('s');

      // Verificar en Inventario Ideal
      const wsIdeal = wb.Sheets['Inventario Ideal'];
      // Columna A es SKU (col 0), columna B es Código de barras (col 1)
      const cellIdealSku = wsIdeal['A2'];
      const cellIdealBc = wsIdeal['B2'];
      expect(cellIdealSku.t).toBe('s');
      expect(cellIdealBc.t).toBe('s');
    });

    it('funciona correctamente sin movimientos ni niveles ideales (graceful fallback)', () => {
      const rows = buildReport(products, counts, true);
      const summary = summarize(rows);

      // Sin movements ni idealLevels pasados: genera el libro tradicional de 5 hojas sin error
      const bytesLegacy = buildReportWorkbook({
        session,
        rows,
        summary,
        counts,
        products,
      });

      expect(bytesLegacy).toBeInstanceOf(Uint8Array);
      const wbLegacy = XLSX.read(bytesLegacy, { type: 'array' });
      expect(wbLegacy.SheetNames).toEqual([
        'Resumen',
        'Conteo completo',
        'Diferencias',
        'No catalogados',
        'Por técnico',
        'Detalle de escaneos',
      ]);

      // Con movements vacío y idealLevels vacío: genera las 7 hojas completas
      const bytesEmpty = buildReportWorkbook({
        session,
        rows,
        summary,
        counts,
        products,
        movements: [],
        idealLevels: {},
      });
      const wbEmpty = XLSX.read(bytesEmpty, { type: 'array' });
      expect(wbEmpty.SheetNames).toContain('Entradas y Salidas (Kardex)');
      expect(wbEmpty.SheetNames).toContain('Inventario Ideal');
      const kardexData = XLSX.utils.sheet_to_json(wbEmpty.Sheets['Entradas y Salidas (Kardex)']);
      expect(kardexData).toHaveLength(0);
      const idealData = XLSX.utils.sheet_to_json(wbEmpty.Sheets['Inventario Ideal']);
      expect(idealData).toHaveLength(2);
    });
  });

  describe('Cloud Synchronization (src/sync/cloudSync.ts)', () => {
    it('fusiona movimientos deduplicando por ID y manteniendo la marca de tiempo más reciente', () => {
      const baseState = {
        app: 'mohawk-inventario' as const,
        version: 1 as const,
        roomCode: 'MHK-TEST-ROOM',
        updatedAt: 1000,
        sessionName: 'Sala Central',
        counts: [],
        products: [],
        participants: {},
        movements: [
          {
            id: 'm1',
            sku: 'SKU-01',
            type: 'IN' as const,
            quantity: 10,
            timestamp: 1000,
            technicianOrSupplier: 'Prov 1',
            machineOrArea: 'Area 1',
            folio: 'F1',
          },
          {
            id: 'm2',
            sku: 'SKU-02',
            type: 'OUT' as const,
            quantity: 4,
            timestamp: 2000,
            technicianOrSupplier: 'Tech A',
            machineOrArea: 'Area 2',
            folio: 'F2',
          },
        ],
        idealLevels: { 'SKU-01': 50 },
      };

      const incoming = {
        roomCode: 'MHK-TEST-ROOM',
        sessionName: 'Sala Central',
        counts: [],
        products: [],
        movements: [
          // m1 duplicado pero con timestamp posterior y corrección de cantidad
          {
            id: 'm1',
            sku: 'SKU-01',
            type: 'IN' as const,
            quantity: 15,
            timestamp: 3000,
            technicianOrSupplier: 'Prov 1',
            machineOrArea: 'Area 1',
            folio: 'F1',
          },
          // m3 nuevo
          {
            id: 'm3',
            sku: 'SKU-03',
            type: 'IN' as const,
            quantity: 8,
            timestamp: 4000,
            technicianOrSupplier: 'Prov 2',
            machineOrArea: 'Area 3',
            folio: 'F3',
          },
        ],
        idealLevels: {
          'SKU-02': 25,
          'SKU-01': 55, // Actualización de nivel ideal
        },
      };

      const merged = mergeRoomStates(baseState, incoming);
      expect(merged.movements).toHaveLength(3);

      const m1 = merged.movements?.find((m) => m.id === 'm1')!;
      expect(m1.quantity).toBe(15);
      expect(m1.timestamp).toBe(3000);

      const m2 = merged.movements?.find((m) => m.id === 'm2')!;
      expect(m2.quantity).toBe(4);

      const m3 = merged.movements?.find((m) => m.id === 'm3')!;
      expect(m3.quantity).toBe(8);

      expect(merged.idealLevels).toEqual({
        'SKU-01': 55,
        'SKU-02': 25,
      });
    });

    it('sincroniza bidireccionalmente movimientos y niveles ideales entre clientes vía syncNow', async () => {
      // 1. Cliente 1 registra movimientos y niveles ideales en su base de datos local
      await putProduct({
        barcode: '00071153000999',
        sku: 'MHK-SKU-999',
        description: 'Válvula de control neumático',
        unit: 'PZA',
        expectedQty: 10,
        source: 'catalogo',
      });

      await recordEntry({
        sku: 'MHK-SKU-999',
        quantity: 20,
        supplier: 'Proveedor Neumática',
        folio: 'ING-101',
        notes: 'Entrada para línea 1',
      });

      await recordExit({
        sku: 'MHK-SKU-999',
        quantity: 5,
        technician: 'Jorge Valenzuela',
        folio: 'SAL-101',
        machineOrArea: 'Línea de Envasado',
      });

      await setIdealLevel('MHK-SKU-999', 18);

      const s1 = await createSession('Sesión Almacén', 'Admin');
      await addCount({
        sessionId: s1.id,
        barcode: '00071153000999',
        qty: 15,
        counter: 'Admin',
      });

      // Cliente 1 sincroniza a la sala ROOM-ALPHA
      const syncRes1 = await syncNow({ sessionId: s1.id, roomCode: 'ROOM-ALPHA' });
      expect(syncRes1.roomCode).toBe('ROOM-ALPHA');
      expect(syncRes1.totalRoomCounts).toBe(1);
      expect(syncRes1.totalRoomMovements).toBe(2);

      // 2. Cliente 2 (simulado en el mismo entorno limpiando DB o creando sesión diferente)
      // Simulamos cliente 2 limpiando IndexedDB y sincronizando contra ROOM-ALPHA
      const db = await getDB();
      await db.clear('counts');
      await db.clear('sessions');
      await db.clear('meta');

      const s2 = await createSession('Sesión Supervisor', 'Supervisor');
      const syncRes2 = await syncNow({ sessionId: s2.id, roomCode: 'ROOM-ALPHA' });

      expect(syncRes2.totalRoomCounts).toBe(1);
      expect(syncRes2.totalRoomMovements).toBe(2);

      // Verificar que el Cliente 2 recibió en su IndexedDB local los movimientos y niveles ideales
      const client2Movements = await getAllMovements();
      expect(client2Movements).toHaveLength(2);
      expect(client2Movements.some((m) => m.type === 'IN' && m.quantity === 20)).toBe(true);
      expect(client2Movements.some((m) => m.type === 'OUT' && m.quantity === 5)).toBe(true);

      const client2Ideal = await getIdealLevels();
      expect(client2Ideal['MHK-SKU-999']).toBe(18);

      const summary = await getMovementSummary('MHK-SKU-999');
      expect(summary.totalIn).toBe(20);
      expect(summary.totalOut).toBe(5);
      expect(summary.netMovements).toBe(15);
    });

    it('la re-sincronización sucesiva es idempotente y no duplica movimientos ni conteos', async () => {
      const s = await createSession('Sesión Idempotente', 'Laura');
      await recordEntry({
        sku: 'SKU-IDEM',
        quantity: 50,
        supplier: 'Prov Global',
      });
      await setIdealLevel('SKU-IDEM', 100);

      const resA = await syncNow({ sessionId: s.id, roomCode: 'ROOM-BETA' });
      expect(resA.totalRoomMovements).toBe(1);

      const resB = await syncNow({ sessionId: s.id, roomCode: 'ROOM-BETA' });
      expect(resB.totalRoomMovements).toBe(1);

      const list = await listMovements({ sku: 'SKU-IDEM' });
      expect(list).toHaveLength(1);

      const ideal = await getIdealLevels();
      expect(ideal['SKU-IDEM']).toBe(100);
    });
  });
});
