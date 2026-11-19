import {
  allProducts,
  countsForSession,
  getActiveSession,
  getDB,
  getDeviceId,
  getMeta,
  getSession,
  setMeta,
  type CountEntry,
  type Product,
  type Session,
} from '../db/db';
import {
  getIdealLevels,
  listMovements,
  setIdealLevels,
  updateMovements,
  type Movement,
} from '../db/movements';
import { APP_ID, type CountFile } from '../io/exportResults';
import { mergeCountFiles, reconcileCatalogProducts } from '../io/mergeCounts';
import { loadSettings, saveSettings, settingsSync } from '../settings';
import { isMobileCatalogReadOnly } from '../ui/catalogMode';
import {
  buildRoomEndpointUrl,
  canonicalCountId,
  decodeFirebaseKey,
  encodeFirebaseKey,
  isFirebaseEndpoint,
  isRoomInviteUrl,
  normalizeEndpointBaseUrl,
  normalizeRoomCode,
  parseRoomInviteUrl,
  sanitizeParticipantKey,
} from './firebaseKeys';
import {
  coerceRemoteRoomState,
  fetchRemoteRoom,
  fetchRemoteUpdatedAt,
  getFetchTimeoutSignal,
  patchRemoteRoomDelta,
  putRemoteRoom,
  toArray,
} from './firebaseTransport';
import {
  computeDataFingerprint,
  computeStateFingerprint,
  getLocalTombstones,
  mergeLiveScannersMap,
  mergeRoomStates,
  recordTombstone,
  saveLocalTombstones,
} from './roomMerge';
import {
  emitStatus,
  getCloudConnectionStatus,
  getLocalRoomMirror,
  hasBroadcastChannel,
  memoryRooms,
  notifyRoomListeners,
  postBroadcastMessage,
  saveLocalRoomMirror,
  setBroadcastIncomingHandler,
  updateLocalMirrorQuickly,
  type BroadcastMessagePayload,
} from './roomMirror';
import type {
  CloudParticipant,
  CloudRoomState,
  LiveScannerState,
  RoomDeltaPayload,
  SyncResult,
  TombstoneState,
} from './types';

let syncMutexTail: Promise<unknown> = Promise.resolve();

function withSyncMutex<T>(fn: () => Promise<T>): Promise<T> {
  const previous = syncMutexTail;
  let release: () => void = () => {};
  syncMutexTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  return previous
    .catch(() => undefined)
    .then(fn)
    .finally(() => {
      release();
    });
}

function dispatchRoleChangeEvent(role: 'supervisor' | 'technician'): void {
  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent('mhk:rolechange', { detail: { role } }));
  }
}

async function pruneLocalByTombstones(
  mergedTomb: TombstoneState,
  sessionId?: string,
  excludeMovementsPrune = false,
): Promise<{ changed: boolean; deletedMovs: boolean }> {
  let changed = false;
  let deletedMovs = false;
  const db = await getDB();

  if (sessionId && mergedTomb.counts && Object.keys(mergedTomb.counts).length > 0) {
    const localCounts = await countsForSession(sessionId);
    const idsToDelete: string[] = [];
    for (const c of localCounts) {
      const cid = canonicalCountId(c.id);
      const tombTs = mergedTomb.counts[cid];
      if (tombTs !== undefined && tombTs >= c.timestamp) {
        idsToDelete.push(c.id);
      }
    }
    if (idsToDelete.length > 0) {
      const tx = db.transaction('counts', 'readwrite');
      for (const id of idsToDelete) {
        await tx.store.delete(id);
      }
      await tx.done;
      changed = true;
    }
  }

  if (!excludeMovementsPrune && mergedTomb.movements && Object.keys(mergedTomb.movements).length > 0) {
    await updateMovements((localMovs) => {
      const filtered = localMovs.filter((m) => {
        const tombTs = mergedTomb.movements![m.id];
        return !(tombTs !== undefined && tombTs >= m.timestamp);
      });
      if (filtered.length !== localMovs.length) {
        deletedMovs = true;
        changed = true;
        return filtered;
      }
      return localMovs;
    });
  }

  if (mergedTomb.products && Object.keys(mergedTomb.products).length > 0) {
    const localProds = await allProducts();
    const bcsToDelete: string[] = [];
    for (const p of localProds) {
      const tombTs = mergedTomb.products[p.barcode];
      if (tombTs !== undefined && tombTs >= (p.updatedAt || 0)) {
        bcsToDelete.push(p.barcode);
      }
    }
    if (bcsToDelete.length > 0) {
      const tx = db.transaction('products', 'readwrite');
      for (const bc of bcsToDelete) {
        await tx.store.delete(bc);
      }
      await tx.done;
      changed = true;
    }
  }

  return { changed, deletedMovs };
}

function areIdealMapsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function sanitizeIdealMap(raw?: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const sku = k.trim().toUpperCase();
    if (sku && typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      out[sku] = v;
    }
  }
  return out;
}

