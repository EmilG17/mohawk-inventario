import { countsForSession, getSession, type CountEntry, type Product } from '../db/db';
import type { Movement } from '../db/movements';
import { APP_ID } from '../io/exportResults';
import { normalizeBarcode } from '../io/normalize';
import { loadSettings } from '../settings';
import {
  buildRoomEndpointUrl,
  canonicalCountId,
  decodeFirebaseKey,
  encodeFirebaseKey,
  generateRoomCode,
  isFirebaseEndpoint,
  normalizeEndpointBaseUrl,
  normalizeRoomCode,
} from './firebaseKeys';
import type {
  AvailableRoomInfo,
  CloudArchivedSessionDetail,
  CloudArchivedSessionSummary,
  CloudParticipant,
  CloudRoomState,
  LiveScannerState,
  RoomDeltaPayload,
} from './types';

export function toArray<T>(val: unknown): T[] {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter((x) => x != null) as T[];
  if (typeof val === 'object') {
    return Object.values(val as Record<string, T>).filter((x) => x != null);
  }
  return [];
}

function decodeKeyedDict<V>(raw: unknown): Record<string, V> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, V> = {};
  for (const [k, v] of Object.entries(raw as Record<string, V>)) {
    if (v === undefined || v === null) continue;
    out[decodeFirebaseKey(k)] = v;
  }
  return out;
}

function encodeKeyedDict<V>(raw: Record<string, V> | undefined): Record<string, V> {
  const out: Record<string, V> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!k || v === undefined || v === null) continue;
    out[encodeFirebaseKey(k)] = v;
  }
  return out;
}

export function getFetchTimeoutSignal(timeoutMs = 10000): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout === 'function') {
    return (AbortSignal as any).timeout(timeoutMs);
  }
  return undefined;
}

export function formatRemoteHttpError(status: number, roomCode: string): string {
  if (status === 401 || status === 403) {
    return `Permiso denegado en Firebase (HTTP ${status}). En tu consola de Firebase → Realtime Database → Reglas, habilita lectura y escritura: {"rules": {".read": true, ".write": true}}`;
  }
  if (status === 404) {
    return `URL de base de datos no encontrada (HTTP 404) para la sala ${roomCode}. Verifica el enlace de Firebase.`;
  }
  return `Error HTTP ${status} al conectar con la sala ${roomCode}.`;
}

/**
 * Normaliza la respuesta de Firebase Realtime Database (que omite arreglos vacíos `[]`,
 * convierte arreglos dispersos en objetos `{0: ..., 1: ...}` o usa mapas por UUID/código escapado).
 */
export function coerceRemoteRoomState(data: unknown, fallbackRoomCode: string): CloudRoomState | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

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
  const participants = decodeKeyedDict<CloudParticipant>(obj.participants);
  const liveScanners = decodeKeyedDict<LiveScannerState>(obj.liveScanners);
  const idealLevels = decodeKeyedDict<number>(obj.idealLevels);
  const supervisorPin =
    typeof obj.supervisorPin === 'string' && /^\d{4}$/.test(obj.supervisorPin.trim())
      ? obj.supervisorPin.trim()
      : undefined;
  const supervisorPinUpdatedAt =
    typeof obj.supervisorPinUpdatedAt === 'number' && Number.isFinite(obj.supervisorPinUpdatedAt)
      ? obj.supervisorPinUpdatedAt
      : undefined;

  let tombstones: CloudRoomState['tombstones'] = undefined;
  if (obj.tombstones && typeof obj.tombstones === 'object' && !Array.isArray(obj.tombstones)) {
    const rawTomb = obj.tombstones as Record<string, unknown>;
    tombstones = {
      counts: decodeKeyedDict<number>(rawTomb.counts),
      movements: decodeKeyedDict<number>(rawTomb.movements),
      products: decodeKeyedDict<number>(rawTomb.products),
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
    ...(supervisorPin ? { supervisorPin } : {}),
    ...(supervisorPinUpdatedAt ? { supervisorPinUpdatedAt } : {}),
  };
}

/**
 * Serializa el estado de sala para Firebase RTDB usando mapas por UUID/código codificado
 * (compatible 1:1 con multi-path PATCH y sin claves inválidas `. # $ [ ] /`).
 */
