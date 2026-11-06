import { allProducts } from '../db/db';
import { settingsSync } from '../settings';
import { isLookupable, resolveDescription } from './lookup';

let running = false;

/**
 * Reintenta la búsqueda en línea de los productos que quedaron sin descripción por falta de conexión.
 * Se ejecuta al abrir la app y cada vez que el teléfono recupera internet.
 * @returns cantidad de descripciones obtenidas
 */
export async function processPending(onUpdate?: (resolved: number) => void): Promise<number> {
  if (running || !settingsSync().onlineLookup) return 0;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0;
  running = true;
  let resolved = 0;
  try {
    const pending = (await allProducts()).filter(
      (p) => !p.description && !p.notFoundOnline && isLookupable(p.barcode),
    );
    for (const p of pending) {
      const r = await resolveDescription(p.barcode);
      if (r.status === 'encontrado') {
        resolved++;
        onUpdate?.(resolved);
      }
      if (r.status === 'sin_conexion') break; // seguimos sin red; se reintentará después
    }
  } finally {
    running = false;
  }
  return resolved;
}

export async function pendingCount(): Promise<number> {
  return (await allProducts()).filter((p) => !p.description).length;
}

export function startPendingWatcher(onUpdate: (resolved: number) => void): void {
  const run = () => processPending(onUpdate).catch(() => undefined);
  window.addEventListener('online', run);
  setTimeout(run, 3000);
}