async function _applyIncomingRoomStateToLocalUnlocked(
  incomingState: CloudRoomState,
  sourceTransport: 'remote' | 'local',
): Promise<boolean> {
  const prevMirror = getLocalRoomMirror(incomingState.roomCode);
  const mergedState: CloudRoomState = {
    ...incomingState,
    liveScanners: mergeLiveScannersMap(prevMirror?.liveScanners, incomingState.liveScanners),
  };
  const prevFp = computeStateFingerprint(prevMirror);
  const nextFp = computeStateFingerprint(mergedState);
  const dataChanged = !prevMirror || computeDataFingerprint(prevMirror) !== computeDataFingerprint(mergedState);

  saveLocalRoomMirror(incomingState.roomCode, mergedState);

  let hasNewChanges = prevFp !== nextFp;

  if (dataChanged) {
    const localTombstones = await getLocalTombstones();
    const mergedTomb: TombstoneState = {
      counts: { ...(localTombstones.counts || {}) },
      movements: { ...(localTombstones.movements || {}) },
      products: { ...(localTombstones.products || {}) },
    };
    let tombChanged = false;

    if (incomingState.tombstones) {
      if (incomingState.tombstones.counts) {
        for (const [id, ts] of Object.entries(incomingState.tombstones.counts)) {
          if (typeof ts === 'number') {
            const cid = canonicalCountId(id);
            const prevTs = mergedTomb.counts?.[cid] || 0;
            if (ts > prevTs) {
              mergedTomb.counts![cid] = ts;
              tombChanged = true;
            }
          }
        }
      }
      if (incomingState.tombstones.movements) {
        for (const [id, ts] of Object.entries(incomingState.tombstones.movements)) {
          if (typeof ts === 'number') {
            const prevTs = mergedTomb.movements?.[id] || 0;
            if (ts > prevTs) {
              mergedTomb.movements![id] = ts;
              tombChanged = true;
            }
          }
        }
      }
      if (incomingState.tombstones.products) {
        for (const [bc, ts] of Object.entries(incomingState.tombstones.products)) {
          if (typeof ts === 'number') {
            const prevTs = mergedTomb.products?.[bc] || 0;
            if (ts > prevTs) {
              mergedTomb.products![bc] = ts;
              tombChanged = true;
            }
          }
        }
      }
    }

    // Limpiar lápida de producto si fue reingresado con un timestamp estrictamente posterior
    for (const p of incomingState.products || []) {
      const tombTs = mergedTomb.products?.[p.barcode];
      if (tombTs !== undefined && (p.updatedAt || 0) > tombTs) {
        delete mergedTomb.products![p.barcode];
        tombChanged = true;
      }
    }

    if (tombChanged) {
      await saveLocalTombstones(mergedTomb);
    }

    const activeSession = await getActiveSession();
    const pruneRes = await pruneLocalByTombstones(mergedTomb, activeSession?.id, true);
    if (pruneRes.changed) hasNewChanges = true;

    const incomingProducts = (incomingState.products || []).filter((p) => {
      const tombTs = mergedTomb.products?.[p.barcode];
      return !(tombTs !== undefined && tombTs >= (p.updatedAt || 0));
    });
    const incomingCounts = (incomingState.counts || []).filter((c) => {
      const cid = canonicalCountId(c.id);
      const tombTs = mergedTomb.counts?.[cid];
      return !(tombTs !== undefined && tombTs >= c.timestamp);
    });

    if (incomingProducts.length > 0) {
      const recRes = await reconcileCatalogProducts(incomingProducts);
      if (recRes.added > 0 || recRes.updated > 0) {
        hasNewChanges = true;
      }
    }

    if (activeSession && incomingCounts.length > 0) {
      const remoteFile: CountFile = {
        app: APP_ID,
        version: 1,
        kind: 'conteo',
        exportedAt: new Date().toISOString(),
        deviceId: 'cloud-room',
        session: {
          id: activeSession.id,
          name: mergedState.sessionName || activeSession.name,
          counter: 'Sala ' + mergedState.roomCode,
          createdAt: activeSession.createdAt,
          closed: false,
        },
        counts: incomingCounts,
        products: [],
      };
      const mergeRes = await mergeCountFiles(activeSession.id, [remoteFile]);
      if (mergeRes.added > 0 || (mergeRes.updated || 0) > 0 || mergeRes.productsAdded > 0) {
        hasNewChanges = true;
      }
    }

    const incomingMovements = incomingState.movements && Array.isArray(incomingState.movements)
      ? incomingState.movements
      : [];
    const hasMovementTombstones = Boolean(mergedTomb.movements && Object.keys(mergedTomb.movements).length > 0);

    if (incomingMovements.length > 0 || hasMovementTombstones) {
      await updateMovements((localMovs) => {
        const movMap = new Map<string, Movement>();
        let movsModified = false;

        for (const m of localMovs) {
          const tombTs = mergedTomb.movements?.[m.id];
          if (tombTs !== undefined && tombTs >= m.timestamp) {
            movsModified = true;
            continue;
          }
          movMap.set(m.id, m);
        }

        for (const m of incomingMovements) {
          if (!m || !m.id) continue;
          const tombTs = mergedTomb.movements?.[m.id];
          if (tombTs !== undefined && tombTs >= (m.timestamp || 0)) continue;

          const prev = movMap.get(m.id);
          if (!prev) {
            movMap.set(m.id, m);
            movsModified = true;
            hasNewChanges = true;
          } else if (
            m.timestamp > (prev.timestamp || 0) ||
            (m.timestamp === (prev.timestamp || 0) &&
              (m.quantity !== prev.quantity ||
                m.type !== prev.type ||
                m.sku !== prev.sku ||
                m.notes !== prev.notes ||
                m.folio !== prev.folio ||
                m.machineOrArea !== prev.machineOrArea ||
                m.technicianOrSupplier !== prev.technicianOrSupplier))
          ) {
            movMap.set(m.id, m);
            movsModified = true;
            hasNewChanges = true;
          }
        }

        if (!movsModified) return localMovs;
        hasNewChanges = true;
        return [...movMap.values()].sort((a, b) => a.timestamp - b.timestamp);
      });
    }

    if (incomingState.idealLevels && typeof incomingState.idealLevels === 'object') {
      const cleanIncomingIdeals = sanitizeIdealMap(incomingState.idealLevels);
      if (Object.keys(cleanIncomingIdeals).length > 0) {
        const curIdeals = await getIdealLevels();
        const mergedIdeals = { ...curIdeals, ...cleanIncomingIdeals };
        if (!areIdealMapsEqual(curIdeals, mergedIdeals)) {
          await setIdealLevels(mergedIdeals);
          hasNewChanges = true;
        }
      }
    }
  }

  const now = Date.now();
  if (sourceTransport === 'remote') {
    await setMeta(`lastSync_${incomingState.roomCode}`, now);
    if (typeof incomingState.updatedAt === 'number') {
      await setMeta(`lastSeenRemoteUpdatedAt_${incomingState.roomCode}`, incomingState.updatedAt);
    }
  }

  emitStatus({
    state: sourceTransport === 'remote' ? 'connected' : 'local_only',
    roomCode: mergedState.roomCode,
    transport: sourceTransport,
    lastSyncedAt: sourceTransport === 'remote' ? now : getCloudConnectionStatus().lastSyncedAt,
    lastError: null,
    participantCount: Object.keys(mergedState.participants || {}).length,
    totalCounts: mergedState.counts.length,
    totalMovements: mergedState.movements?.length ?? 0,
  });

  if (hasNewChanges) {
    notifyRoomListeners(mergedState);
  }
  return hasNewChanges;
}

/**
 * Aplica en la base de datos local (IndexedDB) un estado recibido en tiempo real desde Firebase o BroadcastChannel
 * sin sobrescribir ni perder datos locales.
 */
export function applyIncomingRoomStateToLocal(
  incomingState: CloudRoomState,
  sourceTransport: 'remote' | 'local',
): Promise<boolean> {
  return withSyncMutex(() => _applyIncomingRoomStateToLocalUnlocked(incomingState, sourceTransport));
}

