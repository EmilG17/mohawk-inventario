import {
  allProducts,
  allSessions,
  closeSession,
  countsForSession,
  createSession,
  getActiveSession,
  reopenSession,
} from '../db/db';
import { L, getLocaleTag } from '../i18n/i18n';
import { getAllMovements } from '../db/movements';
import { pendingCount } from '../lookup/pendingQueue';
import { loadSettings, saveSettings } from '../settings';
import { getCloudConnectionStatus, onCloudRoomUpdate } from '../sync/cloudSync';
import { computeRoomDataSig } from './cloudSignal';
import { detectPlatformInfo } from './app';
import { openBarcodeSheetDialog } from './barcodeSheet';
import { importCatalogFlow, syncCatalogWithDbFlow } from './catalog';
import { isMobileCatalogReadOnly, isSupervisorModeEnabled } from './catalogMode';
import {
  clear,
  confirmDialog,
  fmtDateTime,
  fmtNum,
  h,
  icon,
  promptDialog,
  toast,
} from './dom';
import { installState, promptInstall } from './install';
import { createBrandLogo } from './logo';
import type { View } from './router';
import { currentPath, navigate } from './router';
import { openUnifyReportsDialog } from './unifyReportsDialog';

export async function askCounterName(force = false): Promise<string | null> {
  const s = await loadSettings();
  if (s.counterName && !force) return s.counterName;
  const name = await promptDialog(L('¿Quién está contando?', 'Who is counting?'), L('Tu nombre', 'Your name'), s.counterName, {
    autocomplete: 'name',
    maxlength: 40,
    placeholder: L('Ej. Juan Pérez', 'e.g. Jane Doe'),
  });
  if (name && name.trim()) {
    await saveSettings({ counterName: name.trim() });
    return name.trim();
  }
  return s.counterName || null;
}

export async function newSessionFlow(): Promise<boolean> {
  const counter = await askCounterName();
  if (!counter) {
    toast(L('Captura tu nombre para iniciar', 'Enter your name to start'), 'warn');
    return false;
  }
  const d = new Date();
  const def = `${L('Inventario', 'Inventory')} ${d.toLocaleDateString(getLocaleTag())} ${counter.split(' ')[0]}`;
  const name = await promptDialog(L('Nueva sesión de conteo', 'New counting session'), L('Nombre de la sesión', 'Session name'), def, {
    maxlength: 60,
  });
  if (!name) return false;
  await createSession(name.trim() || def, counter);
  toast(L('Sesión creada', 'Session created'), 'ok');
  return true;
}

let currentRoot: HTMLElement | null = null;
let unsubscribeHomeCloud: (() => void) | null = null;
let homeRenderSeq = 0;
let homeCloudTimer: ReturnType<typeof setTimeout> | null = null;
let lastHomeDataFp = '';

