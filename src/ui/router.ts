export interface View {
  title: string;
  render(root: HTMLElement, params: URLSearchParams): void | Promise<void>;
  /** Se llama al salir de la pantalla (p. ej. apagar la cámara) */
  destroy?(): void | Promise<void>;
}

const routes = new Map<string, View>();
let current: View | null = null;
let root: HTMLElement;
let onChange: (path: string, view: View) => void = () => undefined;

export function registerRoute(path: string, view: View): void {
  routes.set(path, view);
}

export function navigate(path: string): void {
  const target = '#' + path;
  if (location.hash === target) void render();
  else location.hash = target;
}

export function currentPath(): string {
  return (location.hash.slice(1) || '/').split('?')[0];
}

async function render(): Promise<void> {
  const [path, query] = (location.hash.slice(1) || '/').split('?');
  const view = routes.get(path) ?? routes.get('/')!;
  if (current?.destroy) {
    try { await current.destroy(); } catch (e) { console.error(e); }
  }
  current = view;
  root.scrollTop = 0;
  window.scrollTo(0, 0);
  onChange(path, view);
  try {
    await view.render(root, new URLSearchParams(query ?? ''));
  } catch (e) {
    console.error(e);
    root.textContent = 'Ocurrió un error: ' + (e as Error).message;
  }
}

export function startRouter(el: HTMLElement, cb: (path: string, view: View) => void): void {
  root = el;
  onChange = cb;
  window.addEventListener('hashchange', () => void render());
  void render();
}
