import { L } from '../i18n/i18n';
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
import { loadSettings } from '../settings';
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
import { isMobileCatalogReadOnly, isStrictTechnicianClient, isSupervisorModeEnabled } from './catalogMode';
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
import { onCloudRoomUpdate, publishLiveScannerState, triggerBackgroundSync } from '../sync/cloudSync';
import { computeRoomDataSig } from './cloudSignal';
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
let movRenderSeq = 0;
let movCloudTimer: ReturnType<typeof setTimeout> | null = null;
let lastMovDataFp = '';

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

function resolveBaseStock(hasSession: boolean, countedQty: number | undefined, product?: Product): number {
  if (hasSession && countedQty !== undefined) {
    return countedQty;
  }
  if (product && typeof product.expectedQty === 'number') {
    return product.expectedQty;
  }
  return 0;
}

/**
 * Vista de Entradas / Salidas (Kardex) y Conciliación con Inventario Ideal
 */
export const movementsView: View = {
  title: () => L('Entradas / Salidas e Inventario Ideal', 'Stock In/Out & Ideal Inventory'),

  async render(root: HTMLElement, params: URLSearchParams): Promise<void> {
    viewRootEl = root;
    lastMovDataFp = '';

    await loadSettings();
    if (viewRootEl !== root) return;

    const actionParam = params?.get('action');

    if (params?.get('tab') === 'bitacora') {
      activeSubTab = 'bitacora';
    } else if (params?.get('tab') === 'comparative') {
      activeSubTab = 'comparative';
    }
    if (params?.get('filter') === 'deficit_critical') {
      tableFilter = 'deficit_critical';
    }

    await renderMainView();
    if (viewRootEl !== root) return;
    setupKeyboardWedge();
    setupSimulationHook();

    if (unsubscribeCloud) unsubscribeCloud();
    if (movCloudTimer) {
      clearTimeout(movCloudTimer);
      movCloudTimer = null;
    }
    unsubscribeCloud = onCloudRoomUpdate((roomState) => {
      if (viewRootEl !== root || (activeModalDialog && activeModalDialog.open)) return;
      if (roomState) {
        const nextFp = computeRoomDataSig(roomState);
        if (nextFp && nextFp === lastMovDataFp) return;
        lastMovDataFp = nextFp;
      }
      if (movCloudTimer) clearTimeout(movCloudTimer);
      movCloudTimer = setTimeout(() => {
        movCloudTimer = null;
        if (viewRootEl !== root || (activeModalDialog && activeModalDialog.open)) return;
        void renderMainView();
      }, 0);
    });

    if (actionParam === 'in' || actionParam === 'out') {
      if (
        typeof history !== 'undefined' &&
        typeof history.replaceState === 'function' &&
        typeof location !== 'undefined' &&
        typeof location.hash === 'string'
      ) {
        const hash = location.hash || '#/movimientos';
        const qIdx = hash.indexOf('?');
        if (qIdx !== -1) {
          const base = hash.slice(0, qIdx);
          const nextParams = new URLSearchParams(hash.slice(qIdx + 1));
          nextParams.delete('action');
          const nextQs = nextParams.toString();
          const nextHash = nextQs ? `${base}?${nextQs}` : base;
          history.replaceState(null, '', `${location.pathname ?? ''}${location.search ?? ''}${nextHash}`);
        }
      }
      const initialType = actionParam === 'out' ? 'OUT' : 'IN';
      void openMovementRegistrationModal(undefined, initialType, async () => {
        await renderMainView();
      });
    }
  },

  async destroy(): Promise<void> {
    isModalOpening = false;
    movRenderSeq++;
    if (movCloudTimer) {
      clearTimeout(movCloudTimer);
      movCloudTimer = null;
    }
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
async function handleWedgeScan(code: string, _target?: HTMLElement | null) {
  beep('ok');
  vibrate('ok');

  if (activeModalDialog && activeModalDialog.open) {
    const skuInput = activeModalDialog.querySelector('#m-sku-input') as HTMLInputElement | null;
    const resolvedCode = code;
    if (skuInput) {
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
  const targetRoot = viewRootEl;
  if (!targetRoot) return;
  const seq = ++movRenderSeq;

  const [products, session, summariesMap, idealLevels, movements] = await Promise.all([
    allProducts(),
    getActiveSession(),
    getMovementSummariesBySku(),
    getIdealLevels(),
    listMovements(),
  ]);
  if (viewRootEl !== targetRoot || seq !== movRenderSeq) return;

  const counts: CountEntry[] = session ? await countsForSession(session.id) : [];
  if (viewRootEl !== targetRoot || seq !== movRenderSeq) return;

  // Mapear conteos físicos actuales por SKU / clave y código de barras
  const countQtyByKey = new Map<string, number>();
  const countQtyByBarcode = new Map<string, number>();
  for (const c of counts) {
    countQtyByBarcode.set(c.barcode, (countQtyByBarcode.get(c.barcode) ?? 0) + c.qty);
    const normBc = normalizeBarcode(c.barcode);
    if (normBc && normBc !== c.barcode) {
      countQtyByBarcode.set(normBc, (countQtyByBarcode.get(normBc) ?? 0) + c.qty);
    }
  }

  // Mapa de productos por barcode y por sku (respaldando productos solo con barcode)
  const productBySku = new Map<string, Product>();
  const allSkusSet = new Set<string>();
  for (const p of products) {
    const key = (p.sku || p.barcode || '').trim().toUpperCase();
    if (!key) continue;
    productBySku.set(key, p);
    if (p.sku) {
      productBySku.set(p.sku.trim().toUpperCase(), p);
    }
    allSkusSet.add(key);
    const normBc = normalizeBarcode(p.barcode);
    const cQty = countQtyByBarcode.get(p.barcode) ?? (normBc ? countQtyByBarcode.get(normBc) : undefined);
    if (cQty !== undefined) {
      countQtyByKey.set(key, (countQtyByKey.get(key) ?? 0) + cQty);
    }
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

    // Stock actual: conteo físico si existe sesión con lecturas del producto, o existencia teórica esperada, o 0
    const countedQty = session && countQtyByKey.has(sku) ? countQtyByKey.get(sku) : undefined;
    const currentStock = resolveBaseStock(Boolean(session), countedQty, p);

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
      description: p?.description || (p?.uncataloged ? L('Producto no catalogado', 'Uncataloged product') : L('Sin descripción', 'No description')),
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
    h('div', { class: 'card-head wrap' },
      h('h2', null, L('Control de Movimientos y Existencia Ideal', 'Movements & Ideal Stock Control')),
      h('div', { class: 'row wrap', style: 'gap: 6px;' },
        h('button', {
          class: 'btn sm dash-flow-in',
          type: 'button',
          'data-testid': 'movements-quick-in-btn',
          onclick: async () => {
            await openMovementRegistrationModal(undefined, 'IN', async () => {
              await renderMainView();
            });
          },
        }, L('+ Entrada', '+ Stock In')),
        h('button', {
          class: 'btn sm dash-flow-out',
          type: 'button',
          'data-testid': 'movements-quick-out-btn',
          onclick: async () => {
            await openMovementRegistrationModal(undefined, 'OUT', async () => {
              await renderMainView();
            });
          },
        }, L('− Salida', '− Stock Out')),
        h('button', {
          class: 'btn ghost sm',
          'data-testid': 'movements-register-btn',
          onclick: async () => {
            await openMovementRegistrationModal(undefined, 'IN', async () => {
              await renderMainView();
            });
          },
        }, icon('swap'), L('Registrar Movimiento', 'Log Movement')),
      ),
    ),
    h('div', { class: 'kpis kpis-4' },
      h('div', { class: 'kpi good', id: 'kpi-card-in' },
        h('div', { class: 'kpi-v', id: 'kpi-in' }, `+${fmtNum(totalEntriesQty)}`),
        h('div', { class: 'kpi-l' }, L('Total Entradas', 'Total In')),
      ),
      h('div', { class: 'kpi warn', id: 'kpi-card-out' },
        h('div', { class: 'kpi-v', id: 'kpi-out' }, `−${fmtNum(totalExitsQty)}`),
        h('div', { class: 'kpi-l' }, L('Total Salidas', 'Total Out')),
      ),
      h('div', { class: 'kpi', id: 'kpi-card-net' },
        h('div', {
          class: 'kpi-v',
          id: 'kpi-net',
          style: netMovementsBalance >= 0 ? 'color: var(--success);' : 'color: var(--danger);',
        }, `${netMovementsBalance >= 0 ? '+' : ''}${fmtNum(netMovementsBalance)}`),
        h('div', { class: 'kpi-l' }, L('Balance Neto', 'Net Balance')),
      ),
      h('div', {
        class: 'kpi bad',
        id: 'kpi-card-deficit',
        style: 'cursor: pointer;',
        title: L('Click para ver SKUs en déficit o críticos', 'Click to view deficit or critical SKUs'),
        onclick: () => {
          activeSubTab = 'comparative';
          tableFilter = 'deficit_critical';
          void renderMainView();
        },
      },
      h('div', { class: 'kpi-v', id: 'kpi-deficit' }, `${deficitOrCriticalCount} SKUs`),
      h('div', { class: 'kpi-l' }, L('En Déficit / Críticos', 'Deficit / Critical')),
      ),
    ),
  );

  // 2. Selector de Sub-Pestaña (barra segmentada uniforme)
  const subNav = h('div', { class: 'chips sup-tabs-bar sup-tabs-2' },
    h('button', {
      class: `chip sup-tab-btn ${activeSubTab === 'comparative' ? 'active' : ''}`,
      onclick: () => {
        activeSubTab = 'comparative';
        void renderMainView();
      },
    }, L('Conciliación e Ideal', 'Reconciliation & Ideal')),
    h('button', {
      class: `chip sup-tab-btn ${activeSubTab === 'bitacora' ? 'active' : ''}`,
      onclick: () => {
        activeSubTab = 'bitacora';
        void renderMainView();
      },
    }, `${L('Bitácora de Consumo', 'Movement Log')} (${movements.length})`),
  );

  // 3. Contenedor Activo
  const contentSection =
    activeSubTab === 'comparative'
      ? renderComparativeSection(rows)
      : renderBitacoraSection(movements, productBySku);

  if (viewRootEl !== targetRoot || seq !== movRenderSeq) return;
  clear(targetRoot, kpiSection, subNav, contentSection);
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
    placeholder: L('Buscar por SKU o descripción...', 'Search by SKU or description...'),
    value: tableSearchQuery,
    oninput: (e: Event) => {
      tableSearchQuery = (e.target as HTMLInputElement).value;
      updateTableRows();
    },
  }) as HTMLInputElement;

  const allChipBtn = h('button', {
    class: `chip ${tableFilter === 'todos' ? 'active' : ''}`,
    onclick: () => { tableFilter = 'todos'; updateChips(); updateTableRows(); },
  }, `${L('Todos', 'All')} (${rows.length})`) as HTMLButtonElement;
  const deficitChipBtn = h('button', {
    class: `chip ${tableFilter === 'deficit_critical' ? 'active' : ''}`,
    onclick: () => { tableFilter = 'deficit_critical'; updateChips(); updateTableRows(); },
  }, `${L('Déficit / Críticos', 'Deficit / Critical')} (${deficitCount})`) as HTMLButtonElement;
  const optimalChipBtn = h('button', {
    class: `chip ${tableFilter === 'optimal' ? 'active' : ''}`,
    onclick: () => { tableFilter = 'optimal'; updateChips(); updateTableRows(); },
  }, `${L('Óptimos', 'Optimal')} (${optimalCount})`) as HTMLButtonElement;
  const excessChipBtn = h('button', {
    class: `chip ${tableFilter === 'excess' ? 'active' : ''}`,
    onclick: () => { tableFilter = 'excess'; updateChips(); updateTableRows(); },
  }, `${L('Exceso', 'Excess')} (${excessCount})`) as HTMLButtonElement;
  const withMovChipBtn = h('button', {
    class: `chip ${tableFilter === 'with_movements' ? 'active' : ''}`,
    onclick: () => { tableFilter = 'with_movements'; updateChips(); updateTableRows(); },
  }, `${L('Con Movimientos', 'With Movements')} (${withMovementsCount})`) as HTMLButtonElement;

  const chipsContainer = h('div', { class: 'chips' },
    allChipBtn,
    deficitChipBtn,
    optimalChipBtn,
    excessChipBtn,
    withMovChipBtn,
  );

  const updateChipCounts = () => {
    const def = rows.filter((r) => r.status === 'deficit' || r.status === 'critical').length;
    const opt = rows.filter((r) => r.status === 'optimal').length;
    const exc = rows.filter((r) => r.status === 'excess').length;
    const mov = rows.filter((r) => r.totalIn > 0 || r.totalOut > 0).length;
    allChipBtn.textContent = `${L('Todos', 'All')} (${rows.length})`;
    deficitChipBtn.textContent = `${L('Déficit / Críticos', 'Deficit / Critical')} (${def})`;
    optimalChipBtn.textContent = `${L('Óptimos', 'Optimal')} (${opt})`;
    excessChipBtn.textContent = `${L('Exceso', 'Excess')} (${exc})`;
    withMovChipBtn.textContent = `${L('Con Movimientos', 'With Movements')} (${mov})`;
  };

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
          h('th', null, L('SKU / Código', 'SKU / Code')),
          h('th', null, L('Descripción', 'Description')),
          h('th', { style: 'text-align: right;' }, L('Físico', 'Physical')),
          h('th', { style: 'text-align: right;' }, L('Entradas', 'In')),
          h('th', { style: 'text-align: right;' }, L('Salidas', 'Out')),
          h('th', { style: 'text-align: right;' }, L('Dinámico', 'Dynamic')),
          h('th', { style: 'text-align: right;' }, L('Ideal', 'Ideal')),
          h('th', { style: 'text-align: right;' }, L('Brecha', 'Gap')),
          h('th', { style: 'text-align: center;' }, L('Estado', 'Status')),
          h('th', { style: 'text-align: center;' }, L('Acciones', 'Actions')),
        ),
      ),
      tableBody,
    ),
  );

  const emptyMsg = h('p', { class: 'muted center', style: 'padding: 20px 0; display: none;' }, L('No se encontraron productos coincidentes.', 'No matching products found.'));

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
        tableBody.appendChild(createComparativeRow(row, rows, updateChipCounts));
      }
    }
  };

  updateTableRows();

  clear(container,
    h('div', { class: 'filter-bar-row' },
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
function createComparativeRow(
  row: ComparativeRow,
  allRows: ComparativeRow[] = [row],
  onIdealUpdated?: () => void,
): HTMLTableRowElement {
  const tr = h('tr', { 'data-sku': row.sku });

  // SKU cell
  const skuCell = h('td', null,
    h('b', null, row.sku),
    row.barcode ? h('div', { class: 'muted small' }, displayBarcode(row.barcode)) : null,
  );

  // Descripción cell
  const descCell = h('td', { class: 'kdx-desc-cell' },
    h('div', { class: 'kdx-desc-title' }, row.description),
    h('span', { class: 'badge sm kdx-unit-badge' }, row.unit),
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

  // Inventario Ideal (Input Inline solo para Supervisor en modo escritorio/edición)
  const canEditIdeal = isSupervisorModeEnabled() && !isMobileCatalogReadOnly();
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
    let label = L('Óptimo', 'Optimal');
    if (row.status === 'deficit') {
      badgeCls = 'badge warn';
      label = L('Déficit', 'Deficit');
    } else if (row.status === 'critical') {
      badgeCls = 'badge error';
      label = L('Crítico', 'Critical');
    } else if (row.status === 'excess') {
      badgeCls = 'badge info';
      label = L('Exceso', 'Excess');
    }
    clear(statusCell, h('span', { class: badgeCls }, label));
  };

  renderGapAndStatus();

  // Persistencia instantánea de Inventario Ideal al cambiar/desenfocar
  let lastSavedVal = row.idealQty;
  const onIdealChange = async () => {
    if (!canEditIdeal) return;
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
    onIdealUpdated?.();
    toast(L(`Inventario ideal de ${row.sku} actualizado a ${newQty}`, `Ideal stock for ${row.sku} updated to ${newQty}`), 'ok', 1400);

    // Actualizar live KPI card con el conjunto completo de filas
    updateLiveDeficitKpi(allRows);
  };

  if (canEditIdeal) {
    idealInput.addEventListener('change', () => void onIdealChange());
    idealInput.addEventListener('blur', () => void onIdealChange());
  }

  const idealCell = h(
    'td',
    { style: 'text-align: right;' },
    canEditIdeal ? idealInput : h('span', { class: 'muted' }, fmtNum(row.idealQty)),
  );

  // Acciones: + Entrada y - Salida rápidos
  const actionsCell = h('td', { style: 'text-align: center; white-space: nowrap;' },
    h('button', {
      class: 'btn sm good',
      style: 'padding: 4px 8px; margin-right: 4px; font-weight: 700;',
      title: L(`Registrar entrada de ${row.sku}`, `Log stock in for ${row.sku}`),
      onclick: async () => {
        await openMovementRegistrationModal(row.sku, 'IN', async () => {
          await renderMainView();
        });
      },
    }, '+'),
    h('button', {
      class: 'btn sm warn',
      style: 'padding: 4px 8px; font-weight: 700;',
      title: L(`Registrar salida de ${row.sku}`, `Log stock out for ${row.sku}`),
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
 * Actualiza el contador del KPI de déficit en vivo usando el catálogo completo de filas
 */
function updateLiveDeficitKpi(allRows?: ComparativeRow[]) {
  let count = 0;
  if (allRows) {
    for (const r of allRows) {
      if (r.status === 'deficit' || r.status === 'critical') count++;
    }
  } else {
    const table = viewRootEl?.querySelector('.comp-table');
    if (!table) return;
    const badges = table.querySelectorAll('tbody tr td:nth-child(9) .badge');
    badges.forEach((b) => {
      if (b.classList.contains('warn') || b.classList.contains('error')) {
        count++;
      }
    });
  }
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
    placeholder: L('Buscar en bitácora (SKU, folio, notas, técnico)...', 'Search log (SKU, ref, notes, technician)...'),
    value: bitacoraSearch,
    oninput: (e: Event) => {
      bitacoraSearch = (e.target as HTMLInputElement).value;
      renderMovementList();
    },
  });

  const techInput = h('input', {
    class: 'input sm',
    placeholder: L('Filtrar por técnico/proveedor...', 'Filter by technician/supplier...'),
    value: bitacoraTech,
    oninput: (e: Event) => {
      bitacoraTech = (e.target as HTMLInputElement).value;
      renderMovementList();
    },
  });

  const areaInput = h('input', {
    class: 'input sm',
    placeholder: L('Filtrar por máquina/área...', 'Filter by machine/area...'),
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
    }, L('Todos los tipos', 'All types')),
    h('button', {
      class: `chip ${bitacoraType === 'IN' ? 'active' : ''}`,
      onclick: () => { bitacoraType = 'IN'; updateTypeChips(); renderMovementList(); },
    }, L('Solo Entradas (IN)', 'Stock In Only (IN)')),
    h('button', {
      class: `chip ${bitacoraType === 'OUT' ? 'active' : ''}`,
      onclick: () => { bitacoraType = 'OUT'; updateTypeChips(); renderMovementList(); },
    }, L('Solo Salidas (OUT)', 'Stock Out Only (OUT)')),
  );

  const dateChips = h('div', { class: 'chips' },
    h('button', {
      class: `chip ${bitacoraDateRange === 'all' ? 'active' : ''}`,
      onclick: () => { bitacoraDateRange = 'all'; updateDateChips(); renderMovementList(); },
    }, L('Todo el historial', 'All history')),
    h('button', {
      class: `chip ${bitacoraDateRange === 'today' ? 'active' : ''}`,
      onclick: () => { bitacoraDateRange = 'today'; updateDateChips(); renderMovementList(); },
    }, L('Hoy', 'Today')),
    h('button', {
      class: `chip ${bitacoraDateRange === '7days' ? 'active' : ''}`,
      onclick: () => { bitacoraDateRange = '7days'; updateDateChips(); renderMovementList(); },
    }, L('Últimos 7 días', 'Last 7 days')),
    h('button', {
      class: `chip ${bitacoraDateRange === 'month' ? 'active' : ''}`,
      onclick: () => { bitacoraDateRange = 'month'; updateDateChips(); renderMovementList(); },
    }, L('Este mes', 'This month')),
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
        h('div', { class: 'empty' }, L('No hay movimientos que coincidan con los filtros seleccionados.', 'No movements match the selected filters.')),
      );
      return;
    }

    for (const m of filtered) {
      const prod = productBySku.get(m.sku.toUpperCase());
      const isEntry = m.type === 'IN';

      const itemCard = h('div', { class: `m-item ${isEntry ? 'in' : 'out'}` },
        h('div', { class: 'm-head' },
          h('div', { style: 'display: flex; align-items: center; gap: 8px;' },
            h('span', { class: `badge ${isEntry ? 'ok' : 'warn'}` }, isEntry ? L('ENTRADA', 'IN') : L('SALIDA', 'OUT')),
            h('span', { class: `m-qty ${isEntry ? 'in' : 'out'}` },
              `${isEntry ? '+' : '−'}${fmtNum(m.quantity)} ${prod?.unit || 'PZA'}`,
            ),
          ),
          h('div', { class: 'muted small' }, fmtDateTime(m.timestamp)),
        ),
        h('div', { class: 'm-body' },
          h('div', { class: 'm-desc' },
            h('span', { style: 'font-weight: 800; margin-right: 6px;' }, m.sku),
            prod?.description || L('Producto', 'Product'),
          ),
          h('div', { class: 'm-meta' },
            m.technicianOrSupplier
              ? h('span', null, h('b', null, isEntry ? L('Proveedor: ', 'Supplier: ') : L('Técnico: ', 'Technician: ')), m.technicianOrSupplier)
              : null,
            m.machineOrArea
              ? h('span', null, h('b', null, L('Área/Máq: ', 'Area/Machine: ')), m.machineOrArea)
              : null,
            m.folio ? h('span', null, h('b', null, L('Folio: ', 'Ref: ')), m.folio) : null,
          ),
          m.notes
            ? h('div', { class: 'small muted', style: 'margin-top: 4px; font-style: italic;' },
              `${L('Notas:', 'Notes:')} ${m.notes}`,
            )
            : null,
        ),
        !isStrictTechnicianClient()
          ? h('div', { style: 'display: flex; justify-content: flex-end; margin-top: 8px;' },
              h('button', {
                class: 'btn sm danger ghost',
                onclick: async () => {
                  const ok = await confirmDialog(
                    L('Eliminar movimiento', 'Delete movement'),
                    L(
                      `¿Deseas revertir y eliminar este movimiento de ${isEntry ? 'Entrada' : 'Salida'} (${m.quantity} ${m.sku})?`,
                      `Revert and delete this ${isEntry ? 'Stock In' : 'Stock Out'} movement (${m.quantity} ${m.sku})?`,
                    ),
                    L('Eliminar', 'Delete'),
                    true,
                  );
                  if (ok) {
                    await deleteMovement(m.id);
                    triggerBackgroundSync();
                    toast(L('Movimiento eliminado correctamente', 'Movement deleted'), 'ok');
                    await renderMainView();
                  }
                },
              }, icon('trash'), L('Eliminar', 'Delete')),
            )
          : null,
      );

      listContainer.appendChild(itemCard);
    }
  };

  renderMovementList();

  clear(container,
    h('div', { class: 'card-head' },
      h('h3', null, L('Bitácora de Consumo y Trazabilidad', 'Consumption & Traceability Log')),
    ),
    h('div', { class: 'filter-bar-row' },
      searchInput,
      typeChips,
    ),
    h('details', { class: 'ui-disclosure', style: 'margin-bottom: 10px;' },
      h('summary', { class: 'ui-disclosure-summary' }, L('Filtros avanzados (técnico, área y periodo)', 'Advanced filters (technician, area & date)')),
      h('div', { class: 'ui-disclosure-body' },
        h('div', { style: 'display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px;' },
          techInput,
          areaInput,
        ),
        dateChips,
      ),
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
    let camAttemptSeq = 0;
    let skuResolveSeq = 0;

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
    }, L('Entrada (IN)', 'Stock In (IN)'));

    const exitBtn = h('button', {
      class: `segmented-btn ${movementType === 'OUT' ? 'active out' : ''}`,
      type: 'button',
      'data-testid': 'movement-type-out',
      onclick: () => {
        movementType = 'OUT';
        updateSegmentedStyles();
      },
    }, L('Salida (OUT)', 'Stock Out (OUT)'));

    const segmentedSwitch = h('div', { class: 'segmented-switch' }, entryBtn, exitBtn);

    const actorLabelSpan = h('span', null, movementType === 'IN' ? L('Proveedor / Origen', 'Supplier / Source') : L('Técnico / Solicitante', 'Technician / Requester'));
    const defaultAreaIn = L('Almacén Central', 'Central Warehouse');
    const defaultAreaOut = L('Línea de Producción', 'Production Line');

    const updateSegmentedStyles = () => {
      if (movementType === 'IN') {
        entryBtn.className = 'segmented-btn active in';
        exitBtn.className = 'segmented-btn';
        actorLabelSpan.textContent = L('Proveedor / Origen', 'Supplier / Source');
        if (!areaInput.value || areaInput.value === defaultAreaOut) {
          areaInput.value = defaultAreaIn;
        }
      } else {
        entryBtn.className = 'segmented-btn';
        exitBtn.className = 'segmented-btn active out';
        actorLabelSpan.textContent = L('Técnico / Solicitante', 'Technician / Requester');
        if (!areaInput.value || areaInput.value === defaultAreaIn) {
          areaInput.value = defaultAreaOut;
        }
      }
    };

    // 2. Campo de Código / SKU y botón de escáner
    const skuInput = h('input', {
      id: 'm-sku-input',
      'data-testid': 'movements-sku-input',
      class: 'input',
      placeholder: L('Código de barras o SKU (ej. MHK-001)...', 'Barcode or SKU (e.g. MHK-001)...'),
      autocomplete: 'off',
    }) as HTMLInputElement;

  const camToggleBtn = h('button', {
    class: 'btn ghost sm',
    type: 'button',
    title: L('Escanear con cámara', 'Scan with camera'),
    onclick: () => void toggleCamera(),
  }, icon('camera'), L('Cámara', 'Camera'));

  const skuField = h('div', { style: 'margin-bottom: 10px;' },
    h('label', { class: 'field' },
      h('span', null, L('Código de barras o SKU *', 'Barcode or SKU *')),
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
  }, icon('torch'), L('Linterna', 'Flashlight'));

  let torchState = false;
  const camBox = h('div', { class: 'cam-box', style: 'display: none;' },
    camVideo,
    h('div', { class: 'cam-controls' }, torchBtn),
  );

  const stopCameraStream = () => {
    camAttemptSeq++;
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
    camToggleBtn.replaceChildren(icon('camera'), L('Cámara', 'Camera'));
    torchBtn.style.display = 'none';
    torchState = false;
  };

  const toggleCamera = async () => {
    if (cameraRunning) {
      stopCameraStream();
      return;
    }
    const attempt = ++camAttemptSeq;
    camBox.style.display = 'flex';
    camToggleBtn.replaceChildren(icon('stop'), L('Detener', 'Stop'));
    cameraRunning = true;

    try {
      const debouncer = createDebouncer(1500);
      const scanner = await startScanner(camVideo, (code) => {
        if (!debouncer(code)) return;
        beep('ok');
        vibrate('ok');
        skuInput.value = code;
        void resolveSkuInput(code, false);
        stopCameraStream();
      });

      if (attempt !== camAttemptSeq || !cameraRunning || !activeModalDialog || !activeModalDialog.open) {
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
      toast(L('No se pudo acceder a la cámara: ', 'Could not access camera: ') + (err as Error).message, 'error');
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

    const skuUpper = (detectedProduct?.sku || detectedProduct?.barcode || skuInput.value.trim()).toUpperCase();
    const summary = summaries.get(skuUpper) ?? { totalIn: 0, totalOut: 0 };

    // Stock actual
    let countedQty: number | undefined;
    if (session && detectedProduct) {
      const targetNorm = normalizeBarcode(detectedProduct.barcode);
      const barcodeCounts = counts.filter(
        (c) => c.barcode === detectedProduct?.barcode || (targetNorm && normalizeBarcode(c.barcode) === targetNorm),
      );
      if (barcodeCounts.length > 0) {
        countedQty = barcodeCounts.reduce((a, c) => a + c.qty, 0);
      }
    }
    initialStock = resolveBaseStock(Boolean(session), countedQty, detectedProduct);

    dynamicStock = Math.round((initialStock + summary.totalIn - summary.totalOut) * 1000) / 1000;
    idealStock =
      idealLevels[skuUpper] !== undefined
        ? idealLevels[skuUpper]
        : (detectedProduct as any)?.idealQty ?? detectedProduct?.maxQty ?? detectedProduct?.expectedQty ?? 0;

    clear(previewCard,
      h('div', { class: 'title' }, detectedProduct?.description || L('Producto no catalogado', 'Uncataloged product')),
      h('div', { class: 'meta' },
        h('span', null, h('b', null, 'SKU: '), skuUpper),
        detectedProduct?.barcode ? h('span', null, h('b', null, L('Barras: ', 'Barcode: ')), displayBarcode(detectedProduct.barcode)) : null,
        h('span', null, h('b', null, L('Unidad: ', 'Unit: ')), detectedProduct?.unit || 'PZA'),
      ),
      h('div', { class: 'meta', style: 'margin-top: 6px; font-weight: 600;' },
        h('span', null, L('Stock Físico: ', 'Physical Stock: '), h('span', { style: 'color: var(--primary);' }, fmtNum(initialStock))),
        h('span', null, L('Stock Dinámico: ', 'Dynamic Stock: '), h('span', { style: 'color: var(--text);' }, fmtNum(dynamicStock))),
        h('span', null, L('Inventario Ideal: ', 'Ideal Stock: '), h('span', { style: 'color: var(--info);' }, fmtNum(idealStock))),
      ),
    );
  };

  const resolveSkuInput = async (val: string, fromManualInput = false) => {
    const clean = val.trim();
    const seq = ++skuResolveSeq;
    if (!clean) {
      detectedProduct = undefined;
      updatePreview();
      return;
    }
    const found = await findProductByCode(clean);
    if (seq !== skuResolveSeq || activeModalDialog !== dlg) return;
    detectedProduct = found;
    if (!fromManualInput && found && found.sku) {
      skuInput.value = found.sku;
    }
    updatePreview();
    void publishLiveScannerState({
      status: 'pending_confirm',
      cameraOn: cameraRunning,
      origin: cameraRunning ? 'camara' : 'manual',
      barcode: found?.barcode || clean,
      sku: found?.sku || found?.barcode || clean.toUpperCase(),
      description: found?.description,
      qty: parseFloat(qtyInput.value) || 1,
      sessionName: 'Movimientos Kardex',
    });
  };
  (dlg as any).__resolveSku = (val: string) => resolveSkuInput(val, false);

  skuInput.addEventListener('input', () => {
    void resolveSkuInput(skuInput.value, true);
  });
  skuInput.addEventListener('change', () => {
    void resolveSkuInput(skuInput.value, false);
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
      qtyInput.value = String(Math.max(1, Math.round((cur - 1) * 1000) / 1000));
    },
  }, '−');

  const plusBtn = h('button', {
    class: 'stepper-btn',
    type: 'button',
    onclick: () => {
      const cur = parseFloat(qtyInput.value) || 0;
      qtyInput.value = String(Math.round((cur + 1) * 1000) / 1000);
    },
  }, '+');

  const stepperWrap = h('div', { class: 'stepper-wrap' }, minusBtn, qtyInput, plusBtn);

  // 5. Técnico / Proveedor
  const actorInput = h('input', {
    class: 'input',
    placeholder: L('Nombre de persona o empresa...', 'Person or company name...'),
    value: session?.counter || '',
  }) as HTMLInputElement;

  // 6. Área / Máquina
  const areaInput = h('input', {
    class: 'input',
    placeholder: L('Ej. Línea 1, Taller Mecánico, Almacén Central...', 'e.g. Line 1, Machine Shop, Central Warehouse...'),
    value: movementType === 'IN' ? defaultAreaIn : defaultAreaOut,
  }) as HTMLInputElement;

  // 7. Folio
  const folioInput = h('input', {
    class: 'input',
    placeholder: L('Ej. REQ-2045 o Factura 182...', 'e.g. REQ-2045 or Invoice 182...'),
  }) as HTMLInputElement;

  // 8. Notas
  const notesInput = h('textarea', {
    class: 'input',
    rows: 2,
    placeholder: L('Observaciones o motivo del movimiento...', 'Notes or movement reason...'),
  }) as HTMLTextAreaElement;

  // Cuerpo del Formulario
  const formBody = h('div', { class: 'form', style: 'max-height: 70vh; overflow-y: auto;' },
    segmentedSwitch,
    skuField,
    camBox,
    previewCard,
    h('label', { class: 'field' },
      h('span', null, L('Cantidad *', 'Quantity *')),
      stepperWrap,
    ),
    h('label', { class: 'field' },
      actorLabelSpan,
      actorInput,
    ),
    h('label', { class: 'field' },
      h('span', null, L('Área o Máquina de Destino/Origen', 'Target/Source Area or Machine')),
      areaInput,
    ),
    h('label', { class: 'field' },
      h('span', null, L('Folio o Referencia', 'Reference / Slip #')),
      folioInput,
    ),
    h('label', { class: 'field' },
      h('span', null, L('Notas adicionales', 'Additional notes')),
      notesInput,
    ),
  );

  // Lógica de Guardado
  const saveEntry = async (keepOpen = false): Promise<boolean> => {
    const rawSku = skuInput.value.trim().toUpperCase();
    if (!rawSku) {
      toast(L('Captura o escanea el SKU del producto', 'Enter or scan the product SKU'), 'warn');
      skuInput.focus();
      return false;
    }

    const qty = parseFloat(qtyInput.value);
    if (isNaN(qty) || qty <= 0) {
      toast(L('Ingresa una cantidad válida mayor a 0', 'Enter a valid quantity greater than 0'), 'warn');
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
      const prevSum = summaries.get(rawSku) ?? {
        totalIn: 0,
        totalOut: 0,
        netMovements: 0,
        movementCount: 0,
        inCount: 0,
        outCount: 0,
      };
      const nextIn = movementType === 'IN' ? Math.round((prevSum.totalIn + qty) * 1000) / 1000 : prevSum.totalIn;
      const nextOut = movementType === 'OUT' ? Math.round((prevSum.totalOut + qty) * 1000) / 1000 : prevSum.totalOut;
      summaries.set(rawSku, {
        ...prevSum,
        totalIn: nextIn,
        totalOut: nextOut,
        netMovements: Math.round((nextIn - nextOut) * 1000) / 1000,
        movementCount: prevSum.movementCount + 1,
        inCount: prevSum.inCount + (movementType === 'IN' ? 1 : 0),
        outCount: prevSum.outCount + (movementType === 'OUT' ? 1 : 0),
      });
      void publishLiveScannerState({
        status: 'registered',
        cameraOn: cameraRunning,
        barcode: detectedProduct?.barcode || rawSku,
        sku: rawSku,
        description: detectedProduct?.description,
        qty,
        counter: actorInput.value.trim() || undefined,
        sessionName: 'Movimientos Kardex',
      });
      triggerBackgroundSync();

      beep('ok');
      vibrate('ok');
      toast(
        `${L('Movimiento registrado:', 'Movement recorded:')} ${movementType === 'IN' ? '+' : '−'}${qty} ${rawSku}`,
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
      toast(L('Error al guardar movimiento: ', 'Failed to save movement: ') + (e as Error).message, 'error');
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
    }, L('Cancelar', 'Cancel')),
    h('button', {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        await saveEntry(true);
      },
    }, L('Guardar y Nuevo', 'Save & New')),
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
    }, L('Guardar Movimiento', 'Save Movement')),
  );

  clear(dlg,
    h('h3', null, L('Registrar Movimiento de Inventario', 'Record Inventory Movement')),
    h('div', { class: 'dlg-body' }, formBody),
    actionsDiv,
  );

  dlg.addEventListener('close', () => {
    skuResolveSeq++;
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
