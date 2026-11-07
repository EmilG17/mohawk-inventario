import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProduct, putProduct, type Product } from '../../src/db/db';
import { _setProviders, lookupOnline, resolveDescription, setManualDescription } from '../../src/lookup/lookup';
import { openLibrary } from '../../src/lookup/providers/openlibrary';
import { LookupUnavailable, type LookupProvider, type ProductInfo } from '../../src/lookup/providers/types';
import { upcItemDb } from '../../src/lookup/providers/upcitemdb';
import { saveSettings } from '../../src/settings';

const originalFetch = globalThis.fetch;

describe('resolveDescription', () => {
  afterEach(() => {
    _setProviders();
    globalThis.fetch = originalFetch;
    delete (globalThis as any).window;
  });

  it('devuelve descripción del catálogo local si ya existe sin llamar a internet', async () => {
    let providerCalled = false;
    const dummyProvider: LookupProvider = {
      name: 'OpenFacts',
      async lookup() {
        providerCalled = true;
        return null;
      },
    };
    _setProviders([dummyProvider]);

    const local: Product = {
      barcode: '00071153000100',
      sku: 'MHK-001',
      description: 'Guantes M catálogo Mohawk',
      unit: 'CJA',
      source: 'catalogo',
    };
    await putProduct(local);

    const r = await resolveDescription('00071153000100');
    expect(r.status).toBe('catalogo');
    expect(r.product.description).toBe('Guantes M catálogo Mohawk');
    expect(providerCalled).toBe(false);
  });

  it('consulta proveedores en cascada cuando el producto no tiene descripción', async () => {
    const mockProvider: LookupProvider = {
      name: 'OpenFacts',
      async lookup(code) {
        if (code === '071153000100' || code === '00071153000100') {
          return { description: 'Guantes Ansell Nitrilo M', brand: 'Ansell' };
        }
        return null;
      },
    };
    _setProviders([mockProvider]);

    const r = await resolveDescription('00071153000100');
    expect(r.status).toBe('encontrado');
    expect(r.product.description).toBe('Guantes Ansell Nitrilo M');
    expect(r.product.source).toBe('OpenFacts');
    expect(r.product.brand).toBe('Ansell');

    // Debe quedar guardado en IndexedDB para no volver a consultar
    const stored = await getProduct('00071153000100');
    expect(stored?.description).toBe('Guantes Ansell Nitrilo M');
  });

  it('prevalida GTIN y no consulta la red si el checksum es inválido', async () => {
    let providerCalled = false;
    const mockProvider: LookupProvider = {
      name: 'OpenFacts',
      async lookup() {
        providerCalled = true;
        return { description: 'No debería llamarse' };
      },
    };
    _setProviders([mockProvider]);

    // WD-40 con dígito verificador alterado (3 en vez de 2)
    const r = await resolveDescription('079567011003');
    expect(r.status).toBe('no_encontrado');
    expect(r.product.notFoundOnline).toBe(true);
    expect(providerCalled).toBe(false);

    // Ansell con dígito verificador alterado (8 en vez de 0)
    const r2 = await resolveDescription('00071153000108');
    expect(r2.status).toBe('no_encontrado');
    expect(r2.product.notFoundOnline).toBe(true);
    expect(providerCalled).toBe(false);
  });

  it('marca como no encontrado si ningún proveedor tiene el código', async () => {
    const emptyProvider: LookupProvider = {
      name: 'OpenFacts',
      async lookup() {
        return null;
      },
    };
    _setProviders([emptyProvider]);

    const r = await resolveDescription('00000000000000');
    expect(r.status).toBe('no_encontrado');
    expect(r.product.description).toBe('');
    expect(r.product.notFoundOnline).toBe(true);
  });

  it('permite guardar captura manual de descripción', async () => {
    await setManualDescription('00071153000100', 'Guantes capturados a mano', { sku: 'MHK-MAN-1' });
    const stored = await getProduct('00071153000100');
    expect(stored?.description).toBe('Guantes capturados a mano');
    expect(stored?.source).toBe('manual');
    expect(stored?.sku).toBe('MHK-MAN-1');
  });

  it('respeta cuando la búsqueda en línea está desactivada en ajustes', async () => {
    await saveSettings({ onlineLookup: false });
    let called = false;
    _setProviders([{ name: 'OpenFacts', lookup: async () => { called = true; return null; } }]);

    const r = await resolveDescription('00071153000100');
    expect(r.status).toBe('desactivado');
    expect(called).toBe(false);
  });
});

describe('openLibrary Provider', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('resuelve metadatos para un ISBN-13 válido', async () => {
    const mockBook = {
      title: 'Manual de Seguridad Industrial',
      publishers: ['Editorial Técnica'],
      covers: [98765],
      isbn_13: ['9780140328721'],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockBook,
    } as any);

    const ctrl = new AbortController();
    const result = await openLibrary.lookup('9780140328721', ctrl.signal);

    expect(result).not.toBeNull();
    expect(result?.description).toBe('Manual de Seguridad Industrial');
    expect(result?.brand).toBe('Editorial Técnica');
    expect(result?.imageUrl).toBe('https://covers.openlibrary.org/b/id/98765-M.jpg');
    expect(result?.unit).toBe('PZA');
  });

  it('retorna null inmediatamente para códigos no-ISBN sin realizar peticiones fetch', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    const ctrl = new AbortController();
    // Código UPC común de ferretería (no ISBN)
    const result = await openLibrary.lookup('079567011002', ctrl.signal);

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maneja respuesta 404 HTML de Open Library retornando null sin lanzar excepción', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 404,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => '<html><body>404 Not Found</body></html>',
    } as any);

    const ctrl = new AbortController();
    const result = await openLibrary.lookup('9789999999999', ctrl.signal);

    expect(result).toBeNull();
  });
});

