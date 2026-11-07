import { getMeta, setMeta } from './db/db';

export interface Settings {
  counterName: string;
  /** Buscar descripción en internet cuando el código no está en el catálogo */
  onlineLookup: boolean;
  /** URL del proxy para UPCitemdb ('' = desactivado) */
  proxyUrl: string;
  beep: boolean;
  vibrate: boolean;
  /** true: cada escaneo suma 1 sin pedir cantidad (modo rápido) */
  quickMode: boolean;
  /** Mostrar la existencia teórica en la pantalla de conteo (por defecto no: conteo "ciego") */
  showExpected: boolean;
  currency: string;
  /** Sincronización en línea en tiempo real habilitada */
  syncEnabled: boolean;
  /** Código de sala compartida entre técnicos y supervisor (ej. MHK-2026) */
  syncRoomCode: string;
  /** URL del servidor de sincronización opcional (Firebase Realtime DB, REST, Webhook) */
  syncEndpointUrl: string;
  /** Sincronizar automáticamente cada escaneo en segundo plano */
  syncAuto: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  counterName: '',
  onlineLookup: true,
  proxyUrl: 'api/upc',
  beep: true,
  vibrate: true,
  quickMode: false,
  showExpected: false,
  currency: 'MXN',
  syncEnabled: false,
  syncRoomCode: '',
  syncEndpointUrl: '',
  syncAuto: true,
};

let cache: Settings | null = null;

export async function loadSettings(): Promise<Settings> {
  if (!cache) cache = { ...DEFAULT_SETTINGS, ...((await getMeta<Partial<Settings>>('settings')) ?? {}) };
  return cache;
}

export function settingsSync(): Settings {
  return cache ?? DEFAULT_SETTINGS;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  cache = { ...(await loadSettings()), ...patch };
  await setMeta('settings', cache);
  return cache;
}

/** Solo para pruebas */
export function _resetSettings(): void {
  cache = null;
}
