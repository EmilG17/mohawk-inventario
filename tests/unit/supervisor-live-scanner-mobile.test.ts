import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addCount,
  allProducts,
  createSession,
  getActiveSession,
  getDB,
  getProduct,
  putProduct,
  setActiveSession,
} from '../../src/db/db';
import { getIdealLevels } from '../../src/db/movements';
import { loadSettings, saveSettings } from '../../src/settings';
import {
  _clearMemoryRooms,
  applyIncomingRoomStateToLocal,
  coerceRemoteRoomState,
  computeStateFingerprint,
  getCachedRoomState,
  onCloudRoomUpdate,
  publishLiveScannerState,
  testFirebaseConnection,
  type CloudRoomState,
} from '../../src/sync/cloudSync';
import { isMobileViewport, isSupervisorModeEnabled } from '../../src/ui/catalogMode';

const { body, installMockDom, setMockViewportWidth, resetDom } = vi.hoisted(() => {
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
    contains(other: MockNode | null): boolean {
      if (!other) return false;
      let cur: MockNode | null = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
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
    constructor(t: string) {
      super();
      this._text = t;
    }
  }

  class MockEl extends MockNode {
    tagName: string;
    className = '';
    attributes: Record<string, string> = {};
    listeners: Record<string, Array<(ev: any) => void>> = {};
    id = '';
    value = '';
    checked = false;
    disabled = false;
    readOnly = false;
    hidden = false;
    open = false;
    type = '';
    style: Record<string, string> = {};

    constructor(tag: string) {
      super();
      this.tagName = tag.toUpperCase();
    }
    get isConnected(): boolean {
      let cur: MockNode | null = this;
      while (cur) {
        if (cur === body) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    get offsetWidth(): number {
      return 100;
    }
    get classList() {
      const getClasses = () => this.className.split(/\s+/).filter(Boolean);
      return {
        add: (...names: string[]) => {
          const set = new Set(getClasses());
          for (const n of names) set.add(n);
          this.className = Array.from(set).join(' ');
        },
        remove: (...names: string[]) => {
          const rm = new Set(names);
          this.className = getClasses().filter((c) => !rm.has(c)).join(' ');
        },
        toggle: (c: string, force?: boolean) => {
          const set = new Set(getClasses());
          const shouldHave = force === undefined ? !set.has(c) : force;
          if (shouldHave) set.add(c);
          else set.delete(c);
          this.className = Array.from(set).join(' ');
          return shouldHave;
        },
        contains: (c: string) => getClasses().includes(c),
      };
    }
    setAttribute(k: string, v: string): void {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.className = String(v);
    }
    getAttribute(k: string): string | null {
      if (k === 'id') return this.id || null;
      if (k === 'class') return this.className || null;
      return k in this.attributes ? this.attributes[k] : null;
    }
    addEventListener(type: string, fn: (ev: any) => void): void {
      (this.listeners[type] ||= []).push(fn);
    }
    removeEventListener(type: string, fn: (ev: any) => void): void {
      if (this.listeners[type]) {
        this.listeners[type] = this.listeners[type].filter((f) => f !== fn);
      }
    }
    dispatchEvent(ev: any): boolean {
      const e = ev && typeof ev === 'object' ? ev : { type: String(ev) };
      e.target = this;
      for (const fn of this.listeners[e.type] || []) fn(e);
      return true;
    }
    showModal(): void {
      this.open = true;
    }
    close(): void {
      if (this.open) {
        this.open = false;
        this.dispatchEvent({ type: 'close', stopPropagation: () => {}, preventDefault: () => {} });
      }
    }
    click(): void {
      this.dispatchEvent({ type: 'click', stopPropagation: () => {}, preventDefault: () => {} });
    }
    select(): void {}
    focus(): void {}
    blur(): void {}
    querySelectorAll(selector: string): MockEl[] {
      const out: MockEl[] = [];
      const visit = (node: MockNode) => {
        for (const child of node.childNodes) {
          if (child instanceof MockEl) {
            if (matches(child, selector)) out.push(child);
            visit(child);
          }
        }
      };
      visit(this);
      return out;
    }
    querySelector(selector: string): MockEl | null {
      return this.querySelectorAll(selector)[0] ?? null;
    }
  }

  function matches(el: MockEl, selector: string): boolean {
    if (selector === 'dialog[open]') return el.tagName === 'DIALOG' && el.open;
    const m = selector.match(/^([a-zA-Z0-9_-]+)?\[([^=\]]+)="([^"]+)"\]$/);
    if (m) {
      const [, tag, attr, val] = m;
      if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      return el.getAttribute(attr) === val;
    }
    if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return el.id === selector.slice(1);
    return el.tagName.toLowerCase() === selector.toLowerCase();
  }

  const body = new MockEl('body');
  const html = new MockEl('html');
  let viewportWidth = 1280;

  function makeStorage() {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => map.set(k, String(v)),
      removeItem: (k: string) => map.delete(k),
      clear: () => map.clear(),
    };
  }

  function installMockDom() {
    (globalThis as any).Node = MockNode;
    (globalThis as any).HTMLElement = MockEl;
    (globalThis as any).document = {
      body,
      documentElement: html,
      activeElement: null,
      createElement: (tag: string) => new MockEl(tag),
      createElementNS: (_ns: string, tag: string) => new MockEl(tag),
      createTextNode: (t: string) => new MockText(t),
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: (sel: string) => body.querySelector(sel),
      querySelectorAll: (sel: string) => body.querySelectorAll(sel),
      getElementById: (id: string) => body.querySelector(`#${id}`),
    };
    (globalThis as any).window = {
      get innerWidth() {
        return viewportWidth;
      },
      matchMedia: () => ({ matches: viewportWidth < 900 }),
      addEventListener: () => {},
      removeEventListener: () => {},
      scrollTo: () => {},
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      location: { hash: '#/' },
    };
    (globalThis as any).localStorage = makeStorage();
    (globalThis as any).sessionStorage = makeStorage();
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true, maxTouchPoints: 0 },
      configurable: true,
    });
  }

  function setMockViewportWidth(w: number) {
    viewportWidth = w;
  }

  function resetDom() {
    body.childNodes = [];
  }

  installMockDom();
  return { body, installMockDom, setMockViewportWidth, resetDom };
});

