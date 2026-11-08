import { getActiveSession } from '../db/db';
import { startPendingWatcher } from '../lookup/pendingQueue';
import { loadSettings } from '../settings';
import { catalogView } from './catalog';
import { countView } from './count';
import { clear, h, icon, toast } from './dom';
import { homeView } from './home';
import { initInstall } from './install';
import { movementsView } from './movementsView';
import { reportView } from './reportView';
import { currentPath, navigate, registerRoute, startRouter, type View } from './router';
import { settingsView } from './settingsView';
import { teamView } from './teamView';

const NAV_ITEMS: { path: string; label: string; icon: string }[] = [
  { path: '/', label: 'Inicio', icon: 'home' },
  { path: '/contar', label: 'Contar', icon: 'scan' },
  { path: '/movimientos', label: 'Kardex', icon: 'swap' },
  { path: '/catalogo', label: 'Catálogo', icon: 'list' },
  { path: '/reporte', label: 'Reporte', icon: 'chart' },
  { path: '/equipo', label: 'Equipo', icon: 'users' },
  { path: '/ajustes', label: 'Ajustes', icon: 'gear' },
];

export async function bootstrapApp(): Promise<void> {
  await loadSettings();

  registerRoute('/', homeView);
  registerRoute('/contar', countView);
  registerRoute('/movimientos', movementsView);
  registerRoute('/catalogo', catalogView);
  registerRoute('/reporte', reportView);
  registerRoute('/equipo', teamView);
  registerRoute('/ajustes', settingsView);

  const appEl = document.getElementById('app')!;
  const titleEl = h('h1', { class: 'brand-title' }, 'Inventario de Consumibles');
  const sessionBadge = h('span', { class: 'top-session muted small' });
  const onlineDot = h('span', { class: 'online-dot', title: navigator.onLine ? 'En línea' : 'Sin conexión' });

  const brandLogoEl = h('span', { class: 'brand-mark', 'aria-hidden': 'true' });
  brandLogoEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="24" height="24" style="display:block;">
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

  const header = h('header', { class: 'app-header' },
    h('div', { class: 'header-left', onclick: () => navigate('/') },
      brandLogoEl,
      titleEl,
    ),
    h('div', { class: 'header-right' },
      sessionBadge,
      onlineDot,
    ),
  );

  const main = h('main', { class: 'app-main', id: 'view-root' });

  const navButtons = new Map<string, HTMLElement>();
  const nav = h('nav', { class: 'app-nav', 'aria-label': 'Navegación principal' },
    NAV_ITEMS.map((item) => {
      const btn = h('button', {
        class: 'nav-btn',
        'data-path': item.path,
        onclick: () => navigate(item.path),
      },
      icon(item.icon),
      h('span', null, item.label),
      );
      navButtons.set(item.path, btn);
      return btn;
    }),
  );

  clear(appEl, header, main, nav);

  const updateHeaderSession = async () => {
    const s = await getActiveSession();
    sessionBadge.textContent = s ? s.name : 'Sin sesión';
  };

  const updateNet = () => {
    const on = navigator.onLine;
    onlineDot.className = `online-dot ${on ? 'on' : 'off'}`;
    onlineDot.title = on ? 'En línea' : 'Sin conexión (modo offline)';
  };
  window.addEventListener('online', () => { updateNet(); toast('Conexión restaurada', 'ok'); });
  window.addEventListener('offline', () => { updateNet(); toast('Modo offline: los datos se guardan en el teléfono', 'warn', 4000); });
  updateNet();

  startRouter(main, (path, view) => {
    document.title = `${view.title} · Inventario de Consumibles`;
    const cur = path || '/';
    navButtons.forEach((btn, p) => btn.classList.toggle('active', p === cur));
    void updateHeaderSession();
  });

  initInstall(() => {
    // Si la pantalla de inicio está activa, re-renderizar para mostrar botón de instalar
    if (currentPath() === '/') navigate('/');
  });

  startPendingWatcher((resolved) => {
    toast(`Se obtuvieron ${resolved} descripción(es) en internet`, 'ok');
  });
}
