import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allProducts,
  bulkPutProducts,
  clearProducts,
  createSession,
  putProduct,
  type Product,
} from '../../src/db/db';
import {
  clearIdealLevels,
  clearMovements,
  getAllMovements,
  getIdealLevels,
  getIdealQtyForSku,
  recordEntry,
  recordExit,
  recordMovement,
  setIdealLevel,
  type Movement,
} from '../../src/db/movements';

// --- Lightweight DOM Mock for Node Test Environment ---

class MockClassList {
  private classes = new Set<string>();
  constructor(initial = '') {
    if (initial) {
      initial.split(/\s+/).filter(Boolean).forEach((c) => this.classes.add(c));
    }
  }
  add(...tokens: string[]) {
    tokens.forEach((t) => this.classes.add(t));
  }
  remove(...tokens: string[]) {
    tokens.forEach((t) => this.classes.delete(t));
  }
  contains(token: string) {
    return this.classes.has(token);
  }
  toString() {
    return Array.from(this.classes).join(' ');
  }
}

class MockNode {}

class MockElement extends MockNode {
  tagName: string;
  id = '';
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  classList: MockClassList;
  childNodes: (MockElement | MockText)[] = [];
  parentNode: MockElement | null = null;
  listeners: Record<string, ((e: any) => void)[]> = {};
  value = '';
  open = false;
  title = '';

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
    this.classList = new MockClassList();
  }

  get className(): string {
    return this.classList.toString();
  }
  set className(val: string) {
    this.classList = new MockClassList(val);
  }

  get children(): MockElement[] {
    return this.childNodes.filter((c): c is MockElement => c instanceof MockElement);
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(val: string) {
    this.childNodes = [new MockText(val)];
  }

  appendChild<T extends MockElement | MockText>(child: T): T {
    if (child instanceof MockElement) {
      child.parentNode = this;
    }
    this.childNodes.push(child);
    return child;
  }

  replaceChildren(...newChildren: (MockElement | MockText | string)[]) {
    this.childNodes = [];
    for (const c of newChildren) {
      if (typeof c === 'string') {
        this.appendChild(new MockText(c));
      } else if (c) {
        this.appendChild(c);
      }
    }
  }

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.childNodes.indexOf(this);
      if (idx !== -1) {
        this.parentNode.childNodes.splice(idx, 1);
      }
      this.parentNode = null;
    }
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'value') this.value = String(value);
    if (name === 'title') this.title = String(value);
  }

  getAttribute(name: string): string | null {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    if (name === 'value') return this.value || null;
    return this.attributes[name] ?? null;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
  }

  addEventListener(type: string, listener: (e: any) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: (e: any) => void) {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
  }

  dispatchEvent(event: any): boolean {
    const list = this.listeners[event.type] || [];
    for (const l of list) {
      l(event);
    }
    return true;
  }

  click() {
    this.dispatchEvent({ type: 'click', target: this, defaultPrevented: false });
  }

  focus() {
    this.dispatchEvent({ type: 'focus', target: this });
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
    this.dispatchEvent({ type: 'close', target: this });
  }

  querySelector(selector: string): MockElement | null {
    const all = this.querySelectorAll(selector);
    return all[0] || null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];

    const matchSimple = (el: MockElement, sel: string): boolean => {
      if (sel.startsWith('#')) {
        return el.id === sel.slice(1);
      }
      if (sel.startsWith('.')) {
        return el.classList.contains(sel.slice(1));
      }
      const attrMatch = sel.match(/^([a-zA-Z0-9_-]*)\[([a-zA-Z0-9_-]+)(?:=["']?([^"']*)["']?)?\]$/);
      if (attrMatch) {
        const [, tag, attr, val] = attrMatch;
        if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
        const actual = el.getAttribute(attr);
        if (actual === null) return false;
        if (val !== undefined && actual !== val) return false;
        return true;
      }
      const classMatch = sel.match(/^([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)$/);
      if (classMatch) {
        const [, tag, cls] = classMatch;
        if (el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
        return el.classList.contains(cls);
      }
      return el.tagName.toLowerCase() === sel.toLowerCase();
    };

    const matchElement = (el: MockElement): boolean => {
      const parts = selector.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 1) {
        return matchSimple(el, parts[0]);
      }
      const lastPart = parts[parts.length - 1];
      if (!matchSimple(el, lastPart)) return false;
      let curAncestor = el.parentNode;
      for (let i = parts.length - 2; i >= 0; i--) {
        const targetPart = parts[i];
        let found = false;
        while (curAncestor) {
          if (matchSimple(curAncestor, targetPart)) {
            found = true;
            curAncestor = curAncestor.parentNode;
            break;
          }
          curAncestor = curAncestor.parentNode;
        }
        if (!found) return false;
      }
      return true;
    };

    const traverse = (node: MockElement) => {
      for (const child of node.children) {
        if (matchElement(child)) {
          results.push(child);
        }
        traverse(child);
      }
    };

    traverse(this);
    return results;
  }
}

