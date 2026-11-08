import { getDeviceId, getMeta, setMeta, uid } from './db';

export const MOVEMENTS_META_KEY = 'movements_ledger_v1';
export const IDEAL_LEVELS_META_KEY = 'sku_ideal_levels_v1';

export type MovementType = 'IN' | 'OUT';

export interface Movement {
  id: string;
  sku: string;
  barcode?: string;
  type: MovementType;
  quantity: number;
  timestamp: number;
  technicianOrSupplier: string;
  machineOrArea: string;
  folio: string;
  notes?: string;
  cost?: number;
  deviceId?: string;
}

export type NewMovement = Omit<Movement, 'id' | 'timestamp'> & {
  id?: string;
  timestamp?: number;
};

export interface MovementFilter {
  sku?: string;
  type?: MovementType;
  technicianOrSupplier?: string;
  machineOrArea?: string;
  folio?: string;
  startDate?: number;
  endDate?: number;
  search?: string;
}

export interface MovementSummary {
  totalIn: number;
  totalOut: number;
  netMovements: number; // totalIn - totalOut
  movementCount: number;
  inCount: number;
  outCount: number;
  lastMovementTimestamp?: number;
}

// ----------------- CRUD & LEDGER -----------------

export async function getAllMovements(): Promise<Movement[]> {
  const ledger = await getMeta<Movement[]>(MOVEMENTS_META_KEY);
  return Array.isArray(ledger) ? ledger : [];
}

export async function saveAllMovements(movements: Movement[]): Promise<void> {
  await setMeta(MOVEMENTS_META_KEY, movements);
}

export async function recordMovement(data: NewMovement): Promise<Movement> {
  if (typeof data.quantity !== 'number' || isNaN(data.quantity) || data.quantity <= 0) {
    throw new Error('La cantidad del movimiento debe ser un número positivo mayor a 0');
  }
  const sku = (data.sku || '').trim().toUpperCase();
  if (!sku) {
    throw new Error('El movimiento requiere un SKU válido');
  }
  if (data.type !== 'IN' && data.type !== 'OUT') {
    throw new Error('El tipo de movimiento debe ser IN o OUT');
  }

  const deviceId = data.deviceId ?? (await getDeviceId());
  const movement: Movement = {
    id: data.id ?? uid(),
    sku,
    barcode: data.barcode?.trim() || undefined,
    type: data.type,
    quantity: Math.round(data.quantity * 1000) / 1000,
    timestamp: data.timestamp ?? Date.now(),
    technicianOrSupplier: (data.technicianOrSupplier || '').trim(),
    machineOrArea: (data.machineOrArea || '').trim(),
    folio: (data.folio || '').trim(),
    notes: data.notes?.trim() || undefined,
    cost: typeof data.cost === 'number' && !isNaN(data.cost) ? Math.round(data.cost * 1000) / 1000 : undefined,
    deviceId,
  };

  const current = await getAllMovements();
  current.push(movement);
  await saveAllMovements(current);
  return movement;
}

export async function recordEntry(params: {
  sku: string;
  quantity: number;
  supplier?: string;
  technicianOrSupplier?: string;
  machineOrArea?: string;
  folio?: string;
  notes?: string;
  barcode?: string;
  cost?: number;
  timestamp?: number;
}): Promise<Movement> {
  return recordMovement({
    sku: params.sku,
    barcode: params.barcode,
    type: 'IN',
    quantity: params.quantity,
    technicianOrSupplier: params.supplier ?? params.technicianOrSupplier ?? '',
    machineOrArea: params.machineOrArea ?? 'Almacén Central',
    folio: params.folio ?? '',
    notes: params.notes,
    cost: params.cost,
    timestamp: params.timestamp,
  });
}

