import type { CountEntry, Product } from '../db/db';
import type { Movement } from '../db/movements';
import { APP_ID } from '../io/exportResults';

export const ROOM_STORAGE_PREFIX = 'mohawk_cloud_room_v1_';
export const QR_PREFIX = 'MHKSYNC1|';
export const CHANNEL_NAME = 'inventario_cloud_sync_v1';

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
  idealLevels?: Record<string, number | null>;
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

export interface AvailableRoomInfo {
  roomCode: string;
  sessionName?: string;
  totalCounts?: number;
  updatedAt?: number;
}