async function _doSyncNowUnlocked(opts?: {
  sessionId?: string;
  roomCode?: string;
  endpointUrl?: string;
}): Promise<SyncResult> {
  const s = await loadSettings();
  const roomCode = normalizeRoomCode(opts?.roomCode ?? s.syncRoomCode);
  if (!roomCode) {
    throw new Error('Ingresa o genera primero un Código de Sala para sincronizar.');
  }
  const rawEndpoint = (opts?.endpointUrl ?? s.syncEndpointUrl ?? '').trim();
  const endpointUrl = normalizeEndpointBaseUrl(rawEndpoint);

  await getDeviceId();
  let session: Session | undefined;
  if (opts?.sessionId) {
    session = await getSession(opts.sessionId);
  }
  if (!session) {
    session = await getActiveSession();
  }

  const syncStartedAt = Date.now();
  let remoteState: CloudRoomState | null = null;
  let transport: 'remote' | 'local' = 'local';
  let remoteError: string | null = null;

  if (endpointUrl) {
    emitStatus({ state: 'connecting', roomCode, endpointUrl });
    try {
      remoteState = await fetchRemoteRoom(endpointUrl, roomCode);
      transport = 'remote';
    } catch (err) {
      remoteError = (err as Error).message || 'Error al consultar Firebase';
      remoteState = getLocalRoomMirror(roomCode);
    }
  } else {
    remoteState = getLocalRoomMirror(roomCode);
  }

  const localCounts = session ? await countsForSession(session.id) : [];
  const [localProducts, localMovements, localIdealLevels, localTombstones] = await Promise.all([
    allProducts(),
    listMovements(),
    getIdealLevels(),
    getLocalTombstones(),
  ]);

  const mobileReadOnly = isMobileCatalogReadOnly();
  const remoteBarcodeSet = new Set((remoteState?.products || []).map((p) => p.barcode));
  const touchedBarcodes = new Set(localCounts.map((c) => c.barcode));
  const touchedSkus = new Set(localMovements.map((m) => m.sku.toUpperCase()));
  const includeFullCatalog =
    localProducts.length <= 5000 || !remoteState || (remoteState.products?.length ?? 0) === 0;

  let changedProducts: Product[];
  if (mobileReadOnly) {
    changedProducts = localProducts.filter((p) => p.uncataloged && !remoteBarcodeSet.has(p.barcode));
  } else if (includeFullCatalog) {
    changedProducts = localProducts;
  } else {
    changedProducts = localProducts.filter(
      (p) =>
        touchedBarcodes.has(p.barcode) ||
        touchedSkus.has(p.sku.toUpperCase()) ||
        p.uncataloged ||
        p.source !== 'catalogo',
    );
  }

  const outgoingTombstones: TombstoneState = mobileReadOnly
    ? {
        counts: localTombstones.counts,
        movements: localTombstones.movements,
      }
    : localTombstones;

  const localMirrorScanners = getLocalRoomMirror(roomCode)?.liveScanners;
  const mergedRoom = mergeRoomStates(remoteState, {
    roomCode,
    sessionName: session?.name || remoteState?.sessionName || `Sala ${roomCode}`,
    counts: localCounts,
    products: changedProducts,
    liveScanners: localMirrorScanners,
    movements: localMovements,
    idealLevels: localIdealLevels,
    tombstones: outgoingTombstones,
  });

  if (mergedRoom.tombstones) {
    await saveLocalTombstones(mergedRoom.tombstones);
  }

  let addedCounts = 0;
  let duplicateCounts = 0;
  let productsAdded = 0;

  if (mergedRoom.products && mergedRoom.products.length > 0) {
    const recRes = await reconcileCatalogProducts(mergedRoom.products);
    productsAdded += recRes.added;
  }

  if (session && mergedRoom.counts.length > 0) {
    const remoteFile: CountFile = {
      app: APP_ID,
      version: 1,
      kind: 'conteo',
      exportedAt: new Date().toISOString(),
      deviceId: 'cloud-room',
      session: {
        id: session.id,
        name: mergedRoom.sessionName,
        counter: 'Sala ' + roomCode,
        createdAt: session.createdAt,
        closed: false,
      },
      counts: mergedRoom.counts,
      products: [],
    };
    const mergeRes = await mergeCountFiles(session.id, [remoteFile]);
    addedCounts = mergeRes.added;
    duplicateCounts = mergeRes.duplicates;
    if (mergeRes.productsAdded > productsAdded) {
      productsAdded = mergeRes.productsAdded;
    }
  }

  if (mergedRoom.tombstones) {
    await pruneLocalByTombstones(mergedRoom.tombstones, session?.id, true);
  }

  // Una sola actualización atómica para movimientos (tombstones + movimientos fusionados + cualquier alta durante fetch)
  await updateMovements((latestLocal) => {
    const movMap = new Map<string, Movement>();
    const movTombs = mergedRoom.tombstones?.movements;
    for (const m of mergedRoom.movements || []) {
      if (!m || !m.id) continue;
      const t = movTombs?.[m.id];
      if (t !== undefined && t >= m.timestamp) continue;
      movMap.set(m.id, m);
    }
    for (const m of latestLocal) {
      if (!m || !m.id) continue;
      const t = movTombs?.[m.id];
      if (t !== undefined && t >= m.timestamp) continue;
      const prev = movMap.get(m.id);
      if (!prev || m.timestamp > (prev.timestamp || 0)) {
        movMap.set(m.id, m);
      }
    }
    return [...movMap.values()].sort((a, b) => a.timestamp - b.timestamp);
  });

  if (mergedRoom.idealLevels) {
    await setIdealLevels(mergedRoom.idealLevels);
  }

  saveLocalRoomMirror(roomCode, mergedRoom);
  postBroadcastMessage(mergedRoom);

  if (endpointUrl) {
    try {
      const ok = await putRemoteRoom(endpointUrl, roomCode, mergedRoom);
      if (ok) {
        transport = 'remote';
        remoteError = null;
      }
    } catch (err) {
      remoteError = (err as Error).message || 'Error al guardar en Firebase';
      await setMeta('pendingCloudSyncRoom', roomCode);
    }
  }

  const syncedAt = Date.now();
  const latencyMs = Math.max(1, syncedAt - syncStartedAt);
  if (endpointUrl && !remoteError) {
    await setMeta(`lastSync_${roomCode}`, syncStartedAt);
    await setMeta(`lastSeenRemoteUpdatedAt_${roomCode}`, mergedRoom.updatedAt);
  } else if (!endpointUrl) {
    await setMeta(`lastSync_${roomCode}`, syncStartedAt);
  }

  emitStatus({
    state: remoteError ? 'error' : endpointUrl ? 'connected' : 'local_only',
    roomCode,
    endpointUrl,
    transport,
    lastSyncedAt: remoteError ? getCloudConnectionStatus().lastSyncedAt : syncedAt,
    lastLatencyMs: latencyMs,
    lastError: remoteError,
    participantCount: Object.keys(mergedRoom.participants).length,
    totalCounts: mergedRoom.counts.length,
    totalMovements: mergedRoom.movements?.length ?? 0,
  });

  notifyRoomListeners(mergedRoom);

  return {
    roomCode,
    sessionId: session?.id || '',
    addedCounts,
    duplicateCounts,
    productsAdded,
    totalRoomCounts: mergedRoom.counts.length,
    totalRoomMovements: mergedRoom.movements?.length ?? 0,
    participants: Object.values(mergedRoom.participants),
    syncedAt,
    transport,
    latencyMs,
  };
}

/**
 * Sincroniza bidireccionalmente (Push + Pull) la sesión local con la Sala en Línea.
 * Protegido contra reentrancia mediante un mutex en memoria para evitar colisiones concurrentes.
 */
export function syncNow(opts?: {
  sessionId?: string;
  roomCode?: string;
  endpointUrl?: string;
}): Promise<SyncResult> {
  return withSyncMutex(() => _doSyncNowUnlocked(opts));
}

