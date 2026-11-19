import { getMeta, setMeta, updateTombstonesAtomic, type CountEntry, type Product } from '../db/db';
import type { Movement } from '../db/movements';
import { APP_ID } from '../io/exportResults';
import { canonicalCountId, normalizeRoomCode, sanitizeParticipantKey } from './firebaseKeys';
import type { CloudParticipant, CloudRoomState, LiveScannerState, TombstoneState } from './types';

const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TOMBSTONES_PER_TYPE = 2000;

export function pruneTombstoneMap(map?: Record<string, number>, now = Date.now()): Record<string, number> {
  if (!map) return {};
  const cutoff = now - TOMBSTONE_TTL_MS;
  const entries = Object.entries(map).filter(
    ([, ts]) => typeof ts === 'number' && Number.isFinite(ts) && ts >= cutoff,
  );
  if (entries.length > MAX_TOMBSTONES_PER_TYPE) {
    entries.sort((a, b) => b[1] - a[1]);
    entries.length = MAX_TOMBSTONES_PER_TYPE;
  }
  return Object.fromEntries(entries);
}

export async function getLocalTombstones(): Promise<TombstoneState> {
  return (await getMeta<TombstoneState>('cloud_sync_tombstones_v1')) || {};
}

export async function saveLocalTombstones(tombstones: TombstoneState): Promise<void> {
  await setMeta('cloud_sync_tombstones_v1', tombstones);
}

export async function recordTombstone(
  type: 'counts' | 'movements' | 'products',
  id: string,
  timestamp = Date.now(),
): Promise<void> {
  const normId = type === 'counts' ? canonicalCountId(id) : id;
  await updateTombstonesAtomic((current) => {
    const currentMap = { ...(current[type] || {}) };
    currentMap[normId] = Math.max(currentMap[normId] || 0, timestamp);
    return { ...current, [type]: currentMap };
  });
}

export function mergeLiveScannersMap(
  baseMap?: Record<string, LiveScannerState>,
  incomingMap?: Record<string, LiveScannerState>,
): Record<string, LiveScannerState> {
  const cutoff = Date.now() - 12 * 3600 * 1000;
  const out: Record<string, LiveScannerState> = {};
  for (const src of [baseMap, incomingMap]) {
    if (!src || typeof src !== 'object') continue;
    for (const [key, sc] of Object.entries(src)) {
      if (!sc || typeof sc !== 'object') continue;
      if (typeof sc.updatedAt === 'number' && sc.updatedAt < cutoff) continue;
      const prev = out[key];
      if (!prev || (sc.updatedAt || 0) >= (prev.updatedAt || 0)) {
        out[key] = sc;
      }
    }
  }
  return out;
}

/**
 * Helper único y determinista de conciliación LWW para productos entre IndexedDB local y salas de nube.
 */
