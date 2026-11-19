import type { CountEntry } from '../db/db';
import type { Movement } from '../db/movements';
import { settingsSync } from '../settings';
import { canonicalCountId, normalizeRoomCode } from './firebaseKeys';
import { coerceRemoteRoomState } from './firebaseTransport';
import {
  CHANNEL_NAME,
  ROOM_STORAGE_PREFIX,
  type CloudConnectionStatus,
  type CloudRoomState,
  type LiveScannerState,
} from './types';

export const memoryRooms = new Map<string, CloudRoomState>();
export const syncListeners = new Set<(state: CloudRoomState) => void>();
export const statusListeners = new Set<(status: CloudConnectionStatus) => void>();

export interface BroadcastMessagePayload {
  kind?: 'roomState' | 'liveScanner';
  roomCode?: string;
  deviceKey?: string;
  entry?: LiveScannerState;
}

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

export function emitStatus(patch: Partial<CloudConnectionStatus>): void {
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

export function onCloudRoomUpdate(listener: (state: CloudRoomState) => void): () => void {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}

export function notifyRoomListeners(state: CloudRoomState): void {
  for (const fn of [...syncListeners]) {
    if (!syncListeners.has(fn)) continue;
    try {
      fn(state);
    } catch {}
  }
}

export function structuredCloneState(state: CloudRoomState): CloudRoomState {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(state);
    } catch {}
  }
  return JSON.parse(JSON.stringify(state)) as CloudRoomState;
}

export function getLocalRoomMirror(roomCode: string): CloudRoomState | null {
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

export function saveLocalRoomMirror(roomCode: string, state: CloudRoomState): void {
  const norm = normalizeRoomCode(roomCode);
  if (!norm) return;
  const copy = structuredCloneState(state);
  memoryRooms.set(norm, copy);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(ROOM_STORAGE_PREFIX + norm, JSON.stringify(copy));
    } catch {
      // Si el catálogo es muy grande y excede la cuota de 5MB de localStorage,
      // persistir una instantánea ligera sin productos (que ya viven en IndexedDB).
      try {
        const slim: CloudRoomState = { ...copy, products: [] };
        localStorage.setItem(ROOM_STORAGE_PREFIX + norm, JSON.stringify(slim));
      } catch {}
    }
  }
}

export function clearLocalStorageRoomMirrors(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(ROOM_STORAGE_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {}
}

export function getCachedRoomState(roomCode?: string): CloudRoomState | null {
  const code = normalizeRoomCode(roomCode || settingsSync().syncRoomCode);
  if (!code) return null;
  return getLocalRoomMirror(code);
}

export function updateLocalMirrorQuickly(
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

let broadcastChannel: BroadcastChannel | null = null;
let broadcastIncomingHandler: ((msg: unknown) => void) | null = null;

if (typeof BroadcastChannel !== 'undefined') {
  try {
    broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
    broadcastChannel.onmessage = (ev) => {
      broadcastIncomingHandler?.(ev.data);
    };
  } catch {
    broadcastChannel = null;
  }
}

export function hasBroadcastChannel(): boolean {
  return broadcastChannel !== null;
}

export function postBroadcastMessage(payload: unknown): void {
  if (!broadcastChannel) return;
  try {
    broadcastChannel.postMessage(payload);
  } catch {}
}

export function setBroadcastIncomingHandler(handler: (msg: unknown) => void): void {
  broadcastIncomingHandler = handler;
}
