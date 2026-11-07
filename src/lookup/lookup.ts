import { getProduct, putProduct, type Product } from '../db/db';
import { displayBarcode, isValidGtin } from '../io/normalize';
import { settingsSync } from '../settings';
import { openFacts } from './providers/openfacts';
import { openLibrary } from './providers/openlibrary';
import { LookupUnavailable, type LookupProvider, type ProductInfo } from './providers/types';
import { upcItemDb } from './providers/upcitemdb';

export type ResolveStatus = 'catalogo' | 'encontrado' | 'no_encontrado' | 'sin_conexion' | 'manual' | 'desactivado';

export interface ResolveResult {
  product: Product;
  status: ResolveStatus;
}

const TIMEOUT_MS = 3500;
/** Proveedores marcados como no disponibles temporalmente (sin proxy, límite diario…) */
const disabledUntil = new Map<string, { until: number; transient: boolean }>();

let defaultProviders: LookupProvider[] = [openFacts, openLibrary, upcItemDb(() => settingsSync().proxyUrl)];
let providers: LookupProvider[] = [...defaultProviders];

/** Solo para pruebas */
export function _setProviders(p?: LookupProvider[]): void {
  providers = p ?? [openFacts, openLibrary, upcItemDb(() => settingsSync().proxyUrl)];
  disabledUntil.clear();
}

/** Solo códigos GTIN (UPC/EAN) o ISBN tienen sentido en bases públicas. */
export function isLookupable(code: string): boolean {
  const d = displayBarcode(code);
  return /^\d{8}$|^\d{12,14}$/.test(d) || /^\d{14}$/.test(code) || /^(978|979)\d{10}$|^\d{9}[\dX]$/i.test(d);
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * Busca la descripción en internet usando los proveedores en cascada.
 * found: info encontrada · null: nadie lo tiene · 'unavailable': no se pudo consultar
 */
export async function lookupOnline(code: string): Promise<{ provider: LookupProvider['name']; info: ProductInfo } | null | 'unavailable'> {
  if (!isOnline()) return 'unavailable';
  const query = displayBarcode(code);
  const isGtin = /^\d{8}$|^\d{12,14}$/.test(code) || /^\d{8}$|^\d{12,14}$/.test(query);

  // Pre-validar checksum GTIN antes de llamadas de red:
  // Si es un código numérico tipo GTIN con dígito verificador inválido, omitir llamadas de red
  if (isGtin && !isValidGtin(code) && !isValidGtin(query)) {
    return null;
  }

  // Si coincide con prefijo ISBN (978/979 o 10 dígitos), priorizar OpenLibrary
  const isIsbn = /^(978|979)\d{10}$|^\d{9}[\dX]$/i.test(query);
  const chain = isIsbn
    ? [...providers].sort((a, b) => (a.name === 'OpenLibrary' ? -1 : b.name === 'OpenLibrary' ? 1 : 0))
    : providers;

  /** true si algún proveedor falló por causa transitoria (red, límite diario): vale la pena reintentar */
  let transient = false;
  for (const p of chain) {
    const until = disabledUntil.get(p.name);
    if (until && until.until > Date.now()) {
      if (until.transient) transient = true;
      continue;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const info = await p.lookup(query, ctrl.signal);
      if (info) return { provider: p.name, info };
    } catch (e) {
      const msg = (e as Error).message ?? '';
      const isUnavailable = e instanceof LookupUnavailable;
      const retryAfter = isUnavailable && e.retryAfterSeconds ? e.retryAfterSeconds : undefined;
      const isHostingUnavailable = msg.includes('no disponible en este hosting');
      const misconfigured = isUnavailable && (e.isMisconfigured || /configurado/.test(msg));

      if (retryAfter) {
        disabledUntil.set(p.name, { until: Date.now() + retryAfter * 1000, transient: true });
        transient = true;
      } else if (misconfigured) {
        disabledUntil.set(p.name, { until: Date.now() + 15 * 60_000, transient: false });
      } else if (/Límite/.test(msg)) {
        disabledUntil.set(p.name, { until: Date.now() + 60_000, transient: true });
        transient = true;
      } else if (isHostingUnavailable) {
        // En hosting estático (GitHub Pages), proxy relativo no está disponible.
        // No bloquear permanentemente 15 minutos ni forzar sin_conexión si otros no fallaron.
      } else {
        transient = true;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return transient ? 'unavailable' : null;
}

/**
 * Obtiene la descripción de un código escaneado:
 * 1) catálogo local → 2) bases públicas en línea → 3) queda pendiente para captura manual / reintento.
 * Siempre devuelve un producto guardado localmente.
 */
export async function resolveDescription(code: string, opts: { forceOnline?: boolean } = {}): Promise<ResolveResult> {
  const local = await getProduct(code);
  if (local && local.description && !opts.forceOnline) {
    return { product: local, status: local.source === 'manual' ? 'manual' : local.source === 'catalogo' ? 'catalogo' : 'encontrado' };
  }
  const base: Product = local ?? {
    barcode: code, sku: '', description: '', unit: '', uncataloged: true, source: 'pendiente',
  };

  if (!settingsSync().onlineLookup || !isLookupable(code)) {
    if (!local) await putProduct(base);
    return { product: base, status: settingsSync().onlineLookup ? 'no_encontrado' : 'desactivado' };
  }

  const query = displayBarcode(code);
  const isGtin = /^\d{8}$|^\d{12,14}$/.test(code) || /^\d{8}$|^\d{12,14}$/.test(query);

  // Pre-validar checksum GTIN antes de llamadas de red:
  // Si el checksum es inválido, marcar como notFoundOnline sin fallar la cola de pendientes
  if (isGtin && !isValidGtin(code) && !isValidGtin(query)) {
    const updated: Product = { ...base, lookedUpAt: Date.now(), notFoundOnline: true };
    await putProduct(updated);
    return { product: updated, status: 'no_encontrado' };
  }

  const r = await lookupOnline(code);
  if (r && typeof r === 'object') {
    const updated: Product = {
      ...base,
      description: r.info.description,
      brand: r.info.brand ?? base.brand,
      imageUrl: r.info.imageUrl ?? base.imageUrl,
      source: r.provider as any,
      lookedUpAt: Date.now(),
      notFoundOnline: false,
    };
    await putProduct(updated);
    return { product: updated, status: 'encontrado' };
  }
  const notFound = r === null;
  const updated: Product = { ...base, lookedUpAt: Date.now(), notFoundOnline: notFound };
  await putProduct(updated);
  return { product: updated, status: notFound ? 'no_encontrado' : 'sin_conexion' };
}

/** Guarda una descripción capturada a mano. */
export async function setManualDescription(code: string, description: string, extra: Partial<Product> = {}): Promise<Product> {
  const local = await getProduct(code);
  const p: Product = {
    ...(local ?? { barcode: code, sku: '', unit: '', uncataloged: true }),
    ...extra,
    description: description.trim(),
    source: 'manual',
  } as Product;
  await putProduct(p);
  return p;
}
