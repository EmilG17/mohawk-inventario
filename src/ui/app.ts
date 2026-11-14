import { getActiveSession } from '../db/db';
import { startPendingWatcher } from '../lookup/pendingQueue';
import { loadSettings } from '../settings';
import {
  consumeUrlSyncParams,
  getCloudConnectionStatus,
  onCloudRoomUpdate,
  onCloudStatusChange,
  startLiveCloudSync,
} from '../sync/cloudSync';
import { catalogView } from './catalog';
import { countView } from './count';
import { clear, h, icon, toast } from './dom';
import { homeView } from './home';
import { initInstall } from './install';
import { movementsView } from './movementsView';
import { reportView } from './reportView';
import { currentPath, navigate, registerRoute, startRouter } from './router';
import { settingsView } from './settingsView';
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
    return { platform: 'mobile', isTouch, label: '📱 Terminal Móvil' };
  }
  if (width <= 1024 && isTouch) {
    return { platform: 'tablet', isTouch, label: '📟 Tableta Industrial' };
  }
  return { platform: 'desktop', isTouch, label: '🖥️ Estación de Trabajo' };
}

const NAV_ITEMS: { path: string; label: string; icon: string; shortcut?: string; testId: string }[] = [
  { path: '/', label: 'Inicio', icon: 'home', shortcut: '1', testId: 'nav-home' },
  { path: '/contar', label: 'Contar', icon: 'scan', shortcut: '2', testId: 'nav-count' },
  { path: '/movimientos', label: 'Kardex', icon: 'swap', shortcut: '3', testId: 'nav-movements' },
  { path: '/catalogo', label: 'Catálogo', icon: 'list', shortcut: '4', testId: 'nav-catalog' },
  { path: '/reporte', label: 'Reporte', icon: 'chart', shortcut: '5', testId: 'nav-report' },
  { path: '/equipo', label: 'Supervisor', icon: 'users', shortcut: '6', testId: 'nav-team' },
  { path: '/ajustes', label: 'Ajustes', icon: 'gear', shortcut: '7', testId: 'nav-settings' },
];

const MOBILE_PRIMARY_PATHS = new Set(['/', '/contar', '/movimientos', '/catalogo']);