export function mergeCatalogProduct(prev: Product, next: Product, targetBarcode: string): Product {
  const pTs = next.updatedAt ?? 0;
  const prevTs = prev.updatedAt ?? 0;
  const incomingIsOfficial = !next.uncataloged && (next.source === 'catalogo' || next.source === 'manual');
  const prevIsPending = prev.source === 'pendiente' || Boolean(prev.uncataloged);

  if (pTs > prevTs) {
    const mergedProd: Product = {
      ...prev,
      ...next,
      barcode: targetBarcode,
      description: next.description || prev.description,
      sku: next.sku || prev.sku,
      unit: next.unit || prev.unit,
      expectedQty: next.expectedQty,
      minQty: next.minQty,
      maxQty: next.maxQty,
      unitCost: next.unitCost,
      brand: next.brand ?? prev.brand,
      imageUrl: next.imageUrl ?? prev.imageUrl,
      uncataloged: next.uncataloged !== undefined ? next.uncataloged : prev.uncataloged,
      source:
        next.source === 'pendiente' && prev.source !== 'pendiente' && !next.description
          ? prev.source
          : next.source,
      updatedAt: pTs,
    };
    if (mergedProd.expectedQty === undefined) delete mergedProd.expectedQty;
    if (mergedProd.minQty === undefined) delete mergedProd.minQty;
    if (mergedProd.maxQty === undefined) delete mergedProd.maxQty;
    if (mergedProd.unitCost === undefined) delete mergedProd.unitCost;
    if (mergedProd.brand === undefined) delete mergedProd.brand;
    if (mergedProd.imageUrl === undefined) delete mergedProd.imageUrl;
    return mergedProd;
  }

  if (prevTs > pTs) {
    const promotePrev = prevIsPending && incomingIsOfficial;
    return {
      ...prev,
      barcode: targetBarcode,
      description: prev.description || next.description,
      sku: prev.sku || next.sku,
      unit: prev.unit || next.unit,
      expectedQty: prev.expectedQty !== undefined ? prev.expectedQty : next.expectedQty,
      minQty: prev.minQty !== undefined ? prev.minQty : next.minQty,
      maxQty: prev.maxQty !== undefined ? prev.maxQty : next.maxQty,
      unitCost: prev.unitCost !== undefined ? prev.unitCost : next.unitCost,
      brand: prev.brand || next.brand,
      imageUrl: prev.imageUrl || next.imageUrl,
      uncataloged: promotePrev ? false : prev.uncataloged,
      source: promotePrev
        ? next.source
        : prev.source === 'pendiente' && next.source !== 'pendiente'
          ? next.source
          : prev.source,
      updatedAt: prevTs,
    };
  }

  const nextDesc =
    next.description && (prevIsPending || incomingIsOfficial || !prev.description)
      ? next.description
      : prev.description || next.description;
  const nextSource: Product['source'] =
    next.source === 'catalogo' || prev.source === 'catalogo'
      ? 'catalogo'
      : prev.source === 'pendiente' && next.source !== 'pendiente'
        ? next.source
        : prev.source;
  const nextUncataloged =
    next.uncataloged === false || prev.uncataloged === false || nextSource === 'catalogo'
      ? false
      : Boolean(prev.uncataloged && next.uncataloged);

  const mergedProd: Product = {
    ...prev,
    ...next,
    barcode: targetBarcode,
    description: nextDesc,
    sku: next.sku || prev.sku,
    unit: next.unit || prev.unit,
    expectedQty: next.expectedQty !== undefined ? next.expectedQty : prev.expectedQty,
    minQty: next.minQty !== undefined ? next.minQty : prev.minQty,
    maxQty: next.maxQty !== undefined ? next.maxQty : prev.maxQty,
    unitCost: next.unitCost !== undefined ? next.unitCost : prev.unitCost,
    brand: next.brand || prev.brand,
    imageUrl: next.imageUrl || prev.imageUrl,
    uncataloged: nextUncataloged,
    source: nextSource,
  };
  const sameTs = pTs || prevTs;
  if (sameTs) mergedProd.updatedAt = sameTs;
  return mergedProd;
}

/**
 * Combina dos estados de sala sin perder ni duplicar conteos, productos ni movimientos.
 */
