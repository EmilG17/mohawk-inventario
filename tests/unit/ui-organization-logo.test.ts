import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  cloudHandlers,
  activeDialogs,
  installMockDom,
  resetDom,
} = vi.hoisted(() => {
  const cloudHandlers = new Set<() => void>();
  const activeDialogs: MockEl[] = [];

  class MockNode {
    parentNode: MockNode | null = null;
    childNodes: MockNode[] = [];
    nodeType = 1;
    protected _text = '';

    get textContent(): string {
      if (this.childNodes.length === 0) return this._text;
      return this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(v: string) {
      this._text = String(v ?? '');
      this.childNodes = [];
    }
    appendChild<T extends MockNode>(child: T): T {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    replaceChildren(...nodes: Array<MockNode | string>): void {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = [];
      this._text = '';
      for (const n of nodes) {
        this.appendChild(typeof n === 'string' ? new MockText(n) : n);
      }
    }
    removeChild(child: MockNode): void {
      const idx = this.childNodes.indexOf(child);
      if (idx >= 0) this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    remove(): void {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
  }

  class MockText extends MockNode {
    override nodeType = 3;
    constructor(text: string) {
      super();
      this._text = text;
    }
  }

  class MockEl extends MockNode {
    tagName: string;
    className = '';
    attributes: Record<string, string> = {};
    listeners: Record<string, Array<(e: any) => void>> = {};
    style: Record<string, string> = {};
    value = '';
    checked = false;
    disabled = false;
    hidden = false;
    open = false;
    id = '';
    type = '';
    private _innerHTML = '';

    constructor(tag: string) {
      super();
      this.tagName = tag.toUpperCase();
    }

    get innerHTML(): string {
      return this._innerHTML;
    }
    set innerHTML(v: string) {
      this._innerHTML = v;
      if (v === '') {
        this.childNodes = [];
        this._text = '';
      }
    }

    get isConnected(): boolean {
      return true;
    }

    classList = {
      add: (...cls: string[]) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        cls.forEach((c) => set.add(c));
        this.className = Array.from(set).join(' ');
      },
      remove: (...cls: string[]) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        cls.forEach((c) => set.delete(c));
        this.className = Array.from(set).join(' ');
      },
      toggle: (c: string, force?: boolean) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        const shouldHave = force === undefined ? !set.has(c) : force;
        if (shouldHave) set.add(c);
        else set.delete(c);
        this.className = Array.from(set).join(' ');
        return shouldHave;
      },
      contains: (c: string) => this.className.split(/\s+/).filter(Boolean).includes(c),
    };

    setAttribute(k: string, v: string): void {
      const val = String(v);
      this.attributes[k] = val;
      if (k === 'id') this.id = val;
      if (k === 'type') this.type = val;
      if (k === 'class') this.className = val;
    }
    getAttribute(k: string): string | null {
      if (k === 'id' && this.id) return this.id;
      if (k === 'class') return this.className;
      return k in this.attributes ? this.attributes[k] : null;
    }

    addEventListener(evt: string, fn: (e: any) => void): void {
      if (!this.listeners[evt]) this.listeners[evt] = [];
      this.listeners[evt].push(fn);
    }
    removeEventListener(evt: string, fn: (e: any) => void): void {
      const arr = this.listeners[evt];
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    }
    dispatchEvent(evt: any): boolean {
      const e = evt && typeof evt === 'object' ? evt : { type: String(evt) };
      e.target = this;
      e.currentTarget = this;
      e.preventDefault = e.preventDefault ?? (() => {});
      e.stopPropagation = e.stopPropagation ?? (() => {});
      for (const fn of [...(this.listeners[e.type] ?? [])]) {
        fn(e);
      }
      return true;
    }
    click(): void {
      this.dispatchEvent({ type: 'click' });
    }
    focus(): void {}
    blur(): void {}
    select(): void {}

    showModal(): void {
      this.open = true;
      if (!activeDialogs.includes(this)) activeDialogs.push(this);
    }
    close(): void {
      this.open = false;
      const idx = activeDialogs.indexOf(this);
      if (idx >= 0) activeDialogs.splice(idx, 1);
      this.dispatchEvent({ type: 'close' });
    }

    querySelectorAll(selector: string): MockEl[] {
      const parts = selector.trim().split(/\s+/).filter(Boolean);
      if (parts.length > 1) {
        let currentRoots: MockEl[] = [this];
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i];
          const next: MockEl[] = [];
          for (const r of currentRoots) {
            next.push(...r.querySelectorAll(part));
          }
          currentRoots = Array.from(new Set(next));
        }
        return currentRoots;
      }
      const res: MockEl[] = [];
      const visit = (node: MockNode) => {
        if (node instanceof MockEl) {
          if (matchesSimpleSelector(node, selector)) res.push(node);
        }
        for (const c of node.childNodes) visit(c);
      };
      for (const c of this.childNodes) visit(c);
      return res;
    }

    querySelector(selector: string): MockEl | null {
      return this.querySelectorAll(selector)[0] ?? null;
    }
  }

  function matchesSimpleSelector(el: MockEl, selector: string): boolean {
    if (selector === 'dialog[open]') {
      return el.tagName === 'DIALOG' && el.open;
    }
    const tagAttrMatch = selector.match(/^([a-zA-Z0-9_-]+)?\[([^=\]]+)="([^"]+)"\]$/);
    if (tagAttrMatch) {
      const [, tag, attr, val] = tagAttrMatch;
      if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      if (attr === 'value') return el.value === val || el.getAttribute('value') === val;
      return el.getAttribute(attr) === val;
    }
    if (selector.startsWith('.')) {
      return el.classList.contains(selector.slice(1));
    }
    if (selector.startsWith('#')) {
      return el.id === selector.slice(1);
    }
    return el.tagName.toLowerCase() === selector.toLowerCase();
  }

  const body = new MockEl('body');

  function makeStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => map.set(k, String(v)),
      removeItem: (k: string) => map.delete(k),
      clear: () => map.clear(),
    };
  }

  function resetDom() {
    body.childNodes = [];
    activeDialogs.length = 0;
  }

  function installMockDom() {
    (globalThis as any).Node = MockNode;
    (globalThis as any).HTMLElement = MockEl;
    const doc = {
      body,
      createElement: (tag: string) => new MockEl(tag),
      createElementNS: (_ns: string, tag: string) => new MockEl(tag),
      createTextNode: (t: string) => new MockText(t),
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: (sel: string) => {
        if (sel === 'dialog[open]') return activeDialogs.find((d) => d.open) ?? null;
        return body.querySelector(sel);
      },
      querySelectorAll: (sel: string) => body.querySelectorAll(sel),
      getElementById: (id: string) => body.querySelector(`#${id}`),
    };
    (globalThis as any).document = doc;
    (globalThis as any).window = {
      innerWidth: 1280,
      matchMedia: () => ({ matches: false }),
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      location: { hash: '#/' },
    };
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true, maxTouchPoints: 0 },
      configurable: true,
    });
    (globalThis as any).sessionStorage = makeStorage();
    (globalThis as any).localStorage = makeStorage();
  }

  installMockDom();

  return { cloudHandlers, activeDialogs, installMockDom, resetDom };
});

