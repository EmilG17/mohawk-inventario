import {
  allProducts,
  countsForSession,
  findBySku,
  getActiveSession,
  getProduct,
  type CountEntry,
  type Product,
} from '../db/db';
import {
  deleteMovement,
  getIdealLevels,
  getMovementSummariesBySku,
  listMovements,
  recordMovement,
  setIdealLevel,
  type Movement,
  type MovementFilter,
  type MovementSummary,
  type MovementType,
} from '../db/movements';
import { displayBarcode, normalizeBarcode } from '../io/normalize';
import { computeIdealStatus, type IdealStatus } from '../report';
import {
  beep,
  cameraAvailable,
  createDebouncer,
  startScanner,
  unlockAudio,
  vibrate,
  type ScannerHandle,
} from '../scanner/scanner';
import { createWedgeController, type WedgeController } from '../scanner/wedge';
import {
  clear,
  confirmDialog,
  fmtDateTime,
  fmtNum,
  h,
  icon,
  openDialog,
  toast,
} from './dom';
import { onCloudRoomUpdate, triggerBackgroundSync } from '../sync/cloudSync';
import type { View } from './router';

export type MovementStatus = IdealStatus;

export interface ComparativeRow {
  sku: string;
  barcode: string;
  description: string;
  unit: string;
  currentStock: number;
  totalIn: number;
  totalOut: number;
  dynamicStock: number;
  idealQty: number;
  idealGap: number;
  status: MovementStatus;
  minQty?: number;
  maxQty?: number;
}

export type TableFilter = 'todos' | 'deficit_critical' | 'optimal' | 'excess' | 'with_movements';
export type DateRangeFilter = 'all' | 'today' | '7days' | 'month';

// State shared within view instance
let activeSubTab: 'comparative' | 'bitacora' = 'comparative';
let tableFilter: TableFilter = 'todos';
let tableSearchQuery = '';

let bitacoraType: 'ALL' | 'IN' | 'OUT' = 'ALL';
let bitacoraDateRange: DateRangeFilter = 'all';
let bitacoraTech = '';
let bitacoraArea = '';
let bitacoraSearch = '';

let viewRootEl: HTMLElement | null = null;
let activeModalDialog: HTMLDialogElement | null = null;
let activeModalScanner: ScannerHandle | null = null;
let wedgeController: WedgeController | null = null;
let unsubscribeCloud: (() => void) | null = null;
let isModalOpening = false;

/**
 * Resuelve un producto en el catálogo por código de barras o SKU
 */
export async function findProductByCode(code: string): Promise<Product | undefined> {
  const clean = code.trim();
  if (!clean) return undefined;

  // 1. Búsqueda directa por código de barras
  let p = await getProduct(clean);
  if (p) return p;

  // 2. Búsqueda por código normalizado (GTIN / UPC)
  const norm = normalizeBarcode(clean);
  if (norm) {
    p = await getProduct(norm);
    if (p) return p;
  }

  // 3. Búsqueda por SKU exacto (mayúsculas)
  p = await findBySku(clean.toUpperCase());
  if (p) return p;
  p = await findBySku(clean);
  if (p) return p;

  // 4. Búsqueda secuencial en catálogo por si el SKU difiere en mayúsculas/minúsculas
  const all = await allProducts();
  const upper = clean.toUpperCase();
  const disp = displayBarcode(clean);
  return all.find(
    (item) =>
      item.sku.toUpperCase() === upper ||
      item.barcode === clean ||
      item.barcode === norm ||
      (disp && item.barcode === disp) ||
      (norm && normalizeBarcode(item.barcode) === norm),
  );
}

/**
 * Vista de Entradas / Salidas (Kardex) y Conciliación con Inventario Ideal
 */
export const movementsView: View = {
  title: 'Entradas / Salidas e Inventario Ideal',

  async render(root: HTMLElement, params: URLSearchParams): Promise<void> {
    viewRootEl = root;

    if (params.get('tab') === 'bitacora') {
      activeSubTab = 'bitacora';
    } else if (params.get('tab') === 'comparative') {
      activeSubTab = 'comparative';
    }
    if (params.get('filter') === 'deficit_critical') {
      tableFilter = 'deficit_critical';
    }

    await renderMainView();
    if (!viewRootEl) return;
    setupKeyboardWedge();
    setupSimulationHook();

    if (unsubscribeCloud) unsubscribeCloud();
    unsubscribeCloud = onCloudRoomUpdate(() => {
      if (viewRootEl && (!activeModalDialog || !activeModalDialog.open)) {
        void renderMainView();
      }
    });
  },

  async destroy(): Promise<void> {
    isModalOpening = false;
    if (unsubscribeCloud) {
      unsubscribeCloud();
      unsubscribeCloud = null;
    }
    if (wedgeController) {
      wedgeController.detach();
      wedgeController = null;
    }
    if (activeModalScanner) {
      try {
        activeModalScanner.stop();
      } catch {
        /* ignore */
      }
      activeModalScanner = null;
    }
    if (activeModalDialog && activeModalDialog.open) {
      try {
        activeModalDialog.close();
      } catch {
        /* ignore */
      }
      activeModalDialog = null;
    }
    viewRootEl = null;
    delete (window as any).__simulateMovementScan;
  },
};

/**
 * Configura la captura de escáner USB tipo keyboard wedge
 */
function setupKeyboardWedge() {
  if (wedgeController) {
    wedgeController.detach();
  }
  wedgeController = createWedgeController({
    minLength: 3,
    maxIntervalMs: 80,
    allowInputIds: ['m-sku-input'],
    onScan: (code, target) => {
      void handleWedgeScan(code, target);
    },
  });
  wedgeController.attach();
}

/**
 * Maneja una lectura recibida desde teclado USB o simulación
 */
