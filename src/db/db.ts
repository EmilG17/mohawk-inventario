import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export type DescriptionSource = 'catalogo' | 'UPCitemdb' | 'OpenFacts' | 'manual' | 'pendiente';

export interface Product {
  barcode: string;
  sku: string;
  description: string;
  unit: string;
  expectedQty?: number;
  minQty?: number;
  maxQty?: number;
  unitCost?: number;
  brand?: string;
  imageUrl?: string;
  /** Producto escaneado que no venía en el catálogo importado */
  uncataloged?: boolean;
  source: DescriptionSource;
  lookedUpAt?: number;
  /** Se buscó en línea y ninguna base lo tiene (no se reintenta automáticamente) */
  notFoundOnline?: boolean;
  /** Marca temporal de la última modificación del producto para sincronización con DB */
  updatedAt?: number;
}

export interface CountEntry {
  id: string;
  sessionId: string;
  barcode: string;
  qty: number;
  counter: string;
  deviceId: string;
  timestamp: number;
}

export interface Session {
  id: string;
  name: string;
  counter: string;
  createdAt: number;
  closed: boolean;
  closedAt?: number;
}

interface InvDB extends DBSchema {
  products: { key: string; value: Product; indexes: { sku: string } };
  counts: { key: string; value: CountEntry; indexes: { sessionId: string; barcode: string } };
  sessions: { key: string; value: Session };
  meta: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<InvDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<InvDB>> {
  if (!dbPromise) {
    dbPromise = openDB<InvDB>('mohawk-inventario', 1, {
      upgrade(db) {
        const p = db.createObjectStore('products', { keyPath: 'barcode' });
        p.createIndex('sku', 'sku');
        const c = db.createObjectStore('counts', { keyPath: 'id' });
        c.createIndex('sessionId', 'sessionId');
        c.createIndex('barcode', 'barcode');
        db.createObjectStore('sessions', { keyPath: 'id' });
        db.createObjectStore('meta');
      },
    });
  }
  return dbPromise;
}

/** Solo para pruebas */
export async function _resetDBHandle(): Promise<void> {
  if (dbPromise) {
    try {
      const db = await dbPromise;
      db.close();
    } catch {
      /* ignore */
    }
  }
  dbPromise = null;
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---------- meta ----------
export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await (await getDB()).get('meta', key)) as T | undefined;
}
export async function setMeta(key: string, value: unknown): Promise<void> {
  await (await getDB()).put('meta', value, key);
}
export async function getDeviceId(): Promise<string> {
  let id = await getMeta<string>('deviceId');
  if (!id) {
    id = uid();
    await setMeta('deviceId', id);
  }
  return id;
}

type TombstonesMeta = {
  counts?: Record<string, number>;
  movements?: Record<string, number>;
  products?: Record<string, number>;
};

async function recordProductTombstones(barcodes: string[], ts = Date.now()): Promise<void> {
  if (!barcodes.length) return;
  try {
    const current = (await getMeta<TombstonesMeta>('cloud_sync_tombstones_v1')) || {};
    const productsMap = { ...(current.products || {}) };
    for (const bc of barcodes) {
      if (!bc) continue;
      productsMap[bc] = Math.max(productsMap[bc] || 0, ts);
    }
    await setMeta('cloud_sync_tombstones_v1', { ...current, products: productsMap });
  } catch {}
}

async function clearProductTombstones(
  entries: Array<string | { barcode: string; updatedAt: number }>,
  defaultUpdatedAt = Date.now(),
): Promise<void> {
  if (!entries.length) return;
  try {
    const current = (await getMeta<TombstonesMeta>('cloud_sync_tombstones_v1')) || {};
    if (!current.products || Object.keys(current.products).length === 0) return;
    const productsMap = { ...current.products };
    let changed = false;
    for (const item of entries) {
      const bc = typeof item === 'string' ? item : item.barcode;
      const ts = typeof item === 'string' ? defaultUpdatedAt : item.updatedAt;
      const tombTs = productsMap[bc];
      if (tombTs !== undefined && ts >= tombTs) {
        delete productsMap[bc];
        changed = true;
      }
    }
    if (changed) {
      await setMeta('cloud_sync_tombstones_v1', { ...current, products: productsMap });
    }
  } catch {}
}

