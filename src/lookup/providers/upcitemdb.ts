import { fetchJson, LookupUnavailable, type LookupProvider } from './types';

/**
 * UPCitemdb (amplia cobertura de productos con UPC/EAN, incluidos artículos industriales y de ferretería).
 * Su API no permite llamadas directas desde otros sitios (CORS), por eso se consulta a través de un
 * proxy serverless (ver carpeta /proxy). La URL del proxy es configurable; por defecto "api/upc",
 * que funciona automáticamente al publicar en Netlify con la función incluida.
 */
export function upcItemDb(proxyUrl: () => string): LookupProvider {
  return {
    name: 'UPCitemdb',
    async lookup(code, signal) {
      const base = proxyUrl().trim();
      if (!base) throw new LookupUnavailable('Proxy UPCitemdb no configurado');
      const url = `${base}${base.includes('?') ? '&' : '?'}upc=${encodeURIComponent(code)}`;
      const { status, data } = await fetchJson(url, signal);
      if (status === 404 && data?.code === 'NOT_FOUND') return null;
      if (status >= 400) {
        if (data?.code === 'INVALID_UPC') return null;
        throw new LookupUnavailable(data?.message ?? `UPCitemdb respondió ${status}`);
      }
      const item = Array.isArray(data?.items) ? data.items[0] : undefined;
      if (!item?.title) return null;
      return {
        description: String(item.title).trim(),
        brand: item.brand || undefined,
        imageUrl: Array.isArray(item.images) ? item.images.find((u: string) => u.startsWith('https://')) : undefined,
      };
    },
  };
}
