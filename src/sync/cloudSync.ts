import {
  allProducts,
  countsForSession,
  createSession,
  getActiveSession,
  getDeviceId,
  getMeta,
  getSession,
  setMeta,
  uid,
  type CountEntry,
  type Product,
  type Session,
} from '../db/db';
import { APP_ID, type CountFile } from '../io/exportResults';
import { mergeCountFiles } from '../io/mergeCounts';
import { normalizeBarcode } from '../io/normalize';
import { loadSettings, saveSettings, settingsSync } from '../settings';

export interface CloudParticipant {
  counter: string;
  deviceId: string;
  lastSeen: number;
  scans: number;
  units: number;
}

export interface CloudRoomState {
  app: typeof APP_ID;
  version: 1;
  roomCode: string;
  updatedAt: number;
  sessionName: string;
  counts: CountEntry[];
  products: Product[];
  participants: Record<string, CloudParticipant>;
}

export interface SyncResult {
  roomCode: string;
  sessionId: string;
  addedCounts: number;
  duplicateCounts: number;
  productsAdded: number;
  totalRoomCounts: number;
  participants: CloudParticipant[];
  syncedAt: number;
  transport: 'remote' | 'local';
}

const ROOM_STORAGE_PREFIX = 'mohawk_cloud_room_v1_';
const QR_PREFIX = 'MHKSYNC1|';
const CHANNEL_NAME = 'inventario_cloud_sync_v1';

// En memoria para entorno de pruebas Node y acceso instantáneo
const memoryRooms = new Map<string, CloudRoomState>();
const syncListeners = new Set<(state: CloudRoomState) => void>();

let broadcastChannel: BroadcastChannel | null = null;
if (typeof BroadcastChannel !== 'undefined') {
  try {
    broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
    broadcastChannel.onmessage = (ev) => {
      const data = ev.data as CloudRoomState | undefined;
      if (data && data.roomCode && Array.isArray(data.counts)) {
        saveLocalRoomMirror(data.roomCode, data);
        for (const fn of syncListeners) {
          try {
            fn(data);
          } catch {}
        }
      }
    };
  } catch {
    broadcastChannel = null;
  }
}

export function normalizeRoomCode(code: string): string {
  return (code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function generateRoomCode(prefix = 'MHK'): string {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${num}`;
}

export function onCloudRoomUpdate(listener: (state: CloudRoomState) => void): () => void {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}

function getLocalRoomMirror(roomCode: string): CloudRoomState | null {
  const norm = normalizeRoomCode(roomCode);
  if (!norm) return null;
  if (memoryRooms.has(norm)) {
    return structuredCloneState(memoryRooms.get(norm)!);
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(ROOM_STORAGE_PREFIX + norm);
      if (raw) {
        const parsed = JSON.parse(raw) as CloudRoomState;
        memoryRooms.set(norm, parsed);
        return structuredCloneState(parsed);
      }
    } catch {}
  }
  return null;
}

function saveLocalRoomMirror(roomCode: string, state: CloudRoomState): void {
  const norm = normalizeRoomCode(roomCode);
  if (!norm) return;
  const copy = structuredCloneState(state);
  memoryRooms.set(norm, copy);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(ROOM_STORAGE_PREFIX + norm, JSON.stringify(copy));
    } catch {}
  }
}

function structuredCloneState(state: CloudRoomState): CloudRoomState {
  return JSON.parse(JSON.stringify(state)) as CloudRoomState;
}

/**
 * Construye la URL final para leer/escribir el estado de la sala en un servidor REST / Firebase / Webhook.
 */
export function buildRoomEndpointUrl(baseUrl: string, roomCode: string): string {
  const cleanRoom = encodeURIComponent(normalizeRoomCode(roomCode));
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.includes('{room}')) {
    return trimmed.replace(/\{room\}/g, cleanRoom);
  }
  if (/firebaseio\.com/i.test(trimmed) || /\.firebasedatabase\.app/i.test(trimmed)) {
    const baseNoJson = trimmed.replace(/\.json$/i, '');
    return `${baseNoJson}/rooms/${cleanRoom}.json`;
  }
  if (trimmed.endsWith('.json')) {
    return trimmed;
  }
  return `${trimmed}/${cleanRoom}`;
}

async function fetchRemoteRoom(endpointUrl: string, roomCode: string): Promise<CloudRoomState | null> {
  const url = buildRoomEndpointUrl(endpointUrl, roomCode);
  if (!url || typeof fetch === 'undefined') return null;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} al consultar sala ${roomCode}`);
  }
  const data = await res.json();
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.counts)) {
    return data as CloudRoomState;
  }
  return null;
}

