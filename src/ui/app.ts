import { getActiveSession } from '../db/db';
import { startPendingWatcher } from '../lookup/pendingQueue';
import { loadSettings } from '../settings';
import { catalogView } from './catalog';
import { countView } from './count';
import { clear, h, icon, toast } from './dom';
import { homeView } from './home';
import { initInstall } from './install';
import { reportView } from './reportView';
import { currentPath, navigate, registerRoute, startRouter, type View } from './router';
import { settingsView } from './settingsView';
import { teamView } from './teamView';

const NAV_ITEMS: { path: string; label: string; icon: string }[] = [
  { path: '/', label: 'Inicio', icon: 'home' },
  { path: '/contar', label: 'Contar', icon: 'scan' },
  { path: '/catalogo', label: 'Catálogo', icon: 'list' },
  { path: '/reporte', label: 'Reporte', icon: 'chart' },
  { path: '/equipo', label: 'Equipo', icon: 'users' },
  { path: '/ajustes', label: 'Ajustes', icon: 'gear' },
];

export async function bootstrapApp(): Promise<void> {
  await loadSettings();

  registerRoute('/', homeView);
  registerRoute('/contar', countView);
  registerRoute('/catalogo', catalogView);
  registerRoute('/reporte', reportView);
  registerRoute('/equipo', teamView);
  registerRoute('/ajustes', settingsView);

  const appEl = document.getElementById('app')!;
  const titleEl = h('h1', { class: 'brand-title' }, 'Inventario Mohawk');
  const sessionBadge = h('span', { class: 'top-session muted small' });
  const onlineDot = h('span', { class: 'online-dot', title: navigator.onLine ? 'En línea' : 'Sin conexión' });

  const header = h('header', { class: 'app-header' },
    h('div', { class: 'header-left', onclick: () => navigate('/') },
      h('span', { class: 'brand-mark' }, 'M'),
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
    document.title = `${view.title} · Inventario Mohawk`;
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
