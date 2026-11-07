import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allProducts, getProduct, putProduct, type Product } from '../../src/db/db';
import { _setProviders, isLookupable, lookupOnline, resolveDescription } from '../../src/lookup/lookup';
import { pendingCount, processPending } from '../../src/lookup/pendingQueue';
import { openFacts } from '../../src/lookup/providers/openfacts';
import { openLibrary } from '../../src/lookup/providers/openlibrary';
import { LookupUnavailable, type LookupProvider } from '../../src/lookup/providers/types';
import { upcItemDb } from '../../src/lookup/providers/upcitemdb';
import { saveSettings } from '../../src/settings';

const originalFetch = globalThis.fetch;

describe('Challenger Tier 5: Provider Chain Resilience & Network Simulation', () => {
  beforeEach(async () => {
    _setProviders();
    await saveSettings({ onlineLookup: true, proxyUrl: 'api/upc' });
  });

  afterEach(() => {
    _setProviders();
    globalThis.fetch = originalFetch;
    delete (globalThis as any).window;
    delete (globalThis as any).navigator;
    vi.restoreAllMocks();
  });

  describe('1. Mock Fetch Responses & Status Codes', () => {
    it('Open Library 200 OK: resolves book metadata, formats unit PZA and extracts cover image', async () => {
      const mockIsbn = '9780140328721';
      const mockBookResponse = {
        title: 'Guía de Mantenimiento Preventivo y Seguridad',
        publishers: ['Mohawk Press Industrial'],
        covers: [876543],
        isbn_13: [mockIsbn],
      };

      const fetchSpy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('openlibrary.org')) {
          expect(init?.headers).toBeDefined();
          const headers = init?.headers as Record<string, string>;
          expect(headers['X-User-Agent']).toBe('Mohawk-Inventario/1.0 (contacto@mohawk.com)');
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => mockBookResponse,
          };
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });
      globalThis.fetch = fetchSpy;

      const result = await lookupOnline(mockIsbn);
      expect(result).not.toBeNull();
      expect(result).not.toBe('unavailable');
      if (typeof result === 'object' && result !== null) {
        expect(result.provider).toBe('OpenLibrary');
        expect(result.info.description).toBe('Guía de Mantenimiento Preventivo y Seguridad');
        expect(result.info.brand).toBe('Mohawk Press Industrial');
        expect(result.info.imageUrl).toBe('https://covers.openlibrary.org/b/id/876543-M.jpg');
        expect(result.info.unit).toBe('PZA');
      }

      // Assert that only Open Library was queried, not Open Food Facts or UPCitemdb
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toContain('openlibrary.org/isbn/9780140328721.json');
    });

    it('Open Food Facts 404: handles 404 JSON gracefully without throwing and allows fallback', async () => {
      const gtin = '079567011002'; // Valid GTIN-12 (WD-40)

      const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('openproductsfacts.org') || url.includes('openfoodfacts.org') || url.includes('openbeautyfacts.org')) {
          return {
            status: 404,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({ status: 0, status_verbose: 'product not found' }),
          };
        }
        if (url.includes('api/upc')) {
          // Fallback to UPCitemdb mock returning product
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({
              items: [{ title: 'WD-40 Specialist 11oz', brand: 'WD-40 Company' }],
            }),
          };
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });
      globalThis.fetch = fetchSpy;

      const result = await lookupOnline(gtin);
      expect(result).not.toBeNull();
      expect(typeof result === 'object' && result?.provider).toBe('UPCitemdb');
      expect(result?.info.description).toBe('WD-40 Specialist 11oz');
      expect(result?.info.brand).toBe('WD-40 Company');
    });

    it('UPCitemdb 429 TOO_FAST: sets transient lockout and returns unavailable without blacklisting', async () => {
      const gtin = '079567011002';

      // OpenFacts fails with clean 404, then UPCitemdb encounters 429 TOO_FAST
      const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('openproductsfacts.org') || url.includes('openfoodfacts.org') || url.includes('openbeautyfacts.org')) {
          return {
            status: 404,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({ status: 0, status_verbose: 'product not found' }),
          };
        }
        if (url.includes('api/upc')) {
          return {
            status: 429,
            headers: new Headers({
              'content-type': 'application/json',
              'retry-after': '30',
            }),
            json: async () => ({ code: 'TOO_FAST', message: 'Too many requests' }),
          };
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });
      globalThis.fetch = fetchSpy;

      const result = await lookupOnline(gtin);
      expect(result).toBe('unavailable');

      // resolveDescription should return status 'sin_conexion' and NOT set notFoundOnline: true
      const resolveRes = await resolveDescription(gtin, { forceOnline: true });
      expect(resolveRes.status).toBe('sin_conexion');
      expect(resolveRes.product.notFoundOnline).toBe(false);

      // Verify that within the 30-second window, UPCitemdb is skipped without making a network request
      fetchSpy.mockClear();
      const cachedResult = await lookupOnline(gtin);
      expect(cachedResult).toBe('unavailable');
      // Only Open Facts hosts called (3 calls), UPCitemdb was skipped by transient lockout
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      for (const call of fetchSpy.mock.calls) {
        expect(call[0]).not.toContain('api/upc');
      }
    });

    it('UPCitemdb 404 HTML (Static Host Simulation): relative proxy returning 404 HTML does NOT trigger 15-minute lockout', async () => {
      const gtin = '071153000100'; // Ansell M valid GTIN-12

      // Simulate static host (e.g. GitHub Pages) returning HTML 404 for api/upc
      const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('openproductsfacts.org') || url.includes('openfoodfacts.org') || url.includes('openbeautyfacts.org')) {
          return {
            status: 404,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({ status: 0, status_verbose: 'product not found' }),
          };
        }
        if (url.includes('api/upc')) {
          return {
            status: 404,
            headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
            text: async () => '<!DOCTYPE html><html><head><title>404 Not Found</title></head><body>404 Not Found</body></html>',
          };
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });
      globalThis.fetch = fetchSpy;

      // 1st lookup: OpenFacts returns 404, UPCitemdb returns 404 HTML (hosting unavailable)
      const res1 = await lookupOnline(gtin);
      expect(res1).toBeNull(); // Must return null, not 'unavailable'!

      const resolveRes = await resolveDescription(gtin);
      expect(resolveRes.status).toBe('no_encontrado');
      expect(resolveRes.product.notFoundOnline).toBe(true);

      // 2nd lookup: verify UPCitemdb is NOT locked out for 15 minutes. It must be called again.
      fetchSpy.mockClear();
      const res2 = await lookupOnline(gtin);
      expect(res2).toBeNull();
      // Should have attempted Open Facts (3) and UPCitemdb (1) = 4 calls total
      expect(fetchSpy).toHaveBeenCalledTimes(4);
      const calledUrls = fetchSpy.mock.calls.map((c) => c[0]);
      expect(calledUrls.some((u: string) => u.includes('api/upc'))).toBe(true);
    });
  });

  describe('2. Circuit Breaker Logic & Failure Modes', () => {
    it('distinguishes between static host 404 and unconfigured proxy (misconfiguration lockout)', async () => {
      // 1) Unconfigured proxy ('') -> triggers 15-minute lockout
      await saveSettings({ proxyUrl: '' });
      _setProviders(); // reloads with empty proxy

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          status: 404,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ status: 0 }),
        };
      });

      // 1st call: UPCitemdb is unconfigured -> disabled for 15 minutes
      await lookupOnline('079567011002');

      // Reset fetch count to test if UPCitemdb is skipped in 2nd call
      callCount = 0;
      await lookupOnline('079567011002');
      // OpenFacts makes 3 calls, UPCitemdb is completely skipped because it is locked out
      expect(callCount).toBe(3);

      // 2) Contrast with static host 404:
      await saveSettings({ proxyUrl: 'api/upc' });
      _setProviders(); // resets providers and disabledUntil

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('api/upc')) {
          return {
            status: 404,
            headers: new Headers({ 'content-type': 'text/html' }),
            text: async () => '<html>404</html>',
          };
        }
        return {
          status: 404,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ status: 0 }),
        };
      });

      // 5 consecutive lookups: UPCitemdb must be called in EVERY one without being locked out
      for (let i = 0; i < 5; i++) {
        (globalThis.fetch as any).mockClear();
        await lookupOnline('079567011002');
        const upcCalled = (globalThis.fetch as any).mock.calls.some((c: any) => c[0].includes('api/upc'));
        expect(upcCalled).toBe(true);
      }
    });

    it('handles simulated offline navigator state without making network requests', async () => {
      (globalThis as any).navigator = { onLine: false };

      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      const result = await lookupOnline('079567011002');
      expect(result).toBe('unavailable');
      expect(fetchSpy).not.toHaveBeenCalled();

      const resolveRes = await resolveDescription('079567011002');
      expect(resolveRes.status).toBe('sin_conexion');
      expect(resolveRes.product.notFoundOnline).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('3. ISBN Prioritization & Chain Ordering', () => {
    it('ISBN-13 (978 prefix): queries Open Library first and short-circuits upon success', async () => {
      const order: string[] = [];

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('openlibrary.org')) {
          order.push('OpenLibrary');
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({
              title: 'Manual de Normas Técnicas',
              publishers: ['ISO / ASTM'],
            }),
          };
        }
        if (url.includes('openfacts') || url.includes('openfoodfacts')) {
          order.push('OpenFacts');
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({ status: 1, product: { product_name: 'Should not be called' } }),
          };
        }
        if (url.includes('api/upc')) {
          order.push('UPCitemdb');
          return { status: 404 };
        }
        throw new Error(`Unexpected url: ${url}`);
      });

      const res = await lookupOnline('9788497592208');
      expect(res).not.toBeNull();
      expect(typeof res === 'object' && res?.provider).toBe('OpenLibrary');
      expect(res?.info.description).toBe('Manual de Normas Técnicas');
      expect(order).toEqual(['OpenLibrary']);
    });

    it('ISBN-10 (with X check digit): recognized and prioritized to Open Library', async () => {
      const order: string[] = [];
      const isbn10 = '080442957X';

      expect(isLookupable(isbn10)).toBe(true);

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('openlibrary.org')) {
          order.push('OpenLibrary');
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({
              title: 'Critical Thinking Handbook',
              publishers: ['Academic Press'],
            }),
          };
        }
        order.push('Other');
        return { status: 404 };
      });

      const res = await lookupOnline(isbn10);
      expect(res).not.toBeNull();
      expect(typeof res === 'object' && res?.provider).toBe('OpenLibrary');
      expect(order).toEqual(['OpenLibrary']);
    });

    it('Standard GTIN-12 consumable: queries OpenFacts first and skips Open Library without network request', async () => {
      const order: string[] = [];
      const gtin = '079567011002'; // WD-40

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('openproductsfacts.org') || url.includes('openfoodfacts.org') || url.includes('openbeautyfacts.org')) {
          order.push('OpenFacts');
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({
              status: 1,
              product: {
                product_name: 'WD-40 Lubricante Multiusos',
                brands: 'WD-40',
              },
            }),
          };
        }
        if (url.includes('openlibrary.org')) {
          order.push('OpenLibrary');
          return { status: 404 };
        }
        return { status: 404 };
      });

      const res = await lookupOnline(gtin);
      expect(res).not.toBeNull();
      expect(typeof res === 'object' && res?.provider).toBe('OpenFacts');
      expect(res?.info.description).toBe('WD-40 Lubricante Multiusos');

      // OpenLibrary was never contacted over network
      expect(order.some((name) => name === 'OpenLibrary')).toBe(false);
    });
  });

  describe('4. Pending Queue Processing with Mixed Valid/Invalid Data', () => {
    it('processes pending queue with mixed valid, invalid, corrupted check digit, and non-lookupable codes cleanly without throwing', async () => {
      // Setup test products in IndexedDB:
      const testProducts: Product[] = [
        // 1. Valid GTIN-12: WD-40 (should resolve online via OpenFacts)
        { barcode: '00079567011002', sku: '', description: '', unit: '', source: 'pendiente' },
        // 2. Valid ISBN-13: Book (should resolve online via OpenLibrary)
        { barcode: '9780140328721', sku: '', description: '', unit: '', source: 'pendiente' },
        // 3. Invalid GTIN checksum: WD-40 with check digit 3 instead of 2 (should be pre-validated and skipped without fetch)
        { barcode: '00079567011003', sku: '', description: '', unit: '', source: 'pendiente' },
        // 4. Invalid GTIN checksum: Ansell M with check digit 8 instead of 0 (should be pre-validated and marked notFoundOnline)
        { barcode: '00071153000108', sku: '', description: '', unit: '', source: 'pendiente' },
        // 5. Non-lookupable code: alphanumeric internal code (should be excluded by isLookupable)
        { barcode: 'MHK-INTERNAL-999', sku: 'MHK-999', description: '', unit: 'PZA', source: 'pendiente' },
        // 6. Non-lookupable code: short numeric code (should be excluded by isLookupable)
        { barcode: '12345', sku: 'MHK-SHORT', description: '', unit: 'PZA', source: 'pendiente' },
        // 7. Already cataloged product with description (should be excluded by !p.description)
        { barcode: '00071153000100', sku: 'MHK-001', description: 'Guantes Ansell Nitrilo M', unit: 'CJA', source: 'catalogo' },
        // 8. Already marked as not found online (should be excluded by !p.notFoundOnline)
        { barcode: '00071153000117', sku: '', description: '', unit: '', source: 'pendiente', notFoundOnline: true },
        // 9. Valid GTIN-12: Stanley Cutter (all providers return 404 / static host 404 HTML, should be marked notFoundOnline)
        { barcode: '00076174100051', sku: '', description: '', unit: '', source: 'pendiente' },
      ];

      for (const p of testProducts) {
        await putProduct(p);
      }

      const initialPending = await pendingCount();
      expect(initialPending).toBe(8); // 8 products without description

      // Mock network responses:
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        // WD-40 resolves via OpenFacts
        if (url.includes('079567011002')) {
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({
              status: 1,
              product: { product_name: 'WD-40 Especializado', brands: 'WD-40' },
            }),
          };
        }
        // ISBN resolves via Open Library
        if (url.includes('9780140328721')) {
          return {
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({
              title: 'Manual de Seguridad Industrial 2026',
              publishers: ['Editorial Mohawk'],
            }),
          };
        }
        // UPCitemdb relative proxy on static host returns 404 HTML
        if (url.includes('api/upc')) {
          return {
            status: 404,
            headers: new Headers({ 'content-type': 'text/html' }),
            text: async () => '<html>404 Not Found</html>',
          };
        }
        // Stanley Cutter returns 404 on OpenFacts
        if (url.includes('076174100051')) {
          return {
            status: 404,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => ({ status: 0 }),
          };
        }
        // If fetch is called for invalid checksums, fail the test!
        if (url.includes('079567011003') || url.includes('071153000108')) {
          throw new Error(`CRITICAL: Fetch was called for invalid GTIN checksum: ${url}`);
        }
        return {
          status: 404,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ status: 0 }),
        };
      });

      const updates: number[] = [];
      const resolvedTotal = await processPending((count) => {
        updates.push(count);
      });

      // Exactly 2 products should have been successfully resolved
      expect(resolvedTotal).toBe(2);
      expect(updates).toEqual([1, 2]);

      // Inspect DB state of all products:
      const pWd40 = await getProduct('00079567011002');
      expect(pWd40?.description).toBe('WD-40 Especializado');
      expect(pWd40?.source).toBe('OpenFacts');
      expect(pWd40?.notFoundOnline).toBe(false);

      const pBook = await getProduct('9780140328721');
      expect(pBook?.description).toBe('Manual de Seguridad Industrial 2026');
      expect(pBook?.source).toBe('OpenLibrary');
      expect(pBook?.notFoundOnline).toBe(false);

      // Invalid checksum products: marked notFoundOnline, no description, no throws
      const pInvalidWd40 = await getProduct('00079567011003');
      expect(pInvalidWd40?.description).toBe('');
      expect(pInvalidWd40?.notFoundOnline).toBe(true);

      const pInvalidAnsell = await getProduct('00071153000108');
      expect(pInvalidAnsell?.description).toBe('');
      expect(pInvalidAnsell?.notFoundOnline).toBe(true);

      // Stanley cutter: not found online
      const pStanley = await getProduct('00076174100051');
      expect(pStanley?.description).toBe('');
      expect(pStanley?.notFoundOnline).toBe(true);

      // Alphanumeric code: untouched
      const pInternal = await getProduct('MHK-INTERNAL-999');
      expect(pInternal?.description).toBe('');
      expect(pInternal?.notFoundOnline).toBeUndefined();

      // Second run: must resolve 0 because all eligible products are either resolved or marked notFoundOnline
      const secondRunUpdates: number[] = [];
      const secondRunResolved = await processPending((count) => {
        secondRunUpdates.push(count);
      });
      expect(secondRunResolved).toBe(0);
      expect(secondRunUpdates).toHaveLength(0);
    });

    it('breaks queue processing early upon network disconnection (sin_conexion) to preserve battery/quota', async () => {
      // 3 valid products in queue
      // In IndexedDB, keys are sorted alphabetically:
      // 1st: 00071153000100 (attempted, encounters network error, returns sin_conexion)
      // 2nd: 00071153000117 (unattempted due to early break!)
      // 3rd: 00079567011002 (unattempted due to early break!)
      await putProduct({ barcode: '00071153000100', sku: '', description: '', unit: '', source: 'pendiente' });
      await putProduct({ barcode: '00071153000117', sku: '', description: '', unit: '', source: 'pendiente' });
      await putProduct({ barcode: '00079567011002', sku: '', description: '', unit: '', source: 'pendiente' });

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        // Simulate immediate network disconnect / timeout
        throw new TypeError('Failed to fetch');
      });

      const resolved = await processPending();
      expect(resolved).toBe(0);

      // 1st product calls OpenFacts (3 hosts in parallel) + UPCitemdb (1 call) = 4 calls total
      // Loop breaks immediately at sin_conexion, so products 2 and 3 are never attempted!
      expect(callCount).toBe(4);

      // Verify product 1 was attempted and updated with lookedUpAt
      const p1 = await getProduct('00071153000100');
      expect(p1?.lookedUpAt).toBeDefined();

      // Verify products 2 and 3 remain untouched for future retry
      const p2 = await getProduct('00071153000117');
      expect(p2?.notFoundOnline).toBeUndefined();
      expect(p2?.lookedUpAt).toBeUndefined();

      const p3 = await getProduct('00079567011002');
      expect(p3?.notFoundOnline).toBeUndefined();
      expect(p3?.lookedUpAt).toBeUndefined();
    });

    it('concurrency guard: prevents overlapping simultaneous executions of processPending', async () => {
      await putProduct({ barcode: '00079567011002', sku: '', description: '', unit: '', source: 'pendiente' });

      let resolveSlowFetch: (val: any) => void;
      const slowFetchPromise = new Promise((resolve) => {
        resolveSlowFetch = resolve;
      });

      globalThis.fetch = vi.fn().mockImplementation(async () => {
        await slowFetchPromise;
        return {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            status: 1,
            product: { product_name: 'Slow Resolution Product' },
          }),
        };
      });

      // Launch first run (will pause at fetch)
      const p1 = processPending();

      // Launch second run while first is in-flight
      const p2 = processPending();

      // Second call must return 0 immediately due to running guard
      const result2 = await p2;
      expect(result2).toBe(0);

      // Now allow first run to complete
      resolveSlowFetch!({});
      const result1 = await p1;
      expect(result1).toBe(1);
    });
  });
});