async function handleWedgeScan(code: string, target?: HTMLElement | null) {
  beep('ok');
  vibrate('ok');

  if (activeModalDialog && activeModalDialog.open) {
    const skuInput = activeModalDialog.querySelector('#m-sku-input') as HTMLInputElement | null;
    // Proteger escritura manual previa si #m-sku-input ya contiene un valor completo mayor que la ráfaga
    const existing = skuInput?.value.trim() ?? '';
    const useExisting = target?.id === 'm-sku-input' && existing.length > code.length && existing.endsWith(code);
    const resolvedCode = useExisting ? existing : code;
    if (skuInput && !useExisting) {
      skuInput.value = resolvedCode;
      skuInput.dispatchEvent(new Event('input', { bubbles: true }));
      skuInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (typeof (activeModalDialog as any).__resolveSku === 'function') {
      void (activeModalDialog as any).__resolveSku(resolvedCode);
    }
    return;
  }

  await openMovementRegistrationModal(code, 'IN', async () => {
    await renderMainView();
  });
}

/**
 * Expone gancho para pruebas unitarias y E2E
 */
function setupSimulationHook() {
  (window as any).__simulateMovementScan = async (code: string) => {
    await handleWedgeScan(code);
  };
}

/**
 * Renderiza la vista principal con KPIs, selector de sub-pestaña y el contenido activo
 */
async function renderMainView(): Promise<void> {
  if (!viewRootEl) return;

  const [products, session, summariesMap, idealLevels, movements] = await Promise.all([
    allProducts(),
    getActiveSession(),
    getMovementSummariesBySku(),
    getIdealLevels(),
    listMovements(),
  ]);
  if (!viewRootEl) return;

  const counts: CountEntry[] = session ? await countsForSession(session.id) : [];
  if (!viewRootEl) return;

  // Mapear conteos físicos actuales por SKU y código de barras
  const countQtyBySku = new Map<string, number>();
  const countQtyByBarcode = new Map<string, number>();
  for (const c of counts) {
    countQtyByBarcode.set(c.barcode, (countQtyByBarcode.get(c.barcode) ?? 0) + c.qty);
  }

  // Mapa de productos por barcode y por sku
  const productBySku = new Map<string, Product>();
  for (const p of products) {
    if (p.sku) {
      productBySku.set(p.sku.toUpperCase(), p);
    }
    const cQty = countQtyByBarcode.get(p.barcode) ?? 0;
    if (p.sku && cQty > 0) {
      const upperSku = p.sku.toUpperCase();
      countQtyBySku.set(upperSku, (countQtyBySku.get(upperSku) ?? 0) + cQty);
    }
  }

  // Recopilar todos los SKUs (Catálogo + Movimientos)
  const allSkusSet = new Set<string>();
  for (const p of products) {
    if (p.sku) allSkusSet.add(p.sku.toUpperCase());
  }
  for (const [sku] of summariesMap.entries()) {
    if (sku) allSkusSet.add(sku.toUpperCase());
  }

  // Construir filas comparativas
  const rows: ComparativeRow[] = [];
  let totalEntriesQty = 0;
  let totalExitsQty = 0;

  for (const m of movements) {
    if (m.type === 'IN') {
      totalEntriesQty += m.quantity;
    } else {
      totalExitsQty += m.quantity;
    }
  }
  totalEntriesQty = Math.round(totalEntriesQty * 1000) / 1000;
  totalExitsQty = Math.round(totalExitsQty * 1000) / 1000;
  const netMovementsBalance = Math.round((totalEntriesQty - totalExitsQty) * 1000) / 1000;

  let deficitOrCriticalCount = 0;

  for (const sku of allSkusSet) {
    const p = productBySku.get(sku);
    const summary = summariesMap.get(sku) ?? {
      totalIn: 0,
      totalOut: 0,
      netMovements: 0,
      movementCount: 0,
      inCount: 0,
      outCount: 0,
    };

    // Stock actual: conteo físico si existe sesión, o existencia teórica esperada del catálogo, o 0
    let currentStock = 0;
    if (session && countQtyBySku.has(sku)) {
      currentStock = countQtyBySku.get(sku)!;
    } else if (p && typeof p.expectedQty === 'number') {
      currentStock = p.expectedQty;
    }

    const totalIn = summary.totalIn;
    const totalOut = summary.totalOut;
    const dynamicStock = Math.round((currentStock + totalIn - totalOut) * 1000) / 1000;

    // Nivel ideal configurado o fallback al producto
    const configuredIdeal = idealLevels[sku];
    const idealQty =
      configuredIdeal !== undefined
        ? configuredIdeal
        : typeof (p as any)?.idealQty === 'number'
        ? (p as any).idealQty
        : typeof p?.maxQty === 'number'
        ? p.maxQty
        : typeof p?.expectedQty === 'number'
        ? p.expectedQty
        : 0;

    const idealGap = Math.round((dynamicStock - idealQty) * 1000) / 1000;
    const status = computeIdealStatus({
      currentStock: dynamicStock,
      idealQty,
      minQty: p?.minQty,
      maxQty: p?.maxQty,
    });

    if (status === 'deficit' || status === 'critical') {
      deficitOrCriticalCount++;
    }

    rows.push({
      sku,
      barcode: p?.barcode || '',
      description: p?.description || (p?.uncataloged ? 'Producto no catalogado' : 'Sin descripción'),
      unit: p?.unit || 'PZA',
      currentStock,
      totalIn,
      totalOut,
      dynamicStock,
      idealQty,
      idealGap,
      status,
      minQty: p?.minQty,
      maxQty: p?.maxQty,
    });
  }

  // Ordenar filas alfabéticamente por SKU
  rows.sort((a, b) => a.sku.localeCompare(b.sku));

  // 1. KPIs en Vivo
  const kpiSection = h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', null, 'Control de Movimientos y Existencia Ideal'),
      h('button', {
        class: 'btn primary sm',
        'data-testid': 'movements-register-btn',
        onclick: async () => {
          await openMovementRegistrationModal(undefined, 'IN', async () => {
            await renderMainView();
          });
        },
      }, icon('swap'), 'Registrar Movimiento'),
    ),
    h('div', { class: 'kpis kpis-4' },
      h('div', { class: 'kpi good', id: 'kpi-card-in' },
        h('div', { class: 'kpi-v', id: 'kpi-in' }, `+${fmtNum(totalEntriesQty)}`),
        h('div', { class: 'kpi-l' }, 'Total Entradas'),
      ),
      h('div', { class: 'kpi warn', id: 'kpi-card-out' },
        h('div', { class: 'kpi-v', id: 'kpi-out' }, `−${fmtNum(totalExitsQty)}`),
        h('div', { class: 'kpi-l' }, 'Total Salidas'),
      ),
      h('div', { class: 'kpi', id: 'kpi-card-net' },
        h('div', {
          class: 'kpi-v',
          id: 'kpi-net',
          style: netMovementsBalance >= 0 ? 'color: var(--success);' : 'color: var(--danger);',
        }, `${netMovementsBalance >= 0 ? '+' : ''}${fmtNum(netMovementsBalance)}`),
        h('div', { class: 'kpi-l' }, 'Balance Neto'),
      ),
      h('div', {
        class: 'kpi bad',
        id: 'kpi-card-deficit',
        style: 'cursor: pointer;',
        title: 'Click para ver SKUs en déficit o críticos',
        onclick: () => {
          activeSubTab = 'comparative';
          tableFilter = 'deficit_critical';
          void renderMainView();
        },
      },
      h('div', { class: 'kpi-v', id: 'kpi-deficit' }, `${deficitOrCriticalCount} SKUs`),
      h('div', { class: 'kpi-l' }, 'En Déficit / Críticos'),
      ),
    ),
  );

  // 2. Selector de Sub-Pestaña
  const subNav = h('div', { class: 'chips', style: 'margin: 12px 0;' },
    h('button', {
      class: `chip ${activeSubTab === 'comparative' ? 'active' : ''}`,
      onclick: () => {
        activeSubTab = 'comparative';
        void renderMainView();
      },
    }, '📊 Conciliación e Ideal'),
    h('button', {
      class: `chip ${activeSubTab === 'bitacora' ? 'active' : ''}`,
      onclick: () => {
        activeSubTab = 'bitacora';
        void renderMainView();
      },
    }, `📜 Bitácora de Consumo (${movements.length})`),
  );

  // 3. Contenedor Activo
  const contentSection =
    activeSubTab === 'comparative'
      ? renderComparativeSection(rows)
      : renderBitacoraSection(movements, productBySku);

  if (!viewRootEl) return;
  clear(viewRootEl, kpiSection, subNav, contentSection);
}

