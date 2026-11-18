import { getActiveSession } from '../db/db';
import { L, applyDocumentLang } from '../i18n/i18n';
import { startPendingWatcher } from '../lookup/pendingQueue';
import { loadSettings, saveSettings, settingsSync } from '../settings';
import {
  consumeUrlSyncParams,
  getCloudConnectionStatus,
  onCloudRoomUpdate,
  onCloudStatusChange,
  startLiveCloudSync,
} from '../sync/cloudSync';
import { catalogView } from './catalog';
import { isSupervisorModeEnabled } from './catalogMode';
import { countView } from './count';
import { clear, h, icon, toast } from './dom';
import { homeView } from './home';
import { initInstall } from './install';
import { createBrandLogo } from './logo';
import { movementsView } from './movementsView';
import { reportView } from './reportView';
import { currentPath, navigate, registerRoute, startRouter } from './router';
import { settingsView } from './settingsView';
import { promptSupervisorPin, switchToSupervisorSession, switchToTechnicianSession } from './supervisorAuth';
import { teamView } from './teamView';

export interface PlatformInfo {
  platform: 'mobile' | 'tablet' | 'desktop';
  isTouch: boolean;
  label: string;
}

export function detectPlatformInfo(): PlatformInfo {
  const width = window.innerWidth;
  const isTouch =
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    window.matchMedia('(pointer: coarse)').matches;

  if (width < 900) {
    return { platform: 'mobile', isTouch, label: L('Terminal Móvil', 'Mobile Terminal') };
  }
  if (width <= 1024 && isTouch) {
    return { platform: 'tablet', isTouch, label: L('Tableta Industrial', 'Industrial Tablet') };
  }
  return { platform: 'desktop', isTouch, label: L('Estación de Trabajo', 'Workstation') };
}

const NAV_ITEMS: { path: string; labelEs: string; labelEn: string; icon: string; shortcut?: string; testId: string }[] = [
  { path: '/', labelEs: 'Inicio', labelEn: 'Home', icon: 'home', shortcut: '1', testId: 'nav-home' },
  { path: '/contar', labelEs: 'Contar', labelEn: 'Count', icon: 'scan', shortcut: '2', testId: 'nav-count' },
  { path: '/movimientos', labelEs: 'Kardex', labelEn: 'Kardex', icon: 'swap', shortcut: '3', testId: 'nav-movements' },
  { path: '/catalogo', labelEs: 'Catálogo', labelEn: 'Catalog', icon: 'list', shortcut: '4', testId: 'nav-catalog' },
  { path: '/reporte', labelEs: 'Reporte', labelEn: 'Report', icon: 'chart', shortcut: '5', testId: 'nav-report' },
  { path: '/equipo', labelEs: 'Supervisor', labelEn: 'Supervisor', icon: 'users', shortcut: '6', testId: 'nav-team' },
  { path: '/ajustes', labelEs: 'Ajustes', labelEn: 'Settings', icon: 'gear', shortcut: '7', testId: 'nav-settings' },
];

export function notifyLanguageChanged(): void {
  applyDocumentLang();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('mhk:languagechange'));
  }
}

const MOBILE_PRIMARY_PATHS = new Set(['/', '/contar', '/movimientos', '/catalogo']);

