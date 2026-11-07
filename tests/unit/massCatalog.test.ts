import { describe, expect, it } from 'vitest';
import { bulkModifyProducts, bulkPutProducts, clearProducts, deleteProduct, deleteProducts, getProduct, allProducts, type Product } from '../../src/db/db';

describe('Operaciones masivas en el catálogo (modificación y eliminación)', () => {
  const sampleProducts: Product[] = [
    { barcode: '1001', sku: 'MHK-01', description: 'Cinta adhesiva 2in', unit: 'ROLLO', expectedQty: 10, unitCost: 25.5, brand: 'Mohawk', source: 'catalogo' },
    { barcode: '1002', sku: 'MHK-02', description: 'Cinta de aislar negra', unit: 'ROLLO', expectedQty: 50, unitCost: 12.0, brand: '3M', source: 'catalogo' },
    { barcode: '1003', sku: 'MHK-03', description: 'Guantes de nitrilo L', unit: 'CJA', expectedQty: 20, unitCost: 150.0, brand: 'Ansell', source: 'catalogo' },
    { barcode: '1004', sku: '', description: 'Producto no catalogado', unit: 'PZA', uncataloged: true, source: 'manual' },
  ];

  it('elimina un solo producto con deleteProduct', async () => {
    await bulkPutProducts(sampleProducts, 'replace');
    await deleteProduct('1001');
    expect(await getProduct('1001')).toBeUndefined();
    expect(await getProduct('1002')).toBeDefined();
  });

  it('elimina masivamente una lista de productos con deleteProducts', async () => {
    await bulkPutProducts(sampleProducts, 'replace');
    const count = await deleteProducts(['1001', '1003', '9999']); // 9999 no existe
    expect(count).toBe(2);
    expect(await getProduct('1001')).toBeUndefined();
    expect(await getProduct('1002')).toBeDefined();
    expect(await getProduct('1003')).toBeUndefined();
  });

  it('modifica masivamente campos como unidad y marca con bulkModifyProducts', async () => {
    await bulkPutProducts(sampleProducts, 'replace');
    const count = await bulkModifyProducts(['1001', '1002'], {
      brand: 'Truper',
      unit: 'PZA',
    });
    expect(count).toBe(2);
    const p1 = await getProduct('1001');
    const p2 = await getProduct('1002');
    expect(p1?.brand).toBe('Truper');
    expect(p1?.unit).toBe('PZA');
    expect(p2?.brand).toBe('Truper');
    expect(p2?.unit).toBe('PZA');
    // Verifica que los demás campos se preservaron intactos
    expect(p1?.description).toBe('Cinta adhesiva 2in');
    expect(p1?.expectedQty).toBe(10);
  });

  it('asigna y resetea existencia teórica masivamente', async () => {
    await bulkPutProducts(sampleProducts, 'replace');
    // Asignar 0
    await bulkModifyProducts(['1001', '1002'], { expectedQty: 0 });
    expect((await getProduct('1001'))?.expectedQty).toBe(0);
    expect((await getProduct('1002'))?.expectedQty).toBe(0);

    // Quitar/limpiar existencia teórica (null)
    await bulkModifyProducts(['1001'], { expectedQty: null });
    expect((await getProduct('1001'))?.expectedQty).toBeUndefined();
  });

  it('modifica estado de no catalogado y añade prefijos/sufijos masivamente', async () => {
    await bulkPutProducts(sampleProducts, 'replace');
    await bulkModifyProducts(['1004'], {
      uncataloged: false,
      descriptionPrefix: '[VALIDADO]',
    });
    const p4 = await getProduct('1004');
    expect(p4?.uncataloged).toBe(false);
    expect(p4?.description).toBe('[VALIDADO] Producto no catalogado');
  });

  it('vacía el catálogo completamente con clearProducts', async () => {
    await bulkPutProducts(sampleProducts, 'replace');
    expect((await allProducts()).length).toBe(4);
    await clearProducts();
    expect((await allProducts()).length).toBe(0);
  });
});