async function putRemoteRoom(endpointUrl: string, roomCode: string, state: CloudRoomState): Promise<boolean> {
  const url = buildRoomEndpointUrl(endpointUrl, roomCode);
  if (!url || typeof fetch === 'undefined') return false;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(state),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} al guardar sala ${roomCode}`);
  }
  return true;
}

export function canonicalCountId(id: string): string {
  const parts = (id || '').split('__');
  return parts[parts.length - 1] || id;
}

/**
 * Combina dos estados de sala sin perder ni duplicar conteos ni productos.
 */
export function mergeRoomStates(
  base: CloudRoomState | null,
  incoming: {
    roomCode: string;
    sessionName: string;
    counts: CountEntry[];
    products: Product[];
  },
): CloudRoomState {
  const roomCode = normalizeRoomCode(incoming.roomCode);
  const countMap = new Map<string, CountEntry>();
  if (base?.counts) {
    for (const c of base.counts) {
      if (c && c.id) {
        const cid = canonicalCountId(c.id);
        countMap.set(cid, { ...c, id: cid });
      }
    }
  }
  for (const c of incoming.counts) {
    if (c && c.id) {
      const cid = canonicalCountId(c.id);
      const prev = countMap.get(cid);
      if (!prev || c.timestamp >= prev.timestamp) {
        countMap.set(cid, { ...c, id: cid });
      }
    }
  }

  const prodMap = new Map<string, Product>();
  if (base?.products) {
    for (const p of base.products) {
      if (p && p.barcode) prodMap.set(p.barcode, p);
    }
  }
  for (const p of incoming.products) {
    if (p && p.barcode) {
      const prev = prodMap.get(p.barcode);
      prodMap.set(p.barcode, prev ? { ...prev, ...p, description: p.description || prev.description } : p);
    }
  }

  const allCounts = [...countMap.values()].sort((a, b) => a.timestamp - b.timestamp);
  const participants: Record<string, CloudParticipant> = {};
  for (const c of allCounts) {
    const key = `${c.counter || 'Técnico'}__${(c.deviceId || 'local').slice(0, 8)}`;
    const cur = participants[key] ?? {
      counter: c.counter || 'Técnico',
      deviceId: (c.deviceId || 'local').slice(0, 8),
      lastSeen: 0,
      scans: 0,
      units: 0,
    };
    cur.scans += 1;
    cur.units += c.qty;
    if (c.timestamp > cur.lastSeen) cur.lastSeen = c.timestamp;
    participants[key] = cur;
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
  };
}

/**
 * Sincroniza bidireccionalmente (Push + Pull) la sesión local con la Sala en Línea.
 */
export async function syncNow(opts?: {
  sessionId?: string;
  roomCode?: string;
  endpointUrl?: string;
}): Promise<SyncResult> {
  const s = await loadSettings();
  const roomCode = normalizeRoomCode(opts?.roomCode ?? s.syncRoomCode);
  if (!roomCode) {
    throw new Error('Ingresa o genera primero un Código de Sala para sincronizar.');
  }
  const endpointUrl = (opts?.endpointUrl ?? s.syncEndpointUrl ?? '').trim();

  const deviceId = await getDeviceId();
  let session: Session | undefined;
  if (opts?.sessionId) {
    session = await getSession(opts.sessionId);
  }
  if (!session) {
    session = await getActiveSession();
  }

  // 1. Obtener estado previo de la sala (remoto si hay endpoint, o espejo local/BroadcastChannel)
  let remoteState: CloudRoomState | null = null;
  let transport: 'remote' | 'local' = 'local';

  if (endpointUrl) {
    try {
      remoteState = await fetchRemoteRoom(endpointUrl, roomCode);
      transport = 'remote';
    } catch {
      remoteState = getLocalRoomMirror(roomCode);
    }
  } else {
    remoteState = getLocalRoomMirror(roomCode);
  }

  // Si no hay sesión local activa, crear una automáticamente para esta sala
  if (!session) {
    const sessName = remoteState?.sessionName || `Inventario Sala ${roomCode}`;
    const counter = s.counterName || 'Supervisor';
    session = await createSession(sessName, counter);
  }

  const [localCounts, localProducts] = await Promise.all([
    countsForSession(session.id),
    allProducts(),
  ]);

  const touchedBarcodes = new Set(localCounts.map((c) => c.barcode));
  const changedProducts = localProducts.filter(
    (p) => touchedBarcodes.has(p.barcode) || p.uncataloged || p.source !== 'catalogo',
  );

  // 2. Fusionar conteos locales + remotos
  const mergedRoom = mergeRoomStates(remoteState, {
    roomCode,
    sessionName: session.name,
    counts: localCounts,
    products: changedProducts,
  });

  // 3. Importar a la sesión local los conteos que venían de otros dispositivos/técnicos
  let addedCounts = 0;
  let duplicateCounts = 0;
  let productsAdded = 0;

  if (mergedRoom.counts.length > 0 || mergedRoom.products.length > 0) {
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
      products: mergedRoom.products,
    };
    const mergeRes = await mergeCountFiles(session.id, [remoteFile]);
    addedCounts = mergeRes.added;
    duplicateCounts = mergeRes.duplicates;
    productsAdded = mergeRes.productsAdded;
  }

  // 4. Guardar estado consolidado en espejo local, BroadcastChannel y endpoint remoto
  saveLocalRoomMirror(roomCode, mergedRoom);
  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage(mergedRoom);
    } catch {}
  }

  if (endpointUrl) {
    try {
      const ok = await putRemoteRoom(endpointUrl, roomCode, mergedRoom);
      if (ok) transport = 'remote';
    } catch {
      // Queda guardado en local mirror y se reintentará al reconectar
      await setMeta('pendingCloudSyncRoom', roomCode);
    }
  }

  const syncedAt = Date.now();
  await setMeta(`lastSync_${roomCode}`, syncedAt);

  return {
    roomCode,
    sessionId: session.id,
    addedCounts,
    duplicateCounts,
    productsAdded,
    totalRoomCounts: mergedRoom.counts.length,
    participants: Object.values(mergedRoom.participants),
    syncedAt,
    transport,
  };
}

let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Dispara una sincronización automática en segundo plano (con debounce de 600ms)
 * cuando el técnico registra, modifica o elimina un escaneo.
 */
export function triggerBackgroundSync(sessionId?: string): void {
  const s = settingsSync();
  if (!s.syncEnabled || !s.syncAuto || !s.syncRoomCode.trim()) return;
  if (autoSyncTimer) clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => {
    void syncNow({ sessionId }).catch(() => {
      void setMeta('pendingCloudSyncRoom', s.syncRoomCode);
    });
  }, 600);
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', () => {
    void (async () => {
      const pendingRoom = await getMeta<string>('pendingCloudSyncRoom');
      const s = await loadSettings();
      if (pendingRoom || (s.syncEnabled && s.syncRoomCode)) {
        try {
          await syncNow();
          await setMeta('pendingCloudSyncRoom', null);
        } catch {}
      }
    })();
  });
}

// ============================================================================
// CONSOLIDACIÓN RÁPIDA POR CÓDIGO QR (OFFLINE / SIN RED)
// ============================================================================

export function isCompactCountQr(text: string): boolean {
  return (text || '').trim().startsWith(QR_PREFIX);
}

/**
 * Codifica los conteos de una sesión en uno o varios códigos QR compactos (`MHKSYNC1|...`)
 * para que el supervisor pueda escanearlos directamente desde la pantalla del técnico.
 */
export function encodeCompactCountQrChunks(
  session: Session,
  counts: CountEntry[],
  maxEntriesPerQr = 25,
): string[] {
  const safeSession = encodeURIComponent(session.name || 'Sesion');
  const safeCounter = encodeURIComponent(session.counter || 'Tecnico');
  if (counts.length === 0) {
    return [`${QR_PREFIX}${safeSession}|${safeCounter}|1/1|`];
  }

  const chunks: CountEntry[][] = [];
  for (let i = 0; i < counts.length; i += Math.max(1, maxEntriesPerQr)) {
    chunks.push(counts.slice(i, i + Math.max(1, maxEntriesPerQr)));
  }

  return chunks.map((chunk, idx) => {
    const entriesStr = chunk
      .map((c) => {
        const bc = encodeURIComponent(c.barcode);
        const qty = c.qty;
        const idShort = encodeURIComponent(c.id.slice(0, 12));
        const tsSec = Math.floor((c.timestamp || Date.now()) / 1000);
        const who = c.counter && c.counter !== session.counter ? encodeURIComponent(c.counter) : '';
        return `${bc}:${qty}:${idShort}:${tsSec}${who ? `:${who}` : ''}`;
      })
      .join(';');
    return `${QR_PREFIX}${safeSession}|${safeCounter}|${idx + 1}/${chunks.length}|${entriesStr}`;
  });
}

/**
 * Decodifica una cadena `MHKSYNC1|...` escaneada de un QR y devuelve un `CountFile` listo
 * para fusionar mediante `mergeCountFiles`.
 */
export function decodeCompactCountQr(payload: string): CountFile {
  const raw = (payload || '').trim();
  if (!raw.startsWith(QR_PREFIX)) {
    throw new Error('El código QR no corresponde a un reporte de conteo (MHKSYNC1).');
  }
  const body = raw.slice(QR_PREFIX.length);
  const parts = body.split('|');
  if (parts.length < 4) {
    throw new Error('Formato de QR de conteo incompleto.');
  }

  const sessionName = decodeURIComponent(parts[0] || 'Sesión QR');
  const counterName = decodeURIComponent(parts[1] || 'Técnico');
  const entriesRaw = parts.slice(3).join('|');

  const counts: CountEntry[] = [];
  if (entriesRaw.trim()) {
    for (const item of entriesRaw.split(';')) {
      if (!item.trim()) continue;
      const fields = item.split(':');
      if (fields.length < 2) continue;
      const rawBc = decodeURIComponent(fields[0] || '');
      const barcode = rawBc.startsWith('SKU:') ? rawBc : normalizeBarcode(rawBc) || rawBc;
      const qty = Number(fields[1]);
      if (!barcode || !Number.isFinite(qty) || qty === 0) continue;
      const idShort = decodeURIComponent(fields[2] || uid().slice(0, 10));
      const tsSec = Number(fields[3]);
      const timestamp = Number.isFinite(tsSec) && tsSec > 0 ? tsSec * 1000 : Date.now();
      const itemCounter = fields[4] ? decodeURIComponent(fields[4]) : counterName;

      counts.push({
        id: `qr_${counterName}_${barcode}_${idShort}`,
        sessionId: 'qr-import',
        barcode,
        qty,
        counter: itemCounter,
        deviceId: `qr-${counterName}`,
        timestamp,
      });
    }
  }

  return {
    app: APP_ID,
    version: 1,
    kind: 'conteo',
    exportedAt: new Date().toISOString(),
    deviceId: `qr-${counterName}`,
    session: {
      id: `qr_${Date.now()}`,
      name: sessionName,
      counter: counterName,
      createdAt: Date.now(),
      closed: false,
    },
    counts,
    products: [],
  };
}

/** Solo para pruebas */
export function _clearMemoryRooms(): void {
  memoryRooms.clear();
}
