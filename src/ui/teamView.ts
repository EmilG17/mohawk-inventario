import { L } from '../i18n/i18n';
import { loadSettings } from '../settings';
import {
  getCloudConnectionStatus,
  onCloudRoomUpdate,
  onCloudStatusChange,
  startLiveCloudSync,
} from '../sync/cloudSync';
import { isMobileViewport, isSupervisorModeEnabled } from './catalogMode';
import { clear, fmtNum, h, icon } from './dom';
import { newSessionFlow } from './home';
import { navigate, type View } from './router';
import { promptSupervisorPin, switchToSupervisorSession } from './supervisorAuth';
import { createTeamConfigController, type TeamConfigController } from './team/teamConfigDrawer';
import { buildTeamDashboardData } from './team/teamData';
import { renderLiveFeedTab } from './team/teamFeedTab';
import { createMatrixTabRenderer } from './team/teamMatrixTab';
import { openRoomInviteQrDialog } from './team/teamQrDialogs';
import { renderSessionsTab } from './team/teamSessionsTab';
import { renderTechsTab } from './team/teamTechsTab';
import {
  fmtRelativeAgo,
  type FeedFilter,
  type MatrixFilter,
  type SupervisorTab,
} from './team/teamTypes';

let activeTab: SupervisorTab = 'techs';
let userSelectedTab = false;
let feedFilter: FeedFilter = 'all';
let selectedTechFilter = '';
let matrixFilter: MatrixFilter = 'all';
let matrixSearch = '';
let configExpanded: boolean | null = null;

let unsubscribeRoom: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;
let relativeTimeTimer: ReturnType<typeof setInterval> | null = null;
let teamRoomTimer: ReturnType<typeof setTimeout> | null = null;
let configController: TeamConfigController | null = null;
let teamMounted = false;
let teamMountSeq = 0;
let teamRefreshSeq = 0;

function cleanupTeamResources(): void {
  if (teamRoomTimer) {
    clearTimeout(teamRoomTimer);
    teamRoomTimer = null;
  }
  if (unsubscribeRoom) {
    unsubscribeRoom();
    unsubscribeRoom = null;
  }
  if (unsubscribeStatus) {
    unsubscribeStatus();
    unsubscribeStatus = null;
  }
  if (relativeTimeTimer) {
    clearInterval(relativeTimeTimer);
    relativeTimeTimer = null;
  }
  if (configController) {
    configController.destroy();
    configController = null;
  }
}