/**
 * Renderiza la sección de Conciliación e Inventario Ideal (Tabla Comparativa)
 */
function renderComparativeSection(rows: ComparativeRow[]): HTMLElement {
  const container = h('section', { class: 'card' });

  // Contadores para chips
  const deficitCount = rows.filter((r) => r.status === 'deficit' || r.status === 'critical').length;
  const optimalCount = rows.filter((r) => r.status === 'optimal').length;
  const excessCount = rows.filter((r) => r.status === 'excess').length;
  const withMovementsCount = rows.filter((r) => r.totalIn > 0 || r.totalOut > 0).length;

  // Barra de Búsqueda y Filtros
  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Buscar por SKU o descripción...',
    value: tableSearchQuery,
    oninput: (e: Event) => {
      tableSearchQuery = (e.target as HTMLInputElement).value;
      updateTableRows();
    },
  }) as HTMLInputElement;

  const chipsContainer = h('div', { class: 'chips', style: 'padding-top: 8px;' },
    h('button', {
      class: `chip ${tableFilter === 'todos' ? 'active' : ''}`,
      onclick: () => { tableFilter = 'todos'; updateChips(); updateTableRows(); },
    }, `Todos (${rows.length})`),
    h('button', {
      class: `chip ${tableFilter === 'deficit_critical' ? 'active' : ''}`,
      onclick: () => { tableFilter = 'deficit_critical'; updateChips(); updateTableRows(); },
    }, `⚠️ Déficit / Críticos (${deficitCount})`),
    h('button', {
      class: `chip ${tableFilter === 'optimal' ? 'active' : ''}`,
      onclick: () => { tableFilter = 'optimal'; updateChips(); updateTableRows(); },
    }, `✅ Óptimos (${optimalCount})`),
    h('button', {
      class: `chip ${tableFilter === 'excess' ? 'active' : ''}`,
      onclick: () => { tableFilter = 'excess'; updateChips(); updateTableRows(); },
    }, `🔷 Exceso (${excessCount})`),
    h('button', {
      class: `chip ${tableFilter === 'with_movements' ? 'active' : ''}`,
      onclick: () => { tableFilter = 'with_movements'; updateChips(); updateTableRows(); },
    }, `🔄 Con Movimientos (${withMovementsCount})`),
  );

  const updateChips = () => {
    const buttons = chipsContainer.querySelectorAll('.chip');
    const filters: TableFilter[] = ['todos', 'deficit_critical', 'optimal', 'excess', 'with_movements'];
    buttons.forEach((btn, idx) => {
      if (filters[idx] === tableFilter) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  };

  const tableBody = h('tbody');
  const tableWrap = h('div', { class: 'table-wrap' },
    h('table', { class: 'comp-table' },
      h('thead', null,
        h('tr', null,
          h('th', null, 'SKU / Código'),
          h('th', null, 'Descripción'),
          h('th', { style: 'text-align: right;' }, 'Stock Físico'),
          h('th', { style: 'text-align: right;' }, 'Entradas (+)'),
          h('th', { style: 'text-align: right;' }, 'Salidas (−)'),
          h('th', { style: 'text-align: right;' }, 'Stock Dinámico'),
          h('th', { style: 'text-align: right;' }, 'Inventario Ideal'),
          h('th', { style: 'text-align: right;' }, 'Brecha / Gap'),
          h('th', { style: 'text-align: center;' }, 'Estado'),
          h('th', { style: 'text-align: center;' }, 'Acciones'),
        ),
      ),
      tableBody,
    ),
  );

  const emptyMsg = h('p', { class: 'muted center', style: 'padding: 20px 0; display: none;' }, 'No se encontraron productos coincidentes.');

  const updateTableRows = () => {
    clear(tableBody);
    const q = tableSearchQuery.trim().toLowerCase();

    const filtered = rows.filter((r) => {
      if (q) {
        const match =
          r.sku.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q) ||
          r.barcode.toLowerCase().includes(q);
        if (!match) return false;
      }

      if (tableFilter === 'deficit_critical') {
        return r.status === 'deficit' || r.status === 'critical';
      }
      if (tableFilter === 'optimal') {
        return r.status === 'optimal';
      }
      if (tableFilter === 'excess') {
        return r.status === 'excess';
      }
      if (tableFilter === 'with_movements') {
        return r.totalIn > 0 || r.totalOut > 0;
      }
      return true;
    });

    if (filtered.length === 0) {
      emptyMsg.style.display = 'block';
    } else {
      emptyMsg.style.display = 'none';
      for (const row of filtered) {
        tableBody.appendChild(createComparativeRow(row));
      }
    }
  };

  updateTableRows();

  clear(container,
    h('div', { style: 'margin-bottom: 10px;' },
      searchInput,
      chipsContainer,
    ),
    tableWrap,
    emptyMsg,
  );

  return container;
}

