import type { CloudRoomState } from '../sync/cloudSync';

/**
 * Firma ligera de datos de negocio (conteos, productos, movimientos e ideales),
 * excluyendo telemetría efímera de cámara/escáner (`liveScanners`).
 */
export function computeRoomDataSig(state?: CloudRoomState | null): string {
  if (!state) return '';
  const counts = Array.isArray(state.counts) ? state.counts : [];
  const products = Array.isArray(state.products) ? state.products : [];
  const movements = Array.isArray(state.movements) ? state.movements : [];
  const ideals = state.idealLevels && typeof state.idealLevels === 'object' ? state.idealLevels : {};
  const tombs = state.tombstones || {};

  const lastCountTs = counts.length ? counts[counts.length - 1]?.timestamp ?? 0 : 0;
  const countQtySum = counts.reduce((s, c) => s + (c?.qty || 0), 0);
  const lastProdTs = products.reduce((m, p) => Math.max(m, p?.updatedAt || 0), 0);
  const lastMovTs = movements.length ? movements[movements.length - 1]?.timestamp ?? 0 : 0;
  const movQtySum = movements.reduce((s, m) => s + (m?.quantity || 0), 0);
  const idealKeyCount = Object.keys(ideals).length;
  const tombCount =
    Object.keys(tombs.counts || {}).length +
    Object.keys(tombs.movements || {}).length +
    Object.keys(tombs.products || {}).length;

  return `${state.sessionName || ''}|${counts.length}:${lastCountTs}:${countQtySum}|${products.length}:${lastProdTs}|${movements.length}:${lastMovTs}:${movQtySum}|${idealKeyCount}|${tombCount}`;
}