export async function recordExit(params: {
  sku: string;
  quantity: number;
  technician?: string;
  technicianOrSupplier?: string;
  machineOrArea?: string;
  folio?: string;
  notes?: string;
  barcode?: string;
  cost?: number;
  timestamp?: number;
}): Promise<Movement> {
  return recordMovement({
    sku: params.sku,
    barcode: params.barcode,
    type: 'OUT',
    quantity: params.quantity,
    technicianOrSupplier: params.technician ?? params.technicianOrSupplier ?? '',
    machineOrArea: params.machineOrArea ?? 'Línea de Producción',
    folio: params.folio ?? '',
    notes: params.notes,
    cost: params.cost,
    timestamp: params.timestamp,
  });
}

export async function listMovements(filter?: MovementFilter): Promise<Movement[]> {
  const all = await getAllMovements();
  if (!filter) {
    return [...all].sort((a, b) => b.timestamp - a.timestamp);
  }

  const skuQuery = filter.sku?.trim().toUpperCase();
  const techQuery = filter.technicianOrSupplier?.trim().toLowerCase();
  const areaQuery = filter.machineOrArea?.trim().toLowerCase();
  const folioQuery = filter.folio?.trim().toLowerCase();
  const searchQuery = filter.search?.trim().toLowerCase();

  const filtered = all.filter((m) => {
    if (skuQuery && m.sku !== skuQuery) return false;
    if (filter.type && m.type !== filter.type) return false;
    if (techQuery && !m.technicianOrSupplier.toLowerCase().includes(techQuery)) return false;
    if (areaQuery && !m.machineOrArea.toLowerCase().includes(areaQuery)) return false;
    if (folioQuery && !m.folio.toLowerCase().includes(folioQuery)) return false;
    if (filter.startDate !== undefined && m.timestamp < filter.startDate) return false;
    if (filter.endDate !== undefined && m.timestamp > filter.endDate) return false;
    if (searchQuery) {
      const match =
        m.sku.toLowerCase().includes(searchQuery) ||
        (m.barcode && m.barcode.toLowerCase().includes(searchQuery)) ||
        m.technicianOrSupplier.toLowerCase().includes(searchQuery) ||
        m.machineOrArea.toLowerCase().includes(searchQuery) ||
        m.folio.toLowerCase().includes(searchQuery) ||
        (m.notes && m.notes.toLowerCase().includes(searchQuery));
      if (!match) return false;
    }
    return true;
  });

  return filtered.sort((a, b) => b.timestamp - a.timestamp);
}

export async function getMovement(id: string): Promise<Movement | undefined> {
  const all = await getAllMovements();
  return all.find((m) => m.id === id);
}

export async function deleteMovement(id: string): Promise<boolean> {
  const all = await getAllMovements();
  const idx = all.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  all.splice(idx, 1);
  await saveAllMovements(all);
  return true;
}

export async function clearMovements(): Promise<void> {
  await setMeta(MOVEMENTS_META_KEY, []);
}

export async function importMovements(
  incoming: Movement[],
  mode: 'append' | 'replace' = 'append',
): Promise<{ added: number; duplicates: number }> {
  if (mode === 'replace') {
    const valid = incoming.filter((m) => m.id && m.sku && typeof m.quantity === 'number' && m.quantity > 0);
    await saveAllMovements(valid);
    return { added: valid.length, duplicates: 0 };
  }

  const current = await getAllMovements();
  const map = new Map<string, Movement>(current.map((m) => [m.id, m]));
  let added = 0;
  let duplicates = 0;

  for (const m of incoming) {
    if (!m.id || !m.sku || typeof m.quantity !== 'number' || m.quantity <= 0) continue;
    if (map.has(m.id)) {
      duplicates++;
    } else {
      map.set(m.id, m);
      added++;
    }
  }

  await saveAllMovements([...map.values()]);
  return { added, duplicates };
}

// ----------------- SUMMARIES & AGGREGATIONS -----------------