import { countView, processCode } from '../../src/ui/count';
import { homeView } from '../../src/ui/home';
import { editProductDialog } from '../../src/ui/productDialog';
import { reportView } from '../../src/ui/reportView';
import { settingsView } from '../../src/ui/settingsView';
import { teamView } from '../../src/ui/teamView';

const nativeFetch = globalThis.fetch;

describe('Live Scanner Telemetry in Supervisor & Mobile Supervisor Mode Gating', () => {
  beforeEach(async () => {
    setMockViewportWidth(1280);
    resetDom();
    _clearMemoryRooms();
    (globalThis as any).localStorage.clear();
    (globalThis as any).sessionStorage.clear();
    const db = await getDB();
    await Promise.all([db.clear('products'), db.clear('counts'), db.clear('sessions'), db.clear('meta')]);
    await saveSettings({
      counterName: 'Supervisor',
      syncEnabled: false,
      syncRoomCode: '',
      syncEndpointUrl: '',
      supervisorMode: false,
      quickMode: false,
      showExpected: true,
    });
    vi.restoreAllMocks();
    (globalThis as any).fetch = nativeFetch;
  });

  afterAll(async () => {
    await teamView.destroy?.();
    await countView.destroy?.();
    setMockViewportWidth(1280);
    (globalThis as any).fetch = nativeFetch;
  });

  it('publishLiveScannerState updates mirror, fingerprint, notifies listeners, and PATCHes Firebase /liveScanners.json', async () => {
    const patchCalls: { url: string; method?: string; body?: string }[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string, init?: RequestInit) => {
      patchCalls.push({ url, method: init?.method, body: String(init?.body || '') });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await saveSettings({
      counterName: 'Emil',
      syncEnabled: true,
      syncRoomCode: 'HHF-1114',
      syncEndpointUrl: 'https://hhf-inventory-default-rtdb.firebaseio.com/',
    });

    const received: CloudRoomState[] = [];
    const unsub = onCloudRoomUpdate((st) => received.push(st));

    await publishLiveScannerState({
      status: 'pending_confirm',
      cameraOn: true,
      origin: 'camara',
      barcode: 'M102-0416',
      sku: 'M102-0416',
      description: 'Tornillo prueba',
      qty: 12,
      sessionName: 'Prueba',
    });

    unsub();

    expect(patchCalls.length).toBe(1);
    expect(patchCalls[0].method).toBe('PATCH');
    expect(patchCalls[0].url).toBe('https://hhf-inventory-default-rtdb.firebaseio.com/rooms/HHF-1114/liveScanners.json');
    const parsedPatch = JSON.parse(patchCalls[0].body || '{}');
    const [slotKey] = Object.keys(parsedPatch);
    expect(slotKey).toContain('Emil__');
    expect(parsedPatch[slotKey].status).toBe('pending_confirm');
    expect(parsedPatch[slotKey].qty).toBe(12);
    expect(parsedPatch[slotKey].barcode).toBe('M102-0416');

    const cached = getCachedRoomState('HHF-1114');
    expect(cached).not.toBeNull();
    expect(Object.values(cached!.liveScanners || {}).length).toBe(1);
    expect(received.length).toBe(1);

    // computeStateFingerprint detects changes in liveScanners and participants
    const fp1 = computeStateFingerprint(cached);
    const updatedState: CloudRoomState = {
      ...cached!,
      liveScanners: {
        [slotKey]: {
          ...parsedPatch[slotKey],
          qty: 25,
          updatedAt: Date.now() + 1000,
        },
      },
    };
    const fp2 = computeStateFingerprint(updatedState);
    expect(fp2).not.toBe(fp1);

    const changed = await applyIncomingRoomStateToLocal(updatedState, 'remote');
    expect(changed).toBe(true);
  });

  it('teamView renders live counts, products, participants, and active live scanners WITHOUT a local active session', async () => {
    await saveSettings({
      counterName: 'Supervisor',
      syncEnabled: true,
      syncRoomCode: 'HHF-1114',
      syncEndpointUrl: '',
    });

    expect(await getActiveSession()).toBeUndefined();

    const now = Date.now();
    await applyIncomingRoomStateToLocal(
      {
        app: 'mohawk-inventario',
        version: 1,
        roomCode: 'HHF-1114',
        updatedAt: now,
        sessionName: 'Prueba',
        counts: [
          {
            id: 'cnt_emil_1',
            sessionId: 'sess_remote',
            barcode: 'M102-0416',
            qty: 1,
            counter: 'Emil',
            deviceId: '0c29c0df',
            timestamp: now - 30000,
          },
        ],
        products: [
          {
            barcode: 'M102-0416',
            sku: 'M102-0416',
            description: 'FILTRO HIDRAULICO PRUEBA',
            unit: 'PZA',
            source: 'catalogo',
            updatedAt: now - 60000,
          },
        ],
        participants: {
          Emil__0c29c0df: {
            counter: 'Emil',
            deviceId: '0c29c0df',
            lastSeen: now - 30000,
            scans: 1,
            units: 1,
            lastSku: 'M102-0416',
          },
        },
        liveScanners: {
          Luis__9999aaaa: {
            counter: 'Luis',
            deviceId: '9999aaaa',
            status: 'pending_confirm',
            cameraOn: true,
            origin: 'camara',
            barcode: 'M102-0416',
            sku: 'M102-0416',
            description: 'FILTRO HIDRAULICO PRUEBA',
            qty: 15,
            sessionName: 'Prueba',
            updatedAt: now,
          },
        },
        movements: [],
        idealLevels: {},
      },
      'remote',
    );

    const root = document.createElement('div');
    document.body.appendChild(root);
    await teamView.render(root, new URLSearchParams());

    const liveStrip = root.querySelector('[data-testid="team-live-scanners"]');
    expect(liveStrip).not.toBeNull();
    expect(liveStrip!.textContent).toContain('Luis');
    expect(liveStrip!.textContent).toContain('Confirmando cantidad');
    expect(liveStrip!.textContent).toContain('15');
    expect(liveStrip!.textContent).toContain('M102-0416');

    expect(root.textContent).toContain('Emil');
    expect(root.textContent).toContain('Monitoreando en vivo Sala HHF-1114 (Prueba)');
    expect(root.textContent).toContain('1 lectura(s)');

    await teamView.destroy?.();
  });

  it('connects read-only to live Firebase room HHF-1114 and renders it in teamView without modifying remote data', async () => {
    const firebaseUrl = 'https://hhf-inventory-default-rtdb.firebaseio.com';
    try {
      const check = await testFirebaseConnection(firebaseUrl, 'HHF-1114');
      expect(check.ok).toBe(true);
      expect(check.existingCounts).toBeGreaterThanOrEqual(1);

      const res = await nativeFetch(`${firebaseUrl}/rooms/HHF-1114.json`);
      expect(res.ok).toBe(true);
      const rawJson = await res.json();
      const coerced = coerceRemoteRoomState(rawJson, 'HHF-1114');
      expect(coerced).not.toBeNull();
      expect(coerced!.roomCode).toBe('HHF-1114');
      expect(coerced!.counts.length).toBeGreaterThanOrEqual(1);
      expect(coerced!.products.length).toBeGreaterThanOrEqual(1);

      await saveSettings({
        counterName: 'Supervisor',
        syncEnabled: false,
        syncRoomCode: 'HHF-1114',
        syncEndpointUrl: '',
      });
      await applyIncomingRoomStateToLocal(coerced!, 'remote');

      const root = document.createElement('div');
      document.body.appendChild(root);
      await teamView.render(root, new URLSearchParams());

      expect(root.textContent).toContain('HHF-1114');
      expect(root.textContent).toContain('Emil');
      expect(root.textContent).toContain(`(${coerced!.sessionName})`);
      await teamView.destroy?.();
    } catch (err) {
      // If test environment is strictly offline, ensure unit logic doesn't fail CI
      if (navigator.onLine === false) return;
      throw err;
    }
  });

  it('hides unnecessary supervisor options on mobile (<900px) unless supervisorMode is enabled', async () => {
    await putProduct({
      barcode: '07501055312345',
      sku: 'SKU-100',
      description: 'Tornillo hexagonal 1/4',
      unit: 'PZA',
      expectedQty: 50,
      source: 'catalogo',
      updatedAt: Date.now(),
    });
    const sess = await createSession('Conteo Piso', 'Luis');
    await setActiveSession(sess.id);

    // 1. Mobile default (supervisorMode: false)
    setMockViewportWidth(390);
    await loadSettings();
    await saveSettings({ supervisorMode: false, showExpected: true });
    expect(isMobileViewport()).toBe(true);
    expect(isSupervisorModeEnabled()).toBe(false);

    const homeRoot = document.createElement('div');
    document.body.appendChild(homeRoot);
    await homeView.render(homeRoot, new URLSearchParams());
    expect(homeRoot.querySelector('[data-testid="home-quick-in"]')).not.toBeNull();
    expect(homeRoot.querySelector('[data-testid="home-quick-out"]')).not.toBeNull();
    expect(homeRoot.querySelector('[data-testid="home-quick-import"]')).not.toBeNull();
    expect(homeRoot.querySelector('[data-testid="home-quick-unify"]')).toBeNull();
    expect(homeRoot.querySelector('[data-testid="home-quick-labels"]')).toBeNull();
    expect(homeRoot.querySelector('[data-testid="home-goto-report-btn"]')).toBeNull();
    expect(homeRoot.querySelector('[data-testid="home-create-session-btn"]')).toBeNull();
    expect(homeRoot.querySelector('.dash-cols-layout')).toBeNull();
    await homeView.destroy?.();

    const countRoot = document.createElement('div');
    document.body.appendChild(countRoot);
    await countView.render(countRoot, new URLSearchParams());
    expect(countRoot.querySelector('.scanner-ready-badge')).toBeNull();
    expect(countRoot.querySelector('[data-testid="count-goto-report"]')).toBeNull();

    // Scanning emits live pending_confirm telemetry and omits supervisor "Producto" & "Teórico" on mobile
    await saveSettings({ syncRoomCode: 'MHK-MOB', syncEnabled: false });
    await processCode('7501055312345', 'manual');
    const pcard = countRoot.querySelector('#pcard')!;
    expect(pcard.hidden).toBe(false);
    expect(pcard.textContent).not.toContain('Teórico:');
    expect(pcard.textContent).toContain('Ideal: 50');
    expect(pcard.textContent).not.toContain('Producto');

    const plus5 = countRoot.querySelector('[data-testid="count-quick-plus-5"]');
    expect(plus5).not.toBeNull();
    plus5!.click();
    await new Promise((r) => setTimeout(r, 20));
    const roomAfterStep = getCachedRoomState('MHK-MOB');
    const scannerSlot = Object.values(roomAfterStep?.liveScanners || {})[0];
    expect(scannerSlot).toBeDefined();
    expect(scannerSlot.status).toBe('pending_confirm');
    expect(scannerSlot.qty).toBe(6);

    await countView.destroy?.();

    const settingsRoot = document.createElement('div');
    document.body.appendChild(settingsRoot);
    await settingsView.render(settingsRoot, new URLSearchParams());
    expect(settingsRoot.querySelector('[data-testid="settings-supervisor-mode-toggle"]')).not.toBeNull();
    expect(settingsRoot.textContent).not.toContain('Moneda (Reporte)');
    expect(settingsRoot.textContent).not.toContain('Mostrar teórico');
    expect(settingsRoot.textContent).not.toContain('Buscar en internet');
    expect(settingsRoot.querySelector('.settings-advanced')).toBeNull();

    // 2. Enable Supervisor Mode on mobile -> all supervisor controls become visible
    await saveSettings({ supervisorMode: true });
    expect(isSupervisorModeEnabled()).toBe(true);

    await homeView.render(homeRoot, new URLSearchParams());
    expect(homeRoot.querySelector('[data-testid="home-quick-unify"]')).not.toBeNull();
    expect(homeRoot.querySelector('[data-testid="home-quick-labels"]')).not.toBeNull();
    expect(homeRoot.querySelector('[data-testid="home-goto-report-btn"]')).not.toBeNull();
    expect(homeRoot.querySelector('.dash-cols-layout')).not.toBeNull();
    await homeView.destroy?.();

    await countView.render(countRoot, new URLSearchParams());
    expect(countRoot.querySelector('.scanner-ready-badge')).not.toBeNull();
    expect(countRoot.querySelector('[data-testid="count-goto-report"]')).not.toBeNull();
    await countView.destroy?.();

    await settingsView.render(settingsRoot, new URLSearchParams());
    expect(settingsRoot.textContent).toContain('Moneda (Reporte)');
    expect(settingsRoot.textContent).toContain('Mostrar teórico');
    expect(settingsRoot.querySelector('.settings-advanced')).not.toBeNull();
  });

  it('unifies Existencia teórica & Min/Max into Inventario Ideal across productDialog, countView, and reportView', async () => {
    setMockViewportWidth(1280);
    await loadSettings();
    await saveSettings({ showExpected: true, supervisorMode: true });

    await putProduct({
      barcode: '07501055312345',
      sku: 'SKU-100',
      description: 'Tornillo hexagonal 1/4',
      unit: 'PZA',
      expectedQty: 50,
      source: 'catalogo',
      updatedAt: Date.now(),
    });

    const dlgPromise = editProductDialog('07501055312345');
    await new Promise((r) => setTimeout(r, 20));

    const dlg = document.body.querySelector('dialog[open]')!;
    expect(dlg).not.toBeNull();
    expect(dlg.textContent).toContain('Inventario Ideal');
    expect(dlg.textContent).not.toContain('Stock mínimo');
    expect(dlg.textContent).not.toContain('Stock máximo');

    const idealInput = dlg.querySelector('[data-testid="product-ideal-qty-input"]')!;
    expect(idealInput).not.toBeNull();
    expect(idealInput.value).toBe('50');
    idealInput.value = '85';

    const saveBtn = dlg.querySelectorAll('button').find((b) => b.textContent === 'Guardar')!;
    expect(saveBtn).toBeDefined();
    saveBtn.click();

    const edited = await dlgPromise;
    expect(edited && edited !== 'deleted' ? edited.expectedQty : undefined).toBe(85);
    expect((await getProduct('07501055312345'))?.expectedQty).toBe(85);
    expect((await getIdealLevels())['SKU-100']).toBe(85);

    const sess = await createSession('Auditoría Ideal', 'Emil');
    await setActiveSession(sess.id);
    await addCount({ sessionId: sess.id, barcode: '07501055312345', qty: 60, counter: 'Emil', deviceId: 'dev-1' });

    const countRoot = document.createElement('div');
    document.body.appendChild(countRoot);
    await countView.render(countRoot, new URLSearchParams());
    await processCode('7501055312345', 'teclado');
    const pcard = countRoot.querySelector('#pcard')!;
    expect(pcard.textContent).toContain('Ideal: 85');
    await countView.destroy?.();

    const reportRoot = document.createElement('div');
    document.body.appendChild(reportRoot);
    await reportView.render(reportRoot, new URLSearchParams());
    expect(reportRoot.textContent).toContain('Ideal: 85');
    expect(reportRoot.textContent).not.toContain('Teórico:');
    await reportView.destroy?.();
  });
});
