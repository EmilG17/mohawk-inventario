import {
  allProducts,
  allSessions,
  closeSession,
  countsForSession,
  createSession,
  getActiveSession,
  reopenSession,
} from '../db/db';
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
  const name = await promptDialog('¿Quién está contando?', 'Tu nombre', s.counterName, {
    autocomplete: 'name',
    maxlength: 40,
    placeholder: 'Ej. Juan Pérez',
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
    toast('Captura tu nombre para iniciar', 'warn');
    return false;
  }
  const d = new Date();
  const def = `Inventario ${d.toLocaleDateString('es-MX')} ${counter.split(' ')[0]}`;
  const name = await promptDialog('Nueva sesión de conteo', 'Nombre de la sesión', def, {
    maxlength: 60,
  });
  if (!name) return false;
  await createSession(name.trim() || def, counter);
  toast('Sesión creada', 'ok');
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

    const todayStr = new Intl.DateTimeFormat('es-MX', {
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
                    h('div', { class: 'muted xsmall' }, `Operador · ${todayStr}`),
                    h('div', { class: 'big' }, s.counterName || 'Sin asignar'),
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
                    'Cambiar',
                  ),
                ),
                h(
                  'div',
                  { class: 'dash-tag-row' },
                  h('span', { class: 'badge info' }, platform.label),
                  cloudStatus.roomCode && cloudStatus.state === 'connected'
                    ? h('span', { class: 'badge ok' }, `Sala: ${cloudStatus.roomCode}`)
                    : cloudStatus.roomCode
                      ? h('span', { class: 'badge warn' }, `Sala: ${cloudStatus.roomCode}`)
                      : h('span', { class: 'badge default' }, 'Local'),
                  h(
                    'span',
                    { class: navigator.onLine ? 'badge ok' : 'badge warn' },
                    navigator.onLine ? 'En línea' : 'Sin conexión',
                  ),
                  !session
                    ? h(
                        'h2',
                        { class: 'badge warn dash-idle-pill', 'data-testid': 'home-idle-badge', style: 'margin:0; font-weight:700;' },
                        'Sin sesión activa',
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
              h('span', { class: 'dash-kpi-label' }, 'Sesión'),
              session
                ? h('span', { class: 'badge ok' }, 'Activa')
                : h('span', { class: 'badge default' }, 'Inactiva'),
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
                ? `${session.name} · ${fmtNum(units)} pzas (${counts.length})`
                : 'Sin sesión activa',
            ),
          ),

          // KPI 2: Catálogo
          h(
            'div',
            { class: 'dash-kpi-card clickable', 'data-testid': 'home-kpi-catalog', onclick: () => navigate('/catalogo') },
            h(
              'div',
              { class: 'dash-kpi-header' },
              h('span', { class: 'dash-kpi-label' }, 'Catálogo'),
              h('span', { class: 'badge info' }, `${fmtNum(catalogCount)} SKUs`),
            ),
            h('div', { class: 'dash-kpi-value' }, fmtNum(catalogCount)),
            h(
              'div',
              { class: 'dash-kpi-sub' },
              `${fmtNum(withExpected)} con ideal${uncatalogedCount > 0 ? ` · ${uncatalogedCount} nuevos` : ''}`,
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
              h('span', { class: 'badge ok' }, `${totalMovements} movs`),
            ),
            h(
              'div',
              { class: 'dash-kpi-value flow' },
              h('span', { class: 'in-text' }, `+${fmtNum(Math.round(totalIn))}`),
              ' / ',
              h('span', { class: 'out-text' }, `-${fmtNum(Math.round(totalOut))}`),
            ),
            h('div', { class: 'dash-kpi-sub' }, 'Entradas / salidas'),
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
                cloudStatus.state === 'connected' ? 'En vivo' : 'Local',
              ),
            ),
            h(
              'div',
              { class: 'dash-kpi-value' },
              cloudStatus.state === 'connected' ? 'Conectado' : 'Local',
            ),
            h(
              'div',
              { class: 'dash-kpi-sub' },
              cloudStatus.roomCode ? `Sala ${cloudStatus.roomCode}` : 'Solo este equipo',
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
                'Continuar conteo físico',
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
                      'Ver reporte de diferencias',
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
                      'Crear sesión',
                    )
                  : null,
                h(
                  'button',
                  {
                    class: 'btn sm danger ghost',
                    'data-testid': 'home-close-session-btn',
                    onclick: async () => {
                      const ok = await confirmDialog(
                        'Finalizar sesión de conteo',
                        `¿Deseas finalizar la sesión "${session.name}"? Los datos quedarán guardados y listos para consulta o reporte.`,
                        'Finalizar sesión',
                        true,
                      );
                      if (ok) {
                        await closeSession(session.id);
                        toast('Sesión finalizada con éxito', 'ok');
                        navigate('/');
                      }
                    },
                  },
                  icon('check'),
                  'Finalizar sesión',
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
                'Iniciar nueva sesión de conteo',
              ),
            ),

          h('div', { class: 'dash-divider' }),

          // Acciones Rápidas de Flujo (1 clic)
          h(
            'div',
            { class: 'dash-flow-section' },
            h('span', { class: 'dash-flow-label muted xsmall uppercase' }, 'Accesos rápidos'),
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
                '+ Entrada Kardex',
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
                '− Salida Kardex',
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
                    'Unificar Reportes',
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
                    'Cola de Rótulos',
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
                isMobileCatalogReadOnly() ? 'Sincronizar Catálogo' : 'Importar Catálogo',
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
                h('h3', { class: 'dash-card-title' }, 'Sesiones de Conteo'),
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
                  'Crear sesión',
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
                            ? h('span', { class: 'badge info' }, 'Cerrada')
                            : h('span', { class: 'badge ok' }, 'Abierta'),
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
                          'Reporte',
                        ),
                        ps.closed
                          ? h(
                            'button',
                            {
                              class: 'btn sm ghost',
                              onclick: async () => {
                                await reopenSession(ps.id);
                                toast('Sesión reabierta y activada', 'ok');
                                navigate('/contar');
                              },
                            },
                            'Reabrir',
                          )
                          : h(
                            'button',
                            {
                              class: 'btn sm primary',
                              onclick: async () => {
                                await reopenSession(ps.id);
                                toast(`Sesión activa: ${ps.name}`, 'ok');
                                navigate('/contar');
                              },
                            },
                            'Continuar',
                          ),
                      ),
                    ),
                  ),
                )
                : h(
                  'p',
                  { class: 'muted small' },
                  'Aún no hay sesiones previas registradas en este equipo.',
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
                h('h3', { class: 'dash-card-title' }, 'Actividad Reciente de Kardex'),
                h(
                  'button',
                  { class: 'btn ghost sm', onclick: () => navigate('/movimientos') },
                  'Abrir Kardex →',
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
                        m.type === 'IN' ? 'Entrada' : 'Salida',
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
                : h('p', { class: 'muted small' }, 'Sin movimientos recientes en bitácora.'),
              (pending > 0 || !catalogCount)
                ? h(
                  'div',
                  { class: 'row wrap', style: 'margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); justify-content: space-between; align-items: center;' },
                  h(
                    'span',
                    { class: 'warn-text small' },
                    !catalogCount
                      ? 'Sin catálogo cargado.'
                      : `${pending} producto(s) pendiente(s) de descripción.`,
                  ),
                  h(
                    'button',
                    { class: 'btn ghost sm', onclick: () => navigate('/catalogo') },
                    'Ir a Catálogo →',
                  ),
                )
                : null,
            ),

            // Tarjeta PWA (solo cuando aplica)
            install.canPrompt
              ? h(
                'section',
                { class: 'card accent dash-section-card' },
                h('h3', { class: 'dash-card-title' }, 'Instalar Aplicación'),
                h(
                  'p',
                  { class: 'small' },
                  'Instala la app en tu dispositivo para acceso directo y uso offline.',
                ),
                h(
                  'button',
                  { class: 'btn primary sm', onclick: promptInstall },
                  'Instalar PWA',
                ),
              )
              : install.iosHint
                ? h(
                  'section',
                  { class: 'card accent dash-section-card' },
                  h('h3', { class: 'dash-card-title' }, 'Instalar en iPhone'),
                  h(
                    'p',
                    { class: 'small' },
                    'En Safari toca ',
                    h('b', null, 'Compartir'),
                    ' y ',
                    h('b', null, '“Agregar a pantalla de inicio”'),
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
  title: 'Inicio',
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
