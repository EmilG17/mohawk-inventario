import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import type { CountEntry, Product, Session } from '../../src/db/db';
import { buildReportCsv, buildReportWorkbook } from '../../src/io/exportResults';
import { buildReport, summarize } from '../../src/report';

describe('exportResults', () => {
  const session: Session = { id: 's1', name: 'Inventario Mohawk Noviembre', counter: 'Juan Pérez', createdAt: 1700000000000, closed: false };
  const products: Product[] = [
    { barcode: '00071153000108', sku: 'MHK-001', description: 'Guantes de nitrilo M', unit: 'CJA', expectedQty: 45, unitCost: 185, source: 'catalogo' },
    { barcode: '00079567011003', sku: 'MHK-010', description: 'WD-40 aerosol', unit: 'PZA', expectedQty: 24, unitCost: 115.5, source: 'catalogo' },
  ];
  const counts: CountEntry[] = [
    { id: '1', sessionId: 's1', barcode: '00071153000108', qty: 40, counter: 'Juan Pérez', deviceId: 'd1', timestamp: 1700000100000 },
  ];

  it('genera un libro Excel con todas las hojas requeridas', () => {
    const rows = buildReport(products, counts, true);
    const summary = summarize(rows);
    const bytes = buildReportWorkbook({ session, rows, summary, counts, products });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(1000);

    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toEqual([
      'Resumen',
      'Conteo completo',
      'Diferencias',
      'No catalogados',
      'Detalle de escaneos',
    ]);

    // Resumen incluye título y datos de sesión
    const resumen = XLSX.utils.sheet_to_json<string[]>(wb.Sheets['Resumen'], { header: 1 });
    expect(resumen[0][0]).toContain('Inventario de consumibles – Mohawk');

    // Conteo completo incluye los códigos formateados como texto (no convertidos a número)
    const completo = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Conteo completo']);
    expect(completo).toHaveLength(2);
    // Código de barras preserva el cero inicial en la vista de reporte
    expect(completo[0]['Código de barras']).toBe('071153000108');
  });

  it('genera CSV con BOM UTF-8 para apertura correcta en Excel', () => {
    const rows = buildReport(products, counts, true);
    const csv = buildReportCsv(rows);
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(csv).toContain('Guantes de nitrilo M');
    expect(csv).toContain('Código de barras');
  });
});