async function _syncDeltaToRemoteUnlocked(opts: {
  sessionId?: string;
  roomCode?: string;
  endpointUrl?: string;
  sinceTimestamp?: number;
}): Promise<boolean> {
  const s = await loadSettings();
  const roomCode = normalizeRoomCode(opts.roomCode || s.syncRoomCode);
  const endpointUrl = normalizeEndpointBaseUrl(opts.endpointUrl || s.syncEndpointUrl);
  if (!roomCode || !endpointUrl || !isFirebaseEndpoint(endpointUrl)) return false;

  const syncStartedAt = Date.now();
  const since = opts.sinceTimestamp || 0;
  const session = opts.sessionId ? await getSession(opts.sessionId) : await getActiveSession();
  const mobileReadOnly = isMobileCatalogReadOnly();

  const [allCounts, allMovements, allProds, localIdealLevels, localTombstones] = await Promise.all([
    session ? countsForSession(session.id) : Promise.resolve<CountEntry[]>([]),
    listMovements(),
    allProducts(),
    getIdealLevels(),
    getLocalTombstones(),
  ]);

  const deltaCounts = allCounts.filter((c) => c.timestamp >= since);
  const deltaMovements = allMovements.filter((m) => m.timestamp >= since);
  const deltaProducts = mobileReadOnly
    ? allProds.filter((p) => Boolean(p.uncataloged) && (p.updatedAt || 0) >= since)
    : allProds.filter((p) => (p.updatedAt || 0) >= since);

  const deltaTombCounts: Record<string, number> = {};
  if (localTombstones.counts) {
    for (const [id, ts] of Object.entries(localTombstones.counts)) {
      if (ts >= since) deltaTombCounts[canonicalCountId(id)] = ts;
    }
  }
  const deltaTombMovements: Record<string, number> = {};
  if (localTombstones.movements) {
    for (const [id, ts] of Object.entries(localTombstones.movements)) {
      if (ts >= since) deltaTombMovements[id] = ts;
    }
  }
  const deltaTombProducts: Record<string, number> = {};
  if (!mobileReadOnly && localTombstones.products) {
    for (const [bc, ts] of Object.entries(localTombstones.products)) {
      if (ts >= since) deltaTombProducts[bc] = ts;
    }
  }

  const mirror = getLocalRoomMirror(roomCode);
  const deltaIdealLevels: Record<string, number> = {};
  if (mirror?.idealLevels) {
    const prevIdeals = sanitizeIdealMap(mirror.idealLevels);
    const curIdeals = sanitizeIdealMap(localIdealLevels);
    // Si se eliminó un nivel ideal localmente, usar sync completo para reemplazar el mapa
    for (const prevSku of Object.keys(prevIdeals)) {
      if (!(prevSku in curIdeals)) {
        return false;
      }
    }
    for (const [sku, qty] of Object.entries(curIdeals)) {
      if (prevIdeals[sku] !== qty) {
        deltaIdealLevels[sku] = qty;
      }
    }
  }

  const hasDeltas =
    deltaCounts.length > 0 ||
    deltaMovements.length > 0 ||
    deltaProducts.length > 0 ||
    Object.keys(deltaIdealLevels).length > 0 ||
    Object.keys(deltaTombCounts).length > 0 ||
    Object.keys(deltaTombMovements).length > 0 ||
    Object.keys(deltaTombProducts).length > 0;

  if (!hasDeltas) {
    return true;
  }

  const countsMap: Record<string, CountEntry> = {};
  for (const c of deltaCounts) {
    const cid = canonicalCountId(c.id);
    countsMap[cid] = { ...c, id: cid };
  }

  const movementsMap: Record<string, Movement> = {};
  for (const m of deltaMovements) {
    movementsMap[m.id] = m;
  }

  const productsMap: Record<string, Product> = {};
  for (const p of deltaProducts) {
    productsMap[p.barcode] = p;
  }

  const deviceId = await getDeviceId();
  const counterName = (session?.counter || s.counterName || 'Técnico').trim() || 'Técnico';
  const partKey = sanitizeParticipantKey(counterName, deviceId);
  const myCounts = allCounts.filter((c) => !c.deviceId || c.deviceId === deviceId);
  let newestMyCount: CountEntry | undefined;
  for (const c of deltaCounts) {
    if (!c.deviceId || c.deviceId === deviceId) {
      if (!newestMyCount || c.timestamp >= newestMyCount.timestamp) newestMyCount = c;
    }
  }
  if (!newestMyCount && myCounts.length > 0) {
    for (const c of myCounts) {
      if (!newestMyCount || c.timestamp >= newestMyCount.timestamp) newestMyCount = c;
    }
  }
  const prodByBarcode = new Map(allProds.map((p) => [p.barcode, p]));
  const newestProd = newestMyCount ? prodByBarcode.get(newestMyCount.barcode) : undefined;

  const participantsMap: Record<string, CloudParticipant> | undefined =
    deltaCounts.length > 0 || Object.keys(deltaTombCounts).length > 0
      ? {
          [partKey]: {
            counter: counterName,
            deviceId: deviceId.slice(0, 8),
            lastSeen: Date.now(),
            scans: myCounts.length,
            units: myCounts.reduce((sum, c) => sum + (c.qty || 0), 0),
            lastSku: newestProd?.sku || newestMyCount?.barcode,
            lastDescription: newestProd?.description || newestMyCount?.barcode,
            lastQty: newestMyCount?.qty,
          },
        }
      : undefined;

  const updateTs = Date.now();
  const payload: RoomDeltaPayload = {
    counts: Object.keys(countsMap).length > 0 ? countsMap : undefined,
    movements: Object.keys(movementsMap).length > 0 ? movementsMap : undefined,
    products: Object.keys(productsMap).length > 0 ? productsMap : undefined,
    idealLevels: Object.keys(deltaIdealLevels).length > 0 ? deltaIdealLevels : undefined,
    participants: participantsMap,
    tombstones: {
      counts: Object.keys(deltaTombCounts).length > 0 ? deltaTombCounts : undefined,
      movements: Object.keys(deltaTombMovements).length > 0 ? deltaTombMovements : undefined,
      products: Object.keys(deltaTombProducts).length > 0 ? deltaTombProducts : undefined,
    },
    updatedAt: updateTs,
  };

  const ok = await patchRemoteRoomDelta(endpointUrl, roomCode, payload);

  if (ok) {
    const now = Date.now();
    await setMeta(`lastSync_${roomCode}`, syncStartedAt);
    await setMeta(`lastSeenRemoteUpdatedAt_${roomCode}`, updateTs);

    if (mirror) {
      const tombCountsSet = new Set(Object.keys(deltaTombCounts));
      const tombMovsSet = new Set(Object.keys(deltaTombMovements));
      const tombProdsSet = new Set(Object.keys(deltaTombProducts));

      const cMap = new Map(mirror.counts.map((c) => [canonicalCountId(c.id), c]));
      for (const id of tombCountsSet) cMap.delete(id);
      for (const c of deltaCounts) cMap.set(canonicalCountId(c.id), { ...c, id: canonicalCountId(c.id) });

      const mMap = new Map((mirror.movements || []).map((m) => [m.id, m]));
      for (const id of tombMovsSet) mMap.delete(id);
      for (const m of deltaMovements) mMap.set(m.id, m);

      const pMap = new Map(mirror.products.map((p) => [p.barcode, p]));
      for (const bc of tombProdsSet) pMap.delete(bc);
      for (const p of deltaProducts) pMap.set(p.barcode, p);

      const nextMirror: CloudRoomState = {
        ...mirror,
        updatedAt: updateTs,
        counts: [...cMap.values()].sort((a, b) => a.timestamp - b.timestamp),
        movements: [...mMap.values()].sort((a, b) => a.timestamp - b.timestamp),
        products: [...pMap.values()],
        participants: { ...mirror.participants, ...(participantsMap || {}) },
        idealLevels: { ...(mirror.idealLevels || {}), ...deltaIdealLevels },
        tombstones: {
          counts: { ...(mirror.tombstones?.counts || {}), ...deltaTombCounts },
          movements: { ...(mirror.tombstones?.movements || {}), ...deltaTombMovements },
          products: { ...(mirror.tombstones?.products || {}), ...deltaTombProducts },
        },
      };
      saveLocalRoomMirror(roomCode, nextMirror);
      notifyRoomListeners(nextMirror);
    }

    emitStatus({
      state: 'connected',
      roomCode,
      endpointUrl,
      transport: 'remote',
      lastSyncedAt: now,
      lastError: null,
    });
  }

  return ok;
}