/**
 * Crea una fila HTML de la tabla comparativa con edición inline de inventario ideal
 */
function createComparativeRow(row: ComparativeRow): HTMLTableRowElement {
  const tr = h('tr', { 'data-sku': row.sku });

  // SKU cell
  const skuCell = h('td', null,
    h('b', null, row.sku),
    row.barcode ? h('div', { class: 'muted small' }, displayBarcode(row.barcode)) : null,
  );

  // Descripción cell
  const descCell = h('td', { style: 'max-width: 220px; white-space: normal;' },
    h('div', { style: 'font-weight: 500;' }, row.description),
    h('span', { class: 'badge sm' }, row.unit),
  );

  // Stock Físico cell
  const physCell = h('td', { style: 'text-align: right;' }, fmtNum(row.currentStock));

  // Entradas cell
  const inCell = h('td', {
    style: 'text-align: right; color: var(--success); font-weight: 600;',
  }, row.totalIn > 0 ? `+${fmtNum(row.totalIn)}` : '0');

  // Salidas cell
  const outCell = h('td', {
    style: 'text-align: right; color: var(--danger); font-weight: 600;',
  }, row.totalOut > 0 ? `−${fmtNum(row.totalOut)}` : '0');

  // Stock Dinámico cell
  const dynCell = h('td', {
    style: 'text-align: right; font-weight: 800; font-size: 13px;',
  }, fmtNum(row.dynamicStock));

  // Inventario Ideal (Input Inline)
  const idealInput = h('input', {
    class: 'inline-ideal',
    type: 'number',
    min: '0',
    step: 'any',
    value: String(row.idealQty),
    'data-sku': row.sku,
  }) as HTMLInputElement;

  // Brecha y Estado cells
  const gapCell = h('td', { style: 'text-align: right; font-weight: 700;' });
  const statusCell = h('td', { style: 'text-align: center;' });

  const renderGapAndStatus = () => {
    // Brecha
    gapCell.textContent = `${row.idealGap >= 0 ? '+' : ''}${fmtNum(row.idealGap)}`;
    if (row.idealGap < 0) {
      gapCell.style.color = 'var(--danger)';
    } else {
      gapCell.style.color = 'var(--success)';
    }

    // Badge
    let badgeCls = 'badge ok';
    let label = 'Óptimo';
    if (row.status === 'deficit') {
      badgeCls = 'badge warn';
      label = 'Déficit';
    } else if (row.status === 'critical') {
      badgeCls = 'badge error';
      label = 'Crítico';
    } else if (row.status === 'excess') {
      badgeCls = 'badge info';
      label = 'Exceso';
    }
    clear(statusCell, h('span', { class: badgeCls }, label));
  };

  renderGapAndStatus();

  // Persistencia instantánea de Inventario Ideal al cambiar/desenfocar
  let lastSavedVal = row.idealQty;
  const onIdealChange = async () => {
    const rawVal = idealInput.value.trim();
    const parsed = parseFloat(rawVal);
    const newQty = isNaN(parsed) || parsed < 0 ? 0 : Math.round(parsed * 1000) / 1000;

    if (newQty === lastSavedVal) return;
    lastSavedVal = newQty;

    await setIdealLevel(row.sku, newQty);
    triggerBackgroundSync();
    row.idealQty = newQty;
    row.idealGap = Math.round((row.dynamicStock - newQty) * 1000) / 1000;
    row.status = computeIdealStatus({
      currentStock: row.dynamicStock,
      idealQty: newQty,
      minQty: row.minQty,
      maxQty: row.maxQty,
    });

    renderGapAndStatus();
    toast(`Inventario ideal de ${row.sku} actualizado a ${newQty}`, 'ok', 1400);

    // Actualizar live KPI card si está en DOM
    updateLiveDeficitKpi();
  };

  idealInput.addEventListener('change', () => void onIdealChange());
  idealInput.addEventListener('blur', () => void onIdealChange());

  const idealCell = h('td', { style: 'text-align: right;' }, idealInput);

  // Acciones: + Entrada y - Salida rápidos
  const actionsCell = h('td', { style: 'text-align: center; white-space: nowrap;' },
    h('button', {
      class: 'btn sm good',
      style: 'padding: 4px 8px; margin-right: 4px; font-weight: 700;',
      title: `Registrar entrada de ${row.sku}`,
      onclick: async () => {
        await openMovementRegistrationModal(row.sku, 'IN', async () => {
          await renderMainView();
        });
      },
    }, '+'),
    h('button', {
      class: 'btn sm warn',
      style: 'padding: 4px 8px; font-weight: 700;',
      title: `Registrar salida de ${row.sku}`,
      onclick: async () => {
        await openMovementRegistrationModal(row.sku, 'OUT', async () => {
          await renderMainView();
        });
      },
    }, '−'),
  );

  appendChildren(tr, [
    skuCell,
    descCell,
    physCell,
    inCell,
    outCell,
    dynCell,
    idealCell,
    gapCell,
    statusCell,
    actionsCell,
  ]);

  return tr;
}

