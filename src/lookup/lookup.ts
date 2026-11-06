import { getProduct, putProduct, type Product } from '../db/db';
import { displayBarcode } from '../io/normalize';
import { settingsSync } from '../settings';
import { openFacts } from './providers/openfacts';
import { LookupUnavailable, type LookupProvider, type ProductInfo } from './providers/types';
import { upcItemDb } from './providers/upcitemdb';

export type ResolveStatus = 'catalogo' | 'encontrado' | 'no_encontrado' | 'sin_conexion' | 'manual' | 'desactivado';

export interface ResolveResult {
  product: Product;
  status: ResolveStatus;
}

const TIMEOUT_MS = 6000;
/** Proveedores marcados como no disponibles temporalmente (sin proxy, límite diario…) */
const disabledUntil = new Map<string, { until: number; transient: boolean }>();

let providers: LookupProvider[] = [openFacts, upcItemDb(() => settingsSync().proxyUrl)];

/** Solo para pruebas */
export function _setProviders(p: LookupProvider[]): void {
  providers = p;
  disabledUntil.clear();
}

/** Solo códigos GTIN (UPC/EAN) tienen sentido en bases públicas. */
export function isLookupable(code: string): boolean {
  return /^\d{8}$|^\d{12,14}$/.test(displayBarcode(code)) || /^\d{14}$/.test(code);
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
  /** true si algún proveedor falló por causa transitoria (red, límite diario): vale la pena reintentar */
  let transient = false;
  for (const p of providers) {
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
      const misconfigured = e instanceof LookupUnavailable && /configurado|no válida/.test(msg);
      if (!misconfigured) transient = true;
      if (misconfigured || /Límite/.test(msg)) {
        disabledUntil.set(p.name, { until: Date.now() + 15 * 60_000, transient: !misconfigured });
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

  const r = await lookupOnline(code);
  if (r && typeof r === 'object') {
    const updated: Product = {
      ...base,
      description: r.info.description,
      brand: r.info.brand ?? base.brand,
      imageUrl: r.info.imageUrl ?? base.imageUrl,
      source: r.provider,
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
