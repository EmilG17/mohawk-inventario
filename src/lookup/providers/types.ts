export interface ProductInfo {
  description: string;
  brand?: string;
  imageUrl?: string;
  unit?: string;
}

export interface LookupProvider {
  name: 'UPCitemdb' | 'OpenFacts' | 'OpenLibrary';
  /** null = no encontrado. Lanza LookupUnavailable si el servicio no está disponible (sin red, límite, etc.) */
  lookup(code: string, signal: AbortSignal): Promise<ProductInfo | null>;
}

export class LookupUnavailable extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds?: number,
    public readonly isMisconfigured?: boolean,
  ) {
    super(message);
    this.name = 'LookupUnavailable';
  }
}

export async function fetchJson(
  url: string,
  signal: AbortSignal,
  init?: RequestInit,
): Promise<{ status: number; data: any; headers: Headers }> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal,
      headers: {
        Accept: 'application/json',
        'X-User-Agent': 'Mohawk-Inventario/1.0 (contacto@mohawk.com)',
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    throw new LookupUnavailable(`Sin conexión con ${new URL(url, 'http://x').host}: ${(e as Error).message}`);
  }
  if (res.status === 429) {
    const retrySec = parseInt(res.headers.get('retry-after') || '60', 10);
    throw new LookupUnavailable('Límite de consultas alcanzado', isNaN(retrySec) ? 60 : retrySec);
  }
  if (res.status >= 500) throw new LookupUnavailable(`Error del servicio (${res.status})`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) {
    // p. ej. el proxy no existe y el hosting devolvió index.html
    throw new LookupUnavailable('Respuesta no válida del servicio (no JSON)', undefined, true);
  }
  return { status: res.status, data: await res.json(), headers: res.headers };
}