/**
 * Actualiza el contador del KPI de déficit en vivo si cambió el inventario ideal
 */
function updateLiveDeficitKpi() {
  const table = viewRootEl?.querySelector('.comp-table');
  if (!table) return;
  const badges = table.querySelectorAll('tbody tr td:nth-child(9) .badge');
  let count = 0;
  badges.forEach((b) => {
    if (b.classList.contains('warn') || b.classList.contains('error')) {
      count++;
    }
  });
  const deficitEl = viewRootEl?.querySelector('#kpi-deficit');
  if (deficitEl) {
    deficitEl.textContent = `${count} SKUs`;
  }
}

/**
 * Renderiza la Bitácora de Consumo y Ledger de Movimientos
 */
function renderBitacoraSection(
  movements: Movement[],
  productBySku: Map<string, Product>,
): HTMLElement {
  const container = h('section', { class: 'card' });

  // Filtros
  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Buscar en bitácora (SKU, folio, notas, técnico)...',
    value: bitacoraSearch,
    oninput: (e: Event) => {
      bitacoraSearch = (e.target as HTMLInputElement).value;
      renderMovementList();
    },
  });

  const techInput = h('input', {
    class: 'input sm',
    placeholder: 'Filtrar por técnico/proveedor...',
    value: bitacoraTech,
    oninput: (e: Event) => {
      bitacoraTech = (e.target as HTMLInputElement).value;
      renderMovementList();
    },
  });

  const areaInput = h('input', {
    class: 'input sm',
    placeholder: 'Filtrar por máquina/área...',
    value: bitacoraArea,
    oninput: (e: Event) => {
      bitacoraArea = (e.target as HTMLInputElement).value;
      renderMovementList();
    },
  });

  const typeChips = h('div', { class: 'chips' },
    h('button', {
      class: `chip ${bitacoraType === 'ALL' ? 'active' : ''}`,
      onclick: () => { bitacoraType = 'ALL'; updateTypeChips(); renderMovementList(); },
    }, 'Todos los tipos'),
    h('button', {
      class: `chip ${bitacoraType === 'IN' ? 'active' : ''}`,
      onclick: () => { bitacoraType = 'IN'; updateTypeChips(); renderMovementList(); },
    }, '⬇️ Solo Entradas (IN)'),
    h('button', {
      class: `chip ${bitacoraType === 'OUT' ? 'active' : ''}`,
      onclick: () => { bitacoraType = 'OUT'; updateTypeChips(); renderMovementList(); },
    }, '⬆️ Solo Salidas (OUT)'),
  );

  const dateChips = h('div', { class: 'chips' },
    h('button', {
      class: `chip ${bitacoraDateRange === 'all' ? 'active' : ''}`,
      onclick: () => { bitacoraDateRange = 'all'; updateDateChips(); renderMovementList(); },
    }, 'Todo el historial'),
    h('button', {
      class: `chip ${bitacoraDateRange === 'today' ? 'active' : ''}`,
      onclick: () => { bitacoraDateRange = 'today'; updateDateChips(); renderMovementList(); },
    }, 'Hoy'),
    h('button', {
      class: `chip ${bitacoraDateRange === '7days' ? 'active' : ''}`,
      onclick: () => { bitacoraDateRange = '7days'; updateDateChips(); renderMovementList(); },
    }, 'Últimos 7 días'),
    h('button', {
      class: `chip ${bitacoraDateRange === 'month' ? 'active' : ''}`,
      onclick: () => { bitacoraDateRange = 'month'; updateDateChips(); renderMovementList(); },
    }, 'Este mes'),
  );

  const updateTypeChips = () => {
    const btns = typeChips.querySelectorAll('.chip');
    btns[0].className = `chip ${bitacoraType === 'ALL' ? 'active' : ''}`;
    btns[1].className = `chip ${bitacoraType === 'IN' ? 'active' : ''}`;
    btns[2].className = `chip ${bitacoraType === 'OUT' ? 'active' : ''}`;
  };

  const updateDateChips = () => {
    const btns = dateChips.querySelectorAll('.chip');
    btns[0].className = `chip ${bitacoraDateRange === 'all' ? 'active' : ''}`;
    btns[1].className = `chip ${bitacoraDateRange === 'today' ? 'active' : ''}`;
    btns[2].className = `chip ${bitacoraDateRange === '7days' ? 'active' : ''}`;
    btns[3].className = `chip ${bitacoraDateRange === 'month' ? 'active' : ''}`;
  };

  const listContainer = h('div', { class: 'movement-list', style: 'margin-top: 14px;' });

  const renderMovementList = () => {
    clear(listContainer);

    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

    const q = bitacoraSearch.trim().toLowerCase();
    const tQ = bitacoraTech.trim().toLowerCase();
    const aQ = bitacoraArea.trim().toLowerCase();

    const filtered = movements.filter((m) => {
      // Filtro tipo
      if (bitacoraType !== 'ALL' && m.type !== bitacoraType) return false;

      // Filtro fecha
      if (bitacoraDateRange === 'today' && m.timestamp < todayStart) return false;
      if (bitacoraDateRange === '7days' && m.timestamp < sevenDaysAgo) return false;
      if (bitacoraDateRange === 'month' && m.timestamp < thirtyDaysAgo) return false;

      // Filtro técnico / área
      if (tQ && !m.technicianOrSupplier.toLowerCase().includes(tQ)) return false;
      if (aQ && !m.machineOrArea.toLowerCase().includes(aQ)) return false;

      // Búsqueda general
      if (q) {
        const prod = productBySku.get(m.sku.toUpperCase());
        const desc = prod ? prod.description.toLowerCase() : '';
        const match =
          m.sku.toLowerCase().includes(q) ||
          (m.folio && m.folio.toLowerCase().includes(q)) ||
          (m.notes && m.notes.toLowerCase().includes(q)) ||
          m.technicianOrSupplier.toLowerCase().includes(q) ||
          m.machineOrArea.toLowerCase().includes(q) ||
          desc.includes(q);
        if (!match) return false;
      }

      return true;
    });

    if (filtered.length === 0) {
      listContainer.appendChild(
        h('div', { class: 'empty' }, 'No hay movimientos que coincidan con los filtros seleccionados.'),
      );
      return;
    }

    for (const m of filtered) {
      const prod = productBySku.get(m.sku.toUpperCase());
      const isEntry = m.type === 'IN';

      const itemCard = h('div', { class: `m-item ${isEntry ? 'in' : 'out'}` },
        h('div', { class: 'm-head' },
          h('div', { style: 'display: flex; align-items: center; gap: 8px;' },
            h('span', { class: `badge ${isEntry ? 'ok' : 'warn'}` }, isEntry ? '⬇️ ENTRADA' : '⬆️ SALIDA'),
            h('span', { class: `m-qty ${isEntry ? 'in' : 'out'}` },
              `${isEntry ? '+' : '−'}${fmtNum(m.quantity)} ${prod?.unit || 'PZA'}`,
            ),
          ),
          h('div', { class: 'muted small' }, fmtDateTime(m.timestamp)),
        ),
        h('div', { class: 'm-body' },
          h('div', { class: 'm-desc' },
            h('span', { style: 'font-weight: 800; margin-right: 6px;' }, m.sku),
            prod?.description || 'Producto',
          ),
          h('div', { class: 'm-meta' },
            m.technicianOrSupplier
              ? h('span', null, h('b', null, isEntry ? 'Proveedor: ' : 'Técnico: '), m.technicianOrSupplier)
              : null,
            m.machineOrArea
              ? h('span', null, h('b', null, 'Área/Máq: '), m.machineOrArea)
              : null,
            m.folio ? h('span', null, h('b', null, 'Folio: '), m.folio) : null,
          ),
          m.notes
            ? h('div', { class: 'small muted', style: 'margin-top: 4px; font-style: italic;' },
              `Notas: ${m.notes}`,
            )
            : null,
        ),
        h('div', { style: 'display: flex; justify-content: flex-end; margin-top: 8px;' },
          h('button', {
            class: 'btn sm danger ghost',
            onclick: async () => {
              const ok = await confirmDialog(
                'Eliminar movimiento',
                `¿Deseas revertir y eliminar este movimiento de ${isEntry ? 'Entrada' : 'Salida'} (${m.quantity} ${m.sku})?`,
                'Eliminar',
                true,
              );
              if (ok) {
                await deleteMovement(m.id);
                triggerBackgroundSync();
                toast('Movimiento eliminado correctamente', 'ok');
                await renderMainView();
              }
            },
          }, icon('trash'), 'Eliminar'),
        ),
      );

      listContainer.appendChild(itemCard);
    }
  };

  renderMovementList();

  clear(container,
    h('div', { class: 'card-head' },
      h('h3', null, 'Bitácora de Consumo y Trazabilidad'),
    ),
    h('div', { style: 'display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px;' },
      searchInput,
      h('div', { style: 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px;' },
        techInput,
        areaInput,
      ),
      typeChips,
      dateChips,
    ),
    listContainer,
  );

  return container;
}