async function renderHomeContent(root: HTMLElement, seq = ++homeRenderSeq): Promise<void> {
  const [s, session, products, pending, sessions, movements] = await Promise.all([
    loadSettings(),
    getActiveSession(),
    allProducts(),
    pendingCount(),
    allSessions(),
    getAllMovements(),
  ]);
  if (currentRoot !== root || seq !== homeRenderSeq) return;

    const counts = session ? await countsForSession(session.id) : [];
    if (currentRoot !== root || seq !== homeRenderSeq) return;
    const catalogCount = products.filter((p) => !p.uncataloged).length;
    const withExpected = products.filter((p) => p.expectedQty !== undefined).length;
    const uncatalogedCount = products.filter((p) => p.uncataloged).length;
    const distinct = new Set(counts.map((c) => c.barcode)).size;
    const units = counts.reduce((a, c) => a + c.qty, 0);
    const pastSessions = sessions.slice(0, 4);

    const totalMovements = movements.length;
    const totalIn = movements
      .filter((m) => m.type === 'IN')
      .reduce((acc, m) => acc + m.quantity, 0);
    const totalOut = movements
      .filter((m) => m.type === 'OUT')
      .reduce((acc, m) => acc + m.quantity, 0);
    const recentMovements = [...movements].sort((a, b) => b.timestamp - a.timestamp).slice(0, 3);

    const cloudStatus = getCloudConnectionStatus();
    const platform = detectPlatformInfo();
    const install = installState();
    const supervisorUI = isSupervisorModeEnabled();

    const todayStr = new Intl.DateTimeFormat(getLocaleTag(), {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date());

    clear(
      root,
      h(
        'div',
        { class: 'dash-wrap' },

        /* 1. HERO Y PERFIL RESPONSIVO */
        h(
          'section',
          { class: 'card dash-hero-card' },
          h(
            'div',
            { class: 'dash-hero-inner' },
            h(
              'div',
              { class: 'dash-hero-left' },
              createBrandLogo(44, 'brand-mark hero-brand-mark'),
              h(
                'div',
                { class: 'dash-user-meta' },
                h(
                  'div',
                  { class: 'hello' },
                  h(
                    'div',
                    null,
                    h('div', { class: 'muted xsmall' }, `${L('Operador', 'Operator')} · ${todayStr}`),
                    h('div', { class: 'big' }, s.counterName || L('Sin asignar', 'Unassigned')),
                  ),
                  h(
                    'button',
                    {
                      class: 'btn ghost sm',
                      onclick: async () => {
                        await askCounterName(true);
                        if ((currentPath() || '/') === '/') navigate('/');
                      },
                    },
                    icon('gear'),
                    L('Cambiar', 'Change'),
                  ),
                ),
                h(
                  'div',
                  { class: 'dash-tag-row' },
                  h('span', { class: 'badge info' }, platform.label),
                  cloudStatus.roomCode && cloudStatus.state === 'connected'
                    ? h('span', { class: 'badge ok' }, `${L('Sala', 'Room')}: ${cloudStatus.roomCode}`)
                    : cloudStatus.roomCode
                      ? h('span', { class: 'badge warn' }, `${L('Sala', 'Room')}: ${cloudStatus.roomCode}`)
                      : h('span', { class: 'badge default' }, 'Local'),
                  h(
                    'span',
                    { class: navigator.onLine ? 'badge ok' : 'badge warn' },
                    navigator.onLine ? L('En línea', 'Online') : L('Sin conexión', 'Offline'),
                  ),
                  !session
                    ? h(
                        'h2',
                        { class: 'badge warn dash-idle-pill', 'data-testid': 'home-idle-badge', style: 'margin:0; font-weight:700;' },
                        L('Sin sesión activa', 'No active session'),
                      )
                    : null,
                ),
              ),
            ),
          ),
        ),

        /* 2. CUADRÍCULA DE KPIS METRICAS (4 columnas en desktop, 2 en móvil) */
        h(
          'section',
          { class: 'dash-kpi-grid' },
          // KPI 1: Sesión
          h(
            'div',
            {
              class: 'dash-kpi-card clickable',
              'data-testid': 'home-kpi-session',
              onclick: () => (session ? navigate('/contar') : void (newSessionFlow().then((ok) => ok && navigate('/contar')))),
            },
            h(
              'div',
              { class: 'dash-kpi-header' },
              h('span', { class: 'dash-kpi-label' }, L('Sesión', 'Session')),
              session
                ? h('span', { class: 'badge ok' }, L('Activa', 'Active'))
                : h('span', { class: 'badge default' }, L('Inactiva', 'Inactive')),
            ),
            h(
              'div',
              { class: 'dash-kpi-value' },
              session ? fmtNum(distinct) : '0',
            ),
            h(
              'div',
              { class: 'dash-kpi-sub' },
              session
                ? `${session.name} · ${fmtNum(units)} ${L('pzas', 'pcs')} (${counts.length})`
                : L('Sin sesión activa', 'No active session'),
            ),
          ),

          // KPI 2: Catálogo
          h(
            'div',
            { class: 'dash-kpi-card clickable', 'data-testid': 'home-kpi-catalog', onclick: () => navigate('/catalogo') },
            h(
              'div',
              { class: 'dash-kpi-header' },
              h('span', { class: 'dash-kpi-label' }, L('Catálogo', 'Catalog')),
              h('span', { class: 'badge info' }, `${fmtNum(catalogCount)} SKUs`),
            ),
            h('div', { class: 'dash-kpi-value' }, fmtNum(catalogCount)),
            h(
              'div',
              { class: 'dash-kpi-sub' },
              `${fmtNum(withExpected)} ${L('con ideal', 'with ideal')}${uncatalogedCount > 0 ? ` · ${uncatalogedCount} ${L('nuevos', 'new')}` : ''}`,
            ),
          ),

          // KPI 3: Kardex
          h(
            'div',
            { class: 'dash-kpi-card clickable', 'data-testid': 'home-kpi-kardex', onclick: () => navigate('/movimientos') },
            h(
              'div',
              { class: 'dash-kpi-header' },
              h('span', { class: 'dash-kpi-label' }, 'Kardex'),
              h('span', { class: 'badge ok' }, `${totalMovements} ${L('movs', 'txns')}`),
            ),
            h(
              'div',
              { class: 'dash-kpi-value flow' },
              h('span', { class: 'in-text' }, `+${fmtNum(Math.round(totalIn))}`),
              ' / ',
              h('span', { class: 'out-text' }, `-${fmtNum(Math.round(totalOut))}`),
            ),
            h('div', { class: 'dash-kpi-sub' }, L('Entradas / salidas', 'Stock in / out')),
          ),

          // KPI 4: Equipo y Nube
          h(
            'div',
            { class: 'dash-kpi-card clickable', 'data-testid': 'home-kpi-team', onclick: () => navigate('/equipo') },
            h(
              'div',
              { class: 'dash-kpi-header' },
              h('span', { class: 'dash-kpi-label' }, 'Supervisor'),
              h(
                'span',
                { class: cloudStatus.state === 'connected' ? 'badge ok' : 'badge default' },
                cloudStatus.state === 'connected' ? L('En vivo', 'Live') : 'Local',
              ),
            ),
            h(
              'div',
              { class: 'dash-kpi-value' },
              cloudStatus.state === 'connected' ? L('Conectado', 'Connected') : 'Local',
            ),
            h(
              'div',
              { class: 'dash-kpi-sub' },
              cloudStatus.roomCode ? `${L('Sala', 'Room')} ${cloudStatus.roomCode}` : L('Solo este equipo', 'This device only'),
            ),
          ),
        ),

        /* 3. BARRA DE ACCIÓN Y HERRAMIENTAS RÁPIDAS */
        h(
          'section',
          { class: 'card dash-action-card' },
          session
            ? h(
              'div',
              { class: 'dash-cta-box' },
              h(
                'button',
                {
                  class: 'btn primary xl dash-hero-btn',
                  'data-testid': 'home-resume-count-btn',
                  onclick: () => navigate('/contar'),
                },
                icon('scan'),
                L('Continuar conteo físico', 'Resume physical count'),
              ),
              h(
                'div',
                { class: 'dash-cta-subrow' },
                supervisorUI
                  ? h(
                      'button',
                      {
                        class: 'btn sm',
                        'data-testid': 'home-goto-report-btn',
                        onclick: () => navigate('/reporte'),
                      },
                      icon('chart'),
                      L('Ver reporte de diferencias', 'View discrepancy report'),
                    )
                  : null,
                supervisorUI
                  ? h(
                      'button',
                      {
                        class: 'btn sm',
                        'data-testid': 'home-create-session-btn',
                        onclick: async () => {
                          if (await newSessionFlow()) navigate('/contar');
                        },
                      },
                      L('Crear sesión', 'Create session'),
                    )
                  : null,
                h(
                  'button',
                  {
                    class: 'btn sm danger ghost',
                    'data-testid': 'home-close-session-btn',
                    onclick: async () => {
                      const ok = await confirmDialog(
                        L('Finalizar sesión de conteo', 'Close counting session'),
                        L(
                          `¿Deseas finalizar la sesión "${session.name}"? Los datos quedarán guardados y listos para consulta o reporte.`,
                          `Finish session "${session.name}"? Your data will stay saved and ready for reports.`,
                        ),
                        L('Finalizar sesión', 'Close session'),
                        true,
                      );
                      if (ok) {
                        await closeSession(session.id);
                        toast(L('Sesión finalizada con éxito', 'Session closed'), 'ok');
                        navigate('/');
                      }
                    },
                  },
                  icon('check'),
                  L('Finalizar sesión', 'Close session'),
                ),
              ),
            )
            : h(
              'div',
              { class: 'dash-cta-box' },
              h(
                'button',
                {
                  class: 'btn primary xl dash-hero-btn',
                  'data-testid': 'home-start-session-btn',
                  onclick: async () => {
                    if (await newSessionFlow()) navigate('/contar');
                  },
                },
                icon('scan'),
                L('Iniciar nueva sesión de conteo', 'Start new counting session'),
              ),
            ),

          h('div', { class: 'dash-divider' }),

          // Acciones Rápidas de Flujo (1 clic)
          h(
            'div',
            { class: 'dash-flow-section' },
            h('span', { class: 'dash-flow-label muted xsmall uppercase' }, L('Accesos rápidos', 'Quick actions')),
            h(
              'div',
              { class: 'dash-flow-actions' },
              h(
                'button',
                {
                  class: 'btn sm dash-flow-btn dash-flow-in',
                  type: 'button',
                  'data-testid': 'home-quick-in',
                  onclick: () => navigate('/movimientos?action=in'),
                },
                icon('plus'),
                L('Entrada Kardex', 'Stock In'),
              ),
              h(
                'button',
                {
                  class: 'btn sm dash-flow-btn dash-flow-out',
                  type: 'button',
                  'data-testid': 'home-quick-out',
                  onclick: () => navigate('/movimientos?action=out'),
                },
                icon('swap'),
                L('Salida Kardex', 'Stock Out'),
              ),
              supervisorUI
                ? h(
                    'button',
                    {
                      class: 'btn sm dash-flow-btn',
                      type: 'button',
                      'data-testid': 'home-quick-unify',
                      onclick: () => void openUnifyReportsDialog((sid) => navigate(`/reporte?session=${sid}`)),
                    },
                    icon('users'),
                    L('Unificar Reportes', 'Merge Reports'),
                  )
                : null,
              supervisorUI
                ? h(
                    'button',
                    {
                      class: 'btn sm dash-flow-btn',
                      type: 'button',
                      'data-testid': 'home-quick-labels',
                      onclick: () => openBarcodeSheetDialog(),
                    },
                    icon('scan'),
                    L('Cola de Rótulos', 'Label Queue'),
                  )
                : null,
              h(
                'button',
                {
                  class: 'btn sm dash-flow-btn',
                  type: 'button',
                  'data-testid': 'home-quick-import',
                  onclick: () => {
                    if (isMobileCatalogReadOnly()) {
                      void syncCatalogWithDbFlow(() => {
                        if (currentRoot) void renderHomeContent(currentRoot);
                      });
                    } else {
                      void importCatalogFlow(() => {
                        if (currentRoot) void renderHomeContent(currentRoot);
                      });
                    }
                  },
                },
                icon(isMobileCatalogReadOnly() ? 'refresh' : 'upload'),
                isMobileCatalogReadOnly() ? L('Sincronizar Catálogo', 'Sync Catalog') : L('Importar Catálogo', 'Import Catalog'),
              ),
            ),
          ),
        ),

        /* 4. SECCIÓN EN 2 COLUMNAS (DESKTOP/TABLET / SUPERVISOR) */
        supervisorUI
          ? h(
              'div',
              { class: 'dash-cols-layout' },

          // COLUMNA IZQUIERDA: Sesión y Sesiones Anteriores
          h(
            'div',
            { class: 'dash-col' },

            // Tarjeta de Sesiones Recientes
            h(
              'section',
              { class: 'card dash-section-card' },
              h(
                'div',
                { class: 'card-head' },
                h('h3', { class: 'dash-card-title' }, L('Sesiones de Conteo', 'Counting Sessions')),
                h(
                  'button',
                  {
                    class: 'btn ghost sm',
                    'data-testid': 'home-list-create-session-btn',
                    onclick: async () => {
                      if (await newSessionFlow()) navigate('/contar');
                    },
                  },
                  icon('plus'),
                  L('Crear sesión', 'Create session'),
                ),
              ),
              pastSessions.length > 0
                ? h(
                  'ul',
                  { class: 'session-list dash-session-list' },
                  pastSessions.map((ps) =>
                    h(
                      'li',
                      { class: 's-item dash-session-item' },
                      h(
                        'div',
                        { class: 'grow' },
                        h(
                          'div',
                          { class: 's-name dash-session-name' },
                          ps.name,
                          ' ',
                          ps.closed
                            ? h('span', { class: 'badge info' }, L('Cerrada', 'Closed'))
                            : h('span', { class: 'badge ok' }, L('Abierta', 'Open')),
                        ),
                        h(
                          'div',
                          { class: 'muted small' },
                          `${ps.counter} · ${fmtDateTime(ps.createdAt)}`,
                        ),
                      ),
                      h(
                        'div',
                        { class: 'row', style: 'gap: 6px;' },
                        h(
                          'button',
                          {
                            class: 'btn sm',
                            onclick: () => navigate(`/reporte?session=${ps.id}`),
                          },
                          icon('chart'),
                          L('Reporte', 'Report'),
                        ),
                        ps.closed
                          ? h(
                            'button',
                            {
                              class: 'btn sm ghost',
                              onclick: async () => {
                                await reopenSession(ps.id);
                                toast(L('Sesión reabierta y activada', 'Session reopened and activated'), 'ok');
                                navigate('/contar');
                              },
                            },
                            L('Reabrir', 'Reopen'),
                          )
                          : h(
                            'button',
                            {
                              class: 'btn sm primary',
                              onclick: async () => {
                                await reopenSession(ps.id);
                                toast(`${L('Sesión activa', 'Active session')}: ${ps.name}`, 'ok');
                                navigate('/contar');
                              },
                            },
                            L('Continuar', 'Resume'),
                          ),
                      ),
                    ),
                  ),
                )
                : h(
                  'p',
                  { class: 'muted small' },
                  L('Aún no hay sesiones previas registradas en este equipo.', 'No previous sessions recorded on this device yet.'),
                ),
            ),
          ),

          // COLUMNA DERECHA: Actividad de Kardex y Alertas de Catálogo
          h(
            'div',
            { class: 'dash-col' },

            // Tarjeta de Actividad Reciente (Kardex + Resumen Catálogo)
            h(
              'section',
              { class: 'card dash-section-card' },
              h(
                'div',
                { class: 'card-head' },
                h('h3', { class: 'dash-card-title' }, L('Actividad Reciente de Kardex', 'Recent Kardex Activity')),
                h(
                  'button',
                  { class: 'btn ghost sm', onclick: () => navigate('/movimientos') },
                  L('Abrir Kardex →', 'Open Kardex →'),
                ),
              ),
              recentMovements.length > 0
                ? h(
                  'div',
                  { class: 'dash-mini-movs-list' },
                  recentMovements.map((m) =>
                    h(
                      'div',
                      { class: `dash-mini-mov-row ${m.type === 'IN' ? 'in' : 'out'}` },
                      h(
                        'span',
                        { class: `dash-mini-badge ${m.type === 'IN' ? 'in' : 'out'}` },
                        m.type === 'IN' ? L('Entrada', 'In') : L('Salida', 'Out'),
                      ),
                      h('b', { class: 'dash-mini-sku' }, m.sku),
                      h(
                        'span',
                        { class: `dash-mini-qty ${m.type === 'IN' ? 'in' : 'out'}` },
                        `${m.type === 'IN' ? '+' : '-'}${fmtNum(m.quantity)}`,
                      ),
                      h(
                        'span',
                        { class: 'muted xsmall dash-mini-dest' },
                        m.technicianOrSupplier || m.machineOrArea || '-',
                      ),
                    ),
                  ),
                )
                : h('p', { class: 'muted small' }, L('Sin movimientos recientes en bitácora.', 'No recent movements logged.')),
              (pending > 0 || !catalogCount)
                ? h(
                  'div',
                  { class: 'row wrap', style: 'margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); justify-content: space-between; align-items: center;' },
                  h(
                    'span',
                    { class: 'warn-text small' },
                    !catalogCount
                      ? L('Sin catálogo cargado.', 'No catalog loaded.')
                      : L(`${pending} producto(s) pendiente(s) de descripción.`, `${pending} product(s) pending description.`),
                  ),
                  h(
                    'button',
                    { class: 'btn ghost sm', onclick: () => navigate('/catalogo') },
                    L('Ir a Catálogo →', 'Go to Catalog →'),
                  ),
                )
                : null,
            ),

            // Tarjeta PWA (solo cuando aplica)
            install.canPrompt
              ? h(
                'section',
                { class: 'card accent dash-section-card' },
                h('h3', { class: 'dash-card-title' }, L('Instalar Aplicación', 'Install App')),
                h(
                  'p',
                  { class: 'small' },
                  L('Instala la app en tu dispositivo para acceso directo y uso offline.', 'Install the app on your device for direct access and offline use.'),
                ),
                h(
                  'button',
                  { class: 'btn primary sm', onclick: promptInstall },
                  L('Instalar PWA', 'Install PWA'),
                ),
              )
              : install.iosHint
                ? h(
                  'section',
                  { class: 'card accent dash-section-card' },
                  h('h3', { class: 'dash-card-title' }, L('Instalar en iPhone', 'Install on iPhone')),
                  h(
                    'p',
                    { class: 'small' },
                    L('En Safari toca ', 'In Safari tap '),
                    h('b', null, L('Compartir', 'Share')),
                    L(' y ', ' and '),
                    h('b', null, L('“Agregar a pantalla de inicio”', '“Add to Home Screen”')),
                    '.',
                  ),
                )
                : null,
          ),
        )
          : null,
      ),
    );
}

export const homeView: View = {
  title: () => L('Inicio', 'Home'),
  async render(root) {
    currentRoot = root;
    const seq = ++homeRenderSeq;
    lastHomeDataFp = '';
    if (unsubscribeHomeCloud) {
      unsubscribeHomeCloud();
      unsubscribeHomeCloud = null;
    }
    if (homeCloudTimer) {
      clearTimeout(homeCloudTimer);
      homeCloudTimer = null;
    }
    unsubscribeHomeCloud = onCloudRoomUpdate((roomState) => {
      if (currentRoot !== root) return;
      if (typeof document !== 'undefined' && document.querySelector?.('dialog[open]')) return;
      if (roomState) {
        const nextFp = computeRoomDataSig(roomState);
        if (nextFp && nextFp === lastHomeDataFp) return;
        lastHomeDataFp = nextFp;
      }
      if (homeCloudTimer) clearTimeout(homeCloudTimer);
      homeCloudTimer = setTimeout(() => {
        homeCloudTimer = null;
        if (currentRoot !== root) return;
        void renderHomeContent(root);
      }, 0);
    });
    await renderHomeContent(root, seq);
  },
  destroy() {
    currentRoot = null;
    homeRenderSeq++;
    if (homeCloudTimer) {
      clearTimeout(homeCloudTimer);
      homeCloudTimer = null;
    }
    if (unsubscribeHomeCloud) {
      unsubscribeHomeCloud();
      unsubscribeHomeCloud = null;
    }
  },
};
