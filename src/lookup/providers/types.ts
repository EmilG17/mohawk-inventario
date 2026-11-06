export interface ProductInfo {
  description: string;
  brand?: string;
  imageUrl?: string;
  unit?: string;
}

export interface LookupProvider {
  name: 'UPCitemdb' | 'OpenFacts';
  /** null = no encontrado. Lanza LookupUnavailable si el servicio no está disponible (sin red, límite, etc.) */
  lookup(code: string, signal: AbortSignal): Promise<ProductInfo | null>;
}

export class LookupUnavailable extends Error {}

export async function fetchJson(url: string, signal: AbortSignal, init?: RequestInit): Promise<{ status: number; data: any }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal, headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
  } catch (e) {
    throw new LookupUnavailable(`Sin conexión con ${new URL(url, 'http://x').host}: ${(e as Error).message}`);
  }
  if (res.status === 429) throw new LookupUnavailable('Límite de consultas alcanzado');
  if (res.status >= 500) throw new LookupUnavailable(`Error del servicio (${res.status})`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    // p. ej. el proxy no existe y el hosting devolvió index.html
    throw new LookupUnavailable('Respuesta no válida del servicio');
  }
  return { status: res.status, data: await res.json() };
}
