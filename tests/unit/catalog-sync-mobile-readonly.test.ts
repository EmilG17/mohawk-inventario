import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allProducts,
  bulkModifyProducts,
  clearProducts,
  deleteProduct,
  deleteProducts,
  getActiveSession,
  getDB,
  getProduct,
  putProduct,
  type Product,
} from '../../src/db/db';
import { reconcileCatalogProducts } from '../../src/io/mergeCounts';
import { saveSettings } from '../../src/settings';
import {
  _clearMemoryRooms,
  applyIncomingRoomStateToLocal,
  getCachedRoomState,
  getLocalTombstones,
  syncCatalogWithDb,
  type CloudRoomState,
} from '../../src/sync/cloudSync';
import { isMobileCatalogReadOnly } from '../../src/ui/catalogMode';

const { activeDialogs, body, installMockDom, setMockViewportWidth, resetDom } = vi.hoisted(() => {
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
        contains: (name: string) => getClasses().includes(name),
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
    showModal(): void {
      this.open = true;
      if (!activeDialogs.includes(this)) activeDialogs.push(this);
    }
    close(): void {
      this.open = false;
      const idx = activeDialogs.indexOf(this);
      if (idx >= 0) activeDialogs.splice(idx, 1);
      for (const fn of this.listeners['close'] || []) fn({});
    }
    click(): void {
      for (const fn of this.listeners['click'] || []) {
        fn({ target: this, stopPropagation: () => {}, preventDefault: () => {} });
      }
    }
    select(): void {}
    focus(): void {}
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
  const activeDialogs: MockEl[] = [];
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
      createElement: (tag: string) => new MockEl(tag),
      createElementNS: (_ns: string, tag: string) => new MockEl(tag),
      createTextNode: (t: string) => new MockText(t),
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: (sel: string) => (sel === 'dialog[open]' ? activeDialogs[0] ?? null : body.querySelector(sel)),
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
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      location: { hash: '#/' },
    };
    (globalThis as any).localStorage = makeStorage();
    (globalThis as any).sessionStorage = makeStorage();
  }

  function setMockViewportWidth(w: number) {
    viewportWidth = w;
  }

  function resetDom() {
    body.childNodes = [];
    activeDialogs.length = 0;
  }

  installMockDom();
  return { activeDialogs, body, installMockDom, setMockViewportWidth, resetDom };
});

import { catalogView, importCatalogFlow, openMassDeleteDialog, openMassModifyDialog } from '../../src/ui/catalog';
import { editProductDialog } from '../../src/ui/productDialog';