vi.mock('../../src/db/db', () => ({
  allProducts: vi.fn(async () => [
    { barcode: '7501055312345', sku: 'SKU-100', description: 'Tornillo hexagonal 1/4', source: 'catalogo', unit: 'PZA', updatedAt: Date.now() },
  ]),
  allSessions: vi.fn(async () => [
    { id: 1, name: 'Conteo General', counter: 'Carlos', createdAt: Date.now(), closed: false },
  ]),
  closeSession: vi.fn(async () => {}),
  countsForSession: vi.fn(async () => []),
  createSession: vi.fn(async () => ({ id: 1, name: 'Conteo General', counter: 'Carlos', createdAt: Date.now(), closed: false })),
  getActiveSession: vi.fn(async () => ({ id: 1, name: 'Conteo General', counter: 'Carlos', createdAt: Date.now(), closed: false })),
  reopenSession: vi.fn(async () => {}),
  addCount: vi.fn(async () => 1),
  deleteCount: vi.fn(async () => {}),
  findBySku: vi.fn(async () => undefined),
  getProduct: vi.fn(async () => ({
    barcode: '7501055312345',
    sku: 'SKU-100',
    description: 'Tornillo hexagonal 1/4',
    source: 'catalogo',
    unit: 'PZA',
    updatedAt: Date.now(),
  })),
  putCount: vi.fn(async () => {}),
}));