export function serializeRoomForRemote(endpointUrl: string, state: CloudRoomState): unknown {
  if (!isFirebaseEndpoint(endpointUrl)) {
    return state;
  }

  const countsMap: Record<string, CountEntry> = {};
  for (const c of state.counts || []) {
    if (!c || !c.id) continue;
    const cid = canonicalCountId(c.id);
    countsMap[encodeFirebaseKey(cid)] = { ...c, id: cid };
  }

  const movementsMap: Record<string, Movement> = {};
  for (const m of state.movements || []) {
    if (!m || !m.id) continue;
    movementsMap[encodeFirebaseKey(m.id)] = m;
  }

  const productsMap: Record<string, Product> = {};
  for (const p of state.products || []) {
    if (!p || !p.barcode) continue;
    productsMap[encodeFirebaseKey(p.barcode)] = p;
  }

  return {
    app: state.app,
    version: state.version,
    roomCode: state.roomCode,
    updatedAt: state.updatedAt,
    sessionName: state.sessionName,
    counts: countsMap,
    products: productsMap,
    participants: encodeKeyedDict(state.participants),
    liveScanners: encodeKeyedDict(state.liveScanners),
    movements: movementsMap,
    idealLevels: encodeKeyedDict(state.idealLevels),
    tombstones: state.tombstones
      ? {
          counts: encodeKeyedDict(state.tombstones.counts),
          movements: encodeKeyedDict(state.tombstones.movements),
          products: encodeKeyedDict(state.tombstones.products),
        }
      : {},
    ...(state.supervisorPin && /^\d{4}$/.test(state.supervisorPin)
      ? {
          supervisorPin: state.supervisorPin,
          ...(typeof state.supervisorPinUpdatedAt === 'number'
            ? { supervisorPinUpdatedAt: state.supervisorPinUpdatedAt }
            : {}),
        }
      : {}),
  };
}

export async function fetchRemoteRoom(endpointUrl: string, roomCode: string): Promise<CloudRoomState | null> {
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
  if (res.status === 404) {
    if (isFirebaseEndpoint(endpointUrl)) {
      throw new Error(formatRemoteHttpError(404, roomCode));
    }
    return null;
  }
  if (!res.ok) {
    throw new Error(formatRemoteHttpError(res.status, roomCode));
  }
  const data = await res.json();
  if (data === null) return null;
  return coerceRemoteRoomState(data, roomCode);
}

export async function putRemoteRoom(endpointUrl: string, roomCode: string, state: CloudRoomState): Promise<boolean> {
  const url = buildRoomEndpointUrl(endpointUrl, roomCode);
  if (!url || typeof fetch === 'undefined') return false;
  const payload = serializeRoomForRemote(endpointUrl, state);
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: getFetchTimeoutSignal(10000),
  });
  if (!res.ok) {
    throw new Error(formatRemoteHttpError(res.status, roomCode));
  }
  return true;
}

/**
 * Consulta de forma ultraligera el timestamp de actualización de la sala en Firebase.
 */
