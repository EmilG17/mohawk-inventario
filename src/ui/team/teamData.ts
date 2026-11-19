import {
  allProducts,
  allSessions,
  canonicalCountId,
  countsForSession,
  getActiveSession,
  getDeviceId,
  type CountEntry,
  type Product,
} from '../../db/db';
import {
  getIdealLevels,
  listMovements,
  summarizeMovementsBySku,
  type Movement,
} from '../../db/movements';
import { L } from '../../i18n/i18n';
import { normalizeBarcode } from '../../io/normalize';
import { buildReport } from '../../report';
import type { LiveScannerState } from '../../sync/cloudSync';
import { getCachedRoomState } from '../../sync/roomMirror';
import { fmtNum } from '../dom';
import type { TeamDashboardData, TechSummary } from './teamTypes';

export async function buildTeamDashboardData(opts: {
  syncRoomCode: string;
  supervisorUI: boolean;
}): Promise<TeamDashboardData> {
  const [sessions, current, deviceId, localProducts, localMovements, localIdealLevels] = await Promise.all([
    allSessions(),
    getActiveSession(),
    getDeviceId(),
    allProducts(),
    listMovements(),
    getIdealLevels(),
  ]);

  const roomState = opts.syncRoomCode ? getCachedRoomState(opts.syncRoomCode) : null;
  const localCounts = current ? await countsForSession(current.id) : [];

  // Fusionar productos locales + productos en la nube
  const prodTomb = roomState?.tombstones?.products || {};
  const prodMergedMap = new Map<string, Product>();
  for (const p of localProducts) {
    const tombTs = prodTomb[p.barcode];
    if (tombTs !== undefined && tombTs >= (p.updatedAt || 0)) continue;
    prodMergedMap.set(normalizeBarcode(p.barcode) || p.barcode, p);
  }
  for (const p of roomState?.products || []) {
    if (!p || !p.barcode) continue;
    const tombTs = prodTomb[p.barcode];
    if (tombTs !== undefined && tombTs >= (p.updatedAt || 0)) continue;
    const key = normalizeBarcode(p.barcode) || p.barcode;
    const prev = prodMergedMap.get(key);
    if (!prev || (p.updatedAt || 0) >= (prev.updatedAt || 0) || (prev.uncataloged && !p.uncataloged)) {
      prodMergedMap.set(key, p);
    }
  }
  const products = [...prodMergedMap.values()];

  // Fusionar conteos locales + conteos en vivo de la sala
  const countTomb = roomState?.tombstones?.counts || {};
  const countMergedMap = new Map<string, CountEntry>();
  for (const c of [...localCounts, ...(roomState?.counts || [])]) {
    if (!c || !c.id) continue;
    const cid = canonicalCountId(c.id);
    const tombTs = countTomb[cid];
    if (tombTs !== undefined && tombTs >= c.timestamp) continue;
    const prev = countMergedMap.get(cid);
    if (!prev || c.timestamp >= prev.timestamp) {
      countMergedMap.set(cid, c);
    }
  }
  const curCounts = [...countMergedMap.values()];

  // Fusionar movimientos locales + movimientos de la sala
  const movTomb = roomState?.tombstones?.movements || {};
  const movMergedMap = new Map<string, Movement>();
  for (const m of [...localMovements, ...(roomState?.movements || [])]) {
    if (!m || !m.id) continue;
    const tombTs = movTomb[m.id];
    if (tombTs !== undefined && tombTs >= m.timestamp) continue;
    const prev = movMergedMap.get(m.id);
    if (!prev || m.timestamp >= prev.timestamp) {
      movMergedMap.set(m.id, m);
    }
  }
  const movements = [...movMergedMap.values()];
  const idealLevels = { ...localIdealLevels, ...(roomState?.idealLevels || {}) };

  // Usar siempre los movimientos ya fusionados para evitar rezago de Kardex remoto en KPIs/matriz
  const movSummaries = summarizeMovementsBySku(movements);
  const reportLines = opts.supervisorUI
    ? buildReport(products, curCounts, {
        includeNotCounted: true,
        movementsBySku: movSummaries,
        idealLevels,
      })
    : [];

  const prodByBarcode = new Map<string, Product>();
  const prodBySku = new Map<string, Product>();
  for (const p of products) {
    prodByBarcode.set(p.barcode, p);
    const normKey = normalizeBarcode(p.barcode);
    if (normKey) prodByBarcode.set(normKey, p);
    if (p.sku) prodBySku.set(p.sku.toUpperCase(), p);
  }

  const now = Date.now();
  const activeLiveScanners: LiveScannerState[] = Object.values(roomState?.liveScanners || {})
    .filter((sc) => sc && typeof sc.updatedAt === 'number' && now - sc.updatedAt <= 15 * 60 * 1000)
    .sort((a, b) => {
      const rank = (st: LiveScannerState['status']) =>
        st === 'pending_confirm' ? 0 : st === 'scanning' ? 1 : st === 'registered' ? 2 : 3;
      const dr = rank(a.status) - rank(b.status);
      return dr !== 0 ? dr : b.updatedAt - a.updatedAt;
    });

  const techMap = new Map<string, TechSummary>();
  const connectedLabel = L('Conectado en sala', 'Connected to room');
  const getOrInitTech = (name: string): TechSummary => {
    const existing = techMap.get(name);
    if (existing) return existing;
    const created: TechSummary = {
      name,
      scans: 0,
      units: 0,
      movementsCount: 0,
      lastSeen: 0,
      lastActionLabel: connectedLabel,
      skusTouched: new Set<string>(),
    };
    techMap.set(name, created);
    return created;
  };

  const sortedCounts = [...curCounts].sort((a, b) => a.timestamp - b.timestamp);
  for (const c of sortedCounts) {
    const name = (c.counter || L('Técnico', 'Technician')).trim();
    const prod = prodByBarcode.get(c.barcode) || prodByBarcode.get(normalizeBarcode(c.barcode));
    const skuLabel = prod?.sku || c.barcode;
    const descLabel = prod?.description || c.barcode;
    const cur = getOrInitTech(name);
    cur.scans += 1;
    cur.units += c.qty;
    cur.skusTouched.add(skuLabel);
    if (c.timestamp >= cur.lastSeen) {
      cur.lastSeen = c.timestamp;
      cur.lastActionLabel = `${L('Contó', 'Counted')} ${c.qty >= 0 ? '+' : ''}${fmtNum(c.qty)} · ${skuLabel} (${descLabel})`;
    }
  }

  const sortedMovs = [...movements].sort((a, b) => a.timestamp - b.timestamp);
  for (const m of sortedMovs) {
    const name = (m.technicianOrSupplier || L('Almacén', 'Warehouse')).trim();
    const prod = prodBySku.get(m.sku.toUpperCase());
    const descLabel = prod?.description || m.sku;
    const cur = getOrInitTech(name);
    cur.movementsCount += 1;
    cur.skusTouched.add(m.sku.toUpperCase());
    if (m.timestamp >= cur.lastSeen) {
      cur.lastSeen = m.timestamp;
      const prefix = m.type === 'IN' ? L('Entrada +', 'In +') : L('Salida −', 'Out −');
      cur.lastActionLabel = `${prefix}${fmtNum(m.quantity)} · ${m.sku} (${descLabel})`;
    }
  }

  for (const p of Object.values(roomState?.participants || {})) {
    if (!p || !p.counter) continue;
    const cur = getOrInitTech(p.counter.trim());
    if (cur.scans === 0 && p.scans > 0) {
      cur.scans = p.scans;
      cur.units = p.units;
    }
    if (p.lastSku) cur.skusTouched.add(p.lastSku);
    if (p.lastSeen >= cur.lastSeen) {
      cur.lastSeen = p.lastSeen;
      if (cur.lastActionLabel === connectedLabel && p.lastSku) {
        cur.lastActionLabel = `${L('Contó', 'Counted')} ${p.lastQty ?? 1} · ${p.lastSku}${p.lastDescription ? ` (${p.lastDescription})` : ''}`;
      }
    }
  }

  for (const sc of activeLiveScanners) {
    const cur = getOrInitTech((sc.counter || L('Técnico', 'Technician')).trim());
    if (!cur.liveScanner || sc.updatedAt >= cur.liveScanner.updatedAt) {
      cur.liveScanner = sc;
    }
    if (sc.sku || sc.barcode) {
      cur.skusTouched.add(sc.sku || sc.barcode || '');
    }
    if (sc.updatedAt >= cur.lastSeen) {
      cur.lastSeen = sc.updatedAt;
      if (sc.status === 'pending_confirm' && (sc.sku || sc.barcode)) {
        cur.lastActionLabel = `${L('Confirmando', 'Confirming')} ${fmtNum(sc.qty ?? 1)} · ${sc.sku || sc.barcode}`;
      } else if (sc.status === 'scanning') {
        cur.lastActionLabel = L('Cámara encendida escaneando...', 'Camera active scanning...');
      }
    }
  }

  const techList = [...techMap.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  const activeNowCount = techList.filter((t) => now - t.lastSeen <= 5 * 60 * 1000).length;

  const totalCatalogSkus = products.length;
  const countedSkusCount = reportLines.filter((r) => r.scans > 0).length;
  const progressPct =
    totalCatalogSkus > 0 ? Math.min(100, Math.round((countedSkusCount / totalCatalogSkus) * 100)) : 0;
  const totalUnitsCounted = reportLines.reduce((acc, r) => acc + r.counted, 0);
  const totalInUnits = movements.filter((m) => m.type === 'IN').reduce((acc, m) => acc + m.quantity, 0);
  const totalOutUnits = movements.filter((m) => m.type === 'OUT').reduce((acc, m) => acc + m.quantity, 0);
  const criticalCount = reportLines.filter((r) => r.idealStatus === 'critical').length;
  const deficitCount = reportLines.filter((r) => r.idealStatus === 'deficit').length;
  const alertSkusCount = criticalCount + deficitCount;

  const hasLiveRoomData =
    curCounts.length > 0 ||
    movements.length > 0 ||
    activeLiveScanners.length > 0 ||
    Object.keys(roomState?.participants || {}).length > 0;

  return {
    sessions,
    current,
    deviceId,
    roomState,
    products,
    curCounts,
    movements,
    idealLevels,
    reportLines,
    prodByBarcode,
    prodBySku,
    activeLiveScanners,
    techList,
    activeNowCount,
    totalCatalogSkus,
    countedSkusCount,
    progressPct,
    totalUnitsCounted,
    totalInUnits,
    totalOutUnits,
    criticalCount,
    deficitCount,
    alertSkusCount,
    hasLiveRoomData,
  };
}
