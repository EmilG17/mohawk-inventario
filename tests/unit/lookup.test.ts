import { afterEach, describe, expect, it } from 'vitest';
import { getProduct, putProduct, type Product } from '../../src/db/db';
import { _setProviders, resolveDescription, setManualDescription } from '../../src/lookup/lookup';
import type { LookupProvider, ProductInfo } from '../../src/lookup/providers/types';
import { saveSettings } from '../../src/settings';

describe('resolveDescription', () => {
  afterEach(() => {
    _setProviders([]);
  });

  it('devuelve descripción del catálogo local si ya existe sin llamar a internet', async () => {
    let providerCalled = false;
    const dummyProvider: LookupProvider = {
      name: 'OpenFacts',
      async lookup() { providerCalled = true; return null; },
    };
    _setProviders([dummyProvider]);

    const local: Product = {
      barcode: '00071153000108',
      sku: 'MHK-001',
      description: 'Guantes M catálogo Mohawk',
      unit: 'CJA',
      source: 'catalogo',
    };
    await putProduct(local);

    const r = await resolveDescription('00071153000108');
    expect(r.status).toBe('catalogo');
    expect(r.product.description).toBe('Guantes M catálogo Mohawk');
    expect(providerCalled).toBe(false);
  });

  it('consulta proveedores en cascada cuando el producto no tiene descripción', async () => {
    const mockProvider: LookupProvider = {
      name: 'OpenFacts',
      async lookup(code) {
        if (code === '071153000108' || code === '00071153000108') {
          return { description: 'Guantes Ansell Nitrilo M', brand: 'Ansell' };
        }
        return null;
      },
    };
    _setProviders([mockProvider]);

    const r = await resolveDescription('00071153000108');
    expect(r.status).toBe('encontrado');
    expect(r.product.description).toBe('Guantes Ansell Nitrilo M');
    expect(r.product.source).toBe('OpenFacts');
    expect(r.product.brand).toBe('Ansell');

    // Debe quedar guardado en IndexedDB para no volver a consultar
    const stored = await getProduct('00071153000108');
    expect(stored?.description).toBe('Guantes Ansell Nitrilo M');
  });

  it('marca como no encontrado si ningún proveedor tiene el código', async () => {
    const emptyProvider: LookupProvider = {
      name: 'OpenFacts',
      async lookup() { return null; },
    };
    _setProviders([emptyProvider]);

    const r = await resolveDescription('00000000000000');
    expect(r.status).toBe('no_encontrado');
    expect(r.product.description).toBe('');
    expect(r.product.notFoundOnline).toBe(true);
  });

  it('permite guardar captura manual de descripción', async () => {
    await setManualDescription('00071153000108', 'Guantes capturados a mano', { sku: 'MHK-MAN-1' });
    const stored = await getProduct('00071153000108');
    expect(stored?.description).toBe('Guantes capturados a mano');
    expect(stored?.source).toBe('manual');
    expect(stored?.sku).toBe('MHK-MAN-1');
  });

  it('respeta cuando la búsqueda en línea está desactivada en ajustes', async () => {
    await saveSettings({ onlineLookup: false });
    let called = false;
    _setProviders([{ name: 'OpenFacts', lookup: async () => { called = true; return null; } }]);

    const r = await resolveDescription('00071153000108');
    expect(r.status).toBe('desactivado');
    expect(called).toBe(false);
  });
});
