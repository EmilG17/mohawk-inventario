export interface WedgeListenerOptions {
  minLength?: number;
  maxIntervalMs?: number;
  allowInputIds?: string[];
  isBlocked?: () => boolean;
  onScan: (code: string, target: HTMLElement | null) => void;
}

export interface WedgeController {
  attach: () => void;
  detach: () => void;
  reset: () => void;
}

/**
 * Listener compartido para escáneres USB/Bluetooth en modo teclado (keyboard wedge).
 * Captura ráfagas rápidas de caracteres terminadas en Enter sin interferir con escritura manual.
 */
export function createWedgeController(opts: WedgeListenerOptions): WedgeController {
  const minLength = opts.minLength ?? 4;
  const maxIntervalMs = opts.maxIntervalMs ?? 80;
  const allowSet = new Set(opts.allowInputIds ?? []);
  let keyBuffer = '';
  let keyLast = 0;
  let listener: ((e: KeyboardEvent) => void) | null = null;

  const reset = () => {
    keyBuffer = '';
    keyLast = 0;
  };

  const attach = () => {
    detach();
    listener = (e: KeyboardEvent) => {
      const target = (e.target as HTMLElement | null) ?? null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
        if (tag === 'INPUT' && (!target.id || !allowSet.has(target.id))) return;
      }

      if (opts.isBlocked?.()) return;

      if (e.key === 'Enter') {
        const now = Date.now();
        if (now - keyLast <= maxIntervalMs && keyBuffer.length >= minLength) {
          const code = keyBuffer.trim();
          keyBuffer = '';
          e.preventDefault();
          opts.onScan(code, target);
        } else {
          keyBuffer = '';
        }
        return;
      }

      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const now = Date.now();
        if (now - keyLast > maxIntervalMs) keyBuffer = '';
        keyLast = now;
        keyBuffer += e.key;
      }
    };
    window.addEventListener('keydown', listener);
  };

  const detach = () => {
    if (listener) {
      window.removeEventListener('keydown', listener);
      listener = null;
    }
    reset();
  };

  return { attach, detach, reset };
}