export function mergeRoomStates(
  base: CloudRoomState | null,
  incoming: {
    roomCode: string;
    sessionName: string;
    counts: CountEntry[];
    products: Product[];
    liveScanners?: Record<string, LiveScannerState>;
    movements?: Movement[];
    idealLevels?: Record<string, number>;
    tombstones?: {
      counts?: Record<string, number>;
      movements?: Record<string, number>;
      products?: Record<string, number>;
    };
    supervisorPin?: string;
    supervisorPinUpdatedAt?: number;
  },
): CloudRoomState {
  const roomCode = normalizeRoomCode(incoming.roomCode);

  const mergedTombstones: {
    counts: Record<string, number>;
    movements: Record<string, number>;
    products: Record<string, number>;
  } = {
    counts: { ...(base?.tombstones?.counts || {}) },
    movements: { ...(base?.tombstones?.movements || {}) },
    products: { ...(base?.tombstones?.products || {}) },
  };

  if (incoming.tombstones?.counts) {
    for (const [id, ts] of Object.entries(incoming.tombstones.counts)) {
      if (typeof ts === 'number') {
        const cid = canonicalCountId(id);
        mergedTombstones.counts[cid] = Math.max(mergedTombstones.counts[cid] || 0, ts);
      }
    }
  }
  if (incoming.tombstones?.movements) {
    for (const [id, ts] of Object.entries(incoming.tombstones.movements)) {
      if (typeof ts === 'number') {
        mergedTombstones.movements[id] = Math.max(mergedTombstones.movements[id] || 0, ts);
      }
    }
  }
  if (incoming.tombstones?.products) {
    for (const [bc, ts] of Object.entries(incoming.tombstones.products)) {
      if (typeof ts === 'number') {
        mergedTombstones.products[bc] = Math.max(mergedTombstones.products[bc] || 0, ts);
      }
    }
  }
  const nowTs = Date.now();
  mergedTombstones.counts = pruneTombstoneMap(mergedTombstones.counts, nowTs);
  mergedTombstones.movements = pruneTombstoneMap(mergedTombstones.movements, nowTs);
  mergedTombstones.products = pruneTombstoneMap(mergedTombstones.products, nowTs);

  const countMap = new Map<string, CountEntry>();
  if (base?.counts) {
    for (const c of base.counts) {
      if (c && c.id) {
        const cid = canonicalCountId(c.id);
        const tombTs = mergedTombstones.counts[cid];
        if (tombTs !== undefined && tombTs >= c.timestamp) continue;
        countMap.set(cid, { ...c, id: cid });
      }
    }
  }
  for (const c of incoming.counts) {
    if (c && c.id) {
      const cid = canonicalCountId(c.id);
      const tombTs = mergedTombstones.counts[cid];
      if (tombTs !== undefined && tombTs >= c.timestamp) continue;
      const prev = countMap.get(cid);
      if (!prev || c.timestamp >= prev.timestamp) {
        countMap.set(cid, { ...c, id: cid });
      }
    }
  }

  const prodMap = new Map<string, Product>();
  const skuToBarcode = new Map<string, string>();

  const upsertProdInRoom = (p: Product) => {
    if (!p || !p.barcode) return;
    const prodTombTs = mergedTombstones.products[p.barcode];
    if (prodTombTs !== undefined) {
      if (prodTombTs >= (p.updatedAt || 0)) return;
      // Limpiar lápida superada por reingreso posterior
      delete mergedTombstones.products[p.barcode];
    }

    const skuUpper = (p.sku || '').trim().toUpperCase();
    let existingKey = prodMap.has(p.barcode) ? p.barcode : undefined;
    if (!existingKey && skuUpper && skuToBarcode.has(skuUpper)) {
      const candidateKey = skuToBarcode.get(skuUpper)!;
      const cand = prodMap.get(candidateKey);
      if (cand && (cand.barcode.startsWith('SKU:') || p.barcode.startsWith('SKU:') || cand.uncataloged || p.uncataloged)) {
        existingKey = candidateKey;
      }
    }

    if (!existingKey) {
      prodMap.set(p.barcode, p);
      if (skuUpper) skuToBarcode.set(skuUpper, p.barcode);
      return;
    }

    const prev = prodMap.get(existingKey)!;
    const targetBarcode =
      prev.barcode.startsWith('SKU:') && !p.barcode.startsWith('SKU:')
        ? p.barcode
        : p.barcode.startsWith('SKU:') && !prev.barcode.startsWith('SKU:')
          ? prev.barcode
          : p.barcode;

    if (existingKey !== targetBarcode) {
      prodMap.delete(existingKey);
    }

    const mergedProd = mergeCatalogProduct(prev, p, targetBarcode);
    prodMap.set(targetBarcode, mergedProd);
    if (mergedProd.sku) skuToBarcode.set(mergedProd.sku.trim().toUpperCase(), targetBarcode);
  };

  if (base?.products) {
    for (const p of base.products) upsertProdInRoom(p);
  }
  for (const p of incoming.products) {
    upsertProdInRoom(p);
  }

  const allCounts = [...countMap.values()].sort((a, b) => a.timestamp - b.timestamp);
  const participants: Record<string, CloudParticipant> = {};
  for (const c of allCounts) {
    const key = sanitizeParticipantKey(c.counter || 'Tecnico', c.deviceId || 'local');
    const prod = prodMap.get(c.barcode);
    const cur = participants[key] ?? {
      counter: c.counter || 'Técnico',
      deviceId: (c.deviceId || 'local').slice(0, 8),
      lastSeen: 0,
      scans: 0,
      units: 0,
    };
    cur.scans += 1;
    cur.units += c.qty;
    if (c.timestamp >= cur.lastSeen) {
      cur.lastSeen = c.timestamp;
      cur.lastSku = prod?.sku || c.barcode;
      cur.lastDescription = prod?.description || c.barcode;
      cur.lastQty = c.qty;
    }
    participants[key] = cur;
  }

  const movMap = new Map<string, Movement>();
  if (base?.movements && Array.isArray(base.movements)) {
    for (const m of base.movements) {
      if (m && m.id) {
        const tombTs = mergedTombstones.movements[m.id];
        if (tombTs !== undefined && tombTs >= m.timestamp) continue;
        movMap.set(m.id, m);
      }
    }
  }
  if (incoming.movements && Array.isArray(incoming.movements)) {
    for (const m of incoming.movements) {
      if (m && m.id) {
        const tombTs = mergedTombstones.movements[m.id];
        if (tombTs !== undefined && tombTs >= m.timestamp) continue;
        const prev = movMap.get(m.id);
        if (!prev || m.timestamp >= (prev.timestamp || 0)) {
          movMap.set(m.id, m);
        }
      }
    }
  }
  const mergedMovements = [...movMap.values()].sort((a, b) => a.timestamp - b.timestamp);

  const mergedIdealLevels: Record<string, number> = {};
  if (base?.idealLevels && typeof base.idealLevels === 'object') {
    for (const [k, v] of Object.entries(base.idealLevels)) {
      const sku = k.trim().toUpperCase();
      if (sku && typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        mergedIdealLevels[sku] = v;
      }
    }
  }
  if (incoming.idealLevels && typeof incoming.idealLevels === 'object') {
    for (const [k, v] of Object.entries(incoming.idealLevels)) {
      const sku = k.trim().toUpperCase();
      if (sku && typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        mergedIdealLevels[sku] = v;
      }
    }
  }

  const mergedLiveScanners = mergeLiveScannersMap(base?.liveScanners, incoming.liveScanners);

  const basePin = base?.supervisorPin && /^\d{4}$/.test(base.supervisorPin.trim()) ? base.supervisorPin.trim() : undefined;
  const basePinTs = basePin ? (base?.supervisorPinUpdatedAt || 0) : -1;
  const incPin = incoming.supervisorPin && /^\d{4}$/.test(incoming.supervisorPin.trim()) ? incoming.supervisorPin.trim() : undefined;
  const incPinTs = incPin ? (incoming.supervisorPinUpdatedAt || 0) : -1;

  let mergedSupervisorPin: string | undefined;
  let mergedSupervisorPinUpdatedAt: number | undefined;
  if (incPin && incPinTs >= basePinTs) {
    mergedSupervisorPin = incPin;
    mergedSupervisorPinUpdatedAt = incPinTs > 0 ? incPinTs : undefined;
  } else if (basePin) {
    mergedSupervisorPin = basePin;
    mergedSupervisorPinUpdatedAt = basePinTs > 0 ? basePinTs : undefined;
  }

  return {
    app: APP_ID,
    version: 1,
    roomCode,
    updatedAt: Date.now(),
    sessionName: incoming.sessionName || base?.sessionName || `Sala ${roomCode}`,
    counts: allCounts,
    products: [...prodMap.values()],
    participants,
    liveScanners: mergedLiveScanners,
    movements: mergedMovements,
    idealLevels: mergedIdealLevels,
    tombstones: mergedTombstones,
    ...(mergedSupervisorPin ? { supervisorPin: mergedSupervisorPin } : {}),
    ...(mergedSupervisorPinUpdatedAt ? { supervisorPinUpdatedAt: mergedSupervisorPinUpdatedAt } : {}),
  };
}