/**
 * Sincroniza deltas recientes hacia Firebase de forma ultra-ligera (~200 bytes)
 * enviando únicamente conteos, movimientos, productos y lápidas posteriores a `sinceTimestamp`.
 */
export function syncDeltaToRemote(opts: {
  sessionId?: string;
  roomCode?: string;
  endpointUrl?: string;
  sinceTimestamp?: number;
}): Promise<boolean> {
  return withSyncMutex(() => _syncDeltaToRemoteUnlocked(opts));
}

// ============================================================================
// MOTOR DE ESCUCHA EN TIEMPO REAL (FIREBASE SSE + SMART POLLING)
// ============================================================================

let livePollTimer: ReturnType<typeof setInterval> | null = null;
let liveEventSource: EventSource | null = null;
let liveSseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let liveSseRetries = 0;
let liveSubscribedKey = '';
let isPollingNow = false;
let currentPollMs = 3000;
let isSseConnected = false;

function stopPollingTimer(): void {
  if (livePollTimer !== null) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
}

function resumeLivePolling(endpointUrl: string, roomCode: string): void {
  if (livePollTimer !== null || !endpointUrl || !roomCode) return;
  void pullRemoteRoomQuietly(endpointUrl, roomCode);
  if (typeof setInterval !== 'undefined') {
    livePollTimer = setInterval(() => {
      void pullRemoteRoomQuietly(endpointUrl, roomCode);
    }, currentPollMs);
  }
}

function applyIncrementalRemoteCounts(counts: CountEntry[], roomCode: string): Promise<void> {
  if (!counts || counts.length === 0) return Promise.resolve();
  return withSyncMutex(async () => {
    const tombstones = await getLocalTombstones();
    const valid = counts.filter((c) => {
      if (!c || !c.id) return false;
      const cid = canonicalCountId(c.id);
      const t = tombstones.counts?.[cid];
      return !(t !== undefined && t >= c.timestamp);
    });
    if (valid.length === 0) return;

    const session = await getActiveSession();
    if (session) {
      const remoteFile: CountFile = {
        app: APP_ID,
        version: 1,
        kind: 'conteo',
        exportedAt: new Date().toISOString(),
        deviceId: 'cloud-room',
        session: {
          id: session.id,
          name: session.name,
          counter: 'Sala ' + roomCode,
          createdAt: session.createdAt,
          closed: false,
        },
        counts: valid,
        products: [],
      };
      await mergeCountFiles(session.id, [remoteFile]);
    }
    updateLocalMirrorQuickly(roomCode, { counts: valid });
  });
}

function applyRemoteCountDeletion(countId: string, roomCode: string, timestamp = Date.now()): Promise<void> {
  return withSyncMutex(async () => {
    const normId = canonicalCountId(countId);
    await recordTombstone('counts', normId, timestamp);
    const session = await getActiveSession();
    if (session) {
      const curCounts = await countsForSession(session.id);
      const toDelete = curCounts.filter((c) => canonicalCountId(c.id) === normId).map((c) => c.id);
      if (toDelete.length > 0) {
        const db = await getDB();
        const tx = db.transaction('counts', 'readwrite');
        for (const id of toDelete) await tx.store.delete(id);
        await tx.done;
      }
    }
    updateLocalMirrorQuickly(roomCode, { deletedCountId: normId });
  });
}

function applyIncrementalRemoteMovements(movements: Movement[], roomCode: string): Promise<void> {
  if (!movements || movements.length === 0) return Promise.resolve();
  return withSyncMutex(async () => {
    const tombstones = await getLocalTombstones();
    const valid = movements.filter((m) => {
      if (!m || !m.id) return false;
      const t = tombstones.movements?.[m.id];
      return !(t !== undefined && t >= m.timestamp);
    });
    if (valid.length === 0) return;

    await updateMovements((localMovs) => {
      const movMap = new Map<string, Movement>();
      for (const m of localMovs) movMap.set(m.id, m);
      let changed = false;
      for (const m of valid) {
        const prev = movMap.get(m.id);
        if (!prev || m.timestamp >= (prev.timestamp || 0)) {
          movMap.set(m.id, m);
          changed = true;
        }
      }
      return changed ? [...movMap.values()].sort((a, b) => a.timestamp - b.timestamp) : localMovs;
    });
    updateLocalMirrorQuickly(roomCode, { movements: valid });
  });
}

function applyRemoteMovementDeletion(movId: string, roomCode: string, timestamp = Date.now()): Promise<void> {
  return withSyncMutex(async () => {
    await recordTombstone('movements', movId, timestamp);
    await updateMovements((localMovs) => {
      const filtered = localMovs.filter((m) => m.id !== movId);
      return filtered.length !== localMovs.length ? filtered : localMovs;
    });
    updateLocalMirrorQuickly(roomCode, { deletedMovId: movId });
  });
}

