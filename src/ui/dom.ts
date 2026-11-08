import { settingsSync } from '../settings';

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { class?: string; style?: string };

/** Creación de elementos DOM con escape automático de texto. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'class') {
        el.className = String(v);
      } else if (k === 'value' && 'value' in el) {
        (el as HTMLInputElement).value = String(v);
      } else if (k === 'checked' || k === 'selected' || k === 'disabled') {
        (el as any)[k] = !!v;
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`No existe ${sel}`);
  return el as HTMLElement;
}

// ---------- avisos ----------
let toastTimer: number | undefined;
export function toast(msg: string, kind: 'ok' | 'warn' | 'error' | 'info' = 'info', ms = 2500): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el!.className = ''), ms);
}

// ---------- diálogos ----------
export function openDialog(title: string, body: Child, actions: { label: string; kind?: string; onClick?: () => boolean | void | Promise<boolean | void> }[]): HTMLDialogElement {
  const dlg = h('dialog', { class: 'dlg' },
    h('h3', null, title),
    h('div', { class: 'dlg-body' }, body),
    h('div', { class: 'dlg-actions' },
      actions.map((a) =>
        h('button', {
          class: `btn ${a.kind ?? ''}`,
          type: 'button',
          onclick: async () => {
            const keepOpen = a.onClick ? await a.onClick() : false;
            if (keepOpen !== true) dlg.close();
          },
        }, a.label),
      ),
    ),
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.appendChild(dlg);
  dlg.showModal();
  return dlg;
}

export function confirmDialog(title: string, msg: string, okLabel = 'Aceptar', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const d = openDialog(title, h('p', null, msg), [
      { label: 'Cancelar' },
      { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => { ok = true; } },
    ]);
    d.addEventListener('close', () => resolve(ok));
  });
}

export function promptDialog(title: string, label: string, value = '', inputAttrs: Attrs = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h('input', { class: 'input', value, ...inputAttrs });
    const form = h('form', { onsubmit: (e: Event) => { e.preventDefault(); result = input.value; d.close(); } },
      h('label', { class: 'field' }, h('span', null, label), input));
    const d = openDialog(title, form, [
      { label: 'Cancelar' },
      { label: 'Aceptar', kind: 'primary', onClick: () => { result = input.value; } },
    ]);
    d.addEventListener('close', () => resolve(result));
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

// ---------- archivos ----------
export const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv;charset=utf-8',
  json: 'application/json',
};

export function downloadFile(data: Uint8Array | string | Blob, fileName: string, mime: string): void {
  const blob = data instanceof Blob ? data : new Blob([data as any], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: fileName, style: 'display:none' });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
}

export function canShareFiles(): boolean {
  try {
    return !!navigator.canShare?.({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] });
  } catch {
    return false;
  }
}

/** Comparte con el menú nativo (WhatsApp, correo, Drive…) o descarga si no es posible. */
export async function shareOrDownload(data: Uint8Array | string | Blob, fileName: string, mime: string, title: string): Promise<void> {
  if (canShareFiles()) {
    const file = new File([data as any], fileName, { type: mime.split(';')[0] });
    try {
      await navigator.share({ files: [file], title, text: title });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  downloadFile(data, fileName, mime);
}

export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: 'display:none' });
    input.addEventListener('change', () => { resolve([...(input.files ?? [])]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

export function fmtNum(n: number | undefined, dec = 2): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return n.toLocaleString('es-MX', { maximumFractionDigits: dec });
}
export function fmtMoney(n: number | undefined): string {
  if (n === undefined) return '—';
  try {
    return n.toLocaleString('es-MX', { style: 'currency', currency: settingsSync().currency || 'MXN', maximumFractionDigits: 2 });
  } catch {
    return n.toLocaleString('es-MX', { maximumFractionDigits: 2 });
  }
}
export function fmtDateTime(t: number): string {
  return new Date(t).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short', hour12: false });
}
export function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function icon(name: string): SVGSVGElement {
  const paths: Record<string, string> = {
    home: 'M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
    scan: 'M3 7V4h3M21 7V4h-3M3 17v3h3M21 17v3h-3M7 8v8M10 8v8M13 8v8M17 8v8',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
    users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    torch: 'M9 2h6l-1 7h4l-8 13 2-9H8z',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
    trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
    edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
    camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    stop: 'M6 6h12v12H6z',
    share: 'M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
    globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
    swap: 'M7 10h14l-4-4m4 4-4 4M17 14H3l4 4m-4-4 4-4',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', paths[name] ?? '');
  svg.appendChild(p);
  return svg;
}