export function computeDataFingerprint(state: CloudRoomState | null): string {
  if (!state) return '';
  const lastCountTs = state.counts.reduce((m, c) => Math.max(m, c?.timestamp || 0), 0);
  const countQtySum = state.counts.reduce((sum, c) => sum + (c.qty || 0), 0);
  const countSig = state.counts
    .map((c) => `${canonicalCountId(c.id)}:${c.qty}:${c.timestamp}`)
    .sort()
    .join(';');

  const lastMovTs = (state.movements || []).reduce((m, mv) => Math.max(m, mv?.timestamp || 0), 0);
  const movQtySum = (state.movements || []).reduce((sum, m) => sum + (m.quantity || 0), 0);
  const movSig = (state.movements || [])
    .map((m) => `${m.id}:${m.quantity}:${m.timestamp}:${m.type}`)
    .sort()
    .join(';');

  const idealKeys = state.idealLevels ? Object.entries(state.idealLevels).map(([k, v]) => `${k}:${v}`).sort().join(',') : '';
  const prodSig = state.products
    .map(
      (p) =>
        `${p.barcode}:${p.sku}:${p.description}:${p.expectedQty ?? ''}:${p.minQty ?? ''}:${p.maxQty ?? ''}:${p.unitCost ?? ''}:${p.updatedAt ?? ''}`,
    )
    .sort()
    .join(';');

  const tombSig = state.tombstones
    ? `${Object.entries(state.tombstones.counts || {}).sort().map(([k, v]) => `${k}:${v}`).join(',')}|${Object.entries(state.tombstones.movements || {}).sort().map(([k, v]) => `${k}:${v}`).join(',')}|${Object.entries(state.tombstones.products || {}).sort().map(([k, v]) => `${k}:${v}`).join(',')}`
    : '';

  const partSig = Object.entries(state.participants || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, p]) => `${k}:${p.scans}:${p.units}:${p.lastSeen}:${p.lastSku ?? ''}:${p.lastQty ?? ''}`)
    .join(';');

  const pinSig = `${state.supervisorPin || ''}:${state.supervisorPinUpdatedAt || 0}`;

  return `${state.sessionName || ''}|${state.counts.length}|${lastCountTs}|${countQtySum}|${countSig}|${state.products.length}|${prodSig}|${state.movements?.length ?? 0}|${lastMovTs}|${movQtySum}|${movSig}|${idealKeys}|${tombSig}|${partSig}|${pinSig}`;
}

export function computeStateFingerprint(state: CloudRoomState | null): string {
  if (!state) return '';
  const scannerSig = Object.entries(state.liveScanners || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, sc]) => `${k}:${sc.status}:${sc.barcode ?? ''}:${sc.qty ?? ''}:${sc.cameraOn ? 1 : 0}:${sc.updatedAt}`)
    .join(';');

  return `${computeDataFingerprint(state)}|${scannerSig}`;
}