vi.mock('../../src/db/movements', () => ({
  getAllMovements: vi.fn(async () => []),
  deleteMovement: vi.fn(async () => {}),
  getIdealLevels: vi.fn(async () => []),
  getMovementSummariesBySku: vi.fn(async () => new Map()),
  listMovements: vi.fn(async () => []),
  recordMovement: vi.fn(async () => 1),
  setIdealLevel: vi.fn(async () => {}),
}));

vi.mock('../../src/lookup/pendingQueue', () => ({
  pendingCount: vi.fn(async () => 0),
  processPending: vi.fn(async () => 0),
}));

vi.mock('../../src/settings', () => ({
  loadSettings: vi.fn(async () => ({
    counterName: 'Carlos',
    quickMode: false,
    showExpected: true,
    soundOnScan: false,
    vibrateOnScan: false,
    roomCode: 'MHK1',
  })),
  saveSettings: vi.fn(async () => {}),
  settingsSync: vi.fn(() => ({
    counterName: 'Carlos',
    quickMode: false,
    showExpected: true,
    soundOnScan: false,
    vibrateOnScan: false,
    roomCode: 'MHK1',
  })),
}));

vi.mock('../../src/sync/cloudSync', () => ({
  getCloudConnectionStatus: vi.fn(() => ({ state: 'connected', roomCode: 'MHK1', lastSyncAt: Date.now() })),
  onCloudRoomUpdate: vi.fn((cb: () => void) => {
    cloudHandlers.add(cb);
    return () => cloudHandlers.delete(cb);
  }),
  onCloudStatusChange: vi.fn(() => () => {}),
  decodeCompactCountQr: vi.fn(() => null),
  isCompactCountQr: vi.fn(() => false),
  triggerBackgroundSync: vi.fn(),
}));

vi.mock('../../src/scanner/scanner', () => ({
  beep: vi.fn(),
  cameraAvailable: vi.fn(() => false),
  createDebouncer: vi.fn(() => Object.assign(() => true, { reset: vi.fn() })),
  startScanner: vi.fn(async () => null),
  unlockAudio: vi.fn(),
  vibrate: vi.fn(),
}));

vi.mock('../../src/scanner/wedge', () => ({
  createWedgeController: vi.fn(() => ({
    attach: vi.fn(),
    detach: vi.fn(),
  })),
}));

import { allProducts } from '../../src/db/db';
import { BRAND_CUBE_SVG_PATHS, buildStandaloneIconSvg, createBrandLogo } from '../../src/ui/logo';
import { homeView } from '../../src/ui/home';
import { countView } from '../../src/ui/count';
import { movementsView } from '../../src/ui/movementsView';