function connectLiveSse(endpointUrl: string, roomCode: string, subKey: string): void {
  if (typeof EventSource === 'undefined' || liveSubscribedKey !== subKey) return;
  const roomUrl = buildRoomEndpointUrl(endpointUrl, roomCode);
  if (!roomUrl) return;

  try {
    const es = new EventSource(roomUrl);
    liveEventSource = es;

    const onConnected = () => {
      isSseConnected = true;
      liveSseRetries = 0;
      stopPollingTimer();
      emitStatus({ liveStream: 'sse', state: 'connected', lastError: null });
    };

    es.addEventListener('open', onConnected);

    es.addEventListener('cancel', () => {
      isSseConnected = false;
      emitStatus({
        state: 'error',
        liveStream: 'polling',
        lastError: 'Firebase cerró la conexión en tiempo real (permisos o cuota).',
      });
      resumeLivePolling(endpointUrl, roomCode);
    });

    es.addEventListener('auth_revoked', () => {
      isSseConnected = false;
      emitStatus({
        state: 'error',
        liveStream: 'polling',
        lastError: 'Credenciales o reglas de Firebase revocadas.',
      });
      resumeLivePolling(endpointUrl, roomCode);
    });

    const handleSsePayload = (ev: MessageEvent) => {
      onConnected();
      try {
        const parsed = JSON.parse(ev.data);
        if (parsed && typeof parsed === 'object' && 'path' in parsed && parsed.path && parsed.path !== '/') {
          const pathStr = String(parsed.path);
          if (pathStr.startsWith('/counts/')) {
            const rawKey = pathStr.slice('/counts/'.length).split('/')[0];
            const countId = decodeFirebaseKey(rawKey);
            if (parsed.data === null) {
              void applyRemoteCountDeletion(countId, roomCode);
            } else if (parsed.data && typeof parsed.data === 'object') {
              void applyIncrementalRemoteCounts([parsed.data as CountEntry], roomCode);
            }
            return;
          }
          if (pathStr.startsWith('/movements/')) {
            const rawKey = pathStr.slice('/movements/'.length).split('/')[0];
            const movId = decodeFirebaseKey(rawKey);
            if (parsed.data === null) {
              void applyRemoteMovementDeletion(movId, roomCode);
            } else if (parsed.data && typeof parsed.data === 'object') {
              void applyIncrementalRemoteMovements([parsed.data as Movement], roomCode);
            }
            return;
          }
          void pullRemoteRoomQuietly(endpointUrl, roomCode);
          return;
        }
        const payload = parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
        const coerced = coerceRemoteRoomState(payload, roomCode);
        if (coerced) {
          void applyIncomingRoomStateToLocal(coerced, 'remote');
        }
      } catch {}
    };

    es.addEventListener('put', handleSsePayload as EventListener);
    es.addEventListener('patch', (ev: Event) => {
      onConnected();
      try {
        const msg = ev as MessageEvent;
        const parsed = msg?.data ? JSON.parse(msg.data) : null;
        if (parsed && typeof parsed === 'object' && typeof parsed.path === 'string') {
          const pathStr = parsed.path;

          if (pathStr === '/') {
            void pullRemoteRoomQuietly(endpointUrl, roomCode);
            return;
          }

          if (pathStr.startsWith('/liveScanners')) {
            const mirror = getLocalRoomMirror(roomCode);
            if (mirror && parsed.data && typeof parsed.data === 'object') {
              const patchMap: Record<string, LiveScannerState> = {};
              if (pathStr === '/liveScanners') {
                for (const [k, v] of Object.entries(parsed.data as Record<string, LiveScannerState>)) {
                  if (v && typeof v === 'object') patchMap[decodeFirebaseKey(k)] = v;
                }
              } else {
                const rawKey = pathStr.slice('/liveScanners/'.length).split('/')[0];
                const key = decodeFirebaseKey(rawKey);
                if (key) patchMap[key] = parsed.data as LiveScannerState;
              }
              const nextMirror: CloudRoomState = {
                ...mirror,
                liveScanners: mergeLiveScannersMap(mirror.liveScanners, patchMap),
              };
              saveLocalRoomMirror(roomCode, nextMirror);
              notifyRoomListeners(nextMirror);
              return;
            }
          }

          if (pathStr === '/counts' || pathStr.startsWith('/counts/')) {
            const incoming: CountEntry[] = [];
            if (pathStr === '/counts' && parsed.data && typeof parsed.data === 'object') {
              for (const [rawKey, val] of Object.entries(parsed.data as Record<string, unknown>)) {
                if (val === null) {
                  void applyRemoteCountDeletion(decodeFirebaseKey(rawKey), roomCode);
                } else if (val && typeof val === 'object') {
                  incoming.push(val as CountEntry);
                }
              }
            } else if (parsed.data && typeof parsed.data === 'object') {
              incoming.push(parsed.data as CountEntry);
            } else if (parsed.data === null && pathStr.startsWith('/counts/')) {
              const cid = decodeFirebaseKey(pathStr.slice('/counts/'.length).split('/')[0]);
              void applyRemoteCountDeletion(cid, roomCode);
              return;
            }
            if (incoming.length > 0) {
              void applyIncrementalRemoteCounts(incoming, roomCode);
              return;
            }
            return;
          }

          if (pathStr === '/movements' || pathStr.startsWith('/movements/')) {
            const incoming: Movement[] = [];
            if (pathStr === '/movements' && parsed.data && typeof parsed.data === 'object') {
              for (const [rawKey, val] of Object.entries(parsed.data as Record<string, unknown>)) {
                if (val === null) {
                  void applyRemoteMovementDeletion(decodeFirebaseKey(rawKey), roomCode);
                } else if (val && typeof val === 'object') {
                  incoming.push(val as Movement);
                }
              }
            } else if (parsed.data && typeof parsed.data === 'object') {
              incoming.push(parsed.data as Movement);
            } else if (parsed.data === null && pathStr.startsWith('/movements/')) {
              const mid = decodeFirebaseKey(pathStr.slice('/movements/'.length).split('/')[0]);
              void applyRemoteMovementDeletion(mid, roomCode);
              return;
            }
            if (incoming.length > 0) {
              void applyIncrementalRemoteMovements(incoming, roomCode);
              return;
            }
            return;
          }

          if (pathStr === '/updatedAt') {
            const mirror = getLocalRoomMirror(roomCode);
            if (mirror && typeof parsed.data === 'number') {
              saveLocalRoomMirror(roomCode, { ...mirror, updatedAt: parsed.data });
            }
            return;
          }
        }
      } catch {}
      void pullRemoteRoomQuietly(endpointUrl, roomCode);
    });
    es.onmessage = handleSsePayload;
    es.onerror = () => {
      isSseConnected = false;
      try {
        es.close();
      } catch {}
      if (liveEventSource === es) {
        liveEventSource = null;
        emitStatus({ liveStream: 'polling' });
        resumeLivePolling(endpointUrl, roomCode);
        if (liveSubscribedKey === subKey && typeof setTimeout !== 'undefined') {
          const delayMs = Math.min(30000, 1500 * Math.pow(2, liveSseRetries));
          liveSseRetries = Math.min(liveSseRetries + 1, 6);
          if (liveSseReconnectTimer) clearTimeout(liveSseReconnectTimer);
          liveSseReconnectTimer = setTimeout(() => {
            liveSseReconnectTimer = null;
            connectLiveSse(endpointUrl, roomCode, subKey);
          }, delayMs);
        }
      }
    };
  } catch {
    liveEventSource = null;
    resumeLivePolling(endpointUrl, roomCode);
  }
}

/**
 * Inicia la suscripción en tiempo real a la sala configurada (vía Firebase Server-Sent Events
 * con fallback inteligente a Polling solo cuando SSE no está conectado).
 */
export function startLiveCloudSync(opts?: {
  roomCode?: string;
  endpointUrl?: string;
  pollIntervalMs?: number;
}): void {
  const s = settingsSync();
  const roomCode = normalizeRoomCode(opts?.roomCode ?? s.syncRoomCode);
  const endpointUrl = normalizeEndpointBaseUrl(opts?.endpointUrl ?? s.syncEndpointUrl ?? '');
  const pollMs = opts?.pollIntervalMs ?? 3000;

  if (!roomCode) {
    stopLiveCloudSync();
    return;
  }

  const subKey = `${roomCode}@@${endpointUrl}`;
  if (liveSubscribedKey === subKey && (livePollTimer !== null || liveEventSource !== null)) {
    return;
  }

  stopLiveCloudSync();
  liveSubscribedKey = subKey;
  liveSseRetries = 0;
  currentPollMs = pollMs;

  if (!endpointUrl) {
    const cached = getLocalRoomMirror(roomCode);
    emitStatus({
      state: 'local_only',
      roomCode,
      endpointUrl: '',
      transport: 'local',
      liveStream: hasBroadcastChannel() ? 'broadcast' : 'off',
      participantCount: cached ? Object.keys(cached.participants || {}).length : 0,
      totalCounts: cached?.counts.length ?? 0,
      totalMovements: cached?.movements?.length ?? 0,
    });
    return;
  }

  emitStatus({
    state: 'connecting',
    roomCode,
    endpointUrl,
    transport: 'remote',
    liveStream: 'polling',
  });

  connectLiveSse(endpointUrl, roomCode, subKey);
  resumeLivePolling(endpointUrl, roomCode);
}