export async function getMovementSummary(sku?: string): Promise<MovementSummary> {
  const all = await getAllMovements();
  const targetSku = sku?.trim().toUpperCase();

  let totalIn = 0;
  let totalOut = 0;
  let inCount = 0;
  let outCount = 0;
  let lastTimestamp: number | undefined;

  for (const m of all) {
    if (targetSku && m.sku !== targetSku) continue;
    if (m.type === 'IN') {
      totalIn += m.quantity;
      inCount++;
    } else {
      totalOut += m.quantity;
      outCount++;
    }
    if (!lastTimestamp || m.timestamp > lastTimestamp) {
      lastTimestamp = m.timestamp;
    }
  }

  totalIn = Math.round(totalIn * 1000) / 1000;
  totalOut = Math.round(totalOut * 1000) / 1000;
  const netMovements = Math.round((totalIn - totalOut) * 1000) / 1000;

  return {
    totalIn,
    totalOut,
    netMovements,
    movementCount: inCount + outCount,
    inCount,
    outCount,
    lastMovementTimestamp: lastTimestamp,
  };
}

export async function getMovementSummariesBySku(): Promise<Map<string, MovementSummary>> {
  const all = await getAllMovements();
  const map = new Map<string, MovementSummary>();

  for (const m of all) {
    let cur = map.get(m.sku);
    if (!cur) {
      cur = {
        totalIn: 0,
        totalOut: 0,
        netMovements: 0,
        movementCount: 0,
        inCount: 0,
        outCount: 0,
      };
      map.set(m.sku, cur);
    }
    if (m.type === 'IN') {
      cur.totalIn += m.quantity;
      cur.inCount++;
    } else {
      cur.totalOut += m.quantity;
      cur.outCount++;
    }
    cur.movementCount++;
    if (!cur.lastMovementTimestamp || m.timestamp > cur.lastMovementTimestamp) {
      cur.lastMovementTimestamp = m.timestamp;
    }
  }

  for (const cur of map.values()) {
    cur.totalIn = Math.round(cur.totalIn * 1000) / 1000;
    cur.totalOut = Math.round(cur.totalOut * 1000) / 1000;
    cur.netMovements = Math.round((cur.totalIn - cur.totalOut) * 1000) / 1000;
  }

  return map;
}

// ----------------- IDEAL INVENTORY STORAGE -----------------

export async function getIdealLevels(): Promise<Record<string, number>> {
  const data = await getMeta<Record<string, number>>(IDEAL_LEVELS_META_KEY);
  return data && typeof data === 'object' ? data : {};
}

export async function getIdealQtyForSku(sku: string): Promise<number | undefined> {
  const levels = await getIdealLevels();
  const val = levels[sku.trim().toUpperCase()];
  return typeof val === 'number' && !isNaN(val) ? val : undefined;
}

export async function setIdealLevel(sku: string, idealQty: number): Promise<void> {
  const cleanSku = sku.trim().toUpperCase();
  if (!cleanSku) throw new Error('SKU requerido');
  const levels = await getIdealLevels();
  if (idealQty < 0 || isNaN(idealQty)) {
    delete levels[cleanSku];
  } else {
    levels[cleanSku] = Math.round(idealQty * 1000) / 1000;
  }
  await setMeta(IDEAL_LEVELS_META_KEY, levels);
}

export async function setIdealLevels(levels: Record<string, number>): Promise<void> {
  const current = await getIdealLevels();
  for (const [k, v] of Object.entries(levels)) {
    const sku = k.trim().toUpperCase();
    if (!sku) continue;
    if (typeof v === 'number' && !isNaN(v) && v >= 0) {
      current[sku] = Math.round(v * 1000) / 1000;
    } else if (v < 0 || isNaN(v)) {
      delete current[sku];
    }
  }
  await setMeta(IDEAL_LEVELS_META_KEY, current);
}

export async function clearIdealLevels(): Promise<void> {
  await setMeta(IDEAL_LEVELS_META_KEY, {});
}