describe('Catalog Sync with DB & Mobile Read-Only Enforcement', () => {
  beforeEach(async () => {
    setMockViewportWidth(1280);
    resetDom();
    _clearMemoryRooms();
    (globalThis as any).localStorage.clear();
    const db = await getDB();
    await Promise.all([db.clear('products'), db.clear('counts'), db.clear('sessions'), db.clear('meta')]);
    vi.restoreAllMocks();
  });

  afterAll(() => {
    setMockViewportWidth(1280);
  });

  it('detects mobile read-only mode strictly under 900px breakpoint', () => {
    setMockViewportWidth(1280);
    expect(isMobileCatalogReadOnly()).toBe(false);
    setMockViewportWidth(900);
    expect(isMobileCatalogReadOnly()).toBe(false);
    setMockViewportWidth(899);
    expect(isMobileCatalogReadOnly()).toBe(true);
    setMockViewportWidth(390);
    expect(isMobileCatalogReadOnly()).toBe(true);
  });

  it('syncs catalog updates & cleared optional fields with DB even without an active session', async () => {
    const roomCode = 'CAT-SYNC-01';
    expect(await getActiveSession()).toBeUndefined();

    // Seed an older version in remote room with expectedQty: 50
    await applyIncomingRoomStateToLocal(
      {
        app: 'mohawk-inventario',
        version: 1,
        roomCode,
        updatedAt: 1000,
        sessionName: `Sala ${roomCode}`,
        counts: [],
        products: [
          {
            barcode: '75010001',
            sku: 'SKU-1',
            description: 'Guante Viejo',
            unit: 'PAR',
            expectedQty: 50,
            unitCost: 12,
            uncataloged: false,
            source: 'catalogo',
            updatedAt: 1000,
          },
        ],
        participants: {},
      },
      'local',
    );

    // Desktop edits product with newer timestamp and clears expectedQty
    const newerTs = Date.now() + 5000;
    await putProduct({
      barcode: '75010001',
      sku: 'SKU-1',
      description: 'Guante Actualizado',
      unit: 'CJA',
      unitCost: 24,
      uncataloged: false,
      source: 'catalogo',
      updatedAt: newerTs,
    });
    await bulkModifyProducts(['75010001'], { brand: 'Ansell' });

    const syncRes = await syncCatalogWithDb({ roomCode });
    expect(syncRes.totalLocalProducts).toBe(1);

    const room = getCachedRoomState(roomCode)!;
    expect(room.products).toHaveLength(1);
    expect(room.products[0].description).toBe('Guante Actualizado');
    expect(room.products[0].unit).toBe('CJA');
    expect(room.products[0].brand).toBe('Ansell');
    expect(room.products[0].unitCost).toBe(24);
    expect(room.products[0].expectedQty).toBeUndefined();

    // Simulate stale second device holding old expectedQty: 50 and applying remote state
    await putProduct({
      barcode: '75010001',
      sku: 'SKU-1',
      description: 'Guante Viejo',
      unit: 'PAR',
      expectedQty: 50,
      uncataloged: false,
      source: 'catalogo',
      updatedAt: 1000,
    });
    const rec = await reconcileCatalogProducts(room.products);
    expect(rec.updated).toBe(1);
    const localAfter = await getProduct('75010001');
    expect(localAfter?.description).toBe('Guante Actualizado');
    expect(localAfter?.expectedQty).toBeUndefined();
  });

  it('propagates product deletion tombstones across DB sync and prevents zombie resurrection', async () => {
    const roomCode = 'CAT-TOMB-01';
    const baseTs = 1000;

    await putProduct({
      barcode: '75010001',
      sku: 'SKU-A',
      description: 'Producto A',
      unit: 'PZA',
      uncataloged: false,
      source: 'catalogo',
      updatedAt: baseTs,
    });
    await putProduct({
      barcode: '75010002',
      sku: 'SKU-B',
      description: 'Producto B',
      unit: 'PZA',
      uncataloged: false,
      source: 'catalogo',
      updatedAt: baseTs,
    });
    await putProduct({
      barcode: '75010003',
      sku: 'SKU-C',
      description: 'Producto C',
      unit: 'PZA',
      uncataloged: false,
      source: 'catalogo',
      updatedAt: baseTs,
    });

    await syncCatalogWithDb({ roomCode });
    expect(getCachedRoomState(roomCode)?.products).toHaveLength(3);

    // Desktop deletes one product then bulk-deletes another
    await deleteProduct('75010002');
    await deleteProducts(['75010003']);

    const tombstones = await getLocalTombstones();
    expect(tombstones.products?.['75010002']).toBeGreaterThan(baseTs);
    expect(tombstones.products?.['75010003']).toBeGreaterThan(baseTs);

    const afterDelSync = await syncCatalogWithDb({ roomCode });
    expect(afterDelSync.totalLocalProducts).toBe(1);
    expect(getCachedRoomState(roomCode)?.products.map((p) => p.barcode)).toEqual(['75010001']);

    // Stale client pushes old snapshot containing deleted products -> must stay deleted
    const staleRoom: CloudRoomState = {
      app: 'mohawk-inventario',
      version: 1,
      roomCode,
      updatedAt: baseTs,
      sessionName: `Sala ${roomCode}`,
      counts: [],
      products: [
        {
          barcode: '75010002',
          sku: 'SKU-B',
          description: 'Producto B',
          unit: 'PZA',
          uncataloged: false,
          source: 'catalogo',
          updatedAt: baseTs,
        },
      ],
      participants: {},
    };
    await applyIncomingRoomStateToLocal(staleRoom, 'remote');
    expect(await getProduct('75010002')).toBeUndefined();

    // Clear catalog removes remaining product from DB too
    await clearProducts();
    await syncCatalogWithDb({ roomCode });
    expect(getCachedRoomState(roomCode)?.products).toHaveLength(0);

    // Re-adding product later with a newer updatedAt beats old tombstone cleanly
    await putProduct({
      barcode: '75010002',
      sku: 'SKU-B',
      description: 'Producto B Reingresado',
      unit: 'CJA',
      uncataloged: false,
      source: 'catalogo',
      updatedAt: Date.now() + 10_000,
    });
    await syncCatalogWithDb({ roomCode });
    expect(getCachedRoomState(roomCode)?.products.map((p) => p.barcode)).toEqual(['75010002']);
  });

  it('prevents mobile client from overwriting or deleting remote DB catalog while pulling updates and pushing uncataloged scans', async () => {
    const roomCode = 'CAT-MOB-SYNC';

    // Desktop populates authoritative catalog in DB room
    setMockViewportWidth(1280);
    await putProduct({
      barcode: '75010001',
      sku: 'SKU-M1',
      description: 'Autorizado Desktop',
      unit: 'PZA',
      uncataloged: false,
      source: 'catalogo',
      updatedAt: 2000,
    });
    await putProduct({
      barcode: '75010002',
      sku: 'SKU-M2',
      description: 'Debe Permanecer',
      unit: 'CJA',
      uncataloged: false,
      source: 'catalogo',
      updatedAt: 2000,
    });
    await syncCatalogWithDb({ roomCode });

    // Switch to mobile viewport and tamper with local IndexedDB directly
    setMockViewportWidth(390);
    await putProduct({
      barcode: '75010001',
      sku: 'SKU-M1',
      description: 'Sobrescritura Móvil Bloqueada',
      unit: 'PZA',
      uncataloged: false,
      source: 'manual',
      updatedAt: Date.now() + 50_000,
    });
    await deleteProduct('75010002');
    await putProduct({
      barcode: '999000111',
      sku: '',
      description: '',
      unit: '',
      uncataloged: true,
      source: 'pendiente',
      updatedAt: 5000,
    });

    await saveSettings({ syncRoomCode: roomCode, syncEnabled: true });
    await syncCatalogWithDb({ roomCode });

    const cachedRoom = getCachedRoomState(roomCode)!;
    const p1Remote = cachedRoom.products.find((p) => p.barcode === '75010001');
    const p2Remote = cachedRoom.products.find((p) => p.barcode === '75010002');
    const uncatRemote = cachedRoom.products.find((p) => p.barcode === '999000111');

    // Remote DB stays intact (mobile could not overwrite or tombstone official products)
    expect(p1Remote?.description).toBe('Autorizado Desktop');
    expect(p2Remote?.description).toBe('Debe Permanecer');
    expect(cachedRoom.tombstones?.products?.['75010002']).toBeUndefined();
    // Uncataloged scan placeholder is shared
    expect(uncatRemote?.uncataloged).toBe(true);
    // Deleted official product is restored locally on mobile
    expect((await getProduct('75010002'))?.description).toBe('Debe Permanecer');
  });

  it('hides write controls on mobile catalogView, blocks write flows, and opens productDialog in read-only mode', async () => {
    const sample: Product = {
      barcode: '75010001',
      sku: 'SKU-UI-1',
      description: 'Disco Corte 4.5',
      unit: 'PZA',
      expectedQty: 15,
      uncataloged: false,
      source: 'catalogo',
      updatedAt: 1000,
    };
    await putProduct(sample);

    // 1. Mobile UI
    setMockViewportWidth(390);
    const mobileRoot = (globalThis as any).document.createElement('div');
    (globalThis as any).document.body.appendChild(mobileRoot);
    await catalogView.render(mobileRoot);

    expect(mobileRoot.querySelector('[data-testid="catalog-mobile-readonly-badge"]')).not.toBeNull();
    expect(mobileRoot.querySelector('[data-testid="catalog-sync-db-btn"]')).not.toBeNull();
    expect(mobileRoot.querySelector('[data-testid="catalog-new-btn"]')).toBeNull();
    expect(mobileRoot.querySelector('[data-testid="catalog-import-btn"]')).toBeNull();

    // Blocking write flows on mobile must return without opening dialogs or changing DB
    await importCatalogFlow();
    openMassModifyDialog(['75010001'], () => {});
    openMassDeleteDialog([sample], ['75010001'], [sample], () => {});
    const newRes = await editProductDialog('');
    expect(newRes).toBeNull();
    expect(activeDialogs).toHaveLength(0);

    // Opening existing product shows read-only dialog without Guardar/Eliminar
    const dlgPromise = editProductDialog('75010001', sample);
    await new Promise((r) => setTimeout(r, 0));
    expect(activeDialogs).toHaveLength(1);
    const dlg = activeDialogs[0];
    expect(dlg.querySelector('[data-testid="product-dialog-readonly-notice"]')).not.toBeNull();
    const btns = dlg.querySelectorAll('button').map((b: any) => b.textContent);
    expect(btns).not.toContain('Guardar');
    expect(btns).not.toContain('Eliminar');
    expect(btns).toContain('Cancelar');
    dlg.close();
    expect(await dlgPromise).toBeNull();
    catalogView.destroy?.();

    // 2. Desktop UI restores full CRUD toolbar
    setMockViewportWidth(1280);
    const desktopRoot = (globalThis as any).document.createElement('div');
    (globalThis as any).document.body.appendChild(desktopRoot);
    await catalogView.render(desktopRoot);

    expect(desktopRoot.querySelector('[data-testid="catalog-mobile-readonly-badge"]')).toBeNull();
    expect(desktopRoot.querySelector('[data-testid="catalog-new-btn"]')).not.toBeNull();
    expect(desktopRoot.querySelector('[data-testid="catalog-import-btn"]')).not.toBeNull();
    expect(desktopRoot.querySelector('[data-testid="catalog-sync-db-btn"]')).not.toBeNull();
    catalogView.destroy?.();
    expect((await allProducts()).length).toBe(1);
  });
});