// ---------- productos ----------
export async function getProduct(barcode: string): Promise<Product | undefined> {
  return (await getDB()).get('products', barcode);
}
export async function putProduct(p: Product): Promise<void> {
  const item: Product = { ...p, updatedAt: p.updatedAt ?? Date.now() };
  await (await getDB()).put('products', item);
  await clearProductTombstones([{ barcode: item.barcode, updatedAt: item.updatedAt! }]);
}
export async function allProducts(): Promise<Product[]> {
  return (await getDB()).getAll('products');
}
export async function findBySku(sku: string): Promise<Product | undefined> {
  return (await getDB()).getFromIndex('products', 'sku', sku);
}
/** Inserta/actualiza en bloque. mode 'replace' borra primero los productos del catálogo previo. */
export async function bulkPutProducts(items: Product[], mode: 'merge' | 'replace' = 'merge'): Promise<void> {
  const db = await getDB();
  const now = Date.now();
  const stamped = items.map((it) => ({ ...it, updatedAt: it.updatedAt ?? now }));
  const incomingSet = new Set(stamped.map((it) => it.barcode));
  let removedBarcodes: string[] = [];

  const tx = db.transaction('products', 'readwrite');
  if (mode === 'replace') {
    const existingKeys = (await tx.store.getAllKeys()) as string[];
    removedBarcodes = existingKeys.filter((k) => !incomingSet.has(k));
    await tx.store.clear();
  }
  for (const it of stamped) {
    const prev = mode === 'merge' ? await tx.store.get(it.barcode) : undefined;
    await tx.store.put(prev ? mergeProduct(prev, it) : it);
  }
  await tx.done;

  if (removedBarcodes.length > 0) {
    await recordProductTombstones(removedBarcodes, now);
  }
  if (stamped.length > 0) {
    await clearProductTombstones(stamped.map((it) => ({ barcode: it.barcode, updatedAt: it.updatedAt! })));
  }
}

/** Combina sin perder información: los campos vacíos/indefinidos del nuevo no sobrescriben al anterior. */
export function mergeProduct(prev: Product, next: Product): Product {
  const prevTs = prev.updatedAt ?? 0;
  const nextTs = next.updatedAt ?? 0;
  if (prevTs > nextTs) {
    const out: Product = { ...prev, updatedAt: prevTs };
    for (const [k, v] of Object.entries(next) as [keyof Product, unknown][]) {
      if (k === 'updatedAt' || v === undefined || v === '') continue;
      if ((out as any)[k] === undefined || (out as any)[k] === '') {
        (out as any)[k] = v;
      }
    }
    if (!prev.description && next.description) out.source = next.source;
    return out;
  }

  const out: Product = { ...prev };
  for (const [k, v] of Object.entries(next) as [keyof Product, unknown][]) {
    if (v === undefined || v === '') continue;
    (out as any)[k] = v;
  }
  if (!next.description && prev.description) out.source = prev.source;
  const resolvedTs = Math.max(prevTs, nextTs);
  if (resolvedTs > 0) out.updatedAt = resolvedTs;
  return out;
}
export async function clearProducts(): Promise<void> {
  const db = await getDB();
  const existingKeys = (await db.getAllKeys('products')) as string[];
  await db.clear('products');
  if (existingKeys.length > 0) {
    await recordProductTombstones(existingKeys, Date.now());
  }
}

export async function deleteProduct(barcode: string): Promise<void> {
  await (await getDB()).delete('products', barcode);
  await recordProductTombstones([barcode], Date.now());
}

export async function deleteProducts(barcodes: string[]): Promise<number> {
  const db = await getDB();
  const tx = db.transaction('products', 'readwrite');
  const deleted: string[] = [];
  for (const b of barcodes) {
    const existing = await tx.store.get(b);
    if (existing) {
      await tx.store.delete(b);
      deleted.push(b);
    }
  }
  await tx.done;
  if (deleted.length > 0) {
    await recordProductTombstones(deleted, Date.now());
  }
  return deleted.length;
}

export interface MassProductPatch {
  brand?: string;
  unit?: string;
  description?: string;
  expectedQty?: number | null; // null = eliminar valor
  minQty?: number | null;      // null = eliminar valor
  maxQty?: number | null;      // null = eliminar valor
  unitCost?: number | null;     // null = eliminar valor
  uncataloged?: boolean;
  source?: DescriptionSource;
  descriptionPrefix?: string;
  descriptionSuffix?: string;
}

