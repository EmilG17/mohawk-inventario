import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detectHeaderRow, guessMapping, readWorkbook, rowsToProducts, type Mapping,
} from '../../src/io/importCatalog';

describe('guessMapping', () => {
  it('detecta encabezados comunes en español e inglés', () => {
    const headers = ['CÓDIGO DE BARRAS', 'No. de Parte', 'Descripción del producto', 'U.M.', 'Existencia Teórica', 'Costo'];
    const m = guessMapping(headers);
    expect(m.barcode).toBe(0);
    expect(m.sku).toBe(1);
    expect(m.description).toBe(2);
    expect(m.unit).toBe(3);
    expect(m.expectedQty).toBe(4);
    expect(m.unitCost).toBe(5);
  });

  it('detecta variantes breves como UPC, SKU, Qty, Price', () => {
    const headers = ['UPC', 'SKU', 'Item Description', 'Qty', 'Unit Cost'];
    const m = guessMapping(headers);
    expect(m.barcode).toBe(0);
    expect(m.sku).toBe(1);
    expect(m.description).toBe(2);
    expect(m.expectedQty).toBe(3);
    expect(m.unitCost).toBe(4);
  });

  it('no asigna columnas ausentes (-1)', () => {
    const headers = ['Código', 'Descripción'];
    const m = guessMapping(headers);
    expect(m.barcode).toBe(0);
    expect(m.description).toBe(1);
    expect(m.expectedQty).toBe(-1);
    expect(m.unitCost).toBe(-1);
  });
});

describe('detectHeaderRow', () => {
  it('encuentra la fila de encabezados aun con títulos previos', () => {
    const rows = [
      ['INVENTARIO DE PLANTA MOHAW'],
      ['Fecha: 2026-11-06'],
      [],
      ['Código de barras', 'Descripción', 'Existencia'],
      ['071153000108', 'Guantes nitrilo M', 10],
    ];
    expect(detectHeaderRow(rows)).toBe(3);
  });
});

describe('rowsToProducts', () => {
  it('convierte filas a productos y normaliza códigos', () => {
    const rows = [
      ['Código', 'SKU', 'Descripción', 'UM', 'Stock', 'Costo'],
      ['071153000108', 'MHK-001', 'Guantes M', 'CJA', '45', '$185.00'],
      ['079567011003', 'MHK-010', 'WD-40 11oz', 'PZA', '24', '115.50'],
    ];
    const mapping: Mapping = { barcode: 0, sku: 1, description: 2, unit: 3, expectedQty: 4, unitCost: 5 };
    const r = rowsToProducts(rows, 0, mapping);
    expect(r.products).toHaveLength(2);
    expect(r.products[0].barcode).toBe('00071153000108');
    expect(r.products[0].expectedQty).toBe(45);
    expect(r.products[0].unitCost).toBe(185);
    expect(r.products[0].source).toBe('catalogo');
  });

  it('asigna prefijo SKU: cuando no hay código de barras pero sí SKU', () => {
    const rows = [
      ['Código', 'SKU', 'Descripción'],
      ['', 'MHK-ESP-001', 'Pieza especial sin código'],
    ];
    const mapping: Mapping = { barcode: 0, sku: 1, description: 2, unit: -1, expectedQty: -1, unitCost: -1 };
    const r = rowsToProducts(rows, 0, mapping);
    expect(r.products[0].barcode).toBe('SKU:MHK-ESP-001');
  });

  it('advierte sobre códigos duplicados y suma la existencia teórica', () => {
    const rows = [
      ['Código', 'Descripción', 'Stock'],
      ['071153000108', 'Guantes M lote 1', '20'],
      ['071153000108', 'Guantes M lote 2', '30'],
    ];
    const mapping: Mapping = { barcode: 0, sku: -1, description: 1, unit: -1, expectedQty: 2, unitCost: -1 };
    const r = rowsToProducts(rows, 0, mapping);
    expect(r.products).toHaveLength(1);
    expect(r.products[0].expectedQty).toBe(50);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('duplicado');
  });

  it('lee el archivo Excel generado de muestra sin errores', () => {
    const samplePath = path.resolve(__dirname, '../../sample/catalogo_consumibles_mohawk.xlsx');
    const buf = fs.readFileSync(samplePath);
    const wb = readWorkbook(buf, 'catalogo_consumibles_mohawk.xlsx');
    const rows = wb.rows(wb.sheetNames[0]);
    const headerRow = detectHeaderRow(rows);
    const mapping = guessMapping(rows[headerRow]);
    const res = rowsToProducts(rows, headerRow, mapping);
    expect(res.products.length).toBe(12);
    expect(res.warnings).toHaveLength(0);
    const wd40 = res.products.find((p) => p.sku === 'MHK-LUB-010');
    expect(wd40).toBeDefined();
    expect(wd40?.description).toContain('WD-40');
    expect(wd40?.expectedQty).toBe(24);
  });
});
