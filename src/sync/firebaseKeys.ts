import { canonicalCountId } from '../db/db';
import { QR_PREFIX } from './types';

export { canonicalCountId };

/**
 * Determina si una URL corresponde a Firebase Realtime Database verificando su host.
 */
export function isFirebaseEndpoint(rawUrl: string): boolean {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return false;
  try {
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const host = new URL(withProto).hostname.toLowerCase();
    return host.endsWith('firebaseio.com') || host.endsWith('.firebasedatabase.app');
  } catch {
    return /firebaseio\.com/i.test(trimmed) || /\.firebasedatabase\.app/i.test(trimmed);
  }
}

/**
 * Codifica de forma reversible cualquier clave arbitraria para que nunca contenga caracteres
 * prohibidos por Firebase RTDB (`.`, `#`, `$`, `[`, `]`, `/`). Claves alfanuméricas normales
 * (`cnt_1`, `75010002`, `SKU-1`) permanecen sin cambios.
 */
export function encodeFirebaseKey(key: string): string {
  return String(key || '')
    .replace(/~/g, '~0')
    .replace(/\//g, '~1')
    .replace(/\./g, '~2')
    .replace(/#/g, '~3')
    .replace(/\$/g, '~4')
    .replace(/\[/g, '~5')
    .replace(/\]/g, '~6');
}

export function decodeFirebaseKey(key: string): string {
  if (!key || !key.includes('~')) return String(key || '');
  return String(key)
    .replace(/~6/g, ']')
    .replace(/~5/g, '[')
    .replace(/~4/g, '$')
    .replace(/~3/g, '#')
    .replace(/~2/g, '.')
    .replace(/~1/g, '/')
    .replace(/~0/g, '~');
}

export function sanitizeParticipantKey(counter: string, deviceId: string): string {
  const cleanCounter =
    String(counter || 'Tecnico')
      .trim()
      .replace(/[.#$/[\]\s]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'Tecnico';
  const devShort = String(deviceId || 'local')
    .slice(0, 8)
    .replace(/[.#$/[\]\s]+/g, '_');
  return `${cleanCounter}__${devShort || 'local'}`;
}

export function normalizeRoomCode(code: string): string {
  const clean = (code || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '-')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return clean
    .replace(/^([A-Z]+)(\d+)$/, '$1-$2')
    .replace(/-0+(\d+)/g, '-$1')
    .replace(/-+/g, '-')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

export function generateRoomCode(prefix = 'MHK'): string {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${num}`;
}

/**
 * Convierte cualquier URL pegada por el usuario (incluso desde la consola web de Firebase
 * o sin https://) en una URL base limpia de Firebase Realtime DB o servidor REST.
 */
export function normalizeEndpointBaseUrl(rawUrl: string): string {
  let trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';

  // Link directo copiado desde la consola web de Firebase
  const consoleMatch = trimmed.match(/\/database\/([a-zA-Z0-9_-]+)\/data/i);
  if (consoleMatch && consoleMatch[1]) {
    return `https://${consoleMatch[1]}.firebaseio.com`;
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }

  if (isFirebaseEndpoint(trimmed)) {
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

  if (isFirebaseEndpoint(normalized)) {
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

/**
 * Detecta si una cadena escaneada o recibida es un enlace de invitación a sala.
 */
export function isRoomInviteUrl(raw: string): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (trimmed.startsWith(QR_PREFIX)) return false;
  return /(?:^|[?&])room=/i.test(trimmed);
}

function getSearchParamCaseInsensitive(params: URLSearchParams, targetKey: string): string | null {
  const exact = params.get(targetKey);
  if (exact !== null) return exact;
  const lowerTarget = targetKey.toLowerCase();
  for (const [k, v] of params.entries()) {
    if (k.toLowerCase() === lowerTarget) return v;
  }
  return null;
}

/**
 * Extrae los parámetros de sala, base de datos y rol de un enlace de invitación
 * tolerando nombres de parámetro en cualquier capitalización.
 */
export function parseRoomInviteUrl(raw: string): {
  roomCode?: string;
  endpointUrl?: string;
  role?: 'technician' | 'supervisor';
} | null {
  if (!isRoomInviteUrl(raw)) return null;
  try {
    const trimmed = raw.trim();
    const normalizedInput = /^[a-z]+:\/\//i.test(trimmed)
      ? trimmed
      : trimmed.startsWith('?')
        ? `https://app.local/${trimmed}`
        : `https://${trimmed}`;
    const url = new URL(normalizedInput);
    const room = getSearchParamCaseInsensitive(url.searchParams, 'room');
    const db =
      getSearchParamCaseInsensitive(url.searchParams, 'db') ||
      getSearchParamCaseInsensitive(url.searchParams, 'endpoint');
    const rawRole = getSearchParamCaseInsensitive(url.searchParams, 'role')?.toLowerCase();
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
    const matchRoom = raw.match(/(?:^|[?&])room=([^&#]+)/i);
    const matchDb = raw.match(/(?:^|[?&])(?:db|endpoint)=([^&#]+)/i);
    const matchRole = raw.match(/(?:^|[?&])role=(technician|supervisor|admin|tech|counter)/i);
    if (!matchRoom && !matchDb) return null;
    const r = matchRole ? matchRole[1].toLowerCase() : '';
    const role: 'technician' | 'supervisor' | undefined =
      r === 'supervisor' || r === 'admin' ? 'supervisor' : r ? 'technician' : undefined;
    let decodedRoom = matchRoom ? matchRoom[1] : '';
    let decodedDb = matchDb ? matchDb[1] : '';
    try {
      if (decodedRoom) decodedRoom = decodeURIComponent(decodedRoom);
    } catch {}
    try {
      if (decodedDb) decodedDb = decodeURIComponent(decodedDb);
    } catch {}
    return {
      roomCode: decodedRoom ? normalizeRoomCode(decodedRoom) : undefined,
      endpointUrl: decodedDb ? normalizeEndpointBaseUrl(decodedDb) : undefined,
      role,
    };
  }
}
