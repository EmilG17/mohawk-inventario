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

  const lastCountTs = counts.reduce((m, c) => Math.max(m, c?.timestamp || 0), 0);
  const countQtySum = counts.reduce((s, c) => s + (c?.qty || 0), 0);
  const lastProdTs = products.reduce((m, p) => Math.max(m, p?.updatedAt || 0), 0);
  const lastMovTs = movements.reduce((m, mv) => Math.max(m, mv?.timestamp || 0), 0);
  let movInSum = 0;
  let movOutSum = 0;
  for (const mv of movements) {
    if (!mv) continue;
    if (mv.type === 'IN') movInSum += mv.quantity || 0;
    else if (mv.type === 'OUT') movOutSum += mv.quantity || 0;
  }
  const idealSig = Object.entries(ideals)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  const tombCount =
    Object.keys(tombs.counts || {}).length +
    Object.keys(tombs.movements || {}).length +
    Object.keys(tombs.products || {}).length;

  return `${state.sessionName || ''}|${counts.length}:${lastCountTs}:${countQtySum}|${products.length}:${lastProdTs}|${movements.length}:${lastMovTs}:${movInSum}:${movOutSum}|${idealSig}|${tombCount}`;
}
