import {
  allProducts,
  bulkPutProducts,
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
import {
  getIdealLevels,
  listMovements,
  saveAllMovements,
  setIdealLevels,
  type Movement,
} from '../db/movements';
import { APP_ID, type CountFile } from '../io/exportResults';
import { mergeCountFiles, reconcileCatalogProducts } from '../io/mergeCounts';
import { normalizeBarcode } from '../io/normalize';
import { loadSettings, saveSettings, settingsSync } from '../settings';

export interface CloudParticipant {
  counter: string;
  deviceId: string;
  lastSeen: number;
  scans: number;
  units: number;
  lastSku?: string;
  lastDescription?: string;
  lastQty?: number;
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
  movements?: Movement[];
  idealLevels?: Record<string, number>;
}

export interface SyncResult {
  roomCode: string;
  sessionId: string;
  addedCounts: number;
  duplicateCounts: number;
  productsAdded: number;
  totalRoomCounts: number;
  totalRoomMovements?: number;
  participants: CloudParticipant[];
  syncedAt: number;
  transport: 'remote' | 'local';
  latencyMs?: number;
}

export interface CloudConnectionStatus {
  state: 'disabled' | 'local_only' | 'connecting' | 'connected' | 'error';
  roomCode: string;
  endpointUrl: string;
  transport: 'remote' | 'local' | 'none';
  liveStream: 'sse' | 'polling' | 'broadcast' | 'off';
  lastSyncedAt: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  participantCount: number;
  totalCounts: number;
  totalMovements: number;
}

const ROOM_STORAGE_PREFIX = 'mohawk_cloud_room_v1_';
const QR_PREFIX = 'MHKSYNC1|';
const CHANNEL_NAME = 'inventario_cloud_sync_v1';

// En memoria para entorno de pruebas Node y acceso instantáneo
const memoryRooms = new Map<string, CloudRoomState>();
const syncListeners = new Set<(state: CloudRoomState) => void>();
const statusListeners = new Set<(status: CloudConnectionStatus) => void>();

let currentStatus: CloudConnectionStatus = {
  state: 'disabled',
  roomCode: '',
  endpointUrl: '',
  transport: 'none',
  liveStream: 'off',
  lastSyncedAt: null,
  lastLatencyMs: null,
  lastError: null,
  participantCount: 0,
  totalCounts: 0,
  totalMovements: 0,
};

function emitStatus(patch: Partial<CloudConnectionStatus>): void {
  currentStatus = { ...currentStatus, ...patch };
  for (const fn of statusListeners) {
    try {
      fn(currentStatus);
    } catch {}
  }
}

export function getCloudConnectionStatus(): CloudConnectionStatus {
  return { ...currentStatus };
}

export function onCloudStatusChange(listener: (status: CloudConnectionStatus) => void): () => void {
  statusListeners.add(listener);
  try {
    listener(currentStatus);
  } catch {}
  return () => statusListeners.delete(listener);
}

let broadcastChannel: BroadcastChannel | null = null;
if (typeof BroadcastChannel !== 'undefined') {
  try {
    broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
    broadcastChannel.onmessage = (ev) => {
      const raw = ev.data as CloudRoomState | undefined;
      const data = coerceRemoteRoomState(raw, raw?.roomCode || '');
      if (data && data.roomCode) {
        void applyIncomingRoomStateToLocal(data, 'local');
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

function notifyRoomListeners(state: CloudRoomState): void {
  for (const fn of syncListeners) {
    try {
      fn(state);
    } catch {}
  }
}

export function getCachedRoomState(roomCode?: string): CloudRoomState | null {
  const code = normalizeRoomCode(roomCode || settingsSync().syncRoomCode);
  if (!code) return null;
  return getLocalRoomMirror(code);
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
        const parsed = coerceRemoteRoomState(JSON.parse(raw), norm);
        if (parsed) {
          memoryRooms.set(norm, parsed);
          return structuredCloneState(parsed);
        }
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
 * Convierte cualquier URL pegada por el usuario (incluso desde la consola web de Firebase
 * o sin https://) en una URL base limpia de Firebase Realtime DB o servidor REST.
 */
export function normalizeEndpointBaseUrl(rawUrl: string): string {
  let trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';

  // Si pegaron un link de la consola de Firebase:
  // https://console.firebase.google.com/u/0/project/mi-proj/database/mi-proj-default-rtdb/data/~2F...
  const consoleMatch = trimmed.match(/\/database\/([a-zA-Z0-9_-]+)\/data/i);
  if (consoleMatch && consoleMatch[1]) {
    return `https://${consoleMatch[1]}.firebaseio.com`;
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }

  // Si pegaron una URL de Firebase que ya incluía /rooms/XYZ.json o similar, limpiar a la raíz
  if (/firebaseio\.com/i.test(trimmed) || /\.firebasedatabase\.app/i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      return `${u.protocol}//${u.host}`;
    } catch {
      return trimmed.replace(/\/rooms\/[^/]+(\.json)?$/i, '').replace(/\.json$/i, '').replace(/\/+$/, '');
    }
  }

  return trimmed.replace(/\/+$/, '');
}

/**
 * Construye la URL final para leer/escribir el estado de la sala en un servidor REST / Firebase / Webhook.
 */
export function buildRoomEndpointUrl(baseUrl: string, roomCode: string): string {
  const cleanRoom = encodeURIComponent(normalizeRoomCode(roomCode));
  const rawTrimmed = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!rawTrimmed || !cleanRoom) return '';

  if (rawTrimmed.includes('{room}')) {
    const withProto = /^https?:\/\//i.test(rawTrimmed) ? rawTrimmed : `https://${rawTrimmed}`;
    return withProto.replace(/\{room\}/g, cleanRoom);
  }

  const normalized = normalizeEndpointBaseUrl(rawTrimmed);
  if (!normalized) return '';

  if (/firebaseio\.com/i.test(normalized) || /\.firebasedatabase\.app/i.test(normalized)) {
    const baseNoJson = normalized.replace(/\.json$/i, '');
    return `${baseNoJson}/rooms/${cleanRoom}.json`;
  }
  if (normalized.endsWith('.json')) {
    return normalized;
  }
  return `${normalized}/${cleanRoom}`;
}

/**
 * Construye un enlace directo para invitar a técnicos o supervisores con 1 clic o código QR.
 */
export function buildRoomInviteUrl(roomCode: string, endpointUrl?: string): string {
  const code = normalizeRoomCode(roomCode);
  const cleanDb = normalizeEndpointBaseUrl(endpointUrl || '');
  const base =
    typeof window !== 'undefined' && window.location
      ? `${window.location.origin}${window.location.pathname}`
      : 'https://emilg17.github.io/mohawk-inventario/';
  const params = new URLSearchParams();
  if (code) params.set('room', code);
  if (cleanDb) params.set('db', cleanDb);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function toArray<T>(val: unknown): T[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter((x) => x != null) as T[];
  if (typeof val === 'object') {
    return Object.values(val as Record<string, T>).filter((x) => x != null);
  }
  return [];
}

/**
 * Normaliza la respuesta de Firebase Realtime Database (que omite arreglos vacíos `[]`
 * o convierte arreglos dispersos en objetos `{0: ..., 1: ...}`).
 */
export function coerceRemoteRoomState(data: unknown, fallbackRoomCode: string): CloudRoomState | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

  // Si Firebase devolvió un wrapper { path: "/", data: { ... } } (en eventos SSE 'put')
  if ('data' in obj && 'path' in obj && obj.data && typeof obj.data === 'object') {
    if (obj.path === '/') {
      return coerceRemoteRoomState(obj.data, fallbackRoomCode);
    }
  }

  const hasSignature =
    typeof obj.roomCode === 'string' ||
    obj.app === APP_ID ||
    'counts' in obj ||
    'movements' in obj ||
    'products' in obj ||
    'sessionName' in obj ||
    'updatedAt' in obj;

  if (!hasSignature) return null;

  const roomCode = normalizeRoomCode((obj.roomCode as string) || fallbackRoomCode);
  if (!roomCode) return null;

  const counts = toArray<CountEntry>(obj.counts);
  const products = toArray<Product>(obj.products);
  const movements = toArray<Movement>(obj.movements);
  const participants =
    obj.participants && typeof obj.participants === 'object' && !Array.isArray(obj.participants)
      ? (obj.participants as Record<string, CloudParticipant>)
      : {};
  const idealLevels =
    obj.idealLevels && typeof obj.idealLevels === 'object' && !Array.isArray(obj.idealLevels)
      ? (obj.idealLevels as Record<string, number>)
      : {};

  return {
    app: APP_ID,
    version: 1,
    roomCode,
    updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now(),
    sessionName: typeof obj.sessionName === 'string' && obj.sessionName ? obj.sessionName : `Sala ${roomCode}`,
    counts,
    products,
    participants,
    movements,
    idealLevels,
  };
}

function formatRemoteHttpError(status: number, roomCode: string): string {
  if (status === 401 || status === 403) {
    return `Permiso denegado en Firebase (HTTP ${status}). En tu consola de Firebase → Realtime Database → Reglas, habilita lectura y escritura: {"rules": {".read": true, ".write": true}}`;
  }
  if (status === 404) {
    return `URL de base de datos no encontrada (HTTP 404) para la sala ${roomCode}. Verifica el enlace de Firebase.`;
  }
  return `Error HTTP ${status} al conectar con la sala ${roomCode}.`;
}

async function fetchRemoteRoom(endpointUrl: string, roomCode: string): Promise<CloudRoomState | null> {
  const url = buildRoomEndpointUrl(endpointUrl, roomCode);
  if (!url || typeof fetch === 'undefined') return null;
  const sep = url.includes('?') ? '&' : '?';
  const cacheBustedUrl = `${url}${sep}_t=${Date.now()}`;
  const res = await fetch(cacheBustedUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(formatRemoteHttpError(res.status, roomCode));
  }
  const data = await res.json();
  if (data === null) return null;
  return coerceRemoteRoomState(data, roomCode);
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
    throw new Error(formatRemoteHttpError(res.status, roomCode));
  }
  return true;
}

/**
 * Prueba activa de lectura y escritura contra el endpoint de Firebase / REST.
 */
export async function testFirebaseConnection(
  endpointUrl: string,
  roomCode: string,
): Promise<{
  ok: boolean;
  latencyMs: number;
  url: string;
  message: string;
  existingCounts: number;
  existingMovements: number;
}> {
  const code = normalizeRoomCode(roomCode || 'MHK-TEST');
  const normBase = normalizeEndpointBaseUrl(endpointUrl);
  const url = buildRoomEndpointUrl(normBase, code);
  if (!url) {
    return {
      ok: false,
      latencyMs: 0,
      url: '',
      message: 'Ingresa primero el enlace de tu Realtime Database de Firebase (ej. https://tu-proyecto-default-rtdb.firebaseio.com).',
      existingCounts: 0,
      existingMovements: 0,
    };
  }

  const t0 = Date.now();
  try {
    const existing = await fetchRemoteRoom(normBase, code);
    const latencyMs = Math.max(1, Date.now() - t0);
    return {
      ok: true,
      latencyMs,
      url,
      message: existing
        ? `Conexión exitosa (${latencyMs} ms). Sala "${code}" activa con ${existing.counts.length} conteo(s) y ${existing.movements?.length ?? 0} movimiento(s).`
        : `Conexión exitosa (${latencyMs} ms). El enlace de Firebase responde correctamente y está listo para crear la sala "${code}".`,
      existingCounts: existing?.counts.length ?? 0,
      existingMovements: existing?.movements?.length ?? 0,
    };
  } catch (err) {
    const latencyMs = Math.max(1, Date.now() - t0);
    return {
      ok: false,
      latencyMs,
      url,
      message: (err as Error).message || 'No se pudo conectar al servidor Firebase. Verifica la URL y tu conexión.',
      existingCounts: 0,
      existingMovements: 0,
    };
  }
}

export function canonicalCountId(id: string): string {
  const parts = (id || '').split('__');
  return parts[parts.length - 1] || id;
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
    movements?: Movement[];
    idealLevels?: Record<string, number>;
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
  const skuToBarcode = new Map<string, string>();

  const upsertProdInRoom = (p: Product) => {
    if (!p || !p.barcode) return;
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

    const pIsOfficial = !p.uncataloged && (p.source === 'catalogo' || p.source === 'manual');
    const prevIsPending = prev.source === 'pendiente' || Boolean(prev.uncataloged);
    const nextDesc =
      p.description && (prevIsPending || pIsOfficial || !prev.description)
        ? p.description
        : prev.description || p.description;
    const nextSource: Product['source'] =
      p.source === 'catalogo' || prev.source === 'catalogo'
        ? 'catalogo'
        : prev.source === 'pendiente' && p.source !== 'pendiente'
          ? p.source
          : prev.source;
    const nextUncataloged =
      p.uncataloged === false || prev.uncataloged === false || nextSource === 'catalogo'
        ? false
        : Boolean(prev.uncataloged && p.uncataloged);

    const mergedProd: Product = {
      ...prev,
      ...p,
      barcode: targetBarcode,
      description: nextDesc,
      sku: p.sku || prev.sku,
      unit: p.unit || prev.unit,
      expectedQty: p.expectedQty !== undefined ? p.expectedQty : prev.expectedQty,
      minQty: p.minQty !== undefined ? p.minQty : prev.minQty,
      maxQty: p.maxQty !== undefined ? p.maxQty : prev.maxQty,
      unitCost: p.unitCost !== undefined ? p.unitCost : prev.unitCost,
      brand: p.brand || prev.brand,
      imageUrl: p.imageUrl || prev.imageUrl,
      uncataloged: nextUncataloged,
      source: nextSource,
    };
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
    const key = `${c.counter || 'Técnico'}__${(c.deviceId || 'local').slice(0, 8)}`;
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

  // Movements: deduplicar por UUID (m.id), tomando la marca de tiempo más reciente en colisión
  const movMap = new Map<string, Movement>();
  if (base?.movements && Array.isArray(base.movements)) {
    for (const m of base.movements) {
      if (m && m.id) movMap.set(m.id, m);
    }
  }
  if (incoming.movements && Array.isArray(incoming.movements)) {
    for (const m of incoming.movements) {
      if (m && m.id) {
        const prev = movMap.get(m.id);
        if (!prev || m.timestamp >= (prev.timestamp || 0)) {
          movMap.set(m.id, m);
        }
      }
    }
  }
  const mergedMovements = [...movMap.values()].sort((a, b) => a.timestamp - b.timestamp);

  // También registrar en participantes a quienes hicieron movimientos de Kardex si no habían contado
  for (const m of mergedMovements) {
    const who = m.technicianOrSupplier || 'Almacén';
    const key = `${who}__kardex`;
    const prod = [...prodMap.values()].find((p) => p.sku.toUpperCase() === m.sku.toUpperCase());
    const cur = participants[key];
    if (cur) {
      if (m.timestamp > cur.lastSeen) {
        cur.lastSeen = m.timestamp;
        cur.lastSku = m.sku;
        cur.lastDescription = prod?.description || m.sku;
        cur.lastQty = m.type === 'IN' ? m.quantity : -m.quantity;
      }
    }
  }

  // Niveles ideales: fusionar diccionarios de SKU
  const mergedIdealLevels: Record<string, number> = {};
  if (base?.idealLevels && typeof base.idealLevels === 'object') {
    for (const [k, v] of Object.entries(base.idealLevels)) {
      const sku = k.trim().toUpperCase();
      if (sku && typeof v === 'number' && !isNaN(v) && v >= 0) {
        mergedIdealLevels[sku] = v;
      }
    }
  }
  if (incoming.idealLevels && typeof incoming.idealLevels === 'object') {
    for (const [k, v] of Object.entries(incoming.idealLevels)) {
      const sku = k.trim().toUpperCase();
      if (sku && typeof v === 'number' && !isNaN(v) && v >= 0) {
        mergedIdealLevels[sku] = v;
      }
    }
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
    movements: mergedMovements,
    idealLevels: mergedIdealLevels,
  };
}

function computeStateFingerprint(state: CloudRoomState | null): string {
  if (!state) return '';
  const lastCountTs = state.counts.length ? state.counts[state.counts.length - 1].timestamp : 0;
  const lastMovTs = state.movements?.length ? state.movements[state.movements.length - 1].timestamp : 0;
  const idealKeys = state.idealLevels ? Object.entries(state.idealLevels).map(([k, v]) => `${k}:${v}`).sort().join(',') : '';
  const prodSig = state.products
    .map((p) => `${p.barcode}:${p.sku}:${p.description}:${p.expectedQty ?? ''}:${p.minQty ?? ''}:${p.maxQty ?? ''}`)
    .sort()
    .join(';');
  return `${state.counts.length}|${lastCountTs}|${state.products.length}|${prodSig}|${state.movements?.length ?? 0}|${lastMovTs}|${idealKeys}`;
}

/**
 * Aplica en la base de datos local (IndexedDB) un estado recibido en tiempo real desde Firebase o BroadcastChannel
 * sin sobrescribir ni perder datos locales.
 */
async function applyIncomingRoomStateToLocal(
  incomingState: CloudRoomState,
  sourceTransport: 'remote' | 'local',
): Promise<boolean> {
  const prevMirror = getLocalRoomMirror(incomingState.roomCode);
  const prevFp = computeStateFingerprint(prevMirror);
  const nextFp = computeStateFingerprint(incomingState);

  saveLocalRoomMirror(incomingState.roomCode, incomingState);

  let session = await getActiveSession();
  if (!session) {
    const s = await loadSettings();
    session = await createSession(
      incomingState.sessionName || `Inventario Sala ${incomingState.roomCode}`,
      s.counterName || 'Supervisor',
    );
  }

  let hasNewChanges = prevFp !== nextFp;

  if (incomingState.products && incomingState.products.length > 0) {
    const recRes = await reconcileCatalogProducts(incomingState.products);
    if (recRes.added > 0 || recRes.updated > 0) {
      hasNewChanges = true;
    }
  }

  if (incomingState.counts.length > 0 || incomingState.products.length > 0) {
    const remoteFile: CountFile = {
      app: APP_ID,
      version: 1,
      kind: 'conteo',
      exportedAt: new Date().toISOString(),
      deviceId: 'cloud-room',
      session: {
        id: session.id,
        name: incomingState.sessionName || session.name,
        counter: 'Sala ' + incomingState.roomCode,
        createdAt: session.createdAt,
        closed: false,
      },
      counts: incomingState.counts,
      products: incomingState.products,
    };
    const mergeRes = await mergeCountFiles(session.id, [remoteFile]);
    if (mergeRes.added > 0 || mergeRes.productsAdded > 0) {
      hasNewChanges = true;
    }
  }

  if (incomingState.movements && Array.isArray(incomingState.movements)) {
    const localMovs = await listMovements();
    if (incomingState.movements.length !== localMovs.length) {
      hasNewChanges = true;
    }
    const movMap = new Map<string, Movement>();
    for (const m of localMovs) movMap.set(m.id, m);
    for (const m of incomingState.movements) {
      const prev = movMap.get(m.id);
      if (!prev || m.timestamp >= prev.timestamp) {
        if (!prev) hasNewChanges = true;
        movMap.set(m.id, m);
      }
    }
    if (hasNewChanges) {
      await saveAllMovements([...movMap.values()]);
    }
  }

  if (incomingState.idealLevels && typeof incomingState.idealLevels === 'object') {
    const curIdeals = await getIdealLevels();
    const mergedIdeals = { ...curIdeals, ...incomingState.idealLevels };
    if (JSON.stringify(curIdeals) !== JSON.stringify(mergedIdeals)) {
      await setIdealLevels(mergedIdeals);
      hasNewChanges = true;
    }
  }

  const now = Date.now();
  await setMeta(`lastSync_${incomingState.roomCode}`, now);

  emitStatus({
    state: sourceTransport === 'remote' ? 'connected' : 'local_only',
    roomCode: incomingState.roomCode,
    transport: sourceTransport,
    lastSyncedAt: now,
    lastError: null,
    participantCount: Object.keys(incomingState.participants || {}).length,
    totalCounts: incomingState.counts.length,
    totalMovements: incomingState.movements?.length ?? 0,
  });

  if (hasNewChanges) {
    notifyRoomListeners(incomingState);
  }
  return hasNewChanges;
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

  const t0 = Date.now();
  // 1. Obtener estado previo de la sala (remoto si hay endpoint, o espejo local/BroadcastChannel)
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

  // Si no hay sesión local activa, crear una automáticamente para esta sala
  if (!session) {
    const sessName = remoteState?.sessionName || `Inventario Sala ${roomCode}`;
    const counter = s.counterName || 'Supervisor';
    session = await createSession(sessName, counter);
  }

  const [localCounts, localProducts, localMovements, localIdealLevels] = await Promise.all([
    countsForSession(session.id),
    allProducts(),
    listMovements(),
    getIdealLevels(),
  ]);

  const touchedBarcodes = new Set(localCounts.map((c) => c.barcode));
  const touchedSkus = new Set(localMovements.map((m) => m.sku.toUpperCase()));
  // Sincronizar el catálogo completo (hasta 5000 productos) para garantizar conciliación total entre dispositivos
  const includeFullCatalog =
    localProducts.length <= 5000 || !remoteState || (remoteState.products?.length ?? 0) === 0;
  const changedProducts = includeFullCatalog
    ? localProducts
    : localProducts.filter(
        (p) =>
          touchedBarcodes.has(p.barcode) ||
          touchedSkus.has(p.sku.toUpperCase()) ||
          p.uncataloged ||
          p.source !== 'catalogo',
      );

  // 2. Fusionar conteos locales + remotos
  const mergedRoom = mergeRoomStates(remoteState, {
    roomCode,
    sessionName: session.name,
    counts: localCounts,
    products: changedProducts,
    movements: localMovements,
    idealLevels: localIdealLevels,
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

  // Persistir movimientos y niveles ideales fusionados en IndexedDB local
  if (mergedRoom.movements) {
    await saveAllMovements(mergedRoom.movements);
  }
  if (mergedRoom.idealLevels) {
    await setIdealLevels(mergedRoom.idealLevels);
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
  const latencyMs = Math.max(1, syncedAt - t0);
  await setMeta(`lastSync_${roomCode}`, syncedAt);

  emitStatus({
    state: remoteError ? 'error' : endpointUrl ? 'connected' : 'local_only',
    roomCode,
    endpointUrl,
    transport,
    lastSyncedAt: syncedAt,
    lastLatencyMs: latencyMs,
    lastError: remoteError,
    participantCount: Object.keys(mergedRoom.participants).length,
    totalCounts: mergedRoom.counts.length,
    totalMovements: mergedRoom.movements?.length ?? 0,
  });

  notifyRoomListeners(mergedRoom);

  return {
    roomCode,
    sessionId: session.id,
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

// ============================================================================
// MOTOR DE ESCUCHA EN TIEMPO REAL (FIREBASE SSE + SMART POLLING)
// ============================================================================

let livePollTimer: ReturnType<typeof setInterval> | null = null;
let liveEventSource: EventSource | null = null;
let liveSseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let liveSseRetries = 0;
let liveSubscribedKey = '';
let isPollingNow = false;

function connectLiveSse(endpointUrl: string, roomCode: string, subKey: string): void {
  if (typeof EventSource === 'undefined' || liveSubscribedKey !== subKey) return;
  const roomUrl = buildRoomEndpointUrl(endpointUrl, roomCode);
  if (!roomUrl) return;

  try {
    const es = new EventSource(roomUrl);
    liveEventSource = es;

    const handleSsePayload = (ev: MessageEvent) => {
      liveSseRetries = 0;
      try {
        const parsed = JSON.parse(ev.data);
        const payload = parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
        const coerced = coerceRemoteRoomState(payload, roomCode);
        if (coerced) {
          emitStatus({ liveStream: 'sse', state: 'connected', lastError: null });
          void applyIncomingRoomStateToLocal(coerced, 'remote');
        }
      } catch {}
    };

    es.addEventListener('put', handleSsePayload as EventListener);
    es.addEventListener('patch', () => {
      liveSseRetries = 0;
      void pullRemoteRoomQuietly(endpointUrl, roomCode);
    });
    es.onmessage = handleSsePayload;
    es.onerror = () => {
      try {
        es.close();
      } catch {}
      if (liveEventSource === es) {
        liveEventSource = null;
        emitStatus({ liveStream: 'polling' });
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
  }
}

/**
 * Inicia la suscripción en tiempo real a la sala configurada (vía Firebase Server-Sent Events
 * + Polling rápido cada 3 segundos) para que el supervisor y los técnicos vean los cambios al instante.
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

  if (!endpointUrl) {
    const cached = getLocalRoomMirror(roomCode);
    emitStatus({
      state: 'local_only',
      roomCode,
      endpointUrl: '',
      transport: 'local',
      liveStream: broadcastChannel ? 'broadcast' : 'off',
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

  // 1. Conexión SSE en tiempo real con reconexión exponencial
  connectLiveSse(endpointUrl, roomCode, subKey);

  // 2. Polling periódico ligero (cada 3s) para garantizar tiempo real 100% confiable
  void pullRemoteRoomQuietly(endpointUrl, roomCode);
  if (typeof setInterval !== 'undefined') {
    livePollTimer = setInterval(() => {
      void pullRemoteRoomQuietly(endpointUrl, roomCode);
    }, pollMs);
  }
}

export function stopLiveCloudSync(): void {
  liveSubscribedKey = '';
  liveSseRetries = 0;
  if (liveSseReconnectTimer) {
    clearTimeout(liveSseReconnectTimer);
    liveSseReconnectTimer = null;
  }
  if (livePollTimer) {
    clearInterval(livePollTimer);
    livePollTimer = null;
  }
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
    const remote = await fetchRemoteRoom(endpointUrl, roomCode);
    const latencyMs = Math.max(1, Date.now() - t0);
    if (remote) {
      await applyIncomingRoomStateToLocal(remote, 'remote');
      emitStatus({
        state: 'connected',
        roomCode,
        endpointUrl,
        transport: 'remote',
        lastLatencyMs: latencyMs,
        lastError: null,
      });
    } else {
      // La sala aún no existe en Firebase; empujar nuestro estado inicial
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

let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Dispara una sincronización automática en segundo plano (con debounce de 350ms)
 * cuando el técnico registra, modifica o elimina un escaneo o movimiento de Kardex.
 */
export function triggerBackgroundSync(sessionId?: string): void {
  const s = settingsSync();
  if (!s.syncEnabled || !s.syncAuto || !s.syncRoomCode.trim()) return;
  if (autoSyncTimer) clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => {
    void syncNow({ sessionId }).catch(() => {
      void setMeta('pendingCloudSyncRoom', s.syncRoomCode);
    });
  }, 350);
}

/**
 * Revisa si la URL de arranque contiene `?room=...&db=...` para autoconfigurar Firebase y la Sala.
 */
export async function consumeUrlSyncParams(): Promise<{ joinedRoom?: string; endpointUrl?: string } | null> {
  if (typeof window === 'undefined' || !window.location?.search) return null;
  const params = new URLSearchParams(window.location.search);
  const rawRoom = params.get('room');
  const rawDb = params.get('db');
  if (!rawRoom && !rawDb) return null;

  const s = await loadSettings();
  const roomCode = normalizeRoomCode(rawRoom || s.syncRoomCode || generateRoomCode('MHK'));
  const endpointUrl = normalizeEndpointBaseUrl(rawDb || s.syncEndpointUrl || '');

  await saveSettings({
    syncEnabled: true,
    syncAuto: true,
    syncRoomCode: roomCode,
    syncEndpointUrl: endpointUrl,
  });

  // Limpiar query string de la barra de direcciones sin recargar
  try {
    params.delete('room');
    params.delete('db');
    const cleanSearch = params.toString();
    const cleanUrl = `${window.location.pathname}${cleanSearch ? `?${cleanSearch}` : ''}${window.location.hash}`;
    window.history.replaceState({}, '', cleanUrl);
  } catch {}

  startLiveCloudSync({ roomCode, endpointUrl });
  void syncNow({ roomCode, endpointUrl }).catch(() => {});
  return { joinedRoom: roomCode, endpointUrl };
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
  stopLiveCloudSync();
  memoryRooms.clear();
}