let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
let pendingBgSessionId: string | undefined = undefined;

export function stopLiveCloudSync(): void {
  isSseConnected = false;
  liveSubscribedKey = '';
  liveSseRetries = 0;
  if (autoSyncTimer) {
    clearTimeout(autoSyncTimer);
    autoSyncTimer = null;
  }
  pendingBgSessionId = undefined;
  if (liveSseReconnectTimer) {
    clearTimeout(liveSseReconnectTimer);
    liveSseReconnectTimer = null;
  }
  stopPollingTimer();
  if (liveEventSource) {
    try {
      liveEventSource.close();
    } catch {}
    liveEventSource = null;
  }
}

async function pullRemoteRoomQuietly(endpointUrl: string, roomCode: string): Promise<void> {
  if (isPollingNow || !endpointUrl || !roomCode) return;
  isPollingNow = true;
  const t0 = Date.now();
  try {
    const lastSeenRemote = await getMeta<number>(`lastSeenRemoteUpdatedAt_${roomCode}`);
    if (typeof lastSeenRemote === 'number') {
      const remoteUpdatedAt = await fetchRemoteUpdatedAt(endpointUrl, roomCode);
      if (remoteUpdatedAt !== null && remoteUpdatedAt === lastSeenRemote) {
        return;
      }
    }

    const remote = await fetchRemoteRoom(endpointUrl, roomCode);
    const latencyMs = Math.max(1, Date.now() - t0);
    if (remote) {
      await applyIncomingRoomStateToLocal(remote, 'remote');
      emitStatus({
        state: 'connected',
        roomCode,
        endpointUrl,
        transport: 'remote',
        liveStream: isSseConnected ? 'sse' : 'polling',
        lastLatencyMs: latencyMs,
        lastError: null,
      });
    } else {
      await syncNow({ roomCode, endpointUrl });
    }
  } catch (err) {
    emitStatus({
      state: 'error',
      roomCode,
      endpointUrl,
      lastError: (err as Error).message || 'Error de conexión con Firebase',
    });
  } finally {
    isPollingNow = false;
  }
}

/**
 * Dispara una sincronización automática en segundo plano (con debounce de 350ms)
 * cuando el técnico registra, modifica o elimina un escaneo o movimiento de Kardex.
 */
export function triggerBackgroundSync(sessionId?: string): void {
  const sNow = settingsSync();
  if (!sNow.syncEnabled || !sNow.syncAuto || !sNow.syncRoomCode.trim()) return;
  if (sessionId) pendingBgSessionId = sessionId;

  if (autoSyncTimer) clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(async () => {
    autoSyncTimer = null;
    const targetSessionId = pendingBgSessionId;
    pendingBgSessionId = undefined;

    const latestSettings = await loadSettings();
    const cleanRoom = normalizeRoomCode(latestSettings.syncRoomCode);
    if (!latestSettings.syncEnabled || !latestSettings.syncAuto || !cleanRoom) return;

    try {
      const endpoint = normalizeEndpointBaseUrl(latestSettings.syncEndpointUrl || '');
      const lastSync = (await getMeta<number>(`lastSync_${cleanRoom}`)) || 0;

      if (isFirebaseEndpoint(endpoint) && lastSync > 0 && Date.now() - lastSync < 600000) {
        const deltaOk = await syncDeltaToRemote({
          sessionId: targetSessionId,
          roomCode: cleanRoom,
          endpointUrl: endpoint,
          sinceTimestamp: Math.max(0, lastSync - 3000),
        });
        if (deltaOk) return;
      }

      await syncNow({ sessionId: targetSessionId, roomCode: cleanRoom, endpointUrl: endpoint });
    } catch {
      void setMeta('pendingCloudSyncRoom', cleanRoom);
    }
  }, 350);
}

/**
 * Publica en tiempo real el estado actual del escáner de este dispositivo
 * hacia la sala compartida para que el supervisor lo vea al instante.
 */
export async function publishLiveScannerState(
  patch: Omit<LiveScannerState, 'counter' | 'deviceId' | 'updatedAt'> & { counter?: string },
): Promise<void> {
  const s = await loadSettings();
  const cleanRoom = normalizeRoomCode(s.syncRoomCode);
  if (!cleanRoom) return;

  const counter = (patch.counter || s.counterName || 'Técnico').trim() || 'Técnico';
  const deviceId = await getDeviceId();
  const deviceKey = sanitizeParticipantKey(counter, deviceId);
  const now = Date.now();

  const entry: LiveScannerState = {
    counter,
    deviceId,
    status: patch.status,
    cameraOn: patch.cameraOn,
    origin: patch.origin,
    barcode: patch.barcode,
    sku: patch.sku,
    description: patch.description,
    qty: patch.qty,
    sessionName: patch.sessionName,
    updatedAt: now,
  };

  const prevMirror = getLocalRoomMirror(cleanRoom);
  const nextMirror: CloudRoomState = prevMirror
    ? {
        ...prevMirror,
        updatedAt: now,
        liveScanners: mergeLiveScannersMap(prevMirror.liveScanners, { [deviceKey]: entry }),
      }
    : {
        app: APP_ID,
        version: 1,
        roomCode: cleanRoom,
        updatedAt: now,
        sessionName: patch.sessionName || `Sala ${cleanRoom}`,
        counts: [],
        products: [],
        participants: {},
        liveScanners: { [deviceKey]: entry },
        movements: [],
        idealLevels: {},
      };

  saveLocalRoomMirror(cleanRoom, nextMirror);

  const bcMsg: BroadcastMessagePayload = {
    kind: 'liveScanner',
    roomCode: cleanRoom,
    deviceKey,
    entry,
  };
  postBroadcastMessage(bcMsg);
  notifyRoomListeners(nextMirror);

  const endpointUrl = normalizeEndpointBaseUrl(s.syncEndpointUrl || '');
  if (!s.syncEnabled || !endpointUrl || typeof fetch === 'undefined') return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const roomUrl = buildRoomEndpointUrl(endpointUrl, cleanRoom);
  if (!roomUrl) return;

  if (isFirebaseEndpoint(roomUrl)) {
    const baseRoomNoJson = roomUrl.replace(/\.json$/i, '');
    const scannerPatchUrl = `${baseRoomNoJson}/liveScanners.json`;
    try {
      await fetch(scannerPatchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ [encodeFirebaseKey(deviceKey)]: entry }),
        signal: getFetchTimeoutSignal(6000),
      });
    } catch {
      // Silencioso para no bloquear la operación local de conteo en móvil
    }
  } else if (s.syncAuto) {
    triggerBackgroundSync();
  }
}

/**
 * Conecta e inicializa la sincronización inmediata a una sala desde una invitación QR o link.
 */