describe('UI Organization, Unified Logo & Workflow Improvements', () => {
  beforeEach(() => {
    cloudHandlers.clear();
    resetDom();
  });

  afterEach(async () => {
    await homeView.destroy?.();
    await countView.destroy?.();
    await movementsView.destroy?.();
  });

  it('generates unified cube brand logo for DOM and standalone PWA SVG', () => {
    const logoEl = createBrandLogo(32, 'brand-mark hero-brand-mark');
    expect(logoEl.className).toBe('brand-mark hero-brand-mark');
    expect(logoEl.getAttribute('aria-hidden')).toBe('true');
    expect(logoEl.innerHTML).toContain('width="32" height="32"');
    expect(logoEl.innerHTML).toContain('#38bdf8');
    expect(logoEl.innerHTML).toContain('M256 120 L372 178');

    const standalone = buildStandaloneIconSvg(512);
    expect(standalone).toContain('width="512" height="512"');
    expect(standalone).toContain('id="mohawk-bg"');
    expect(standalone).toContain(BRAND_CUBE_SVG_PATHS);
  });

  it('homeView subscribes to cloud updates, cleans up on destroy, and renders 1-click flow actions', async () => {
    const root = document.createElement('div');
    await homeView.render(root, new URLSearchParams());

    expect(cloudHandlers.size).toBe(1);
    expect(root.querySelector('.hero-brand-mark')).not.toBeNull();
    expect(root.querySelector('.dash-tools-grid')).toBeNull();
    expect(root.querySelector('[data-testid="home-quick-in"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="home-quick-out"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="home-quick-unify"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="home-quick-labels"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="home-quick-import"]')).not.toBeNull();

    const callsBefore = vi.mocked(allProducts).mock.calls.length;
    for (const cb of cloudHandlers) cb();
    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(allProducts).mock.calls.length).toBeGreaterThan(callsBefore);

    await homeView.destroy?.();
    expect(cloudHandlers.size).toBe(0);
  });

  it('countView subscribes to cloud updates, shows session shortcuts, and increments qty with +5/+10/+25 chips', async () => {
    const root = document.createElement('div');
    await countView.render(root, new URLSearchParams());

    expect(cloudHandlers.size).toBe(1);
    expect(root.querySelector('[data-testid="count-goto-kardex"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="count-goto-report"]')).not.toBeNull();
    expect(root.querySelector('.scanner-ready-badge')).not.toBeNull();

    (window as any).__simulateScan('7501055312345');
    await new Promise((r) => setTimeout(r, 15));

    const qtyInput = root.querySelector('.qty-row input') as unknown as HTMLInputElement;
    expect(qtyInput).not.toBeNull();
    expect(qtyInput.value).toBe('1');

    const plus5 = root.querySelector('[data-testid="count-quick-plus-5"]') as HTMLElement;
    const plus10 = root.querySelector('[data-testid="count-quick-plus-10"]') as HTMLElement;
    const plus25 = root.querySelector('[data-testid="count-quick-plus-25"]') as HTMLElement;
    expect(plus5).not.toBeNull();

    plus5.click();
    expect(qtyInput.value).toBe('6');
    plus10.click();
    expect(qtyInput.value).toBe('16');
    plus25.click();
    expect(qtyInput.value).toBe('41');

    await countView.destroy?.();
    expect(cloudHandlers.size).toBe(0);
  });

  it('movementsView renders + Entrada / - Salida buttons and opens registration modal for ?action=in and ?action=out', async () => {
    const root = document.createElement('div');
    await movementsView.render(root, new URLSearchParams('action=in'));
    await new Promise((r) => setTimeout(r, 15));

    expect(root.querySelector('[data-testid="movements-quick-in-btn"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="movements-quick-out-btn"]')).not.toBeNull();
    expect(activeDialogs.length).toBeGreaterThanOrEqual(1);
    const firstModal = activeDialogs[activeDialogs.length - 1];
    const inControls = [
      ...firstModal.querySelectorAll('button').map((b) => `${b.className}:${b.textContent}`),
      ...firstModal.querySelectorAll('select').map((s) => `select:${s.value}`),
      ...firstModal.querySelectorAll('input').map((i) => `${i.type}:${i.value}:${i.checked}`),
    ];
    expect(inControls.some((s) => s.includes('IN') || s.toLowerCase().includes('entrada'))).toBe(true);
    firstModal.close();

    await movementsView.destroy?.();
    resetDom();

    await movementsView.render(root, new URLSearchParams('action=out'));
    await new Promise((r) => setTimeout(r, 15));
    expect(activeDialogs.length).toBeGreaterThanOrEqual(1);
    const outModal = activeDialogs[activeDialogs.length - 1];
    const outControls = [
      ...outModal.querySelectorAll('button').map((b) => `${b.className}:${b.textContent}`),
      ...outModal.querySelectorAll('select').map((s) => `select:${s.value}`),
      ...outModal.querySelectorAll('input').map((i) => `${i.type}:${i.value}:${i.checked}`),
    ];
    expect(outControls.some((s) => s.includes('OUT') || s.toLowerCase().includes('salida'))).toBe(true);
    expect(outControls).not.toEqual(inControls);
    outModal.close();
  });
});