describe('upcItemDb Provider & Static Hosting Adaptation', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as any).window;
  });

  it('detecta entorno GitHub Pages con proxy relativo y lanza mensaje específico', async () => {
    (globalThis as any).window = {
      location: { hostname: 'emilg17.github.io' },
    };

    const provider = upcItemDb(() => 'api/upc');
    const ctrl = new AbortController();

    await expect(provider.lookup('079567011002', ctrl.signal)).rejects.toThrow(
      'Proxy UPCitemdb no disponible en este hosting',
    );
  });

  it('maneja respuesta 404 HTML de proxy relativo devolviendo error no disponible en hosting', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 404,
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => '<html>404 Not Found</html>',
    } as any);

    const provider = upcItemDb(() => 'api/upc');
    const ctrl = new AbortController();

    let err: any;
    try {
      await provider.lookup('079567011002', ctrl.signal);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(LookupUnavailable);
    expect(err.message).toBe('Proxy UPCitemdb no disponible en este hosting');
    expect(err.isMisconfigured).toBe(false);
  });

  it('consulta correctamente cuando se proporciona una URL de proxy válida con cabecera X-User-Agent', async () => {
    let capturedUrl = '';
    let capturedHeaders: any = {};

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          items: [
            {
              title: 'WD-40 Lubricante multiusos 11 oz',
              brand: 'WD-40',
              images: ['https://example.com/wd40.jpg'],
            },
          ],
        }),
      } as any;
    });

    const provider = upcItemDb(() => 'https://mi-proxy.workers.dev/upc');
    const ctrl = new AbortController();
    const result = await provider.lookup('079567011002', ctrl.signal);

    expect(result).not.toBeNull();
    expect(result?.description).toBe('WD-40 Lubricante multiusos 11 oz');
    expect(result?.brand).toBe('WD-40');
    expect(result?.imageUrl).toBe('https://example.com/wd40.jpg');

    expect(capturedUrl).toContain('https://mi-proxy.workers.dev/upc?upc=079567011002');
    expect(capturedHeaders['X-User-Agent']).toBe('Mohawk-Inventario/1.0 (contacto@mohawk.com)');
  });

  it('lanza LookupUnavailable con isMisconfigured=true si el proxy está vacío', async () => {
    const provider = upcItemDb(() => '');
    const ctrl = new AbortController();

    let err: any;
    try {
      await provider.lookup('079567011002', ctrl.signal);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(LookupUnavailable);
    expect(err.message).toBe('Proxy UPCitemdb no configurado');
    expect(err.isMisconfigured).toBe(true);
  });
});

describe('Fallback Chain & ISBN Prioritization', () => {
  afterEach(() => {
    _setProviders();
    globalThis.fetch = originalFetch;
    delete (globalThis as any).window;
  });

  it('prioriza OpenLibrary sobre OpenFacts cuando el código es un ISBN', async () => {
    const callOrder: string[] = [];

    const mockOpenFacts: LookupProvider = {
      name: 'OpenFacts',
      async lookup() {
        callOrder.push('OpenFacts');
        return null;
      },
    };

    const mockOpenLibrary: LookupProvider = {
      name: 'OpenLibrary',
      async lookup() {
        callOrder.push('OpenLibrary');
        return { description: 'Libro de Seguridad' };
      },
    };

    const mockUpc: LookupProvider = {
      name: 'UPCitemdb',
      async lookup() {
        callOrder.push('UPCitemdb');
        return null;
      },
    };

    _setProviders([mockOpenFacts, mockOpenLibrary, mockUpc]);

    const result = await lookupOnline('9780140328721');
    expect(result).not.toBeNull();
    expect(typeof result === 'object' && result?.provider).toBe('OpenLibrary');
    // OpenLibrary debe haber sido consultado primero
    expect(callOrder[0]).toBe('OpenLibrary');
  });

  it('prioriza OpenFacts para códigos GTIN convencionales', async () => {
    const callOrder: string[] = [];

    const mockOpenFacts: LookupProvider = {
      name: 'OpenFacts',
      async lookup() {
        callOrder.push('OpenFacts');
        return { description: 'Producto Industrial' };
      },
    };

    const mockOpenLibrary: LookupProvider = {
      name: 'OpenLibrary',
      async lookup() {
        callOrder.push('OpenLibrary');
        return null;
      },
    };

    _setProviders([mockOpenFacts, mockOpenLibrary]);

    const result = await lookupOnline('079567011002');
    expect(result).not.toBeNull();
    expect(typeof result === 'object' && result?.provider).toBe('OpenFacts');
    expect(callOrder[0]).toBe('OpenFacts');
  });

  it('no inhabilita UPCitemdb por 15 minutos ante error de hosting estático', async () => {
    let lookupCount = 0;
    const mockUpc: LookupProvider = {
      name: 'UPCitemdb',
      async lookup() {
        lookupCount++;
        throw new LookupUnavailable('Proxy UPCitemdb no disponible en este hosting', undefined, false);
      },
    };

    _setProviders([mockUpc]);

    // Primera consulta
    await lookupOnline('079567011002');
    expect(lookupCount).toBe(1);

    // Segunda consulta consecutiva: no debe haber sido bloqueado por circuit breaker
    await lookupOnline('079567011002');
    expect(lookupCount).toBe(2);
  });
});