export async function bulkModifyProducts(barcodes: string[], patch: MassProductPatch): Promise<number> {
  const db = await getDB();
  const tx = db.transaction('products', 'readwrite');
  let count = 0;
  for (const b of barcodes) {
    const p = await tx.store.get(b);
    if (!p) continue;
    if (patch.brand !== undefined) p.brand = patch.brand.trim();
    if (patch.unit !== undefined) p.unit = patch.unit.trim().toUpperCase();
    if (patch.description !== undefined && patch.description.trim()) {
      p.description = patch.description.trim();
      p.source = 'manual';
    }
    if (patch.expectedQty !== undefined) {
      if (patch.expectedQty === null) delete p.expectedQty;
      else p.expectedQty = patch.expectedQty;
    }
    if (patch.minQty !== undefined) {
      if (patch.minQty === null) delete p.minQty;
      else p.minQty = patch.minQty;
    }
    if (patch.maxQty !== undefined) {
      if (patch.maxQty === null) delete p.maxQty;
      else p.maxQty = patch.maxQty;
    }
    if (patch.unitCost !== undefined) {
      if (patch.unitCost === null) delete p.unitCost;
      else p.unitCost = patch.unitCost;
    }
    if (patch.uncataloged !== undefined) p.uncataloged = patch.uncataloged;
    if (patch.source !== undefined) p.source = patch.source;
    if (patch.descriptionPrefix && p.description) p.description = `${patch.descriptionPrefix.trim()} ${p.description}`;
    if (patch.descriptionSuffix && p.description) p.description = `${p.description} ${patch.descriptionSuffix.trim()}`;
    p.updatedAt = Math.max(Date.now(), (p.updatedAt ?? 0) + 1);
    await tx.store.put(p);
    count++;
  }
  await tx.done;
  return count;
}

// ---------- sesiones ----------
export async function createSession(name: string, counter: string): Promise<Session> {
  const s: Session = { id: uid(), name, counter, createdAt: Date.now(), closed: false };
  await (await getDB()).put('sessions', s);
  await setMeta('activeSession', s.id);
  return s;
}
export async function getSession(id: string): Promise<Session | undefined> {
  return (await getDB()).get('sessions', id);
}
export async function putSession(s: Session): Promise<void> {
  await (await getDB()).put('sessions', s);
}
export async function allSessions(): Promise<Session[]> {
  return (await (await getDB()).getAll('sessions')).sort((a, b) => b.createdAt - a.createdAt);
}
export async function getActiveSession(): Promise<Session | undefined> {
  const id = await getMeta<string>('activeSession');
  return id ? getSession(id) : undefined;
}
export async function setActiveSession(id: string | null): Promise<void> {
  await setMeta('activeSession', id);
}
export async function closeSession(id: string): Promise<void> {
  const db = await getDB();
  const s = await db.get('sessions', id);
  if (!s) return;
  s.closed = true;
  s.closedAt = Date.now();
  await db.put('sessions', s);
  const activeId = await getMeta<string>('activeSession');
  if (activeId === id) {
    await setMeta('activeSession', null);
  }
}

export async function reopenSession(id: string): Promise<void> {
  const db = await getDB();
  const s = await db.get('sessions', id);
  if (!s) return;
  s.closed = false;
  await db.put('sessions', s);
  await setMeta('activeSession', s.id);
}

export const listSessions = allSessions;

export async function deleteSession(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['sessions', 'counts'], 'readwrite');
  await tx.objectStore('sessions').delete(id);
  const countStore = tx.objectStore('counts');
  const countKeys = await countStore.index('sessionId').getAllKeys(id);
  for (const k of countKeys) {
    await countStore.delete(k);
  }
  await tx.done;
  const activeId = await getMeta<string>('activeSession');
  if (activeId === id) {
    await setMeta('activeSession', null);
  }
}


// ---------- conteos ----------
export async function addCount(e: Omit<CountEntry, 'id' | 'timestamp' | 'deviceId'> & Partial<CountEntry>): Promise<CountEntry> {
  const entry: CountEntry = {
    id: e.id ?? uid(),
    timestamp: e.timestamp ?? Date.now(),
    deviceId: e.deviceId ?? (await getDeviceId()),
    sessionId: e.sessionId,
    barcode: e.barcode,
    qty: e.qty,
    counter: e.counter,
  };
  await (await getDB()).put('counts', entry);
  return entry;
}
export async function putCount(e: CountEntry): Promise<void> {
  await (await getDB()).put('counts', e);
}
export async function deleteCount(id: string): Promise<void> {
  await (await getDB()).delete('counts', id);
  try {
    const cid = id.includes('__') ? id.split('__').pop() || id : id;
    const tombstones = (await getMeta<{ counts?: Record<string, number> }>('cloud_sync_tombstones_v1')) || {};
    tombstones.counts = tombstones.counts || {};
    tombstones.counts[cid] = Date.now();
    await setMeta('cloud_sync_tombstones_v1', tombstones);
  } catch {}
}
export async function getCount(id: string): Promise<CountEntry | undefined> {
  return (await getDB()).get('counts', id);
}
export async function countsForSession(sessionId: string): Promise<CountEntry[]> {
  return (await (await getDB()).getAllFromIndex('counts', 'sessionId', sessionId)).sort(
    (a, b) => b.timestamp - a.timestamp,
  );
}