export async function bootstrapApp(): Promise<void> {
  const initialSettings = await loadSettings();
  applyDocumentLang();
  const urlJoin = await consumeUrlSyncParams();
  if (!urlJoin && initialSettings.syncEnabled && initialSettings.syncRoomCode) {
    startLiveCloudSync({
      roomCode: initialSettings.syncRoomCode,
      endpointUrl: initialSettings.syncEndpointUrl,
    });
  }

  registerRoute('/', homeView);
  registerRoute('/contar', countView);
  registerRoute('/movimientos', movementsView);
  registerRoute('/catalogo', catalogView);
  registerRoute('/reporte', reportView);
  registerRoute('/equipo', teamView);
  registerRoute('/ajustes', settingsView);

  const appEl = document.getElementById('app')!;

  const SIDEBAR_STORAGE_KEY = 'mhk_sidebar_hidden';
  let sidebarHidden = false;
  try {
    sidebarHidden = localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1';
  } catch {
    sidebarHidden = false;
  }

  const sidebarPlatformBadge = h('span', { class: 'sidebar-platform-badge' });
  const applyPlatformAttributes = () => {
    const info = detectPlatformInfo();
    appEl.setAttribute('data-platform', info.platform);
    appEl.setAttribute('data-touch', String(info.isTouch));
    appEl.setAttribute('data-supervisor', String(isSupervisorModeEnabled()));
    document.documentElement.setAttribute('data-platform', info.platform);
    sidebarPlatformBadge.textContent = info.label;
  };
  applyPlatformAttributes();

  let resizeTimer: any = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      applyPlatformAttributes();
      if (window.innerWidth >= 900) closeMoreSheet();
    }, 120);
  });

  const titleEl = h('h1', { class: 'brand-title' }, L('Inventario de Consumibles', 'Consumables Inventory'));
  const headerKickerEl = h('span', { class: 'brand-kicker' }, L('HHF · TALLER DE REPARACIONES', 'HHF · REPAIR SHOP'));
  const cloudBadge = h('button', {
    class: 'top-cloud-pill',
    type: 'button',
    hidden: true,
    title: L('Estado de sincronización en tiempo real (clic para abrir Monitor de Supervisor)', 'Live sync status (click to open Supervisor Monitor)'),
    onclick: () => navigate('/equipo'),
  });
  const sessionBadge = h('span', { class: 'top-session muted small' });
  const onlineDot = h('span', { class: 'online-dot', title: navigator.onLine ? L('En línea', 'Online') : L('Sin conexión', 'Offline') });

  const mobileBrandLogoEl = createBrandLogo(30);

  // Top header (para pantallas móviles < 900px)
  const header = h('header', { class: 'app-header' },
    h('div', { class: 'header-left', onclick: () => navigate('/') },
      mobileBrandLogoEl,
      h('div', { class: 'header-brand-stack' },
        headerKickerEl,
        titleEl,
      ),
    ),
    h('div', { class: 'header-right' },
      cloudBadge,
      sessionBadge,
      onlineDot,
    ),
  );

  // Desktop Sidebar (visible en pantallas >= 900px)
  const sidebarBrandLogoEl = createBrandLogo(38);
  const sidebarBrandSubEl = h('span', { class: 'sidebar-brand-sub' }, L('Registro de Consumibles · Taller de Reparaciones', 'Consumables Registry · Repair Shop'));
  const sidebarSessionLabelEl = h('div', { class: 'muted xsmall' }, L('Sesión activa', 'Active session'));

  const sidebarCloudPill = h('button', {
    class: 'sidebar-cloud-pill',
    type: 'button',
    onclick: () => navigate('/equipo'),
  });

  const sidebarSessionBox = h('div', {
    class: 'sidebar-session-box',
    onclick: () => navigate('/'),
  },
  sidebarSessionLabelEl,
  h('div', { class: 'sidebar-session-name' }, L('Cargando...', 'Loading...')),
  );

  const allNavElements: { path: string; el: HTMLElement }[] = [];
  const labelBindings: Array<{ el: HTMLElement; es: string; en: string }> = [];

  const sidebarNavList = h('nav', { class: 'sidebar-nav', 'aria-label': L('Navegación de escritorio', 'Desktop navigation') },
    NAV_ITEMS.map((item) => {
      const lbl = h('span', { class: 'sidebar-nav-label' }, L(item.labelEs, item.labelEn));
      labelBindings.push({ el: lbl, es: item.labelEs, en: item.labelEn });
      const btn = h('button', {
        class: 'sidebar-nav-btn',
        'data-path': item.path,
        'data-testid': `sidebar-${item.testId}`,
        onclick: () => navigate(item.path),
      },
      icon(item.icon),
      lbl,
      item.shortcut ? h('span', { class: 'sidebar-nav-shortcut' }, item.shortcut) : null,
      );
      allNavElements.push({ path: item.path, el: btn });
      return btn;
    }),
  );

  const sidebarCollapseBtn = h('button', {
    class: 'sidebar-collapse-btn',
    type: 'button',
    'data-testid': 'sidebar-collapse-btn',
    title: L('Ocultar panel lateral (Ctrl+B)', 'Hide side panel (Ctrl+B)'),
    'aria-label': L('Ocultar panel lateral', 'Hide side panel'),
    onclick: (e: Event) => {
      e.stopPropagation();
      setSidebarHidden(true);
    },
  }, icon('chevronLeft'));

  const sidebar = h('aside', { class: 'app-sidebar', 'aria-hidden': String(sidebarHidden) },
    h('div', { class: 'sidebar-head', onclick: () => navigate('/') },
      h('div', { class: 'sidebar-head-top' },
        h('div', { class: 'sidebar-brand-row' },
          sidebarBrandLogoEl,
          h('div', { class: 'sidebar-title-wrap' },
            h('span', { class: 'sidebar-brand-name' }, 'HHF'),
            sidebarBrandSubEl,
          ),
        ),
        sidebarCollapseBtn,
      ),
      sidebarPlatformBadge,
    ),
    sidebarSessionBox,
    sidebarNavList,
    h('div', { class: 'sidebar-footer' },
      sidebarCloudPill,
      h('div', { class: 'sidebar-status-row' },
        h('span', { class: 'sidebar-net-indicator' },
          h('span', { class: 'online-dot' }),
          h('span', { class: 'sidebar-net-text muted small' }, navigator.onLine ? L('En línea', 'Online') : L('Modo local', 'Local mode')),
        ),
        h('span', { class: 'sidebar-version muted xsmall' }, 'v4.0 PWA'),
      ),
    ),
  );

  const WORKFLOW_PRIMARY: { path: string; step: string; labelEs: string; labelEn: string; testId: string }[] = [
    { path: '/catalogo', step: '1', labelEs: 'Catálogo', labelEn: 'Catalog', testId: 'workflow-catalog' },
    { path: '/contar', step: '2', labelEs: 'Contar', labelEn: 'Count', testId: 'workflow-count' },
    { path: '/movimientos', step: '3', labelEs: 'Kardex', labelEn: 'Kardex', testId: 'workflow-kardex' },
    { path: '/reporte', step: '4', labelEs: 'Reporte', labelEn: 'Report', testId: 'workflow-report' },
  ];

  const WORKFLOW_TOOLS: { path: string; labelEs: string; labelEn: string; iconName: string; testId: string }[] = [
    { path: '/equipo', labelEs: 'Supervisor', labelEn: 'Supervisor', iconName: 'users', testId: 'workflow-team' },
    { path: '/ajustes', labelEs: 'Ajustes', labelEn: 'Settings', iconName: 'gear', testId: 'workflow-settings' },
  ];

  const sidebarToggleLabel = h('span', { class: 'sidebar-toggle-label' }, sidebarHidden ? L('Panel', 'Panel') : '');
  const sidebarToggleBtn = h('button', {
    class: 'sidebar-toggle-btn',
    type: 'button',
    'data-testid': 'sidebar-toggle-btn',
    'aria-expanded': String(!sidebarHidden),
    title: sidebarHidden ? L('Mostrar panel lateral (Ctrl+B)', 'Show side panel (Ctrl+B)') : L('Ocultar panel lateral (Ctrl+B)', 'Hide side panel (Ctrl+B)'),
    'aria-label': sidebarHidden ? L('Mostrar panel lateral', 'Show side panel') : L('Ocultar panel lateral', 'Hide side panel'),
    onclick: () => setSidebarHidden(!sidebarHidden),
  }, icon('panel'), sidebarToggleLabel);

  function setSidebarHidden(next: boolean): void {
    sidebarHidden = next;
    appEl.setAttribute('data-sidebar-hidden', String(next));
    sidebar.setAttribute('aria-hidden', String(next));
    sidebarToggleBtn.setAttribute('aria-expanded', String(!next));
    sidebarToggleBtn.setAttribute('title', next ? L('Mostrar panel lateral (Ctrl+B)', 'Show side panel (Ctrl+B)') : L('Ocultar panel lateral (Ctrl+B)', 'Hide side panel (Ctrl+B)'));
    sidebarToggleBtn.setAttribute('aria-label', next ? L('Mostrar panel lateral', 'Show side panel') : L('Ocultar panel lateral', 'Hide side panel'));
    sidebarToggleLabel.textContent = next ? L('Panel', 'Panel') : '';
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // ignore storage errors
    }
  }
  appEl.setAttribute('data-sidebar-hidden', String(sidebarHidden));

  const workflowBar = h('nav', {
    class: 'workflow-bar',
    'aria-label': L('Flujo de trabajo del inventario', 'Inventory workflow'),
    'data-testid': 'workflow-bar',
  },
  h('div', { class: 'workflow-bar-inner' },
    h('div', { class: 'workflow-bar-left' },
      sidebarToggleBtn,
      h('div', { class: 'workflow-steps' },
        WORKFLOW_PRIMARY.map((item, idx) => {
          const lbl = h('span', null, L(item.labelEs, item.labelEn));
          labelBindings.push({ el: lbl, es: item.labelEs, en: item.labelEn });
          const btn = h('button', {
            class: 'workflow-step',
            type: 'button',
            'data-path': item.path,
            'data-testid': item.testId,
            onclick: () => navigate(item.path),
          },
          h('span', { class: 'workflow-step-num' }, item.step),
          lbl,
          );
          allNavElements.push({ path: item.path, el: btn });
          return idx > 0
            ? [h('span', { class: 'workflow-arrow', 'aria-hidden': 'true' }, '›'), btn]
            : [btn];
        }).flat(),
      ),
    ),
    h('div', { class: 'workflow-tools' },
      WORKFLOW_TOOLS.map((tool) => {
        const lbl = h('span', null, L(tool.labelEs, tool.labelEn));
        labelBindings.push({ el: lbl, es: tool.labelEs, en: tool.labelEn });
        const btn = h('button', {
          class: 'workflow-tool-pill',
          type: 'button',
          'data-path': tool.path,
          'data-testid': tool.testId,
          onclick: () => navigate(tool.path),
        },
        icon(tool.iconName),
        lbl,
        );
        allNavElements.push({ path: tool.path, el: btn });
        return btn;
      }),
    ),
  ),
  );

  const main = h('main', { class: 'app-main', id: 'view-root' });

  const mainCol = h('div', { class: 'app-main-col' },
    workflowBar,
    main,
  );

  // Mobile "Más ⋯" Bottom Sheet (< 900px)
  const mobileSupervisorToggleLabel = h('span', null);
  const syncMobileSupervisorLabel = () => {
    const isSup = isSupervisorModeEnabled();
    mobileSupervisorToggleLabel.textContent = isSup
      ? L('Modo Supervisor: ACTIVO (tocar para Modo Técnico)', 'Supervisor Mode: ACTIVE (tap for Technician Mode)')
      : L('Vista Técnico (tocar para Modo Supervisor)', 'Technician View (tap for Supervisor Mode)');
  };
  syncMobileSupervisorLabel();

  const mobileSupervisorToggleBtn = h(
    'button',
    {
      class: 'mobile-more-item mobile-supervisor-toggle-btn',
      type: 'button',
      'data-testid': 'mobile-supervisor-toggle',
      onclick: async () => {
        const isSup = isSupervisorModeEnabled();
        if (!isSup) {
          const authorized = await promptSupervisorPin();
          if (!authorized) return;
          await switchToSupervisorSession();
        } else {
          await switchToTechnicianSession();
        }
        applyPlatformAttributes();
        syncMobileSupervisorLabel();
        closeMoreSheet();
        navigate(currentPath() || '/');
      },
    },
    mobileSupervisorToggleLabel,
  );

  const moreBackdrop = h('div', {
    class: 'mobile-more-backdrop',
    hidden: true,
    onclick: () => closeMoreSheet(),
  });
  const mobileMoreTitleEl = h('span', { class: 'bold small muted uppercase' }, L('Más secciones', 'More sections'));
  const moreSheet = h('div', {
    class: 'mobile-more-sheet',
    hidden: true,
    role: 'dialog',
    'aria-label': L('Más herramientas', 'More tools'),
    'data-testid': 'mobile-more-sheet',
  },
  h('div', { class: 'mobile-more-head' },
    mobileMoreTitleEl,
    h('button', {
      class: 'btn ghost sm',
      type: 'button',
      'aria-label': L('Cerrar menú', 'Close menu'),
      onclick: () => closeMoreSheet(),
    }, '✕'),
  ),
  NAV_ITEMS.filter((it) => !MOBILE_PRIMARY_PATHS.has(it.path)).map((item) => {
    const lbl = h('span', null, L(item.labelEs, item.labelEn));
    labelBindings.push({ el: lbl, es: item.labelEs, en: item.labelEn });
    const sheetBtn = h('button', {
      class: 'mobile-more-item',
      type: 'button',
      'data-path': item.path,
      'data-testid': `mobile-${item.testId}`,
      onclick: () => {
        closeMoreSheet();
        navigate(item.path);
      },
    },
    icon(item.icon),
    lbl,
    );
    allNavElements.push({ path: item.path, el: sheetBtn });
    return sheetBtn;
  }),
  mobileSupervisorToggleBtn,
  );

  function closeMoreSheet() {
    moreBackdrop.hidden = true;
    moreSheet.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleMoreSheet() {
    syncMobileSupervisorLabel();
    const open = moreSheet.hidden;
    moreBackdrop.hidden = !open;
    moreSheet.hidden = !open;
    moreBtn.setAttribute('aria-expanded', String(open));
  }

  const moreBtnLabel = h('span', null, L('Más', 'More'));
  labelBindings.push({ el: moreBtnLabel, es: 'Más', en: 'More' });
  const moreBtn = h('button', {
    class: 'nav-btn',
    type: 'button',
    'data-testid': 'nav-more',
    'aria-expanded': 'false',
    onclick: () => toggleMoreSheet(),
  },
  icon('more'),
  moreBtnLabel,
  ) as HTMLButtonElement;

  // Bottom Nav (para pantallas móviles < 900px: 4 destinos primarios + Más)
  const nav = h('nav', { class: 'app-nav', 'aria-label': L('Navegación móvil principal', 'Main mobile navigation') },
    NAV_ITEMS.filter((it) => MOBILE_PRIMARY_PATHS.has(it.path)).map((item) => {
      const lbl = h('span', null, L(item.labelEs, item.labelEn));
      labelBindings.push({ el: lbl, es: item.labelEs, en: item.labelEn });
      const btn = h('button', {
        class: 'nav-btn',
        type: 'button',
        'data-path': item.path,
        'data-testid': `mobile-${item.testId}`,
        onclick: () => {
          closeMoreSheet();
          navigate(item.path);
        },
      },
      icon(item.icon),
      lbl,
      );
      allNavElements.push({ path: item.path, el: btn });
      return btn;
    }),
    moreBtn,
  );

  const appLayoutWrapper = h('div', { class: 'app-body-layout' },
    sidebar,
    mainCol,
  );

  clear(appEl, header, appLayoutWrapper, moreBackdrop, moreSheet, nav);

  const updateHeaderSession = async () => {
    const s = await getActiveSession();
    const name = s ? s.name : L('Sin sesión activa', 'No active session');
    sessionBadge.textContent = s ? s.name : L('Sin sesión', 'No session');
    const sBoxName = sidebarSessionBox.querySelector('.sidebar-session-name');
    if (sBoxName) sBoxName.textContent = name;
  };

  const updateCloudBadges = (st: ReturnType<typeof getCloudConnectionStatus>) => {
    if (!st.roomCode || st.state === 'disabled') {
      cloudBadge.hidden = true;
      sidebarCloudPill.className = 'sidebar-cloud-pill disabled';
      sidebarCloudPill.textContent = L('● Modo Local (Sin sala)', '● Local Mode (No room)');
      return;
    }
    cloudBadge.hidden = false;
    if (st.state === 'connected') {
      cloudBadge.className = 'top-cloud-pill live';
      cloudBadge.textContent = L(`● EN VIVO · ${st.roomCode}`, `● LIVE · ${st.roomCode}`);
      sidebarCloudPill.className = 'sidebar-cloud-pill live';
      sidebarCloudPill.textContent = L(`● En vivo · ${st.roomCode}`, `● Live · ${st.roomCode}`);
    } else if (st.state === 'connecting') {
      cloudBadge.className = 'top-cloud-pill connecting';
      cloudBadge.textContent = L(`◌ Conectando · ${st.roomCode}`, `◌ Connecting · ${st.roomCode}`);
      sidebarCloudPill.className = 'sidebar-cloud-pill connecting';
      sidebarCloudPill.textContent = L(`◌ Conectando · ${st.roomCode}`, `◌ Connecting · ${st.roomCode}`);
    } else if (st.state === 'error') {
      cloudBadge.className = 'top-cloud-pill error';
      cloudBadge.textContent = L(`● Error Firebase · ${st.roomCode}`, `● Firebase Error · ${st.roomCode}`);
      sidebarCloudPill.className = 'sidebar-cloud-pill error';
      sidebarCloudPill.textContent = L(`● Error de red · ${st.roomCode}`, `● Network error · ${st.roomCode}`);
    } else {
      cloudBadge.className = 'top-cloud-pill local';
      cloudBadge.textContent = L(`● Sala Local · ${st.roomCode}`, `● Local Room · ${st.roomCode}`);
      sidebarCloudPill.className = 'sidebar-cloud-pill local';
      sidebarCloudPill.textContent = L(`● Sala Local · ${st.roomCode}`, `● Local Room · ${st.roomCode}`);
    }
  };

  onCloudStatusChange((st) => {
    updateCloudBadges(st);
  });

  onCloudRoomUpdate(() => {
    void updateHeaderSession();
  });

  const updateNet = () => {
    const on = navigator.onLine;
    onlineDot.className = `online-dot ${on ? 'on' : 'off'}`;
    onlineDot.title = on ? L('En línea', 'Online') : L('Sin conexión (modo offline)', 'Offline');

    const sideNetDot = sidebar.querySelector('.sidebar-status-row .online-dot');
    if (sideNetDot) sideNetDot.className = `online-dot ${on ? 'on' : 'off'}`;
    const sideNetText = sidebar.querySelector('.sidebar-net-text');
    if (sideNetText) sideNetText.textContent = on ? L('En línea', 'Online') : L('Modo offline', 'Offline mode');
  };
  window.addEventListener('online', () => {
    updateNet();
    toast(L('Conexión restaurada', 'Connection restored'), 'ok');
  });
  window.addEventListener('offline', () => {
    updateNet();
    toast(L('Modo offline: los datos se guardan en el teléfono', 'Offline mode: data is saved locally on this device'), 'warn', 4000);
  });
  updateNet();

  const applyShellTranslations = () => {
    applyDocumentLang();
    titleEl.textContent = L('Inventario de Consumibles', 'Consumables Inventory');
    headerKickerEl.textContent = L('HHF · TALLER DE REPARACIONES', 'HHF · REPAIR SHOP');
    sidebarBrandSubEl.textContent = L('Registro de Consumibles · Taller de Reparaciones', 'Consumables Registry · Repair Shop');
    sidebarSessionLabelEl.textContent = L('Sesión activa', 'Active session');
    mobileMoreTitleEl.textContent = L('Más secciones', 'More sections');
    sidebarCollapseBtn.title = L('Ocultar panel lateral (Ctrl+B)', 'Hide side panel (Ctrl+B)');
    sidebarCollapseBtn.setAttribute('aria-label', L('Ocultar panel lateral', 'Hide side panel'));
    setSidebarHidden(sidebarHidden);
    for (const b of labelBindings) b.el.textContent = L(b.es, b.en);
    applyPlatformAttributes();
    syncMobileSupervisorLabel();
    updateNet();
    updateCloudBadges(getCloudConnectionStatus());
    void updateHeaderSession();
  };

  const handleLangChange = () => {
    applyShellTranslations();
    navigate(currentPath() || '/');
  };
  window.addEventListener('languagechange', handleLangChange);
  window.addEventListener('mhk:languagechange', handleLangChange);

  startRouter(main, (path, view) => {
    const viewTitle = typeof view.title === 'function' ? view.title() : view.title;
    document.title = `${viewTitle} · ${L('Inventario de Consumibles', 'Consumables Inventory')}`;
    const cur = path || '/';
    closeMoreSheet();
    allNavElements.forEach(({ path: p, el }) => {
      el.classList.toggle('active', p === cur);
    });
    moreBtn.classList.toggle('active', !MOBILE_PRIMARY_PATHS.has(cur));
    void updateHeaderSession();
  });

  // Atajos de teclado en escritorio (Alt + 1..7, bloqueados en campos o diálogos abiertos)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !moreSheet.hidden) {
      closeMoreSheet();
      return;
    }
    if (
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement ||
      (e.target instanceof HTMLElement && e.target.isContentEditable) ||
      document.querySelector('dialog[open]')
    ) {
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && window.innerWidth >= 900) {
      e.preventDefault();
      setSidebarHidden(!sidebarHidden);
      return;
    }
    if (e.altKey && e.key >= '1' && e.key <= '7') {
      const idx = Number(e.key) - 1;
      const targetItem = NAV_ITEMS[idx];
      if (targetItem) {
        e.preventDefault();
        navigate(targetItem.path);
      }
    }
  });

  if (urlJoin?.joinedRoom) {
    toast(
      L(
        `Conectado en tiempo real a la Sala ${urlJoin.joinedRoom}${urlJoin.endpointUrl ? ' (Firebase activo)' : ''}`,
        `Connected live to Room ${urlJoin.joinedRoom}${urlJoin.endpointUrl ? ' (Firebase active)' : ''}`,
      ),
      'ok',
      4500,
    );
  }

  initInstall(() => {
    if (currentPath() === '/') navigate('/');
  });

  startPendingWatcher((resolved) => {
    toast(L(`Se obtuvieron ${resolved} descripción(es) en internet`, `Fetched ${resolved} description(s) online`), 'ok');
  });
}