export async function joinRoomFromInvite(
  roomCodeOrUrl: string,
  endpointUrl?: string,
  explicitRole?: 'technician' | 'supervisor',
): Promise<{ success: boolean; roomCode?: string; role?: 'technician' | 'supervisor' }> {
  let targetRoom = roomCodeOrUrl;
  let targetEndpoint = endpointUrl;
  let targetRole = explicitRole;

  if (isRoomInviteUrl(roomCodeOrUrl)) {
    const parsed = parseRoomInviteUrl(roomCodeOrUrl);
    if (parsed) {
      if (parsed.roomCode) targetRoom = parsed.roomCode;
      if (parsed.endpointUrl) targetEndpoint = parsed.endpointUrl;
      if (parsed.role && !targetRole) targetRole = parsed.role;
    }
  }

  if (!targetRole) {
    targetRole = 'technician';
  }

  const code = normalizeRoomCode(targetRoom);
  if (!code) return { success: false };
  const currentSettings = await loadSettings();
  const cleanEndpoint = targetEndpoint ? normalizeEndpointBaseUrl(targetEndpoint) : currentSettings.syncEndpointUrl;

  const isSupervisor = targetRole === 'supervisor';
  await saveSettings({
    syncEnabled: true,
    syncAuto: true,
    syncRoomCode: code,
    syncEndpointUrl: cleanEndpoint,
    userRole: targetRole,
    supervisorMode: isSupervisor,
  });

  dispatchRoleChangeEvent(targetRole);
  startLiveCloudSync({ roomCode: code, endpointUrl: cleanEndpoint });
  void syncNow({ roomCode: code, endpointUrl: cleanEndpoint }).catch(() => {});
  return { success: true, roomCode: code, role: targetRole };
}

/**
 * Revisa si la URL de arranque contiene `?room=...&db=...` para autoconfigurar Firebase y la Sala.
 */
export async function consumeUrlSyncParams(): Promise<{ joinedRoom?: string; endpointUrl?: string } | null> {
  if (typeof window === 'undefined' || !window.location?.search) return null;
  const params = new URLSearchParams(window.location.search);

  let rawRoom: string | null = null;
  let rawDb: string | null = null;
  let rawRole: string | null = null;
  const toDelete: string[] = [];

  for (const [k, v] of params.entries()) {
    const lower = k.toLowerCase();
    if (lower === 'room') {
      rawRoom = v;
      toDelete.push(k);
    } else if (lower === 'db' || lower === 'endpoint') {
      if (!rawDb) rawDb = v;
      toDelete.push(k);
    } else if (lower === 'role') {
      rawRole = v;
      toDelete.push(k);
    }
  }

  const normalizedIncomingRoom = rawRoom ? normalizeRoomCode(rawRoom) : '';
  const normalizedIncomingDb = rawDb ? normalizeEndpointBaseUrl(rawDb) : '';

  if (!normalizedIncomingRoom && !normalizedIncomingDb) {
    return null;
  }

  const s = await loadSettings();
  const roomCode = normalizedIncomingRoom || normalizeRoomCode(s.syncRoomCode);
  if (!roomCode) return null;

  const endpointUrl = normalizedIncomingDb || normalizeEndpointBaseUrl(s.syncEndpointUrl || '');
  const roleLower = (rawRole || '').trim().toLowerCase();
  const parsedRole: 'supervisor' | 'technician' | undefined =
    roleLower === 'supervisor' || roleLower === 'admin'
      ? 'supervisor'
      : roleLower === 'technician' || roleLower === 'tech' || roleLower === 'counter'
        ? 'technician'
        : undefined;

  // Si este dispositivo ya está bloqueado como técnico, no elevar silenciosamente a supervisor por URL sin PIN
  const nextRole: 'supervisor' | 'technician' =
    s.userRole === 'technician'
      ? 'technician'
      : parsedRole ?? (s.userRole === 'supervisor' ? 'supervisor' : 'technician');

  await saveSettings({
    syncEnabled: true,
    syncAuto: true,
    syncRoomCode: roomCode,
    syncEndpointUrl: endpointUrl,
    userRole: nextRole,
    supervisorMode: nextRole === 'supervisor',
  });

  dispatchRoleChangeEvent(nextRole);

  try {
    for (const k of toDelete) params.delete(k);
    const cleanSearch = params.toString();
    const cleanUrl = `${window.location.pathname}${cleanSearch ? `?${cleanSearch}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', cleanUrl);
  } catch {}

  startLiveCloudSync({ roomCode, endpointUrl });
  void syncNow({ roomCode, endpointUrl }).catch(() => {});
  return { joinedRoom: roomCode, endpointUrl };
}

// Registrar receptor de BroadcastChannel una sola vez para sincronización multi-pestaña sin pérdida de datos
setBroadcastIncomingHandler((msg) => {
  if (!msg || typeof msg !== 'object') return;
  const payload = msg as BroadcastMessagePayload & Partial<CloudRoomState>;
  const s = settingsSync();
  const activeRoom = normalizeRoomCode(s.syncRoomCode);

  if (payload.kind === 'liveScanner' && payload.roomCode && payload.deviceKey && payload.entry) {
    const targetRoom = normalizeRoomCode(payload.roomCode);
    if (!targetRoom) return;
    if (s.syncEnabled && activeRoom && targetRoom !== activeRoom) return;

    const prevMirror = getLocalRoomMirror(targetRoom);
    if (prevMirror) {
      const nextMirror: CloudRoomState = {
        ...prevMirror,
        updatedAt: Math.max(prevMirror.updatedAt, payload.entry.updatedAt),
        liveScanners: mergeLiveScannersMap(prevMirror.liveScanners, { [payload.deviceKey]: payload.entry }),
      };
      saveLocalRoomMirror(targetRoom, nextMirror);
      notifyRoomListeners(nextMirror);
    } else {
      notifyRoomListeners({
        app: APP_ID,
        version: 1,
        roomCode: targetRoom,
        updatedAt: payload.entry.updatedAt,
        sessionName: payload.entry.sessionName || `Sala ${targetRoom}`,
        counts: [],
        products: [],
        participants: {},
        liveScanners: { [payload.deviceKey]: payload.entry },
        movements: [],
        idealLevels: {},
      });
    }
    return;
  }

  const data = coerceRemoteRoomState(msg, payload.roomCode || '');
  if (!data || !data.roomCode) return;
  if (s.syncEnabled && activeRoom && data.roomCode !== activeRoom) return;
  void applyIncomingRoomStateToLocal(data, 'local');
});

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', () => {
    void (async () => {
      const pendingRoom = await getMeta<string>('pendingCloudSyncRoom');
      const s = await loadSettings();
      const targetRoom = normalizeRoomCode(pendingRoom || s.syncRoomCode);
      if (targetRoom && (pendingRoom || s.syncEnabled)) {
        try {
          await syncNow({ roomCode: targetRoom });
          if (getCloudConnectionStatus().state !== 'error') {
            await setMeta('pendingCloudSyncRoom', null);
          }
        } catch {}
      }
    })();
  });
}

/**
 * Sincroniza explícitamente el catálogo de productos con la Base de Datos en la nube / sala local,
 * funcionando incluso cuando no hay una sesión de conteo activa.
 */
export async function syncCatalogWithDb(opts?: {
  roomCode?: string;
  endpointUrl?: string;
}): Promise<SyncResult & { totalLocalProducts: number }> {
  const res = await syncNow({
    roomCode: opts?.roomCode,
    endpointUrl: opts?.endpointUrl,
  });
  const totalLocalProducts = (await allProducts()).length;
  return { ...res, totalLocalProducts };
}

/** Solo para pruebas */
export function _clearMemoryRooms(): void {
  stopLiveCloudSync();
  memoryRooms.clear();
  syncMutexTail = Promise.resolve();
}

export { toArray, computeDataFingerprint, computeStateFingerprint };
