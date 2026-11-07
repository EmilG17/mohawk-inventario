import { fetchJson, LookupUnavailable, type LookupProvider, type ProductInfo } from './types';

/**
 * Open Library Provider.
 * Consulta libros, manuales técnicos y normativas con ISBN.
 * Compatible con CORS directo desde el navegador y sin clave de acceso.
 */
export const openLibrary: LookupProvider = {
  name: 'OpenLibrary',
  async lookup(code: string, signal: AbortSignal): Promise<ProductInfo | null> {
    const raw = code.trim().replace(/[-\s]/g, '');
    // Solo aplica a ISBNs: 13 dígitos empezando con 978 o 979, o ISBN-10 (9 dígitos + dígito/X)
    if (!/^(978|979)\d{10}$|^\d{9}[\dX]$/i.test(raw)) {
      return null;
    }

    const isbn = raw.toUpperCase();
    const url = `https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`;

    try {
      const { status, data } = await fetchJson(url, signal);
      if (status === 404 || !data || !data.title) {
        return null;
      }

      const description = String(data.title).trim();
      let brand: string | undefined;
      if (Array.isArray(data.publishers) && data.publishers.length > 0) {
        brand = String(data.publishers[0]).trim();
      }

      let imageUrl: string | undefined;
      if (Array.isArray(data.covers)) {
        const coverId = data.covers.find((id: any) => typeof id === 'number' && id > 0);
        if (coverId) {
          imageUrl = `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`;
        }
      }
      if (!imageUrl && Array.isArray(data.isbn_13) && data.isbn_13[0]) {
        imageUrl = `https://covers.openlibrary.org/b/isbn/${data.isbn_13[0]}-M.jpg`;
      }

      return {
        description,
        brand,
        imageUrl,
        unit: 'PZA',
      };
    } catch (e) {
      if (e instanceof LookupUnavailable) {
        // En Open Library, los libros inexistentes suelen responder 404 HTML (no-JSON)
        if (e.message.includes('no válida') || e.message.includes('no JSON') || e.message.includes('404')) {
          return null;
        }
        if (/Límite/.test(e.message)) {
          throw e;
        }
      }
      return null;
    }
  },
};