export const teamView: View = {
  title: () => L('Monitor de Supervisor en Vivo', 'Live Supervisor Monitor'),
  async render(root) {
    cleanupTeamResources();
    teamMounted = true;
    const mountSeq = ++teamMountSeq;
    let s = await loadSettings();
    if (!teamMounted || mountSeq !== teamMountSeq) return;

    if (s.syncRoomCode) {
      startLiveCloudSync({
        roomCode: s.syncRoomCode,
        endpointUrl: s.syncEndpointUrl,
      });
    }

    if (configExpanded === null || !s.syncRoomCode || !s.syncEndpointUrl) {
      configExpanded = !s.syncRoomCode || !s.syncEndpointUrl;
    }

    const statusHeaderWrap = h('div');
    const errorBannerWrap = h('div');
    const configDrawerWrap = h('div');
    const kpiGridWrap = h('div', { class: 'sup-kpi-grid' });
    const noSessionBannerWrap = h('div');
    const tabsBarWrap = h('div', { class: 'sup-tabs-bar' });
    const tabContentWrap = h('div', { class: 'sup-tab-body' });

    clear(
      root,
      statusHeaderWrap,
      errorBannerWrap,
      configDrawerWrap,
      kpiGridWrap,
      noSessionBannerWrap,
      tabsBarWrap,
      tabContentWrap,
    );

    const matrixRenderer = createMatrixTabRenderer();

    const refreshDashboard = async () => {
      if (!teamMounted || mountSeq !== teamMountSeq) return;
      const refreshSeq = ++teamRefreshSeq;
      const supervisorUI = isSupervisorModeEnabled();
      const data = await buildTeamDashboardData({
        syncRoomCode: s.syncRoomCode,
        supervisorUI,
      });
      if (!teamMounted || mountSeq !== teamMountSeq || refreshSeq !== teamRefreshSeq) return;

      if (!supervisorUI) {
        clear(kpiGridWrap);
        clear(tabsBarWrap);
        clear(tabContentWrap);
        clear(
          noSessionBannerWrap,
          h(
            'div',
            { class: 'card', style: 'padding: 24px; border-radius: 14px; margin-bottom: 16px; border: 1px solid var(--border); box-shadow: var(--shadow-sm);' },
            h(
              'div',
              { class: 'row wrap', style: 'align-items: center; justify-content: space-between; gap: 16px;' },
              h(
                'div',
                { style: 'max-width: 600px;' },
                h('div', { class: 'badge info', style: 'margin-bottom: 8px; font-weight: 700;' }, L('Modo Cliente-Técnico Activo', 'Client-Technician Mode Active')),
                h('h3', { style: 'margin: 0 0 6px 0; font-size: 20px; font-weight: 800;' }, L('Terminal de Conteo Protegido', 'Protected Counting Terminal')),
                h('p', { class: 'muted small', style: 'margin: 0 0 12px 0; line-height: 1.5;' },
                  L(
                    'Tu dispositivo está configurado como terminal de conteo operativo. Las lecturas se transmiten en tiempo real a la sala del supervisor. La sesión de supervisor y la administración de catálogo están separadas y protegidas con PIN.',
                    'Your device is configured as an operational counting terminal. Barcode scans are streamed in real-time to the supervisor room. The supervisor session and catalog administration are separated and protected with a PIN.',
                  ),
                ),
                h(
                  'div',
                  { class: 'row wrap', style: 'gap: 8px;' },
                  h('span', { class: 'chip' }, `${L('Sala:', 'Room:')} ${s.syncRoomCode || 'Local'}`),
                  data.current ? h('span', { class: 'chip' }, `${L('Tu sesión:', 'Your session:')} ${data.current.name}`) : null,
                  h('span', { class: 'chip' }, `${data.curCounts.length} ${L('lecturas enviadas', 'scans sent')}`),
                ),
              ),
              h(
                'div',
                { class: 'col', style: 'gap: 8px; align-items: stretch; min-width: 200px;' },
                h(
                  'button',
                  {
                    class: 'btn primary',
                    style: 'min-height: 46px; font-weight: 700;',
                    onclick: () => navigate('/contar'),
                  },
                  icon('scan'),
                  L('Ir a Escanear / Contar', 'Go to Scan / Count'),
                ),
                isMobileViewport()
                  ? h(
                      'button',
                      {
                        class: 'btn ghost',
                        style: 'min-height: 40px;',
                        onclick: async () => {
                          const ok = await promptSupervisorPin();
                          if (ok) {
                            await switchToSupervisorSession();
                            s = await loadSettings();
                            configController?.updateSettings(s);
                            configController?.renderStatusHeader(getCloudConnectionStatus());
                            configController?.renderConfigDrawer();
                            await refreshDashboard();
                          }
                        },
                      },
                      icon('lock'),
                      L('Acceder como Supervisor (PIN)', 'Access as Supervisor (PIN)'),
                    )
                  : null,
              ),
            ),
          ),
        );
        return;
      }

      clear(
        kpiGridWrap,
        h(
          'div',
          {
            class: 'sup-kpi-card clickable',
            onclick: () => {
              activeTab = 'techs';
              void refreshDashboard();
            },
          },
          h('div', { class: 'sup-kpi-label' }, L('Técnicos Participantes', 'Participating Technicians')),
          h('div', { class: 'sup-kpi-value' }, `${data.techList.length}`),
          h(
            'div',
            { class: 'sup-kpi-sub' },
            data.activeNowCount > 0
              ? L(`● ${data.activeNowCount} activo(s) en los últimos 5 min`, `● ${data.activeNowCount} active in last 5 min`)
              : `${data.curCounts.length} ${L('lecturas acumuladas', 'total scans')}`,
          ),
        ),
        h(
          'div',
          {
            class: 'sup-kpi-card clickable',
            onclick: () => {
              activeTab = 'matrix';
              matrixFilter = 'all';
              void refreshDashboard();
            },
          },
          h('div', { class: 'sup-kpi-label' }, L('Avance de Conteo Físico', 'Physical Count Progress')),
          h('div', { class: 'sup-kpi-value' }, `${fmtNum(data.totalUnitsCounted)} u.`),
          h(
            'div',
            { class: 'sup-kpi-sub' },
            L(
              `${data.countedSkusCount} de ${data.totalCatalogSkus} SKUs contados (${data.progressPct}%)`,
              `${data.countedSkusCount} of ${data.totalCatalogSkus} SKUs counted (${data.progressPct}%)`,
            ),
          ),
          h(
            'div',
            { class: 'sup-progress-track' },
            h('div', { class: 'sup-progress-fill', style: `width: ${data.progressPct}%;` }),
          ),
        ),
        h(
          'div',
          {
            class: 'sup-kpi-card clickable',
            onclick: () => {
              activeTab = 'feed';
              feedFilter = 'movements';
              void refreshDashboard();
            },
          },
          h('div', { class: 'sup-kpi-label' }, L('Flujo Kardex (Entradas / Salidas)', 'Kardex Flow (In / Out)')),
          h(
            'div',
            { class: 'sup-kpi-value', style: 'display: flex; gap: 10px; align-items: baseline;' },
            h('span', { style: 'color: var(--success);' }, `+${fmtNum(data.totalInUnits)}`),
            h('span', { style: 'color: var(--danger);' }, `−${fmtNum(data.totalOutUnits)}`),
          ),
          h('div', { class: 'sup-kpi-sub' }, `${data.movements.length} ${L('movimiento(s) en bitácora', 'movement(s) logged')}`),
        ),
        h(
          'div',
          {
            class: 'sup-kpi-card clickable',
            onclick: () => {
              activeTab = 'matrix';
              matrixFilter = 'alerts';
              void refreshDashboard();
            },
          },
          h('div', { class: 'sup-kpi-label' }, L('Alertas vs. Inventario Ideal', 'Alerts vs. Ideal Stock')),
          h(
            'div',
            {
              class: 'sup-kpi-value',
              style: data.alertSkusCount > 0 ? 'color: var(--danger);' : 'color: var(--success);',
            },
            `${data.alertSkusCount} SKUs`,
          ),
          h(
            'div',
            { class: 'sup-kpi-sub' },
            L(`${data.criticalCount} críticos · ${data.deficitCount} en déficit`, `${data.criticalCount} critical · ${data.deficitCount} deficit`),
          ),
        ),
      );

      if (!userSelectedTab && !data.current && !data.hasLiveRoomData) {
        activeTab = 'sessions';
      } else if (!userSelectedTab && (data.current || data.hasLiveRoomData) && activeTab === 'sessions') {
        activeTab = 'techs';
      }

      const tabs: { id: SupervisorTab; label: string }[] = [
        { id: 'techs', label: `${L('Técnicos en Vivo', 'Live Techs')} (${data.techList.length})` },
        { id: 'feed', label: `${L('Feed en Tiempo Real', 'Live Feed')} (${data.curCounts.length + data.movements.length})` },
        { id: 'matrix', label: `${L('Matriz de Avance por SKU', 'SKU Progress Matrix')} (${data.reportLines.length})` },
        { id: 'sessions', label: `${L('Sesiones y Archivos', 'Sessions & Files')} (${data.sessions.length})` },
      ];

      clear(
        noSessionBannerWrap,
        !data.current
          ? h(
              'div',
              {
                class: 'card',
                'data-testid': 'team-no-session-badge',
                style:
                  'width: 100%; margin: 0 0 14px 0; padding: 14px 18px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px;',
              },
              h(
                'div',
                null,
                h('h2', { style: 'margin: 0 0 2px 0; font-size: 16px;' }, L('Sin sesión activa', 'No active session')),
                h(
                  'div',
                  { class: 'muted small' },
                  data.roomState && (data.hasLiveRoomData || data.products.length > 0)
                    ? L(
                        `Monitoreando en vivo Sala ${data.roomState.roomCode} (${data.roomState.sessionName || 'Remota'}) · ${data.curCounts.length} lectura(s) · ${data.products.length} SKUs`,
                        `Monitoring live Room ${data.roomState.roomCode} (${data.roomState.sessionName || 'Remote'}) · ${data.curCounts.length} scan(s) · ${data.products.length} SKUs`,
                      )
                    : L('Inicia o reabre una sesión para activar el conteo de piso.', 'Start or reopen a session to enable floor counting.'),
                ),
              ),
              h(
                'button',
                {
                  class: 'btn primary sm',
                  type: 'button',
                  'data-testid': 'team-start-session-btn',
                  onclick: async () => {
                    if (await newSessionFlow()) navigate('/contar');
                  },
                },
                icon('scan'),
                L('Iniciar nueva sesión', 'Start new session'),
              ),
            )
          : null,
      );

      clear(
        tabsBarWrap,
        tabs.map((t) =>
          h(
            'button',
            {
              class: `sup-tab-btn ${activeTab === t.id ? 'active' : ''}`,
              type: 'button',
              'data-testid': `team-tab-${t.id}`,
              onclick: () => {
                userSelectedTab = true;
                activeTab = t.id;
                void refreshDashboard();
              },
            },
            t.label,
          ),
        ),
      );

      if (activeTab === 'techs') {
        renderTechsTab({
          container: tabContentWrap,
          roomCode: s.syncRoomCode,
          techList: data.techList,
          totalUnits: data.totalUnitsCounted,
          current: data.current,
          activeLiveScanners: data.activeLiveScanners,
          prodByBarcode: data.prodByBarcode,
          prodBySku: data.prodBySku,
          onOpenInvite: () => openRoomInviteQrDialog(s.syncRoomCode, s.syncEndpointUrl),
          onSelectTech: (name) => {
            selectedTechFilter = name;
            activeTab = 'feed';
            userSelectedTab = true;
            void refreshDashboard();
          },
        });
      } else if (activeTab === 'feed') {
        renderLiveFeedTab({
          container: tabContentWrap,
          roomCode: s.syncRoomCode,
          counts: data.curCounts,
          movements: data.movements,
          prodByBarcode: data.prodByBarcode,
          prodBySku: data.prodBySku,
          activeLiveScanners: data.activeLiveScanners,
          feedFilter,
          selectedTechFilter,
          onChangeFeedFilter: (next) => {
            feedFilter = next;
            void refreshDashboard();
          },
          onClearTechFilter: () => {
            selectedTechFilter = '';
            void refreshDashboard();
          },
        });
      } else if (activeTab === 'matrix') {
        matrixRenderer.render({
          container: tabContentWrap,
          lines: data.reportLines,
          counts: data.curCounts,
          matrixFilter,
          matrixSearch,
          onSearchChange: (q) => {
            matrixSearch = q;
          },
          onFilterChange: (next) => {
            matrixFilter = next;
            void refreshDashboard();
          },
        });
      } else {
        renderSessionsTab({
          container: tabContentWrap,
          sessions: data.sessions,
          current: data.current,
          curCounts: data.curCounts,
          products: data.products,
          deviceId: data.deviceId,
          syncRoomCode: s.syncRoomCode,
          syncEndpointUrl: s.syncEndpointUrl,
          onRefresh: () => void refreshDashboard(),
        });
      }
    };

    configController = createTeamConfigController({
      initialSettings: s,
      statusHeaderWrap,
      errorBannerWrap,
      configDrawerWrap,
      initialExpanded: Boolean(configExpanded),
      onExpandedChange: (exp) => {
        configExpanded = exp;
      },
      onAfterSyncOrRoleChange: async (next) => {
        s = next;
        await refreshDashboard();
      },
    });

    configController.renderStatusHeader(getCloudConnectionStatus());
    configController.renderConfigDrawer();
    await refreshDashboard();

    if (!teamMounted || mountSeq !== teamMountSeq) return;

    unsubscribeStatus = onCloudStatusChange((st) => {
      if (teamMounted && mountSeq === teamMountSeq) {
        configController?.renderStatusHeader(st);
      }
    });

    unsubscribeRoom = onCloudRoomUpdate(() => {
      if (!teamMounted || mountSeq !== teamMountSeq) return;
      if (teamRoomTimer) clearTimeout(teamRoomTimer);
      teamRoomTimer = setTimeout(() => {
        teamRoomTimer = null;
        if (teamMounted && mountSeq === teamMountSeq) {
          void refreshDashboard();
        }
      }, 80);
    });

    relativeTimeTimer = setInterval(() => {
      if (!teamMounted || mountSeq !== teamMountSeq) return;
      const el = document.getElementById('sup-last-sync-ago');
      if (el) {
        const ts = Number(el.getAttribute('data-ts'));
        if (ts) el.textContent = `${L('Actualizado:', 'Updated:')} ${fmtRelativeAgo(ts)}`;
      }
    }, 5000);
  },

  destroy() {
    teamMounted = false;
    teamMountSeq++;
    teamRefreshSeq++;
    userSelectedTab = false;
    cleanupTeamResources();
  },
};
