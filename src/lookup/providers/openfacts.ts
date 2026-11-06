import { fetchJson, LookupUnavailable, type LookupProvider, type ProductInfo } from './types';

/**
 * Open Products Facts / Open Food Facts / Open Beauty Facts.
 * Gratis, sin clave y con CORS abierto: se consulta directamente desde el teléfono.
 */
const HOSTS = [
  'https://world.openproductsfacts.org',
  'https://world.openfoodfacts.org',
  'https://world.openbeautyfacts.org',
];
const FIELDS = 'product_name,product_name_es,generic_name,generic_name_es,brands,quantity,image_front_small_url,image_small_url';

function toInfo(p: any): ProductInfo | null {
  const name = [p.product_name_es, p.product_name, p.generic_name_es, p.generic_name].find(
    (x) => typeof x === 'string' && x.trim(),
  );
  if (!name) return null;
  const qty = typeof p.quantity === 'string' && p.quantity.trim() ? ` ${p.quantity.trim()}` : '';
  return {
    description: `${name.trim()}${qty}`,
    brand: typeof p.brands === 'string' ? p.brands.split(',')[0].trim() || undefined : undefined,
    imageUrl: p.image_front_small_url || p.image_small_url || undefined,
  };
}

export const openFacts: LookupProvider = {
  name: 'OpenFacts',
  async lookup(code, signal) {
    // Todos los dominios en paralelo; gana el primero que encuentre el producto
    let unavailable = 0;
    const attempts = HOSTS.map(async (h) => {
      try {
        const { data } = await fetchJson(`${h}/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`, signal);
        if (data?.status === 1 && data.product) {
          const info = toInfo(data.product);
          if (info) return info;
        }
      } catch (e) {
        if (e instanceof LookupUnavailable) unavailable++;
        else throw e;
      }
      throw new Error('no encontrado');
    });
    try {
      return await Promise.any(attempts);
    } catch {
      if (unavailable === HOSTS.length) throw new LookupUnavailable('Open Facts no disponible');
      return null;
    }
  },
};