export async function bootstrapApp(): Promise<void> {
  const initialSettings = await loadSettings();
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

  const sidebarPlatformBadge = h('span', { class: 'sidebar-platform-badge' });
  const applyPlatformAttributes = () => {
    const info = detectPlatformInfo();
    appEl.setAttribute('data-platform', info.platform);
    appEl.setAttribute('data-touch', String(info.isTouch));
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

  const titleEl = h('h1', { class: 'brand-title' }, 'Inventario de Consumibles');
  const cloudBadge = h('button', {
    class: 'top-cloud-pill',
    type: 'button',
    hidden: true,
    title: 'Estado de sincronización en tiempo real (clic para abrir Monitor de Supervisor)',
    onclick: () => navigate('/equipo'),
  });
  const sessionBadge = h('span', { class: 'top-session muted small' });
  const onlineDot = h('span', { class: 'online-dot', title: navigator.onLine ? 'En línea' : 'Sin conexión' });

  const createBrandLogo = (size = 24) => {
    const el = h('span', { class: 'brand-mark', 'aria-hidden': 'true' });
    el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}" style="display:block;">
      <g stroke="#38bdf8" stroke-width="28" stroke-linecap="round" stroke-linejoin="round" fill="none">
        <path d="M84 160 V108 A24 24 0 0 1 108 84 H160" />
        <path d="M428 160 V108 A24 24 0 0 0 404 84 H352" />
        <path d="M84 352 V404 A24 24 0 0 0 108 428 H160" />
        <path d="M428 352 V404 A24 24 0 0 1 404 428 H352" />
      </g>
      <path d="M256 120 L372 178 L256 236 L140 178 Z" fill="none" stroke="#ffffff" stroke-width="26" stroke-linejoin="round" />
      <path d="M198 149 L314 207" stroke="#38bdf8" stroke-width="22" stroke-linecap="round" />
      <path d="M140 178 V328 L256 386 L372 328 V178" fill="none" stroke="#ffffff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" />
      <rect x="190" y="254" width="22" height="72" rx="10" fill="#ffffff" />
      <rect x="234" y="260" width="28" height="72" rx="10" fill="#38bdf8" />
      <rect x="284" y="254" width="24" height="72" rx="10" fill="#ffffff" />
    </svg>`;
    return el;
  };

  const mobileBrandLogoEl = createBrandLogo(24);

  // Top header (para pantallas móviles < 900px)
  const header = h('header', { class: 'app-header' },
    h('div', { class: 'header-left', onclick: () => navigate('/') },
      mobileBrandLogoEl,
      titleEl,
    ),
    h('div', { class: 'header-right' },
      cloudBadge,
      sessionBadge,
      onlineDot,
    ),
  );

  // Desktop Sidebar (visible en pantallas >= 900px)
  const sidebarBrandLogoEl = createBrandLogo(28);

  const sidebarCloudPill = h('button', {
    class: 'sidebar-cloud-pill',
    type: 'button',
    onclick: () => navigate('/equipo'),
  });

  const sidebarSessionBox = h('div', {
    class: 'sidebar-session-box',
    onclick: () => navigate('/'),
  },
  h('div', { class: 'muted xsmall' }, 'Sesión activa'),
  h('div', { class: 'sidebar-session-name' }, 'Cargando...'),
  );

  const allNavElements: { path: string; el: HTMLElement }[] = [];

  const sidebarNavList = h('nav', { class: 'sidebar-nav', 'aria-label': 'Navegación de escritorio' },
    NAV_ITEMS.map((item) => {
      const btn = h('button', {
        class: 'sidebar-nav-btn',
        'data-path': item.path,
        'data-testid': `sidebar-${item.testId}`,
        onclick: () => navigate(item.path),
      },
      icon(item.icon),
      h('span', { class: 'sidebar-nav-label' }, item.label),
      item.shortcut ? h('span', { class: 'sidebar-nav-shortcut' }, item.shortcut) : null,
      );
      allNavElements.push({ path: item.path, el: btn });
      return btn;
    }),
  );

  const sidebar = h('aside', { class: 'app-sidebar' },
    h('div', { class: 'sidebar-head', onclick: () => navigate('/') },
      h('div', { class: 'sidebar-brand-row' },
        sidebarBrandLogoEl,
        h('div', { class: 'sidebar-title-wrap' },
          h('span', { class: 'sidebar-brand-name' }, 'MOHAWK'),
          h('span', { class: 'sidebar-brand-sub' }, 'Inventario de Consumibles'),
        ),
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
          h('span', { class: 'sidebar-net-text muted small' }, navigator.onLine ? 'En línea' : 'Modo local'),
        ),
        h('span', { class: 'sidebar-version muted xsmall' }, 'v4.0 PWA'),
      ),
    ),
  );

  const main = h('main', { class: 'app-main', id: 'view-root' });

  // Mobile "Más ⋯" Bottom Sheet (< 900px)
  const moreBackdrop = h('div', {
    class: 'mobile-more-backdrop',
    hidden: true,
    onclick: () => closeMoreSheet(),
  });
  const moreSheet = h('div', {
    class: 'mobile-more-sheet',
    hidden: true,
    role: 'dialog',
    'aria-label': 'Más herramientas',
    'data-testid': 'mobile-more-sheet',
  },
  h('div', { class: 'mobile-more-head' },
    h('span', { class: 'bold small muted uppercase' }, 'Más secciones'),
    h('button', {
      class: 'btn ghost sm',
      type: 'button',
      'aria-label': 'Cerrar menú',
      onclick: () => closeMoreSheet(),
    }, '✕'),
  ),
  NAV_ITEMS.filter((it) => !MOBILE_PRIMARY_PATHS.has(it.path)).map((item) => {
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
    h('span', null, item.label),
    );
    allNavElements.push({ path: item.path, el: sheetBtn });
    return sheetBtn;
  }),
  );

  function closeMoreSheet() {
    moreBackdrop.hidden = true;
    moreSheet.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleMoreSheet() {
    const open = moreSheet.hidden;
    moreBackdrop.hidden = !open;
    moreSheet.hidden = !open;
    moreBtn.setAttribute('aria-expanded', String(open));
  }

  const moreBtn = h('button', {
    class: 'nav-btn',
    type: 'button',
    'data-testid': 'nav-more',
    'aria-expanded': 'false',
    onclick: () => toggleMoreSheet(),
  },
  icon('more'),
  h('span', null, 'Más'),
  ) as HTMLButtonElement;

  // Bottom Nav (para pantallas móviles < 900px: 4 destinos primarios + Más)
  const nav = h('nav', { class: 'app-nav', 'aria-label': 'Navegación móvil principal' },
    NAV_ITEMS.filter((it) => MOBILE_PRIMARY_PATHS.has(it.path)).map((item) => {
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
      h('span', null, item.label),
      );
      allNavElements.push({ path: item.path, el: btn });
      return btn;
    }),
    moreBtn,
  );

  const appLayoutWrapper = h('div', { class: 'app-body-layout' },
    sidebar,
    main,
  );

  clear(appEl, header, appLayoutWrapper, moreBackdrop, moreSheet, nav);

  const updateHeaderSession = async () => {
    const s = await getActiveSession();
    const name = s ? s.name : 'Sin sesión activa';
    sessionBadge.textContent = s ? s.name : 'Sin sesión';
    const sBoxName = sidebarSessionBox.querySelector('.sidebar-session-name');
    if (sBoxName) sBoxName.textContent = name;
  };

  const updateCloudBadges = (st: ReturnType<typeof getCloudConnectionStatus>) => {
    if (!st.roomCode || st.state === 'disabled') {
      cloudBadge.hidden = true;
      sidebarCloudPill.className = 'sidebar-cloud-pill disabled';
      sidebarCloudPill.textContent = '⚪ Modo Local (Sin sala)';
      return;
    }
    cloudBadge.hidden = false;
    if (st.state === 'connected') {
      cloudBadge.className = 'top-cloud-pill live';
      cloudBadge.textContent = `● EN VIVO · ${st.roomCode}`;
      sidebarCloudPill.className = 'sidebar-cloud-pill live';
      sidebarCloudPill.textContent = `🟢 En vivo · ${st.roomCode}`;
    } else if (st.state === 'connecting') {
      cloudBadge.className = 'top-cloud-pill connecting';
      cloudBadge.textContent = `◌ Conectando · ${st.roomCode}`;
      sidebarCloudPill.className = 'sidebar-cloud-pill connecting';
      sidebarCloudPill.textContent = `🟡 Conectando · ${st.roomCode}`;
    } else if (st.state === 'error') {
      cloudBadge.className = 'top-cloud-pill error';
      cloudBadge.textContent = `⚠ Error Firebase · ${st.roomCode}`;
      sidebarCloudPill.className = 'sidebar-cloud-pill error';
      sidebarCloudPill.textContent = `🔴 Error de red · ${st.roomCode}`;
    } else {
      cloudBadge.className = 'top-cloud-pill local';
      cloudBadge.textContent = `● Sala Local · ${st.roomCode}`;
      sidebarCloudPill.className = 'sidebar-cloud-pill local';
      sidebarCloudPill.textContent = `⚪ Sala Local · ${st.roomCode}`;
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
    onlineDot.title = on ? 'En línea' : 'Sin conexión (modo offline)';

    const sideNetDot = sidebar.querySelector('.sidebar-status-row .online-dot');
    if (sideNetDot) sideNetDot.className = `online-dot ${on ? 'on' : 'off'}`;
    const sideNetText = sidebar.querySelector('.sidebar-net-text');
    if (sideNetText) sideNetText.textContent = on ? 'En línea' : 'Modo offline';
  };
  window.addEventListener('online', () => {
    updateNet();
    toast('Conexión restaurada', 'ok');
  });
  window.addEventListener('offline', () => {
    updateNet();
    toast('Modo offline: los datos se guardan en el teléfono', 'warn', 4000);
  });
  updateNet();

  startRouter(main, (path, view) => {
    document.title = `${view.title} · Inventario de Consumibles`;
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
      `Conectado en tiempo real a la Sala ${urlJoin.joinedRoom}${urlJoin.endpointUrl ? ' (Firebase activo)' : ''}`,
      'ok',
      4500,
    );
  }

  initInstall(() => {
    if (currentPath() === '/') navigate('/');
  });

  startPendingWatcher((resolved) => {
    toast(`Se obtuvieron ${resolved} descripción(es) en internet`, 'ok');
  });
}
