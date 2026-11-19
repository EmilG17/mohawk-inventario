import { L } from '../i18n/i18n';

export interface View {
  title: string | (() => string);
  render(root: HTMLElement, params: URLSearchParams): void | Promise<void>;
  /** Se llama al salir de la pantalla (p. ej. apagar la cámara) */
  destroy?(): void | Promise<void>;
}

const routes = new Map<string, View>();
let current: View | null = null;
let root: HTMLElement;
let onChange: (path: string, view: View) => void = () => undefined;
let navSeq = 0;
let pendingDestroy: Promise<void> = Promise.resolve();
let hashListenerBound = false;

function normalizeHashPath(rawPath: string): string {
  const cleaned = rawPath || '/';
  return cleaned.length > 1 ? cleaned.replace(/\/+$/, '') || '/' : cleaned;
}

export function registerRoute(path: string, view: View): void {
  routes.set(normalizeHashPath(path), view);
}

export function navigate(path: string): void {
  const [p, q] = (path || '/').split('?');
  const norm = normalizeHashPath(p);
  const target = '#' + (q !== undefined ? `${norm}?${q}` : norm);
  if (location.hash === target) void render();
  else location.hash = target;
}

export function currentPath(): string {
  const [rawPath] = (location.hash.slice(1) || '/').split('?');
  return normalizeHashPath(rawPath);
}

async function render(): Promise<void> {
  const seq = ++navSeq;
  const [rawPath, query] = (location.hash.slice(1) || '/').split('?');
  const path = normalizeHashPath(rawPath);
  const resolvedPath = routes.has(path) ? path : '/';
  const view = routes.get(resolvedPath)!;

  // Cerrar diálogos modales abiertos al navegar entre rutas
  if (typeof document !== 'undefined') {
    document.querySelectorAll('dialog[open]').forEach((dlg) => {
      try {
        (dlg as HTMLDialogElement).close();
      } catch {}
    });
  }

  try {
    await pendingDestroy;
  } catch {}
  if (seq !== navSeq) return;

  const prev = current;
  current = null;
  if (prev?.destroy) {
    pendingDestroy = (async () => {
      try {
        await prev.destroy?.();
      } catch (e) {
        console.error(e);
      }
    })();
    await pendingDestroy;
  }
  if (seq !== navSeq) return;

  current = view;
  root.scrollTop = 0;
  window.scrollTo(0, 0);
  onChange(resolvedPath, view);
  try {
    await view.render(root, new URLSearchParams(query ?? ''));
  } catch (e) {
    if (seq === navSeq) {
      console.error(e);
      root.textContent = L('Ocurrió un error: ', 'An error occurred: ') + (e as Error).message;
    }
  }
}

export function startRouter(el: HTMLElement, cb: (path: string, view: View) => void): void {
  root = el;
  onChange = cb;
  if (!hashListenerBound) {
    hashListenerBound = true;
    window.addEventListener('hashchange', () => void render());
  }
  void render();
}