class MockText extends MockNode {
  textContent: string;
  constructor(text: string) {
    super();
    this.textContent = text;
  }
}

// Setup Global Window & Document Mocks
let originalWindow: any;
let originalDocument: any;
let originalNode: any;

function setupMockDOM() {
  originalWindow = (globalThis as any).window;
  originalDocument = (globalThis as any).document;
  originalNode = (globalThis as any).Node;

  const docBody = new MockElement('body');
  const mockDoc: any = {
    body: docBody,
    createElement: (tag: string) => new MockElement(tag),
    createElementNS: (_ns: string, tag: string) => new MockElement(tag),
    createTextNode: (text: string) => new MockText(text),
    getElementById: (id: string) => {
      if (id === 'body') return docBody;
      return docBody.querySelector('#' + id);
    },
    querySelector: (sel: string) => docBody.querySelector(sel),
    querySelectorAll: (sel: string) => docBody.querySelectorAll(sel),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const windowListeners: Record<string, ((e: any) => void)[]> = {};
  const mockWin: any = {
    document: mockDoc,
    isSecureContext: true,
    addEventListener: (type: string, listener: any) => {
      windowListeners[type] = windowListeners[type] || [];
      windowListeners[type].push(listener);
    },
    removeEventListener: (type: string, listener: any) => {
      if (!windowListeners[type]) return;
      windowListeners[type] = windowListeners[type].filter((l) => l !== listener);
    },
    dispatchEvent: (e: any) => {
      const list = windowListeners[e.type] || [];
      for (const l of list) l(e);
    },
    setTimeout: (fn: Function, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: any) => clearTimeout(id),
    navigator: {
      onLine: true,
      vibrate: vi.fn(),
    },
  };

  (globalThis as any).Node = MockNode;
  (globalThis as any).document = mockDoc;
  (globalThis as any).window = mockWin;
  (globalThis as any).HTMLElement = MockElement;
  (globalThis as any).HTMLDialogElement = MockElement;
  (globalThis as any).HTMLInputElement = MockElement;
  (globalThis as any).HTMLTextAreaElement = MockElement;
  (globalThis as any).HTMLVideoElement = MockElement;
  (globalThis as any).Event = class {
    type: string;
    bubbles: boolean;
    constructor(type: string, options: any = {}) {
      this.type = type;
      this.bubbles = !!options.bubbles;
    }
  };
  (globalThis as any).KeyboardEvent = class {
    type: string;
    key: string;
    target: any;
    defaultPrevented = false;
    constructor(type: string, init: any = {}) {
      this.type = type;
      this.key = init.key || '';
      this.target = init.target || null;
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
  };
}

function restoreDOM() {
  (globalThis as any).window = originalWindow;
  (globalThis as any).document = originalDocument;
  (globalThis as any).Node = originalNode;
}

describe('Movements & Ideal UI View (src/ui/movementsView.ts)', () => {
  let movementsView: any;
  let openMovementRegistrationModal: any;
  let findProductByCode: any;

  beforeEach(async () => {
    setupMockDOM();
    await clearProducts();
    await clearMovements();
    await clearIdealLevels();

    // Import fresh module
    const mod = await import('../../src/ui/movementsView');
    movementsView = mod.movementsView;
    openMovementRegistrationModal = mod.openMovementRegistrationModal;
    findProductByCode = mod.findProductByCode;
  });

  afterEach(async () => {
    if (movementsView && movementsView.destroy) {
      await movementsView.destroy();
    }
    restoreDOM();
  });

  const sampleProducts: Product[] = [
    {
      barcode: '75010001',
      sku: 'MHK-001',
      description: 'Cinta Canela 48mm',
      unit: 'ROLLO',
      expectedQty: 50,
      minQty: 10,
      maxQty: 80,
      source: 'catalogo',
    },
    {
      barcode: '75010002',
      sku: 'MHK-002',
      description: 'Guantes Nitrilo L',
      unit: 'PAR',
      expectedQty: 20,
      minQty: 5,
      maxQty: 30,
      source: 'catalogo',
    },
    {
      barcode: '75010003',
      sku: 'MHK-003',
      description: 'Solvente Industrial 5L',
      unit: 'BOTE',
      expectedQty: 5,
      minQty: 2,
      maxQty: 10,
      source: 'catalogo',
    },
  ];

  describe('Product Code Resolution (findProductByCode)', () => {
    it('finds product by barcode, normalized barcode, and SKU', async () => {
      await bulkPutProducts(sampleProducts);

      const byBarcode = await findProductByCode('75010001');
      expect(byBarcode?.sku).toBe('MHK-001');

      const bySkuExact = await findProductByCode('MHK-002');
      expect(bySkuExact?.description).toBe('Guantes Nitrilo L');

      const bySkuCase = await findProductByCode('mhk-003');
      expect(bySkuCase?.unit).toBe('BOTE');

      const notFound = await findProductByCode('NON-EXISTENT');
      expect(notFound).toBeUndefined();
    });
  });

  describe('Main View Rendering & Live KPIs', () => {
    it('renders 4 live KPI cards with zero entries initially', async () => {
      await bulkPutProducts(sampleProducts);
      const root = (globalThis as any).document.createElement('div');

      await movementsView.render(root, new URLSearchParams());

      const kpiIn = root.querySelector('#kpi-in');
      const kpiOut = root.querySelector('#kpi-out');
      const kpiNet = root.querySelector('#kpi-net');
      const kpiDeficit = root.querySelector('#kpi-deficit');

      expect(kpiIn).toBeDefined();
      expect(kpiIn?.textContent).toContain('+0');
      expect(kpiOut?.textContent).toContain('0');
      expect(kpiNet?.textContent).toContain('0');
      expect(kpiDeficit).toBeDefined();
    });

    it('calculates live KPIs accurately when movements exist', async () => {
      await bulkPutProducts(sampleProducts);

      // Record entries: +100 for MHK-001, +50 for MHK-002
      await recordEntry({ sku: 'MHK-001', quantity: 100, supplier: 'Proveedor 3M' });
      await recordEntry({ sku: 'MHK-002', quantity: 50, supplier: 'Ansell' });

      // Record exits: -30 for MHK-001, -10 for MHK-002
      await recordExit({ sku: 'MHK-001', quantity: 30, technician: 'Juan Perez' });
      await recordExit({ sku: 'MHK-002', quantity: 10, technician: 'Carlos Lopez' });

      // Set ideal level for MHK-003 to 100 (current stock 5 -> will be critical/deficit)
      await setIdealLevel('MHK-003', 100);

      const root = (globalThis as any).document.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      const kpiIn = root.querySelector('#kpi-in');
      const kpiOut = root.querySelector('#kpi-out');
      const kpiNet = root.querySelector('#kpi-net');
      const kpiDeficit = root.querySelector('#kpi-deficit');

      // Total in: 100 + 50 = 150
      expect(kpiIn?.textContent).toBe('+150');
      // Total out: 30 + 10 = 40
      expect(kpiOut?.textContent).toBe('−40');
      // Net: 150 - 40 = +110
      expect(kpiNet?.textContent).toBe('+110');
      // At least MHK-003 is in deficit
      expect(kpiDeficit?.textContent).toContain('SKU');
    });
  });

  describe('Interactive Comparative Table & Inline Ideal Editing', () => {
    it('generates comparative rows with dynamic stock and inline ideal input', async () => {
      await bulkPutProducts(sampleProducts);
      await recordEntry({ sku: 'MHK-001', quantity: 20 });
      await recordExit({ sku: 'MHK-001', quantity: 5 });
      await setIdealLevel('MHK-001', 65);

      const root = (globalThis as any).document.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      const table = root.querySelector('.comp-table');
      expect(table).toBeDefined();

      const row = root.querySelector('tr[data-sku="MHK-001"]');
      expect(row).toBeDefined();

      // Expected 50 + 20 in - 5 out = 65 dynamic stock
      expect(row?.textContent).toContain('MHK-001');
      expect(row?.textContent).toContain('Cinta Canela 48mm');

      const idealInput = row?.querySelector('input.inline-ideal');
      expect(idealInput).toBeDefined();
      expect(idealInput?.value).toBe('65');
    });

    it('inline editing of ideal level immediately updates IndexedDB and DOM in-place', async () => {
      await bulkPutProducts(sampleProducts);
      await recordEntry({ sku: 'MHK-001', quantity: 50 }); // stock = 50 + 50 = 100

      const root = (globalThis as any).document.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      const row = root.querySelector('tr[data-sku="MHK-001"]');
      const idealInput = row?.querySelector('input.inline-ideal');
      expect(idealInput).toBeDefined();

      // Change ideal level to 120 (current dynamic 100 -> deficit of -20)
      idealInput!.value = '120';
      idealInput!.dispatchEvent({ type: 'change', target: idealInput });
      await new Promise((r) => setTimeout(r, 50));

      // Verify immediate persistence in movements DB
      const persistedIdeal = await getIdealQtyForSku('MHK-001');
      expect(persistedIdeal).toBe(120);

      // Verify DOM reflects deficit badge
      const statusCell = row?.querySelectorAll('td')[8];
      expect(statusCell?.textContent).toContain('Déficit');
    });
  });

  describe('Quick Registration Modal (openMovementRegistrationModal)', () => {
    it('opens registration modal with prefilled SKU and saves new IN movement', async () => {
      await bulkPutProducts(sampleProducts);

      let saved = false;
      const dlg = (await openMovementRegistrationModal('MHK-001', 'IN', async () => {
        saved = true;
      })) as MockElement;

      expect(dlg).toBeDefined();
      expect(dlg.open).toBe(true);

      const skuInput = dlg.querySelector('#m-sku-input');
      expect(skuInput?.value).toBe('MHK-001');

      // Fill movement details
      const form = dlg.querySelector('.form');
      expect(form).toBeDefined();

      // Submit modal
      const saveBtn = dlg.querySelectorAll('button').find((b) => b.textContent?.includes('Guardar Movimiento'));
      expect(saveBtn).toBeDefined();
      saveBtn?.click();

      // Allow async save to complete
      await new Promise((r) => setTimeout(r, 10));

      const ledger = await getAllMovements();
      expect(ledger.length).toBe(1);
      expect(ledger[0].sku).toBe('MHK-001');
      expect(ledger[0].type).toBe('IN');
      expect(ledger[0].quantity).toBe(1);
      expect(saved).toBe(true);
    });

    it('stepper buttons increment and decrement quantity', async () => {
      const dlg = (await openMovementRegistrationModal('MHK-002', 'OUT')) as MockElement;
      const qtyInput = dlg.querySelector('input[type="number"]');
      expect(qtyInput?.value).toBe('1');

      const plusBtn = dlg.querySelectorAll('.stepper-btn').find((b) => b.textContent === '+');
      plusBtn?.click();
      expect(qtyInput?.value).toBe('2');

      const minusBtn = dlg.querySelectorAll('.stepper-btn').find((b) => b.textContent === '−');
      minusBtn?.click();
      expect(qtyInput?.value).toBe('1');
    });
  });

  describe('Barcode Simulation Hook & USB Keyboard Wedge', () => {
    it('exposes __simulateMovementScan and opens modal when scanned externally', async () => {
      await bulkPutProducts(sampleProducts);
      const root = (globalThis as any).document.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      expect(typeof (window as any).__simulateMovementScan).toBe('function');

      // Simulate scan of barcode 75010003
      await (window as any).__simulateMovementScan('75010003');

      const openDialog = (document as any).body.querySelector('dialog');
      expect(openDialog).toBeDefined();
      const skuInput = openDialog?.querySelector('#m-sku-input');
      expect(skuInput?.value).toBe('MHK-003');
    });

    it('handles keyboard wedge rapid keystrokes ending in Enter', async () => {
      await bulkPutProducts(sampleProducts);
      const root = (globalThis as any).document.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      // Simulate keyboard wedge firing "MHK-002" followed by Enter in <80ms bursts
      const sendKey = (key: string) => {
        (window as any).dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', { key }));
      };

      sendKey('M');
      sendKey('H');
      sendKey('K');
      sendKey('-');
      sendKey('0');
      sendKey('0');
      sendKey('2');
      sendKey('Enter');

      // Should open registration modal with MHK-002
      await new Promise((r) => setTimeout(r, 10));
      const openDialog = (document as any).body.querySelector('dialog');
      expect(openDialog).toBeDefined();
      const skuInput = openDialog?.querySelector('#m-sku-input');
      expect(skuInput?.value).toBe('MHK-002');
    });
  });

  describe('Sub-Tabs and Bitácora View', () => {
    it('switches to bitácora and renders chronological consumption log', async () => {
      await bulkPutProducts(sampleProducts);
      await recordExit({
        sku: 'MHK-001',
        quantity: 5,
        technician: 'Pedro Ramirez',
        machineOrArea: 'Línea 2',
        folio: 'REQ-999',
        notes: 'Mantenimiento preventivo',
      });

      const root = (globalThis as any).document.createElement('div');
      await movementsView.render(root, new URLSearchParams('tab=bitacora'));

      const bitacora = root.querySelector('.movement-list');
      expect(bitacora).toBeDefined();
      expect(bitacora?.textContent).toContain('MHK-001');
      expect(bitacora?.textContent).toContain('Pedro Ramirez');
      expect(bitacora?.textContent).toContain('Línea 2');
      expect(bitacora?.textContent).toContain('REQ-999');
      expect(bitacora?.textContent).toContain('Mantenimiento preventivo');
    });
  });
});
