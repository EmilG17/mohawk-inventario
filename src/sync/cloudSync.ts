import {
  allProducts,
  countsForSession,
  createSession,
  getActiveSession,
  getDB,
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
import { isMobileCatalogReadOnly } from '../ui/catalogMode';

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

export interface LiveScannerState {
  counter: string;
  deviceId: string;
  status: 'scanning' | 'pending_confirm' | 'registered' | 'idle';
  cameraOn?: boolean;
  origin?: 'camara' | 'teclado' | 'manual';
  barcode?: string;
  sku?: string;
  description?: string;
  qty?: number;
  sessionName?: string;
  updatedAt: number;
}

export interface TombstoneState {
  counts?: Record<string, number>;
  movements?: Record<string, number>;
  products?: Record<string, number>;
}

export interface RoomDeltaPayload {
  counts?: Record<string, CountEntry | null>;
  movements?: Record<string, Movement | null>;
  products?: Record<string, Product | null>;
  liveScanners?: Record<string, LiveScannerState>;
  participants?: Record<string, CloudParticipant>;
  tombstones?: {
    counts?: Record<string, number>;
    movements?: Record<string, number>;
    products?: Record<string, number>;
  };
  updatedAt?: number;
  catalogVersion?: number;
}

export interface CloudArchivedSessionSummary {
  id: string;
  name: string;
  counter: string;
  createdAt: number;
  closedAt: number;
  totalCounts: number;
  totalUnits: number;
  roomCode: string;
}

export interface CloudArchivedSessionDetail extends CloudArchivedSessionSummary {
  counts: CountEntry[];
  movements?: Movement[];
  exportedAt: string;
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
  liveScanners?: Record<string, LiveScannerState>;
  movements?: Movement[];
  idealLevels?: Record<string, number>;
  tombstones?: {
    counts?: Record<string, number>;
    movements?: Record<string, number>;
    products?: Record<string, number>;
  };
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
  for (const fn of [...statusListeners]) {
    if (!statusListeners.has(fn)) continue;
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
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[_\s]+/g, '-')
    .replace(/^([A-Z]+)(\d+)$/, '$1-$2')
    .replace(/-0+(\d+)/g, '-$1')
    .replace(/[^A-Z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

export function generateRoomCode(prefix = 'MHK'): string {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${num}`;
}

export interface AvailableRoomInfo {
  roomCode: string;
  sessionName?: string;
  totalCounts?: number;
  updatedAt?: number;
}

/**
 * Consulta las salas existentes en la base de datos de Firebase para evitar crear duplicados.
 * Utiliza ?shallow=true para una respuesta ultraligera de pocos bytes y consulta el índice.
 */
export async function listAvailableRoomsInDb(endpointUrl: string): Promise<AvailableRoomInfo[]> {
  const normBase = normalizeEndpointBaseUrl(endpointUrl);
  if (!normBase || typeof fetch === 'undefined') return [];

  const isFirebase = /firebaseio\.com/i.test(normBase) || /\.firebasedatabase\.app/i.test(normBase);
  if (!isFirebase) return [];

  const foundMap = new Map<string, AvailableRoomInfo>();

  // 1. Intentar shallow query sobre /rooms.json (ultraligero en Firebase)
  try {
    const url = `${normBase}/rooms.json?shallow=true`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: getFetchTimeoutSignal(5000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') {
        for (const k of Object.keys(data)) {
          const norm = normalizeRoomCode(k);
          if (norm && !foundMap.has(norm)) {
            foundMap.set(norm, { roomCode: norm });
          }
        }
      }
    }
  } catch {}

  // 2. Intentar consultar el registro ligero de salas /rooms_index.json
  try {
    const indexUrl = `${normBase}/rooms_index.json`;
    const res2 = await fetch(indexUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: getFetchTimeoutSignal(4000),
    });
    if (res2.ok) {
      const indexData = await res2.json();
      if (indexData && typeof indexData === 'object') {
        for (const [k, v] of Object.entries(indexData as Record<string, any>)) {
          const norm = normalizeRoomCode(k);
          if (norm) {
            foundMap.set(norm, {
              roomCode: norm,
              sessionName: v?.sessionName,
              totalCounts: v?.totalCounts,
              updatedAt: v?.updatedAt,
            });
          }
        }
      }
    }
  } catch {}

  return [...foundMap.values()];
}

/**
 * Comprueba si una sala específica ya existe en la base de datos de Firebase
 * consultando únicamente su marca de tiempo (solo ~8 bytes).
 */
export async function checkRoomExistsInDb(
  endpointUrl: string,
  roomCode: string,
): Promise<{
  exists: boolean;
  roomCode: string;
  updatedAt?: number;
}> {
  const normBase = normalizeEndpointBaseUrl(endpointUrl);
  const code = normalizeRoomCode(roomCode);
  if (!normBase || !code || typeof fetch === 'undefined') {
    return { exists: false, roomCode: code };
  }

  const isFirebase = /firebaseio\.com/i.test(normBase) || /\.firebasedatabase\.app/i.test(normBase);
  if (!isFirebase) {
    return { exists: false, roomCode: code };
  }

  try {
    const cleanRoom = encodeURIComponent(code);
    const url = `${normBase}/rooms/${cleanRoom}/updatedAt.json`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: getFetchTimeoutSignal(4000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data !== null) {
        return { exists: true, roomCode: code, updatedAt: typeof data === 'number' ? data : undefined };
      }
    }
  } catch {}

  return { exists: false, roomCode: code };
}

/**
 * Genera un código de sala único asegurando que no colisione con ninguna sala existente en la BD.
 */
export async function generateUniqueRoomCode(endpointUrl?: string, prefix = 'MHK'): Promise<string> {
  const normBase = normalizeEndpointBaseUrl(endpointUrl || '');
  if (!normBase) {
    return generateRoomCode(prefix);
  }

  try {
    const existing = await listAvailableRoomsInDb(normBase);
    const set = new Set(existing.map((r) => r.roomCode));

    // Si existen salas con formato secuencial (ej. MHK-1, MHK-2), sugerimos el siguiente entero disponible
    let maxSequential = 0;
    const prefixRegex = new RegExp(`^${prefix}-(\\d+)$`, 'i');
    for (const r of existing) {
      const match = r.roomCode.match(prefixRegex);
      if (match) {
        const val = parseInt(match[1], 10);
        if (val > maxSequential && val < 1000) {
          maxSequential = val;
        }
      }
    }

    if (maxSequential > 0) {
      const candidate = `${prefix}-${maxSequential + 1}`;
      if (!set.has(candidate)) return candidate;
    }

    for (let i = 0; i < 20; i++) {
      const candidate = generateRoomCode(prefix);
      if (!set.has(candidate)) {
        return candidate;
      }
    }
  } catch {}

  const uniqueSuffix = Math.floor(1000 + (Date.now() % 9000));
  return `${prefix}-${uniqueSuffix}`;
}

/**
 * Detecta si una cadena escaneada o recibida es un enlace o código de invitación a sala.
 */
export function isRoomInviteUrl(raw: string): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (trimmed.startsWith(QR_PREFIX)) return false;
  return trimmed.includes('room=') || trimmed.includes('?room=') || trimmed.includes('&room=');
}

/**
 * Extrae los parámetros de sala y base de datos de un enlace de invitación.
 */
export function parseRoomInviteUrl(raw: string): {
  roomCode?: string;
  endpointUrl?: string;
  role?: 'technician' | 'supervisor';
} | null {
  if (!isRoomInviteUrl(raw)) return null;
  try {
    const trimmed = raw.trim();
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const room = url.searchParams.get('room');
    const db = url.searchParams.get('db') || url.searchParams.get('endpoint');
    const rawRole = url.searchParams.get('role')?.toLowerCase();
    const role: 'technician' | 'supervisor' | undefined =
      rawRole === 'supervisor' || rawRole === 'admin'
        ? 'supervisor'
        : rawRole === 'technician' || rawRole === 'tech' || rawRole === 'counter'
          ? 'technician'
          : undefined;

    if (!room && !db) return null;
    return {
      roomCode: room ? normalizeRoomCode(room) : undefined,
      endpointUrl: db ? normalizeEndpointBaseUrl(db) : undefined,
      role,
    };
  } catch {
    const matchRoom = raw.match(/[?&]room=([a-zA-Z0-9_.-]+)/i);
    const matchDb = raw.match(/[?&](?:db|endpoint)=([^&]+)/i);
    const matchRole = raw.match(/[?&]role=(technician|supervisor|tech|counter)/i);
    if (!matchRoom && !matchDb) return null;
    const r = matchRole ? matchRole[1].toLowerCase() : '';
    const role: 'technician' | 'supervisor' | undefined =
      r === 'supervisor' ? 'supervisor' : r ? 'technician' : undefined;
    return {
      roomCode: matchRoom ? normalizeRoomCode(matchRoom[1]) : undefined,
      endpointUrl: matchDb ? normalizeEndpointBaseUrl(decodeURIComponent(matchDb[1])) : undefined,
      role,
    };
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

  // Por defecto al unirse por invitación externa se asigna rol de 'technician' para proteger el centro de gestión
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

  startLiveCloudSync({ roomCode: code, endpointUrl: cleanEndpoint });
  void syncNow({ roomCode: code, endpointUrl: cleanEndpoint }).catch(() => {});
  return { success: true, roomCode: code, role: targetRole };
}

export async function registerRoomInDbIndex(
  endpointUrl: string,
  roomCode: string,
  sessionName: string,
  totalCounts: number,
): Promise<void> {
  const normBase = normalizeEndpointBaseUrl(endpointUrl);
  const cleanRoom = encodeURIComponent(normalizeRoomCode(roomCode));
  if (!normBase || !cleanRoom || typeof fetch === 'undefined') return;
  const isFirebase = /firebaseio\.com/i.test(normBase) || /\.firebasedatabase\.app/i.test(normBase);
  if (!isFirebase) return;

  try {
    const url = `${normBase}/rooms_index/${cleanRoom}.json`;
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        roomCode: normalizeRoomCode(roomCode),
        sessionName: sessionName || `Sala ${roomCode}`,
        totalCounts,
        updatedAt: Date.now(),
      }),
      signal: getFetchTimeoutSignal(4000),
    });
  } catch {}
}

export function onCloudRoomUpdate(listener: (state: CloudRoomState) => void): () => void {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}

function notifyRoomListeners(state: CloudRoomState): void {
  for (const fn of [...syncListeners]) {
    if (!syncListeners.has(fn)) continue;
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
export function buildRoomInviteUrl(
  roomCode: string,
  endpointUrl?: string,
  role: 'technician' | 'supervisor' = 'technician',
): string {
  const code = normalizeRoomCode(roomCode);
  const cleanDb = normalizeEndpointBaseUrl(endpointUrl || '');
  const base =
    typeof window !== 'undefined' && window.location
      ? `${window.location.origin}${window.location.pathname}`
      : 'https://emilg17.github.io/mohawk-inventario/';
  const params = new URLSearchParams();
  if (code) params.set('room', code);
  if (cleanDb) params.set('db', cleanDb);
  if (role) params.set('role', role);
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
    'liveScanners' in obj ||
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
  const liveScanners: Record<string, LiveScannerState> =
    obj.liveScanners && typeof obj.liveScanners === 'object' && !Array.isArray(obj.liveScanners)
      ? (obj.liveScanners as Record<string, LiveScannerState>)
      : {};
  const idealLevels =
    obj.idealLevels && typeof obj.idealLevels === 'object' && !Array.isArray(obj.idealLevels)
      ? (obj.idealLevels as Record<string, number>)
      : {};

  let tombstones: CloudRoomState['tombstones'] = undefined;
  if (obj.tombstones && typeof obj.tombstones === 'object' && !Array.isArray(obj.tombstones)) {
    const rawTomb = obj.tombstones as Record<string, any>;
    tombstones = {
      counts: rawTomb.counts && typeof rawTomb.counts === 'object' ? rawTomb.counts : {},
      movements: rawTomb.movements && typeof rawTomb.movements === 'object' ? rawTomb.movements : {},
      products: rawTomb.products && typeof rawTomb.products === 'object' ? rawTomb.products : {},
    };
  }

  return {
    app: APP_ID,
    version: 1,
    roomCode,
    updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now(),
    sessionName: typeof obj.sessionName === 'string' && obj.sessionName ? obj.sessionName : `Sala ${roomCode}`,
    counts,
    products,
    participants,
    liveScanners,
    movements,
    idealLevels,
    tombstones,
  };
}

function getFetchTimeoutSignal(timeoutMs = 10000): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout === 'function') {
    return (AbortSignal as any).timeout(timeoutMs);
  }
  return undefined;
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
    signal: getFetchTimeoutSignal(10000),
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
    signal: getFetchTimeoutSignal(10000),
  });
  if (!res.ok) {
    throw new Error(formatRemoteHttpError(res.status, roomCode));
  }
  return true;
}

/**
 * Consulta de forma ultraligera el timestamp de actualización de la sala en Firebase
 * sin descargar conteos, productos ni movimientos.
 */
export async function fetchRemoteUpdatedAt(endpointUrl: string, roomCode: string): Promise<number | null> {
  const norm = normalizeEndpointBaseUrl(endpointUrl);
  if (!norm || typeof fetch === 'undefined') return null;
  const isFirebase = /firebaseio\.com/i.test(norm) || /\.firebasedatabase\.app/i.test(norm);
  if (!isFirebase) return null;
  const cleanRoom = encodeURIComponent(normalizeRoomCode(roomCode));
  const url = `${norm}/rooms/${cleanRoom}/updatedAt.json`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: getFetchTimeoutSignal(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data === 'number' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Aplica una actualización granular/delta multi-path en Firebase Realtime Database
 * utilizando peticiones PATCH sobre sub-rutas específicas (counts, movements, liveScanners, etc.).
 * Reduce el consumo de datos de megabytes a solo ~200 bytes por escaneo.
 */
export async function patchRemoteRoomDelta(
  endpointUrl: string,
  roomCode: string,
  delta: RoomDeltaPayload,
): Promise<boolean> {
  const cleanRoom = encodeURIComponent(normalizeRoomCode(roomCode));
  const rawBase = normalizeEndpointBaseUrl(endpointUrl);
  if (!rawBase || !cleanRoom || typeof fetch === 'undefined') return false;

  const isFirebase = /firebaseio\.com/i.test(rawBase) || /\.firebasedatabase\.app/i.test(rawBase);
  if (!isFirebase) return false;

  const now = delta.updatedAt || Date.now();
  const patchPayload: Record<string, unknown> = {
    updatedAt: now,
  };

  if (delta.counts) {
    for (const [id, c] of Object.entries(delta.counts)) {
      const normKey = canonicalCountId(id);
      patchPayload[`counts/${normKey}`] = c;
    }
  }

  if (delta.movements) {
    for (const [id, m] of Object.entries(delta.movements)) {
      patchPayload[`movements/${id}`] = m;
    }
  }

  if (delta.products) {
    for (const [barcode, p] of Object.entries(delta.products)) {
      const normBc = normalizeBarcode(barcode);
      patchPayload[`products/${normBc}`] = p;
    }
  }

  if (delta.liveScanners) {
    for (const [key, scan] of Object.entries(delta.liveScanners)) {
      patchPayload[`liveScanners/${key}`] = scan;
    }
  }

  if (delta.participants) {
    for (const [key, part] of Object.entries(delta.participants)) {
      patchPayload[`participants/${key}`] = part;
    }
  }

  if (delta.tombstones?.counts) {
    for (const [id, ts] of Object.entries(delta.tombstones.counts)) {
      const normKey = canonicalCountId(id);
      patchPayload[`tombstones/counts/${normKey}`] = ts;
      patchPayload[`counts/${normKey}`] = null;
    }
  }

  if (delta.tombstones?.movements) {
    for (const [id, ts] of Object.entries(delta.tombstones.movements)) {
      patchPayload[`tombstones/movements/${id}`] = ts;
      patchPayload[`movements/${id}`] = null;
    }
  }

  if (delta.tombstones?.products) {
    for (const [bc, ts] of Object.entries(delta.tombstones.products)) {
      const normBc = normalizeBarcode(bc);
      patchPayload[`tombstones/products/${normBc}`] = ts;
      patchPayload[`products/${normBc}`] = null;
    }
  }

  if (delta.catalogVersion !== undefined) {
    patchPayload.catalogVersion = delta.catalogVersion;
  }

  const patchUrl = `${rawBase}/rooms/${cleanRoom}.json`;
  try {
    const res = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(patchPayload),
      signal: getFetchTimeoutSignal(8000),
    });
    return res.ok;
  } catch (err) {
    console.warn('[cloudSync] Error en patch delta:', err);
    return false;
  }
}

/**
 * Sincroniza deltas recientes hacia Firebase de forma ultra-ligera (~200 bytes)
 * enviando únicamente conteos, movimientos y lápidas posteriores a `sinceTimestamp`.
 */
export async function syncDeltaToRemote(opts: {
  sessionId?: string;
  roomCode?: string;
  endpointUrl?: string;
  sinceTimestamp?: number;
}): Promise<boolean> {
  const s = settingsSync();
  const roomCode = normalizeRoomCode(opts.roomCode || s.syncRoomCode);
  const endpointUrl = normalizeEndpointBaseUrl(opts.endpointUrl || s.syncEndpointUrl);
  if (!roomCode || !endpointUrl) return false;

  const isFirebase = /firebaseio\.com/i.test(endpointUrl) || /\.firebasedatabase\.app/i.test(endpointUrl);
  if (!isFirebase) return false;

  const since = opts.sinceTimestamp || 0;
  const session = opts.sessionId ? await getSession(opts.sessionId) : await getActiveSession();

  const allCounts = session ? await countsForSession(session.id) : [];
  const deltaCounts = allCounts.filter((c) => c.timestamp >= since);

  const allMovements = await listMovements();
  const deltaMovements = allMovements.filter((m) => m.timestamp >= since);

  const localTombstones = await getLocalTombstones();
  const deltaTombCounts: Record<string, number> = {};
  if (localTombstones.counts) {
    for (const [id, ts] of Object.entries(localTombstones.counts)) {
      if (ts >= since) deltaTombCounts[id] = ts;
    }
  }
  const deltaTombMovements: Record<string, number> = {};
  if (localTombstones.movements) {
    for (const [id, ts] of Object.entries(localTombstones.movements)) {
      if (ts >= since) deltaTombMovements[id] = ts;
    }
  }

  const hasDeltas =
    deltaCounts.length > 0 ||
    deltaMovements.length > 0 ||
    Object.keys(deltaTombCounts).length > 0 ||
    Object.keys(deltaTombMovements).length > 0;

  if (!hasDeltas) {
    return true;
  }

  const countsMap: Record<string, CountEntry> = {};
  for (const c of deltaCounts) {
    countsMap[canonicalCountId(c.id)] = c;
  }

  const movementsMap: Record<string, Movement> = {};
  for (const m of deltaMovements) {
    movementsMap[m.id] = m;
  }

  const deviceId = await getDeviceId();
  const counterName = (session?.counter || s.counterName || 'Técnico').trim() || 'Técnico';
  const participantsMap: Record<string, CloudParticipant> = {
    [deviceId]: {
      counter: counterName,
      deviceId,
      lastSeen: Date.now(),
      scans: allCounts.length,
      units: allCounts.reduce((sum, c) => sum + (c.qty || 0), 0),
      lastSku: deltaCounts[deltaCounts.length - 1]?.barcode,
      lastQty: deltaCounts[deltaCounts.length - 1]?.qty,
    },
  };

  const ok = await patchRemoteRoomDelta(endpointUrl, roomCode, {
    counts: countsMap,
    movements: movementsMap,
    participants: participantsMap,
    tombstones: {
      counts: deltaTombCounts,
      movements: deltaTombMovements,
    },
    updatedAt: Date.now(),
  });

  if (ok) {
    const now = Date.now();
    await setMeta(`lastSync_${roomCode}`, now);
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
 * Archiva una sesión completada en Firebase en una sub-ruta dedicada `/rooms/{sala}/sessions_archive/{id}.json`
 * y guarda su resumen en `/rooms/{sala}/history_summaries/{id}.json`.
 * Esto permite desacoplar sesiones pasadas de la sala activa para mantener el rendimiento al 100%.
 */
export async function archiveSessionToCloud(
  sessionId: string,
  opts?: { roomCode?: string; endpointUrl?: string },
): Promise<boolean> {
  const s = settingsSync();
  const roomCode = normalizeRoomCode(opts?.roomCode || s.syncRoomCode);
  const endpointUrl = normalizeEndpointBaseUrl(opts?.endpointUrl || s.syncEndpointUrl);
  if (!roomCode || !endpointUrl || typeof fetch === 'undefined') return false;

  const session = await getSession(sessionId);
  if (!session) return false;

  const counts = await countsForSession(sessionId);
  const totalUnits = counts.reduce((acc, c) => acc + (c.qty || 0), 0);
  const closedAt = Date.now();

  const summary: CloudArchivedSessionSummary = {
    id: session.id,
    name: session.name,
    counter: session.counter,
    createdAt: session.createdAt,
    closedAt,
    totalCounts: counts.length,
    totalUnits,
    roomCode,
  };

  const detail: CloudArchivedSessionDetail = {
    ...summary,
    counts,
    exportedAt: new Date().toISOString(),
  };

  const isFirebase = /firebaseio\.com/i.test(endpointUrl) || /\.firebasedatabase\.app/i.test(endpointUrl);
  if (!isFirebase) return false;

  const cleanRoom = encodeURIComponent(roomCode);
  const cleanSessionId = encodeURIComponent(session.id);

  try {
    const detailUrl = `${endpointUrl}/rooms/${cleanRoom}/sessions_archive/${cleanSessionId}.json`;
    await fetch(detailUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(detail),
      signal: getFetchTimeoutSignal(10000),
    });

    const summaryUrl = `${endpointUrl}/rooms/${cleanRoom}/history_summaries/${cleanSessionId}.json`;
    await fetch(summaryUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(summary),
      signal: getFetchTimeoutSignal(6000),
    });

    return true;
  } catch (err) {
    console.warn('[cloudSync] Error al archivar sesión en Firebase:', err);
    return false;
  }
}

/**
 * Consulta la lista ligera de sesiones archivadas en la sala de Firebase sin descargar el detalle de conteos.
 */
export async function listCloudArchivedSessions(opts?: {
  roomCode?: string;
  endpointUrl?: string;
}): Promise<CloudArchivedSessionSummary[]> {
  const s = settingsSync();
  const roomCode = normalizeRoomCode(opts?.roomCode || s.syncRoomCode);
  const endpointUrl = normalizeEndpointBaseUrl(opts?.endpointUrl || s.syncEndpointUrl);
  if (!roomCode || !endpointUrl || typeof fetch === 'undefined') return [];

  const cleanRoom = encodeURIComponent(roomCode);
  const url = `${endpointUrl}/rooms/${cleanRoom}/history_summaries.json`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: getFetchTimeoutSignal(8000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data || typeof data !== 'object') return [];
    return Object.values(data as Record<string, CloudArchivedSessionSummary>).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Descarga bajo demanda el detalle completo de una sesión archivada en la nube (para reportes o exportar a Excel).
 */
export async function fetchCloudArchivedSession(
  sessionId: string,
  opts?: { roomCode?: string; endpointUrl?: string },
): Promise<CloudArchivedSessionDetail | null> {
  const s = settingsSync();
  const roomCode = normalizeRoomCode(opts?.roomCode || s.syncRoomCode);
  const endpointUrl = normalizeEndpointBaseUrl(opts?.endpointUrl || s.syncEndpointUrl);
  if (!roomCode || !endpointUrl || !sessionId || typeof fetch === 'undefined') return null;

  const cleanRoom = encodeURIComponent(roomCode);
  const cleanSessionId = encodeURIComponent(sessionId);
  const url = `${endpointUrl}/rooms/${cleanRoom}/sessions_archive/${cleanSessionId}.json`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: getFetchTimeoutSignal(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data === 'object' && 'counts' in data ? (data as CloudArchivedSessionDetail) : null;
  } catch {
    return null;
  }
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
  const current = (await getLocalTombstones()) || {};
  const currentMap = { ...(current[type] || {}) };
  currentMap[normId] = Math.max(currentMap[normId] || 0, timestamp);
  current[type] = currentMap;
  await saveLocalTombstones(current);
}

function mergeLiveScannersMap(
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
    if (prodTombTs !== undefined && prodTombTs >= (p.updatedAt || 0)) return;

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

    const pTs = p.updatedAt ?? 0;
    const prevTs = prev.updatedAt ?? 0;
    let mergedProd: Product;

    if (pTs > prevTs) {
      mergedProd = {
        ...prev,
        ...p,
        barcode: targetBarcode,
        description: p.description || prev.description,
        sku: p.sku || prev.sku,
        unit: p.unit || prev.unit,
        expectedQty: p.expectedQty,
        minQty: p.minQty,
        maxQty: p.maxQty,
        unitCost: p.unitCost,
        brand: p.brand ?? prev.brand,
        imageUrl: p.imageUrl ?? prev.imageUrl,
        uncataloged: p.uncataloged !== undefined ? p.uncataloged : prev.uncataloged,
        source:
          p.source === 'pendiente' && prev.source !== 'pendiente' && !p.description
            ? prev.source
            : p.source,
        updatedAt: pTs,
      };
      if (mergedProd.expectedQty === undefined) delete mergedProd.expectedQty;
      if (mergedProd.minQty === undefined) delete mergedProd.minQty;
      if (mergedProd.maxQty === undefined) delete mergedProd.maxQty;
      if (mergedProd.unitCost === undefined) delete mergedProd.unitCost;
    } else if (prevTs > pTs) {
      const pIsOfficial = !p.uncataloged && (p.source === 'catalogo' || p.source === 'manual');
      const prevIsPending = prev.source === 'pendiente' || Boolean(prev.uncataloged);
      const promotePrev = prevIsPending && pIsOfficial;
      mergedProd = {
        ...prev,
        barcode: targetBarcode,
        description: prev.description || p.description,
        sku: prev.sku || p.sku,
        unit: prev.unit || p.unit,
        expectedQty: prev.expectedQty !== undefined ? prev.expectedQty : p.expectedQty,
        minQty: prev.minQty !== undefined ? prev.minQty : p.minQty,
        maxQty: prev.maxQty !== undefined ? prev.maxQty : p.maxQty,
        unitCost: prev.unitCost !== undefined ? prev.unitCost : p.unitCost,
        brand: prev.brand || p.brand,
        imageUrl: prev.imageUrl || p.imageUrl,
        uncataloged: promotePrev ? false : prev.uncataloged,
        source: promotePrev ? p.source : prev.source,
        updatedAt: prevTs,
      };
    } else {
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

      mergedProd = {
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
      const sameTs = pTs || prevTs;
      if (sameTs) mergedProd.updatedAt = sameTs;
    }

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

  // Movements: deduplicar por UUID (m.id), tomando la marca de tiempo más reciente en colisión, respetando tombstones
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

  const mergedLiveScanners = mergeLiveScannersMap(base?.liveScanners, incoming.liveScanners);

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
  };
}

export function computeDataFingerprint(state: CloudRoomState | null): string {
  if (!state) return '';
  const lastCountTs = state.counts.length ? state.counts[state.counts.length - 1].timestamp : 0;
  const countQtySum = state.counts.reduce((sum, c) => sum + (c.qty || 0), 0);
  const countSig = state.counts
    .map((c) => `${canonicalCountId(c.id)}:${c.qty}:${c.timestamp}`)
    .sort()
    .join(';');

  const lastMovTs = state.movements?.length ? state.movements[state.movements.length - 1].timestamp : 0;
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

  return `${state.sessionName || ''}|${state.counts.length}|${lastCountTs}|${countQtySum}|${countSig}|${state.products.length}|${prodSig}|${state.movements?.length ?? 0}|${lastMovTs}|${movQtySum}|${movSig}|${idealKeys}|${tombSig}|${partSig}`;
}

export function computeStateFingerprint(state: CloudRoomState | null): string {
  if (!state) return '';
  const scannerSig = Object.entries(state.liveScanners || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, sc]) => `${k}:${sc.status}:${sc.barcode ?? ''}:${sc.qty ?? ''}:${sc.cameraOn ? 1 : 0}:${sc.updatedAt}`)
    .join(';');

  return `${computeDataFingerprint(state)}|${scannerSig}`;
}

/**
 * Aplica en la base de datos local (IndexedDB) un estado recibido en tiempo real desde Firebase o BroadcastChannel
 * sin sobrescribir ni perder datos locales.
 */
export async function applyIncomingRoomStateToLocal(
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
    // Prune tombstoned items locally and sync local tombstones
    const localTombstones = await getLocalTombstones();
    const mergedTomb: TombstoneState = {
      counts: { ...(localTombstones.counts || {}) },
      movements: { ...(localTombstones.movements || {}) },
      products: { ...(localTombstones.products || {}) },
    };
    if (incomingState.tombstones) {
      let tombChanged = false;

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
      if (tombChanged) {
        await saveLocalTombstones(mergedTomb);
      }

      // Delete any local count that has been tombstoned
      if (mergedTomb.counts && Object.keys(mergedTomb.counts).length > 0) {
        const activeSession = await getActiveSession();
        if (activeSession) {
          const localCounts = await countsForSession(activeSession.id);
          const db = await getDB();
          for (const c of localCounts) {
            const cid = canonicalCountId(c.id);
            const tombTs = mergedTomb.counts[cid];
            if (tombTs !== undefined && tombTs >= c.timestamp) {
              await db.delete('counts', c.id);
              hasNewChanges = true;
            }
          }
        }
      }

      // Delete any local movement that has been tombstoned
      if (mergedTomb.movements && Object.keys(mergedTomb.movements).length > 0) {
        const localMovs = await listMovements();
        const filteredMovs = localMovs.filter((m) => {
          const tombTs = mergedTomb.movements![m.id];
          return !(tombTs !== undefined && tombTs >= m.timestamp);
        });
        if (filteredMovs.length !== localMovs.length) {
          await saveAllMovements(filteredMovs);
          hasNewChanges = true;
        }
      }

      // Delete any local product that has been tombstoned
      if (mergedTomb.products && Object.keys(mergedTomb.products).length > 0) {
        const localProds = await allProducts();
        const db = await getDB();
        for (const p of localProds) {
          const tombTs = mergedTomb.products[p.barcode];
          if (tombTs !== undefined && tombTs >= (p.updatedAt || 0)) {
            await db.delete('products', p.barcode);
            hasNewChanges = true;
          }
        }
      }
    }

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

    // Si no hay sesión activa, NO creamos una sesión automáticamente (evita sesion fantasma)
    const session = await getActiveSession();
    if (session && incomingCounts.length > 0) {
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
        counts: incomingCounts,
        // Ya conciliado arriba: evita recorrer y serializar todo el catálogo por segunda vez
        products: [],
      };
      const mergeRes = await mergeCountFiles(session.id, [remoteFile]);
      if (mergeRes.added > 0 || (mergeRes.updated || 0) > 0 || mergeRes.productsAdded > 0) {
        hasNewChanges = true;
      }
    }

    if (incomingState.movements && Array.isArray(incomingState.movements)) {
      const localMovs = await listMovements();
      const movMap = new Map<string, Movement>();
      for (const m of localMovs) movMap.set(m.id, m);

      let movsModified = false;
      for (const m of incomingState.movements) {
        const prev = movMap.get(m.id);
        if (!prev) {
          movMap.set(m.id, m);
          movsModified = true;
          hasNewChanges = true;
        } else if (
          m.timestamp > (prev.timestamp || 0) ||
          (m.timestamp === (prev.timestamp || 0) &&
            (m.quantity !== prev.quantity || m.type !== prev.type || m.sku !== prev.sku))
        ) {
          movMap.set(m.id, m);
          movsModified = true;
          hasNewChanges = true;
        }
      }
      if (movsModified) {
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

let syncMutexTail: Promise<any> = Promise.resolve();

/**
 * Sincroniza bidireccionalmente (Push + Pull) la sesión local con la Sala en Línea.
 * Protegido contra reentrancia mediante un mutex en memoria para evitar colisiones concurrentes.
 */
export async function syncNow(opts?: {
  sessionId?: string;
  roomCode?: string;
  endpointUrl?: string;
}): Promise<SyncResult> {
  const previous = syncMutexTail;
  let release: () => void = () => {};
  syncMutexTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    await previous;
  } catch {
    // Continuar con la siguiente sincronización aunque la anterior haya fallado
  }

  try {
    return await doSyncNow(opts);
  } finally {
    release();
  }
}

async function doSyncNow(opts?: {
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

  // Si no hay sesión activa, no creamos automáticamente una sesión local.
  // Procedemos con la sincronización de catálogo, movimientos y niveles ideales.
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
  // Sincronizar el catálogo completo (hasta 5000 productos) para garantizar conciliación total entre dispositivos
  const includeFullCatalog =
    localProducts.length <= 5000 || !remoteState || (remoteState.products?.length ?? 0) === 0;
  let changedProducts: Product[];
  if (mobileReadOnly) {
    // En móvil el catálogo es de solo lectura: nunca sobrescribir ni borrar productos maestros en la BD.
    // Solo compartir artículos no catalogados escaneados en campo que aún no existan en la sala.
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

  // 2. Fusionar conteos locales + remotos incluyendo lápidas (tombstones) y estado de escáneres
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

  // Persistir tombstones consolidados
  if (mergedRoom.tombstones) {
    await saveLocalTombstones(mergedRoom.tombstones);
  }

  // 3. Conciliar catálogo en IndexedDB local (incluso sin sesión activa) e importar conteos a la sesión
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
      // Ya conciliado justo arriba: evita duplicar el cruce de catálogo en cada syncNow
      products: [],
    };
    const mergeRes = await mergeCountFiles(session.id, [remoteFile]);
    addedCounts = mergeRes.added;
    duplicateCounts = mergeRes.duplicates;
    if (mergeRes.productsAdded > productsAdded) {
      productsAdded = mergeRes.productsAdded;
    }
  }

  // Eliminar localmente registros que hayan sido eliminados mediante tombstones
  if (mergedRoom.tombstones) {
    if (session && mergedRoom.tombstones.counts && Object.keys(mergedRoom.tombstones.counts).length > 0) {
      const curCounts = await countsForSession(session.id);
      const db = await getDB();
      for (const c of curCounts) {
        const cid = canonicalCountId(c.id);
        const tombTs = mergedRoom.tombstones.counts[cid];
        if (tombTs !== undefined && tombTs >= c.timestamp) {
          await db.delete('counts', c.id);
        }
      }
    }
    if (mergedRoom.tombstones.movements && Object.keys(mergedRoom.tombstones.movements).length > 0) {
      const curMovs = await listMovements();
      const filtered = curMovs.filter((m) => {
        const tombTs = mergedRoom.tombstones!.movements![m.id];
        return !(tombTs !== undefined && tombTs >= m.timestamp);
      });
      if (filtered.length !== curMovs.length) {
        await saveAllMovements(filtered);
      }
    }
    if (mergedRoom.tombstones.products && Object.keys(mergedRoom.tombstones.products).length > 0) {
      const curProds = await allProducts();
      const db = await getDB();
      for (const p of curProds) {
        const tombTs = mergedRoom.tombstones.products[p.barcode];
        if (tombTs !== undefined && tombTs >= (p.updatedAt || 0)) {
          await db.delete('products', p.barcode);
        }
      }
    }
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

function resumeLivePolling(endpointUrl: string, roomCode: string): void {
  if (livePollTimer !== null || !endpointUrl || !roomCode) return;
  void pullRemoteRoomQuietly(endpointUrl, roomCode);
  if (typeof setInterval !== 'undefined') {
    livePollTimer = setInterval(() => {
      void pullRemoteRoomQuietly(endpointUrl, roomCode);
    }, currentPollMs);
  }
}

async function applyIncrementalRemoteCounts(counts: CountEntry[], roomCode: string): Promise<void> {
  if (!counts || counts.length === 0) return;
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
      counts,
      products: [],
    };
    await mergeCountFiles(session.id, [remoteFile]);
  }
}

async function applyRemoteCountDeletion(countId: string, timestamp = Date.now()): Promise<void> {
  const normId = canonicalCountId(countId);
  await recordTombstone('counts', normId, timestamp);
  const session = await getActiveSession();
  if (session) {
    const curCounts = await countsForSession(session.id);
    const db = await getDB();
    for (const c of curCounts) {
      if (canonicalCountId(c.id) === normId) {
        await db.delete('counts', c.id);
      }
    }
  }
}

async function applyIncrementalRemoteMovements(movements: Movement[]): Promise<void> {
  if (!movements || movements.length === 0) return;
  const localMovs = await listMovements();
  const movMap = new Map<string, Movement>();
  for (const m of localMovs) movMap.set(m.id, m);
  let changed = false;
  for (const m of movements) {
    if (!m || !m.id) continue;
    const prev = movMap.get(m.id);
    if (!prev || m.timestamp >= (prev.timestamp || 0)) {
      movMap.set(m.id, m);
      changed = true;
    }
  }
  if (changed) {
    await saveAllMovements([...movMap.values()]);
  }
}

async function applyRemoteMovementDeletion(movId: string, timestamp = Date.now()): Promise<void> {
  await recordTombstone('movements', movId, timestamp);
  const localMovs = await listMovements();
  const filtered = localMovs.filter((m) => m.id !== movId);
  if (filtered.length !== localMovs.length) {
    await saveAllMovements(filtered);
  }
}

function updateLocalMirrorQuickly(
  roomCode: string,
  delta: { counts?: CountEntry[]; movements?: Movement[]; deletedCountId?: string; deletedMovId?: string },
): void {
  const mirror = getLocalRoomMirror(roomCode);
  if (!mirror) return;

  let changed = false;
  let nextCounts = mirror.counts;
  let nextMovements = mirror.movements || [];

  if (delta.counts && delta.counts.length > 0) {
    const map = new Map(mirror.counts.map((c) => [canonicalCountId(c.id), c]));
    for (const c of delta.counts) {
      if (!c || !c.id) continue;
      map.set(canonicalCountId(c.id), c);
      changed = true;
    }
    nextCounts = [...map.values()];
  }

  if (delta.deletedCountId) {
    const norm = canonicalCountId(delta.deletedCountId);
    const filtered = nextCounts.filter((c) => canonicalCountId(c.id) !== norm);
    if (filtered.length !== nextCounts.length) {
      nextCounts = filtered;
      changed = true;
    }
  }

  if (delta.movements && delta.movements.length > 0) {
    const map = new Map((mirror.movements || []).map((m) => [m.id, m]));
    for (const m of delta.movements) {
      if (!m || !m.id) continue;
      map.set(m.id, m);
      changed = true;
    }
    nextMovements = [...map.values()];
  }

  if (delta.deletedMovId) {
    const filtered = nextMovements.filter((m) => m.id !== delta.deletedMovId);
    if (filtered.length !== nextMovements.length) {
      nextMovements = filtered;
      changed = true;
    }
  }

  if (changed) {
    const nextMirror: CloudRoomState = {
      ...mirror,
      counts: nextCounts,
      movements: nextMovements,
      updatedAt: Date.now(),
    };
    saveLocalRoomMirror(roomCode, nextMirror);
    notifyRoomListeners(nextMirror);
  }
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
      emitStatus({ liveStream: 'sse', state: 'connected', lastError: null });
    };

    es.addEventListener('open', onConnected);

    const handleSsePayload = (ev: MessageEvent) => {
      onConnected();
      try {
        const parsed = JSON.parse(ev.data);
        if (parsed && typeof parsed === 'object' && 'path' in parsed && parsed.path && parsed.path !== '/') {
          const pathStr = String(parsed.path);
          if (pathStr.startsWith('/counts/')) {
            const countId = pathStr.slice('/counts/'.length);
            if (parsed.data === null) {
              void applyRemoteCountDeletion(countId);
              updateLocalMirrorQuickly(roomCode, { deletedCountId: countId });
            } else if (parsed.data && typeof parsed.data === 'object') {
              void applyIncrementalRemoteCounts([parsed.data as CountEntry], roomCode);
              updateLocalMirrorQuickly(roomCode, { counts: [parsed.data as CountEntry] });
            }
            return;
          }
          if (pathStr.startsWith('/movements/')) {
            const movId = pathStr.slice('/movements/'.length);
            if (parsed.data === null) {
              void applyRemoteMovementDeletion(movId);
              updateLocalMirrorQuickly(roomCode, { deletedMovId: movId });
            } else if (parsed.data && typeof parsed.data === 'object') {
              void applyIncrementalRemoteMovements([parsed.data as Movement]);
              updateLocalMirrorQuickly(roomCode, { movements: [parsed.data as Movement] });
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

          if (pathStr.startsWith('/liveScanners')) {
            const mirror = getLocalRoomMirror(roomCode);
            if (mirror && parsed.data && typeof parsed.data === 'object') {
              let patchMap: Record<string, LiveScannerState> = {};
              if (pathStr === '/liveScanners') {
                patchMap = parsed.data as Record<string, LiveScannerState>;
              } else {
                const key = pathStr.slice('/liveScanners/'.length).split('/')[0];
                if (key) patchMap = { [key]: parsed.data as LiveScannerState };
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
              incoming.push(...toArray<CountEntry>(parsed.data));
            } else if (parsed.data && typeof parsed.data === 'object') {
              incoming.push(parsed.data as CountEntry);
            } else if (parsed.data === null && pathStr.startsWith('/counts/')) {
              const cid = pathStr.slice('/counts/'.length);
              void applyRemoteCountDeletion(cid);
              updateLocalMirrorQuickly(roomCode, { deletedCountId: cid });
              return;
            }
            if (incoming.length > 0) {
              void applyIncrementalRemoteCounts(incoming, roomCode);
              updateLocalMirrorQuickly(roomCode, { counts: incoming });
              return;
            }
          }

          if (pathStr === '/movements' || pathStr.startsWith('/movements/')) {
            const incoming: Movement[] = [];
            if (pathStr === '/movements' && parsed.data && typeof parsed.data === 'object') {
              incoming.push(...toArray<Movement>(parsed.data));
            } else if (parsed.data && typeof parsed.data === 'object') {
              incoming.push(parsed.data as Movement);
            } else if (parsed.data === null && pathStr.startsWith('/movements/')) {
              const mid = pathStr.slice('/movements/'.length);
              void applyRemoteMovementDeletion(mid);
              updateLocalMirrorQuickly(roomCode, { deletedMovId: mid });
              return;
            }
            if (incoming.length > 0) {
              void applyIncrementalRemoteMovements(incoming);
              updateLocalMirrorQuickly(roomCode, { movements: incoming });
              return;
            }
          }

          if (pathStr === '/updatedAt') {
            const mirror = getLocalRoomMirror(roomCode);
            if (mirror && typeof parsed.data === 'number') {
              mirror.updatedAt = parsed.data;
              saveLocalRoomMirror(roomCode, mirror);
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
  }
}

/**
 * Inicia la suscripción en tiempo real a la sala configurada (vía Firebase Server-Sent Events
 * con fallback inteligente a Polling cada 3 segundos solo cuando SSE no está disponible)
 * para que el supervisor y los técnicos vean los cambios al instante sin quemar cuota de peticiones.
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

  // 2. Polling de respaldo (solo si SSE no está conectado)
  resumeLivePolling(endpointUrl, roomCode);
}

export function stopLiveCloudSync(): void {
  isSseConnected = false;
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
    const lastSync = (await getMeta<number>(`lastSync_${roomCode}`)) || 0;
    if (lastSync > 0) {
      const remoteUpdatedAt = await fetchRemoteUpdatedAt(endpointUrl, roomCode);
      if (remoteUpdatedAt !== null && remoteUpdatedAt <= lastSync) {
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
 * En salas de Firebase utiliza deltas ultra-ligeros (~200 bytes) para máxima velocidad y eficiencia.
 */
export function triggerBackgroundSync(sessionId?: string): void {
  const s = settingsSync();
  if (!s.syncEnabled || !s.syncAuto || !s.syncRoomCode.trim()) return;
  if (autoSyncTimer) clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(async () => {
    try {
      const cleanRoom = normalizeRoomCode(s.syncRoomCode);
      const endpoint = normalizeEndpointBaseUrl(s.syncEndpointUrl || '');
      const isFirebase = /firebaseio\.com/i.test(endpoint) || /\.firebasedatabase\.app/i.test(endpoint);
      const lastSync = (await getMeta<number>(`lastSync_${cleanRoom}`)) || 0;

      if (isFirebase && lastSync > 0 && Date.now() - lastSync < 600000) {
        const deltaOk = await syncDeltaToRemote({
          sessionId,
          roomCode: cleanRoom,
          endpointUrl: endpoint,
          sinceTimestamp: lastSync - 3000,
        });
        if (deltaOk) return;
      }

      await syncNow({ sessionId });
    } catch {
      void setMeta('pendingCloudSyncRoom', s.syncRoomCode);
    }
  }, 350);
}

/**
 * Publica en tiempo real el estado actual del escáner de este dispositivo
 * (cámara activa, código escaneado pendiente de confirmar, ajuste de cantidad o registro)
 * hacia la sala compartida para que el supervisor lo vea al instante.
 */
export async function publishLiveScannerState(
  patch: Omit<LiveScannerState, 'counter' | 'deviceId' | 'updatedAt'> & { counter?: string },
): Promise<void> {
  const s = settingsSync();
  const cleanRoom = normalizeRoomCode(s.syncRoomCode);
  if (!cleanRoom) return;

  const counter = (patch.counter || s.counterName || 'Técnico').trim() || 'Técnico';
  const deviceId = await getDeviceId();
  const deviceKey = `${counter.replace(/[.#$/[\]\s]+/g, '_')}__${deviceId.slice(0, 8)}`;
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
  if (broadcastChannel) {
    try {
      broadcastChannel.postMessage(nextMirror);
    } catch {}
  }
  notifyRoomListeners(nextMirror);

  const endpointUrl = normalizeEndpointBaseUrl(s.syncEndpointUrl || '');
  if (!s.syncEnabled || !endpointUrl || typeof fetch === 'undefined') return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const roomUrl = buildRoomEndpointUrl(endpointUrl, cleanRoom);
  if (!roomUrl) return;

  const isFirebase = /firebaseio\.com/i.test(roomUrl) || /\.firebasedatabase\.app/i.test(roomUrl);
  if (isFirebase) {
    const baseRoomNoJson = roomUrl.replace(/\.json$/i, '');
    const scannerPatchUrl = `${baseRoomNoJson}/liveScanners.json`;
    try {
      await fetch(scannerPatchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ [deviceKey]: entry }),
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

/**
 * Sincroniza explícitamente el catálogo de productos con la Base de Datos en la nube / sala local,
 * funcionando incluso cuando no hay una sesión de conteo activa.
 * En móvil de solo lectura descarga e incorpora los cambios remotos sin sobrescribir la BD.
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