export async function fetchRemoteUpdatedAt(endpointUrl: string, roomCode: string): Promise<number | null> {
  const norm = normalizeEndpointBaseUrl(endpointUrl);
  if (!norm || typeof fetch === 'undefined' || !isFirebaseEndpoint(norm)) return null;
  const cleanRoom = encodeURIComponent(normalizeRoomCode(roomCode));
  if (!cleanRoom) return null;
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
 * escapando todas las claves de sub-ruta para evitar HTTP 400 o rutas anidadas accidentales.
 */
export async function patchRemoteRoomDelta(
  endpointUrl: string,
  roomCode: string,
  delta: RoomDeltaPayload,
): Promise<boolean> {
  const cleanRoom = encodeURIComponent(normalizeRoomCode(roomCode));
  const rawBase = normalizeEndpointBaseUrl(endpointUrl);
  if (!rawBase || !cleanRoom || typeof fetch === 'undefined' || !isFirebaseEndpoint(rawBase)) return false;

  const now = delta.updatedAt || Date.now();
  const patchPayload: Record<string, unknown> = {
    updatedAt: now,
  };

  if (delta.counts) {
    for (const [id, c] of Object.entries(delta.counts)) {
      const normKey = encodeFirebaseKey(canonicalCountId(id));
      if (!normKey) continue;
      patchPayload[`counts/${normKey}`] = c ? { ...c, id: canonicalCountId(c.id || id) } : null;
    }
  }

  if (delta.movements) {
    for (const [id, m] of Object.entries(delta.movements)) {
      const safeId = encodeFirebaseKey(id);
      if (safeId) patchPayload[`movements/${safeId}`] = m;
    }
  }

  if (delta.products) {
    for (const [barcode, p] of Object.entries(delta.products)) {
      const normBc = barcode.startsWith('SKU:') ? barcode : normalizeBarcode(barcode) || barcode;
      const safeBc = encodeFirebaseKey(normBc);
      if (safeBc) patchPayload[`products/${safeBc}`] = p;
    }
  }

  if (delta.idealLevels) {
    for (const [sku, qty] of Object.entries(delta.idealLevels)) {
      const cleanSku = sku.trim().toUpperCase();
      if (!cleanSku) continue;
      patchPayload[`idealLevels/${encodeFirebaseKey(cleanSku)}`] = qty;
    }
  }

  if (delta.supervisorPin && /^\d{4}$/.test(delta.supervisorPin)) {
    patchPayload['supervisorPin'] = delta.supervisorPin;
    if (typeof delta.supervisorPinUpdatedAt === 'number') {
      patchPayload['supervisorPinUpdatedAt'] = delta.supervisorPinUpdatedAt;
    }
  }

  if (delta.liveScanners) {
    for (const [key, scan] of Object.entries(delta.liveScanners)) {
      const safeKey = encodeFirebaseKey(key);
      if (safeKey) patchPayload[`liveScanners/${safeKey}`] = scan;
    }
  }

  if (delta.participants) {
    for (const [key, part] of Object.entries(delta.participants)) {
      const safeKey = encodeFirebaseKey(key);
      if (safeKey) patchPayload[`participants/${safeKey}`] = part;
    }
  }

  if (delta.tombstones?.counts) {
    for (const [id, ts] of Object.entries(delta.tombstones.counts)) {
      const normKey = encodeFirebaseKey(canonicalCountId(id));
      if (!normKey) continue;
      patchPayload[`tombstones/counts/${normKey}`] = ts;
      patchPayload[`counts/${normKey}`] = null;
    }
  }

  if (delta.tombstones?.movements) {
    for (const [id, ts] of Object.entries(delta.tombstones.movements)) {
      const safeId = encodeFirebaseKey(id);
      if (!safeId) continue;
      patchPayload[`tombstones/movements/${safeId}`] = ts;
      patchPayload[`movements/${safeId}`] = null;
    }
  }

  if (delta.tombstones?.products) {
    for (const [bc, ts] of Object.entries(delta.tombstones.products)) {
      const normBc = bc.startsWith('SKU:') ? bc : normalizeBarcode(bc) || bc;
      const safeBc = encodeFirebaseKey(normBc);
      if (!safeBc) continue;
      patchPayload[`tombstones/products/${safeBc}`] = ts;
      patchPayload[`products/${safeBc}`] = null;
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

export async function listAvailableRoomsInDb(endpointUrl: string): Promise<AvailableRoomInfo[]> {
  const normBase = normalizeEndpointBaseUrl(endpointUrl);
  if (!normBase || typeof fetch === 'undefined' || !isFirebaseEndpoint(normBase)) return [];

  const foundMap = new Map<string, AvailableRoomInfo>();

  const [shallowRes, indexRes] = await Promise.all([
    fetch(`${normBase}/rooms.json?shallow=true`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: getFetchTimeoutSignal(5000),
    }).catch(() => null),
    fetch(`${normBase}/rooms_index.json`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: getFetchTimeoutSignal(4000),
    }).catch(() => null),
  ]);

  if (shallowRes && shallowRes.ok) {
    try {
      const data = await shallowRes.json();
      if (data && typeof data === 'object') {
        for (const k of Object.keys(data)) {
          const norm = normalizeRoomCode(k);
          if (norm && !foundMap.has(norm)) {
            foundMap.set(norm, { roomCode: norm });
          }
        }
      }
    } catch {}
  }

  if (indexRes && indexRes.ok) {
    try {
      const indexData = await indexRes.json();
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
    } catch {}
  }

  return [...foundMap.values()];
}

export async function checkRoomExistsInDb(
  endpointUrl: string,
  roomCode: string,
): Promise<{ exists: boolean; roomCode: string; updatedAt?: number }> {
  const normBase = normalizeEndpointBaseUrl(endpointUrl);
  const code = normalizeRoomCode(roomCode);
  if (!normBase || !code || typeof fetch === 'undefined' || !isFirebaseEndpoint(normBase)) {
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

export async function generateUniqueRoomCode(endpointUrl?: string, prefix = 'MHK'): Promise<string> {
  const normBase = normalizeEndpointBaseUrl(endpointUrl || '');
  if (!normBase) {
    return generateRoomCode(prefix);
  }

  try {
    const existing = await listAvailableRoomsInDb(normBase);
    const set = new Set(existing.map((r) => r.roomCode));

    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefixRegex = new RegExp(`^${escapedPrefix}-(\\d+)$`, 'i');
    let maxSequential = 0;
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

export async function registerRoomInDbIndex(
  endpointUrl: string,
  roomCode: string,
  sessionName: string,
  totalCounts: number,
): Promise<boolean> {
  const normBase = normalizeEndpointBaseUrl(endpointUrl);
  const code = normalizeRoomCode(roomCode);
  const cleanRoom = encodeURIComponent(code);
  if (!normBase || !cleanRoom || typeof fetch === 'undefined' || !isFirebaseEndpoint(normBase)) return false;

  try {
    const url = `${normBase}/rooms_index/${cleanRoom}.json`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        roomCode: code,
        sessionName: sessionName || `Sala ${code}`,
        totalCounts,
        updatedAt: Date.now(),
      }),
      signal: getFetchTimeoutSignal(4000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Archiva una sesión completada en Firebase fuera de `/rooms/{sala}` para que
 * futuros `PUT /rooms/{sala}.json` no la borren ni descarguen archivos históricos pesados.
 */
export async function archiveSessionToCloud(
  sessionId: string,
  opts?: { roomCode?: string; endpointUrl?: string },
): Promise<boolean> {
  const s = await loadSettings();
  const roomCode = normalizeRoomCode(opts?.roomCode || s.syncRoomCode);
  const endpointUrl = normalizeEndpointBaseUrl(opts?.endpointUrl || s.syncEndpointUrl);
  if (!roomCode || !endpointUrl || typeof fetch === 'undefined' || !isFirebaseEndpoint(endpointUrl)) return false;

  const session = await getSession(sessionId);
  if (!session) return false;

  const counts = await countsForSession(sessionId);
  const totalUnits = counts.reduce((acc, c) => acc + (c.qty || 0), 0);
  const closedAt = session.closedAt ?? Date.now();

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

  const cleanRoom = encodeURIComponent(roomCode);
  const cleanSessionId = encodeURIComponent(encodeFirebaseKey(session.id));

  try {
    const detailUrl = `${endpointUrl}/rooms_archives/${cleanRoom}/sessions_archive/${cleanSessionId}.json`;
    const resDetail = await fetch(detailUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(detail),
      signal: getFetchTimeoutSignal(10000),
    });
    if (!resDetail.ok) return false;

    const summaryUrl = `${endpointUrl}/rooms_archives/${cleanRoom}/history_summaries/${cleanSessionId}.json`;
    const resSummary = await fetch(summaryUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(summary),
      signal: getFetchTimeoutSignal(6000),
    });

    return resSummary.ok;
  } catch (err) {
    console.warn('[cloudSync] Error al archivar sesión en Firebase:', err);
    return false;
  }
}

export async function listCloudArchivedSessions(opts?: {
  roomCode?: string;
  endpointUrl?: string;
}): Promise<CloudArchivedSessionSummary[]> {
  const s = await loadSettings();
  const roomCode = normalizeRoomCode(opts?.roomCode || s.syncRoomCode);
  const endpointUrl = normalizeEndpointBaseUrl(opts?.endpointUrl || s.syncEndpointUrl);
  if (!roomCode || !endpointUrl || typeof fetch === 'undefined' || !isFirebaseEndpoint(endpointUrl)) return [];

  const cleanRoom = encodeURIComponent(roomCode);
  const url = `${endpointUrl}/rooms_archives/${cleanRoom}/history_summaries.json`;

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
    return Object.values(data as Record<string, CloudArchivedSessionSummary>)
      .filter((x) => x && typeof x === 'object' && typeof x.id === 'string')
      .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  } catch {
    return [];
  }
}

export async function fetchCloudArchivedSession(
  sessionId: string,
  opts?: { roomCode?: string; endpointUrl?: string },
): Promise<CloudArchivedSessionDetail | null> {
  const s = await loadSettings();
  const roomCode = normalizeRoomCode(opts?.roomCode || s.syncRoomCode);
  const endpointUrl = normalizeEndpointBaseUrl(opts?.endpointUrl || s.syncEndpointUrl);
  if (!roomCode || !endpointUrl || !sessionId || typeof fetch === 'undefined' || !isFirebaseEndpoint(endpointUrl)) {
    return null;
  }

  const cleanRoom = encodeURIComponent(roomCode);
  const cleanSessionId = encodeURIComponent(encodeFirebaseKey(sessionId));
  const url = `${endpointUrl}/rooms_archives/${cleanRoom}/sessions_archive/${cleanSessionId}.json`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: getFetchTimeoutSignal(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data !== 'object' || typeof data.id !== 'string') return null;
    return {
      ...(data as CloudArchivedSessionDetail),
      counts: toArray<CountEntry>(data.counts),
    };
  } catch {
    return null;
  }
}

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