/**
 * Modal de Registro Rápido de Movimientos (Entrada / Salida) con soporte para Cámara y Escáner USB
 */
export async function openMovementRegistrationModal(
  prefillSku?: string,
  defaultType: MovementType = 'IN',
  onSaved?: () => Promise<void>,
): Promise<HTMLDialogElement | void> {
  if (isModalOpening || (activeModalDialog && activeModalDialog.open)) {
    return;
  }
  isModalOpening = true;
  try {
    unlockAudio();

    let movementType: MovementType = defaultType;
    let detectedProduct: Product | undefined;
    let initialStock = 0;
    let dynamicStock = 0;
    let idealStock = 0;
    let cameraRunning = false;

    const [products, session, summaries, idealLevels] = await Promise.all([
      allProducts(),
      getActiveSession(),
      getMovementSummariesBySku(),
      getIdealLevels(),
    ]);

    const counts: CountEntry[] = session ? await countsForSession(session.id) : [];

    // Diálogo modal
    const dlg = h('dialog', { class: 'dlg' }) as HTMLDialogElement;
    activeModalDialog = dlg;

    // 1. Selector de Tipo (Entrada / Salida)
    const entryBtn = h('button', {
      class: `segmented-btn ${movementType === 'IN' ? 'active in' : ''}`,
      type: 'button',
      'data-testid': 'movement-type-in',
      onclick: () => {
        movementType = 'IN';
        updateSegmentedStyles();
      },
    }, '⬇️ Entrada (IN)');

    const exitBtn = h('button', {
      class: `segmented-btn ${movementType === 'OUT' ? 'active out' : ''}`,
      type: 'button',
      'data-testid': 'movement-type-out',
      onclick: () => {
        movementType = 'OUT';
        updateSegmentedStyles();
      },
    }, '⬆️ Salida (OUT)');

    const segmentedSwitch = h('div', { class: 'segmented-switch' }, entryBtn, exitBtn);

    const actorLabelSpan = h('span', null, movementType === 'IN' ? 'Proveedor / Origen' : 'Técnico / Solicitante');

    const updateSegmentedStyles = () => {
      if (movementType === 'IN') {
        entryBtn.className = 'segmented-btn active in';
        exitBtn.className = 'segmented-btn';
        actorLabelSpan.textContent = 'Proveedor / Origen';
        if (!areaInput.value || areaInput.value === 'Línea de Producción') {
          areaInput.value = 'Almacén Central';
        }
      } else {
        entryBtn.className = 'segmented-btn';
        exitBtn.className = 'segmented-btn active out';
        actorLabelSpan.textContent = 'Técnico / Solicitante';
        if (!areaInput.value || areaInput.value === 'Almacén Central') {
          areaInput.value = 'Línea de Producción';
        }
      }
    };

    // 2. Campo de Código / SKU y botón de escáner
    const skuInput = h('input', {
      id: 'm-sku-input',
      'data-testid': 'movements-sku-input',
      class: 'input',
      placeholder: 'Código de barras o SKU (ej. MHK-001)...',
      autocomplete: 'off',
    }) as HTMLInputElement;

  const camToggleBtn = h('button', {
    class: 'btn ghost sm',
    type: 'button',
    title: 'Escanear con cámara',
    onclick: () => void toggleCamera(),
  }, icon('camera'), 'Cámara');

  const skuField = h('div', { style: 'margin-bottom: 10px;' },
    h('label', { class: 'field' },
      h('span', null, 'Código de barras o SKU *'),
      h('div', { style: 'display: flex; gap: 6px;' },
        skuInput,
        cameraAvailable() ? camToggleBtn : null,
      ),
    ),
  );

  // Cámara Drawer
  const camVideo = h('video', { playsinline: true, muted: true, autoplay: true }) as HTMLVideoElement;
  const torchBtn = h('button', {
    class: 'btn sm ghost',
    type: 'button',
    style: 'display: none; background: rgba(0,0,0,0.6); color: #fff;',
    onclick: async () => {
      if (activeModalScanner) {
        torchState = !torchState;
        await activeModalScanner.setTorch(torchState);
      }
    },
  }, icon('torch'), 'Linterna');

  let torchState = false;
  const camBox = h('div', { class: 'cam-box', style: 'display: none;' },
    camVideo,
    h('div', { class: 'cam-controls' }, torchBtn),
  );

  const stopCameraStream = () => {
    if (activeModalScanner) {
      try {
        activeModalScanner.stop();
      } catch {
        /* ignore */
      }
      activeModalScanner = null;
    }
    cameraRunning = false;
    camBox.style.display = 'none';
    camToggleBtn.replaceChildren(icon('camera'), 'Cámara');
    torchBtn.style.display = 'none';
    torchState = false;
  };

  const toggleCamera = async () => {
    if (cameraRunning) {
      stopCameraStream();
      return;
    }
    camBox.style.display = 'flex';
    camToggleBtn.replaceChildren(icon('stop'), 'Detener');
    cameraRunning = true;

    try {
      const debouncer = createDebouncer(1500);
      const scanner = await startScanner(camVideo, (code) => {
        if (!debouncer(code)) return;
        beep('ok');
        vibrate('ok');
        skuInput.value = code;
        void resolveSkuInput(code);
        stopCameraStream();
      });

      if (!cameraRunning || !activeModalDialog || !activeModalDialog.open) {
        try {
          scanner.stop();
        } catch {
          /* ignore */
        }
        return;
      }

      activeModalScanner = scanner;

      if (activeModalScanner.torchSupported) {
        torchBtn.style.display = 'inline-flex';
      }
    } catch (err) {
      console.error(err);
      toast('No se pudo acceder a la cámara: ' + (err as Error).message, 'error');
      stopCameraStream();
    }
  };

  // 3. Tarjeta de Vista Previa del Producto
  const previewCard = h('div', { class: 'product-card-preview', style: 'display: none;' });

  const updatePreview = () => {
    if (!detectedProduct && !skuInput.value.trim()) {
      previewCard.style.display = 'none';
      return;
    }
    previewCard.style.display = 'block';

    const skuUpper = (detectedProduct?.sku || skuInput.value.trim()).toUpperCase();
    const summary = summaries.get(skuUpper) ?? { totalIn: 0, totalOut: 0 };

    // Stock actual
    if (session && detectedProduct) {
      const barcodeCounts = counts.filter((c) => c.barcode === detectedProduct?.barcode);
      initialStock = barcodeCounts.reduce((a, c) => a + c.qty, 0);
    } else if (detectedProduct && typeof detectedProduct.expectedQty === 'number') {
      initialStock = detectedProduct.expectedQty;
    } else {
      initialStock = 0;
    }

    dynamicStock = Math.round((initialStock + summary.totalIn - summary.totalOut) * 1000) / 1000;
    idealStock =
      idealLevels[skuUpper] !== undefined
        ? idealLevels[skuUpper]
        : (detectedProduct as any)?.idealQty ?? detectedProduct?.maxQty ?? detectedProduct?.expectedQty ?? 0;

    clear(previewCard,
      h('div', { class: 'title' }, detectedProduct?.description || 'Producto no catalogado'),
      h('div', { class: 'meta' },
        h('span', null, h('b', null, 'SKU: '), skuUpper),
        detectedProduct?.barcode ? h('span', null, h('b', null, 'Barras: '), displayBarcode(detectedProduct.barcode)) : null,
        h('span', null, h('b', null, 'Unidad: '), detectedProduct?.unit || 'PZA'),
      ),
      h('div', { class: 'meta', style: 'margin-top: 6px; font-weight: 600;' },
        h('span', null, 'Stock Físico: ', h('span', { style: 'color: var(--primary);' }, fmtNum(initialStock))),
        h('span', null, 'Stock Dinámico: ', h('span', { style: 'color: var(--text);' }, fmtNum(dynamicStock))),
        h('span', null, 'Inventario Ideal: ', h('span', { style: 'color: var(--info);' }, fmtNum(idealStock))),
      ),
    );
  };

  const resolveSkuInput = async (val: string) => {
    const clean = val.trim();
    if (!clean) {
      detectedProduct = undefined;
      updatePreview();
      return;
    }
    const found = await findProductByCode(clean);
    detectedProduct = found;
    if (found && found.sku) {
      skuInput.value = found.sku;
    }
    updatePreview();
  };
  (dlg as any).__resolveSku = resolveSkuInput;

  skuInput.addEventListener('input', () => {
    void resolveSkuInput(skuInput.value);
  });
  skuInput.addEventListener('change', () => {
    void resolveSkuInput(skuInput.value);
  });

  // 4. Cantidad con Stepper
  const qtyInput = h('input', {
    class: 'input',
    type: 'number',
    min: '0.001',
    step: 'any',
    value: '1',
    style: 'text-align: center; font-weight: 700; font-size: 16px;',
  }) as HTMLInputElement;

  const minusBtn = h('button', {
    class: 'stepper-btn',
    type: 'button',
    onclick: () => {
      const cur = parseFloat(qtyInput.value) || 1;
      qtyInput.value = String(Math.max(1, cur - 1));
    },
  }, '−');

  const plusBtn = h('button', {
    class: 'stepper-btn',
    type: 'button',
    onclick: () => {
      const cur = parseFloat(qtyInput.value) || 0;
      qtyInput.value = String(cur + 1);
    },
  }, '+');

  const stepperWrap = h('div', { class: 'stepper-wrap' }, minusBtn, qtyInput, plusBtn);

  // 5. Técnico / Proveedor
  const actorInput = h('input', {
    class: 'input',
    placeholder: 'Nombre de persona o empresa...',
    value: session?.counter || '',
  }) as HTMLInputElement;

  // 6. Área / Máquina
  const areaInput = h('input', {
    class: 'input',
    placeholder: 'Ej. Línea 1, Taller Mecánico, Almacén Central...',
    value: movementType === 'IN' ? 'Almacén Central' : 'Línea de Producción',
  }) as HTMLInputElement;

  // 7. Folio
  const folioInput = h('input', {
    class: 'input',
    placeholder: 'Ej. REQ-2045 o Factura 182...',
  }) as HTMLInputElement;

  // 8. Notas
  const notesInput = h('textarea', {
    class: 'input',
    rows: 2,
    placeholder: 'Observaciones o motivo del movimiento...',
  }) as HTMLTextAreaElement;

  // Cuerpo del Formulario
  const formBody = h('div', { class: 'form', style: 'max-height: 70vh; overflow-y: auto;' },
    segmentedSwitch,
    skuField,
    camBox,
    previewCard,
    h('label', { class: 'field' },
      h('span', null, 'Cantidad *'),
      stepperWrap,
    ),
    h('label', { class: 'field' },
      actorLabelSpan,
      actorInput,
    ),
    h('label', { class: 'field' },
      h('span', null, 'Área o Máquina de Destino/Origen'),
      areaInput,
    ),
    h('label', { class: 'field' },
      h('span', null, 'Folio o Referencia'),
      folioInput,
    ),
    h('label', { class: 'field' },
      h('span', null, 'Notas adicionales'),
      notesInput,
    ),
  );

  // Lógica de Guardado
  const saveEntry = async (keepOpen = false): Promise<boolean> => {
    const rawSku = skuInput.value.trim().toUpperCase();
    if (!rawSku) {
      toast('Captura o escanea el SKU del producto', 'warn');
      skuInput.focus();
      return false;
    }

    const qty = parseFloat(qtyInput.value);
    if (isNaN(qty) || qty <= 0) {
      toast('Ingresa una cantidad válida mayor a 0', 'warn');
      qtyInput.focus();
      return false;
    }

    try {
      await recordMovement({
        sku: rawSku,
        barcode: detectedProduct?.barcode,
        type: movementType,
        quantity: qty,
        technicianOrSupplier: actorInput.value.trim(),
        machineOrArea: areaInput.value.trim(),
        folio: folioInput.value.trim(),
        notes: notesInput.value.trim(),
      });
      triggerBackgroundSync();

      beep('ok');
      vibrate('ok');
      toast(
        `Movimiento registrado: ${movementType === 'IN' ? '+' : '−'}${qty} ${rawSku}`,
        'ok',
        1800,
      );

      if (onSaved) {
        await onSaved();
      }

      if (keepOpen) {
        // Limpiar para captura consecutiva
        qtyInput.value = '1';
        notesInput.value = '';
        folioInput.value = '';
        skuInput.value = '';
        detectedProduct = undefined;
        updatePreview();
        skuInput.focus();
        return true;
      }

      return true;
    } catch (e) {
      console.error(e);
      toast('Error al guardar movimiento: ' + (e as Error).message, 'error');
      return false;
    }
  };

  // Botones de Acción del Modal
  const actionsDiv = h('div', { class: 'dlg-actions' },
    h('button', {
      class: 'btn',
      type: 'button',
      onclick: () => {
        stopCameraStream();
        dlg.close();
      },
    }, 'Cancelar'),
    h('button', {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        await saveEntry(true);
      },
    }, 'Guardar y Nuevo'),
    h('button', {
      class: 'btn primary',
      type: 'button',
      'data-testid': 'movements-save-btn',
      onclick: async () => {
        const ok = await saveEntry(false);
        if (ok) {
          stopCameraStream();
          dlg.close();
        }
      },
    }, 'Guardar Movimiento'),
  );

  clear(dlg,
    h('h3', null, 'Registrar Movimiento de Inventario'),
    h('div', { class: 'dlg-body' }, formBody),
    actionsDiv,
  );

  dlg.addEventListener('close', () => {
    stopCameraStream();
    if (activeModalDialog === dlg) {
      activeModalDialog = null;
    }
    dlg.remove();
  });

  document.body.appendChild(dlg);
  dlg.showModal();

  // Si se envió un SKU prellenado
  if (prefillSku) {
    skuInput.value = prefillSku;
    await resolveSkuInput(prefillSku);
  }

  return dlg;
  } finally {
    isModalOpening = false;
  }
}

/** Helper para agregar múltiples hijos */
function appendChildren(el: Node, children: (Node | null | undefined)[]) {
  for (const c of children) {
    if (c) el.appendChild(c);
  }
}
