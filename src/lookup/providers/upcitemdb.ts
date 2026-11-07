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
      if (!base) throw new LookupUnavailable('Proxy UPCitemdb no configurado', undefined, true);

      const isDefaultRelative = base === 'api/upc' || base === '/api/upc';
      const isStaticHost =
        typeof window !== 'undefined' &&
        typeof window.location?.hostname === 'string' &&
        (window.location.hostname.endsWith('github.io') || window.location.hostname === 'github.io');

      if (isDefaultRelative && isStaticHost) {
        throw new LookupUnavailable('Proxy UPCitemdb no disponible en este hosting', undefined, false);
      }

      const url = `${base}${base.includes('?') ? '&' : '?'}upc=${encodeURIComponent(code)}`;
      let status: number;
      let data: any;
      try {
        const res = await fetchJson(url, signal);
        status = res.status;
        data = res.data;
      } catch (e) {
        if (e instanceof LookupUnavailable) {
          if (isDefaultRelative && (e.isMisconfigured || /no válida|no JSON/i.test(e.message))) {
            throw new LookupUnavailable('Proxy UPCitemdb no disponible en este hosting', undefined, false);
          }
        }
        throw e;
      }

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
