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
  deleteMovement,
  getAllMovements,
  getIdealLevels,
  getIdealQtyForSku,
  listMovements,
  recordEntry,
  recordExit,
  recordMovement,
  setIdealLevel,
  type Movement,
} from '../../src/db/movements';
import { fmtNum } from '../../src/ui/dom';

// ============================================================================
// Robust Mock DOM Implementation with Selector & Pseudo-Class Support
// ============================================================================

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
    for (const l of [...list]) {
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
      // 1. Handle :nth-child(N) e.g. "td:nth-child(9)"
      const nthMatch = sel.match(/^([a-zA-Z0-9_-]*):nth-child\((\d+)\)$/);
      if (nthMatch) {
        const [, tag, nthStr] = nthMatch;
        if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
        if (!el.parentNode) return false;
        const siblings = el.parentNode.children;
        const targetIdx = parseInt(nthStr, 10) - 1;
        return siblings[targetIdx] === el;
      }

      // 2. ID match #id
      if (sel.startsWith('#')) {
        return el.id === sel.slice(1);
      }

      // 3. Multi-class or tag+multi-class e.g. "button.btn.danger", ".muted.center", ".chip.active"
      if (sel.includes('.')) {
        const parts = sel.split('.');
        const tag = parts[0];
        const classes = parts.slice(1).filter(Boolean);
        if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
        return classes.every((c) => el.classList.contains(c));
      }

      // 4. Attribute selectors [attr], [attr=val], [attr*=val], [attr^=val]
      const attrMatch = sel.match(/^([a-zA-Z0-9_-]*)\[([a-zA-Z0-9_-]+)([\*\^~]?=)?["']?([^"']*)["']?\]$/);
      if (attrMatch) {
        const [, tag, attr, op, val] = attrMatch;
        if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
        const actual = el.getAttribute(attr);
        if (actual === null) return false;
        if (!op) return true;
        if (op === '=') return actual === val;
        if (op === '*=') return actual.includes(val);
        if (op === '^=') return actual.startsWith(val);
        return true;
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

let originalWindow: any;
let originalDocument: any;
let originalNode: any;
let mockDoc: any;
let mockWin: any;
let docBody: MockElement;
let windowListeners: Record<string, ((e: any) => void)[]>;

function setupMockDOM() {
  originalWindow = (globalThis as any).window;
  originalDocument = (globalThis as any).document;
  originalNode = (globalThis as any).Node;

  docBody = new MockElement('body');
  mockDoc = {
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

  windowListeners = {};
  mockWin = {
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
      for (const l of [...list]) l(e);
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

// ============================================================================
// Challenger Test Suite: Milestone B UI Interaction & Scanner Adversary
// ============================================================================

describe('Challenger Milestone B: Movements UI Interaction & Scanner Stress Harness', () => {
  let movementsView: any;
  let openMovementRegistrationModal: any;
  let findProductByCode: any;

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

  beforeEach(async () => {
    setupMockDOM();
    await clearProducts();
    await clearMovements();
    await clearIdealLevels();

    const mod = await import('../../src/ui/movementsView');
    movementsView = mod.movementsView;
    openMovementRegistrationModal = mod.openMovementRegistrationModal;
    findProductByCode = mod.findProductByCode;
  });

  afterEach(async () => {
    if (movementsView && movementsView.destroy) {
      await movementsView.destroy();
    }
    // Allow any pending microtasks in event handlers to complete before teardown
    await new Promise((r) => setTimeout(r, 40));
    restoreDOM();
  });

  // --------------------------------------------------------------------------
  // 1. Barcode Scan Hook: (window as any).__simulateMovementScan
  // --------------------------------------------------------------------------
  describe('Adversarial Test: Barcode Scan Hook (__simulateMovementScan)', () => {
    it('handles known barcode scan, correctly resolving to product SKU and details', async () => {
      await bulkPutProducts(sampleProducts);
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      expect(typeof (window as any).__simulateMovementScan).toBe('function');

      // Scan barcode 75010001
      await (window as any).__simulateMovementScan('75010001');

      const modal = docBody.querySelector('dialog');
      expect(modal).toBeDefined();
      expect(modal?.open).toBe(true);

      const skuInput = modal?.querySelector('#m-sku-input');
      expect(skuInput?.value).toBe('MHK-001');

      const preview = modal?.querySelector('.product-card-preview');
      expect(preview?.textContent).toContain('Cinta Canela 48mm');
      expect(preview?.textContent).toContain('ROLLO');
      expect(preview?.textContent).toContain('Stock Físico: 50');
    });

    it('handles GTIN-14 scan with leading zeroes normalizing to catalog barcode', async () => {
      // Products imported via importCatalog.ts have GTIN-14 normalized barcodes
      const gtinProduct: Product = {
        barcode: '00000075010001',
        sku: 'MHK-001',
        description: 'Cinta Canela 48mm',
        unit: 'ROLLO',
        expectedQty: 50,
        source: 'catalogo',
      };
      await putProduct(gtinProduct);

      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      // 1. Scan 8-digit short code: normalizes to GTIN-14 and resolves
      await (window as any).__simulateMovementScan('75010001');
      let modal = docBody.querySelector('dialog');
      expect(modal).toBeDefined();
      let skuInput = modal?.querySelector('#m-sku-input');
      expect(skuInput?.value).toBe('MHK-001');
      modal?.close();

      // 2. Scan full 14-digit GTIN code: resolves to same product
      await (window as any).__simulateMovementScan('00000075010001');
      modal = docBody.querySelector('dialog');
      expect(modal).toBeDefined();
      skuInput = modal?.querySelector('#m-sku-input');
      expect(skuInput?.value).toBe('MHK-001');
    });

    it('handles completely unknown barcode gracefully as uncataloged product', async () => {
      await bulkPutProducts(sampleProducts);
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      // Unknown barcode
      await (window as any).__simulateMovementScan('UNKNOWN-BARCODE-999');

      const modal = docBody.querySelector('dialog');
      expect(modal).toBeDefined();
      expect(modal?.open).toBe(true);

      const skuInput = modal?.querySelector('#m-sku-input');
      expect(skuInput?.value).toBe('UNKNOWN-BARCODE-999');

      const preview = modal?.querySelector('.product-card-preview');
      expect(preview?.textContent).toContain('Producto no catalogado');

      // Operator can still register movement for this unknown item
      const saveBtn = modal?.querySelectorAll('button').find((b) => b.textContent?.includes('Guardar Movimiento'));
      expect(saveBtn).toBeDefined();
      saveBtn?.click();

      await new Promise((r) => setTimeout(r, 100));

      const movements = await getAllMovements();
      expect(movements.length).toBe(1);
      expect(movements[0].sku).toBe('UNKNOWN-BARCODE-999');
    });

    it('handles rapid consecutive scans when modal is already open by switching product', async () => {
      await bulkPutProducts(sampleProducts);
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      // Scan 1: opens modal with MHK-001
      await (window as any).__simulateMovementScan('75010001');
      let dialogs = docBody.querySelectorAll('dialog');
      expect(dialogs.length).toBe(1);
      let skuInput = dialogs[0].querySelector('#m-sku-input');
      expect(skuInput?.value).toBe('MHK-001');

      // Scan 2 while modal is open: switches to MHK-002 without creating a duplicate dialog
      await (window as any).__simulateMovementScan('75010002');
      await new Promise((r) => setTimeout(r, 40));

      dialogs = docBody.querySelectorAll('dialog');
      expect(dialogs.length).toBe(1);
      skuInput = dialogs[0].querySelector('#m-sku-input');
      expect(skuInput?.value).toBe('MHK-002');

      const preview = dialogs[0].querySelector('.product-card-preview');
      expect(preview?.textContent).toContain('Guantes Nitrilo L');

      // Scan 3 while modal is open: switches to MHK-003
      await (window as any).__simulateMovementScan('75010003');
      await new Promise((r) => setTimeout(r, 40));

      expect(skuInput?.value).toBe('MHK-003');
      expect(preview?.textContent).toContain('Solvente Industrial 5L');
    });

    it('handles trimmed scan codes with surrounding whitespace or tabs', async () => {
      await bulkPutProducts(sampleProducts);
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      await (window as any).__simulateMovementScan('  \t75010002\r\n  ');
      await new Promise((r) => setTimeout(r, 30));

      const modal = docBody.querySelector('dialog');
      expect(modal).toBeDefined();
      const skuInput = modal?.querySelector('#m-sku-input');
      expect(skuInput?.value).toBe('MHK-002');
    });
  });

  // --------------------------------------------------------------------------
  // 2. Physical USB Keyboard-Wedge Listener (<80ms Bursts + Enter)
  // --------------------------------------------------------------------------
  describe('Adversarial Test: Physical USB Keyboard-Wedge Listener', () => {
    const sendKey = (key: string, target?: any) => {
      (window as any).dispatchEvent(
        new (globalThis as any).KeyboardEvent('keydown', { key, target }),
      );
    };

    const simulateBurst = async (chars: string, target?: any) => {
      for (const char of chars) {
        sendKey(char, target);
      }
      sendKey('Enter', target);
      await new Promise((r) => setTimeout(r, 25));
    };

    it('recognizes rapid keystroke burst (<80ms) terminating with Enter as a barcode scan', async () => {
      await bulkPutProducts(sampleProducts);
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      await simulateBurst('75010001');

      const modal = docBody.querySelector('dialog');
      expect(modal).toBeDefined();
      const skuInput = modal?.querySelector('#m-sku-input');
      expect(skuInput?.value).toBe('MHK-001');
    });

    it('rejects bursts shorter than 3 characters ending in Enter', async () => {
      await bulkPutProducts(sampleProducts);
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      await simulateBurst('12');

      const modal = docBody.querySelector('dialog');
      expect(modal).toBeNull();
    });

    it('ignores slow manual keystrokes (>80ms gap) without opening scanner modal', async () => {
      await bulkPutProducts(sampleProducts);
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      // Simulate human typing slowly: >80ms between keys
      sendKey('7');
      await new Promise((r) => setTimeout(r, 90));
      sendKey('5');
      await new Promise((r) => setTimeout(r, 90));
      sendKey('0');
      await new Promise((r) => setTimeout(r, 90));
      sendKey('1');
      await new Promise((r) => setTimeout(r, 90));
      sendKey('Enter');
      await new Promise((r) => setTimeout(r, 20));

      const modal = docBody.querySelector('dialog');
      expect(modal).toBeNull();
    });

    it('does NOT intercept keystrokes when user is typing in regular inputs (e.g. search box)', async () => {
      await bulkPutProducts(sampleProducts);
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      const searchInput = root.querySelector('input[type="search"]');
      expect(searchInput).toBeDefined();

      // Keystrokes targeted at search input
      await simulateBurst('75010001', searchInput);

      // Should not have opened the movement registration modal
      const modal = docBody.querySelector('dialog');
      expect(modal).toBeNull();
    });

    it('DOES intercept keystrokes when focused on #m-sku-input inside modal', async () => {
      await bulkPutProducts(sampleProducts);
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      // Open empty modal
      const dlg = (await openMovementRegistrationModal()) as MockElement;
      expect(dlg).toBeDefined();

      const skuInput = dlg.querySelector('#m-sku-input');
      expect(skuInput).toBeDefined();

      // Scan barcode gun while focused on #m-sku-input
      await simulateBurst('75010002', skuInput);
      await new Promise((r) => setTimeout(r, 30));

      expect(skuInput?.value).toBe('MHK-002');
      const preview = dlg.querySelector('.product-card-preview');
      expect(preview?.textContent).toContain('Guantes Nitrilo L');
    });

    it('ignores modifier and functional keys (Shift, Alt, Control, ArrowDown) without polluting buffer', async () => {
      await bulkPutProducts(sampleProducts);
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      sendKey('Shift');
      sendKey('Control');
      sendKey('Alt');
      sendKey('ArrowLeft');
      sendKey('7');
      sendKey('5');
      sendKey('0');
      sendKey('1');
      sendKey('0');
      sendKey('0');
      sendKey('0');
      sendKey('3');
      sendKey('Enter');
      await new Promise((r) => setTimeout(r, 25));

      const modal = docBody.querySelector('dialog');
      expect(modal).toBeDefined();
      const skuInput = modal?.querySelector('#m-sku-input');
      expect(skuInput?.value).toBe('MHK-003');
    });

    it('unregisters keydown listener upon view.destroy() so subsequent keys do not fire', async () => {
      await bulkPutProducts(sampleProducts);
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      // Destroy view
      await movementsView.destroy();

      // Emit barcode burst
      await simulateBurst('75010001');

      const modal = docBody.querySelector('dialog');
      expect(modal).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Inline Ideal Input (0, Positive Decimals, Invalid Non-Numbers)
  // --------------------------------------------------------------------------
  describe('Adversarial Test: Inline Ideal Input Persistence & DOM Reactivity', () => {
    it('sets ideal level to 0, updating gap, status, live KPI, and IndexedDB persistence', async () => {
      await bulkPutProducts(sampleProducts);
      // MHK-001 dynamic stock is 50
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      const row = root.querySelector('tr[data-sku="MHK-001"]');
      expect(row).toBeDefined();
      const idealInput = row?.querySelector('input.inline-ideal');
      expect(idealInput).toBeDefined();

      // Change ideal level to 0
      idealInput!.value = '0';
      idealInput!.dispatchEvent({ type: 'change', target: idealInput });
      await new Promise((r) => setTimeout(r, 50));

      // 1. Verify IndexedDB persistence
      const persisted = await getIdealQtyForSku('MHK-001');
      expect(persisted).toBe(0);

      // 2. Verify DOM Gap: dynamicStock (50) - 0 = +50
      const gapCell = row?.querySelectorAll('td')[7];
      expect(gapCell?.textContent).toBe('+50');

      // 3. Status should be Óptimo or Exceso (dynamicStock 50 > ideal 0)
      const statusBadge = row?.querySelector('td:nth-child(9) .badge');
      expect(statusBadge?.textContent).toMatch(/Óptimo|Exceso/);
    });

    it('handles positive decimal values (e.g. 15.5) with 3-decimal rounding and persistence', async () => {
      await bulkPutProducts(sampleProducts);
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      const row = root.querySelector('tr[data-sku="MHK-001"]');
      const idealInput = row?.querySelector('input.inline-ideal');

      // Change ideal level to 75.3333 -> rounded to 75.333
      idealInput!.value = '75.3333';
      idealInput!.dispatchEvent({ type: 'blur', target: idealInput });
      await new Promise((r) => setTimeout(r, 50));

      const persisted = await getIdealQtyForSku('MHK-001');
      expect(persisted).toBe(75.333);

      // Gap: 50 - 75.333 = -25.333 (deficit)
      const gapCell = row?.querySelectorAll('td')[7];
      expect(gapCell?.textContent).toBe(fmtNum(-25.333));

      const statusBadge = row?.querySelector('td:nth-child(9) .badge');
      expect(statusBadge?.textContent).toBe('Déficit');
      expect(statusBadge?.classList.contains('warn')).toBe(true);
    });

    it('coerces invalid non-numbers (NaN, text, negative values) safely to 0', async () => {
      await bulkPutProducts(sampleProducts);
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      const row = root.querySelector('tr[data-sku="MHK-002"]');
      const idealInput = row?.querySelector('input.inline-ideal');

      // 1. Enter invalid text "invalid-abc"
      idealInput!.value = 'invalid-abc';
      idealInput!.dispatchEvent({ type: 'change', target: idealInput });
      await new Promise((r) => setTimeout(r, 50));

      let persisted = await getIdealQtyForSku('MHK-002');
      expect(persisted).toBe(0);

      // 2. Enter negative number "-25"
      idealInput!.value = '-25';
      idealInput!.dispatchEvent({ type: 'change', target: idealInput });
      await new Promise((r) => setTimeout(r, 50));

      persisted = await getIdealQtyForSku('MHK-002');
      expect(persisted).toBe(0);

      // 3. Enter empty string ""
      idealInput!.value = '   ';
      idealInput!.dispatchEvent({ type: 'change', target: idealInput });
      await new Promise((r) => setTimeout(r, 50));

      persisted = await getIdealQtyForSku('MHK-002');
      expect(persisted).toBe(0);
    });

    it('dynamically updates live KPI Deficit card count when ideal edit flips SKU into deficit', async () => {
      // Setup products where MHK-001 starts in OPTIMAL status
      await bulkPutProducts([
        {
          barcode: '75010001',
          sku: 'MHK-001',
          description: 'Cinta Canela 48mm',
          unit: 'ROLLO',
          expectedQty: 50,
          minQty: 10,
          maxQty: 50, // optimal
          source: 'catalogo',
        },
        {
          barcode: '75010002',
          sku: 'MHK-002',
          description: 'Guantes Nitrilo L',
          unit: 'PAR',
          expectedQty: 20,
          minQty: 5,
          maxQty: 20, // optimal
          source: 'catalogo',
        },
      ]);
      await setIdealLevel('MHK-001', 50);
      await setIdealLevel('MHK-002', 20);

      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      const kpiDeficit = root.querySelector('#kpi-deficit');
      expect(kpiDeficit?.textContent).toBe('0 SKUs');

      // Raise MHK-001 ideal level to 1000 -> creates deficit
      const row = root.querySelector('tr[data-sku="MHK-001"]');
      const idealInput = row?.querySelector('input.inline-ideal');

      idealInput!.value = '1000';
      idealInput!.dispatchEvent({ type: 'change', target: idealInput });
      await new Promise((r) => setTimeout(r, 50));

      // Count of deficit/critical items should now be 1 SKU
      expect(kpiDeficit?.textContent).toBe('1 SKUs');
    });

    it('suppresses redundant DB writes when same value is entered consecutively', async () => {
      await bulkPutProducts(sampleProducts);
      await setIdealLevel('MHK-001', 50);

      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      const row = root.querySelector('tr[data-sku="MHK-001"]');
      const idealInput = row?.querySelector('input.inline-ideal');

      // Re-triggering with identical value 50
      idealInput!.value = '50';
      idealInput!.dispatchEvent({ type: 'change', target: idealInput });
      idealInput!.dispatchEvent({ type: 'blur', target: idealInput });
      await new Promise((r) => setTimeout(r, 30));

      const persisted = await getIdealQtyForSku('MHK-001');
      expect(persisted).toBe(50);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Filter Transitions Between Comparative Table and Bitácora
  // --------------------------------------------------------------------------
  describe('Adversarial Test: Filter Transitions Between Comparative Table and Bitácora', () => {
    beforeEach(async () => {
      await bulkPutProducts(sampleProducts);
      // Create movements
      await recordEntry({
        sku: 'MHK-001',
        quantity: 20,
        supplier: 'Proveedor Alfa',
        machineOrArea: 'Almacén Central',
        folio: 'F-101',
        notes: 'Entrada semanal',
      });
      await recordExit({
        sku: 'MHK-002',
        quantity: 5,
        technician: 'Tecnico Bravo',
        machineOrArea: 'Línea 1',
        folio: 'REQ-202',
        notes: 'Cambio de turno',
      });
      // Set MHK-003 to deficit
      await setIdealLevel('MHK-003', 100);

      // Cleanly reset comparative filters
      const rootComp = mockDoc.createElement('div');
      await movementsView.render(rootComp, new URLSearchParams('tab=comparative'));
      const search = rootComp.querySelector('input[type="search"]');
      if (search) {
        search.value = '';
        search.dispatchEvent({ type: 'input', target: search });
      }
      const todosBtn = rootComp.querySelectorAll('.chips button.chip').find((b) => b.textContent?.includes('Todos'));
      todosBtn?.click();
      await new Promise((r) => setTimeout(r, 40));
      await movementsView.destroy();

      // Cleanly reset bitacora filters
      const rootBit = mockDoc.createElement('div');
      await movementsView.render(rootBit, new URLSearchParams('tab=bitacora'));
      const allTypeBtn = rootBit.querySelectorAll('button.chip').find((b) => b.textContent?.includes('Todos los tipos'));
      allTypeBtn?.click();
      const allDateBtn = rootBit.querySelectorAll('button.chip').find((b) => b.textContent?.includes('Todo el historial'));
      allDateBtn?.click();
      const techInput = rootBit.querySelector('input[placeholder*="técnico"]');
      if (techInput) {
        techInput.value = '';
        techInput.dispatchEvent({ type: 'input', target: techInput });
      }
      const areaInput = rootBit.querySelector('input[placeholder*="máquina"]');
      if (areaInput) {
        areaInput.value = '';
        areaInput.dispatchEvent({ type: 'input', target: areaInput });
      }
      const bitSearch = rootBit.querySelector('input[placeholder*="bitácora"]');
      if (bitSearch) {
        bitSearch.value = '';
        bitSearch.dispatchEvent({ type: 'input', target: bitSearch });
      }
      await new Promise((r) => setTimeout(r, 40));
      await movementsView.destroy();
    });

    it('transitions directly to comparative deficit filter upon clicking KPI deficit card', async () => {
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      const kpiDeficitCard = root.querySelector('#kpi-card-deficit');
      expect(kpiDeficitCard).toBeDefined();

      // Click KPI card
      kpiDeficitCard?.click();
      await new Promise((r) => setTimeout(r, 50));

      // Table should now only show deficit/critical rows
      const rows = root.querySelectorAll('tbody tr');
      for (const r of rows) {
        const badge = r.querySelector('td:nth-child(9) .badge');
        expect(badge?.textContent).toMatch(/Déficit|Crítico/);
      }
    });

    it('filters comparative table rows by chip status (with_movements, optimal, deficit)', async () => {
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams('tab=comparative'));

      const chips = root.querySelectorAll('.chips button.chip');
      const withMovementsBtn = chips.find((b) => b.textContent?.includes('Con Movimientos'));
      expect(withMovementsBtn).toBeDefined();

      withMovementsBtn?.click();
      await new Promise((r) => setTimeout(r, 30));

      const rows = root.querySelectorAll('tbody tr');
      // Only MHK-001 and MHK-002 have movements
      expect(rows.length).toBe(2);
      const skus = rows.map((r) => r.getAttribute('data-sku'));
      expect(skus).toContain('MHK-001');
      expect(skus).toContain('MHK-002');
      expect(skus).not.toContain('MHK-003');
    });

    it('filters comparative table rows by search text query and shows empty message when no matches', async () => {
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams('tab=comparative'));

      // Reset to 'todos' chip first
      const todosBtn = root.querySelectorAll('.chips button.chip').find((b) => b.textContent?.includes('Todos'));
      todosBtn?.click();

      const searchInput = root.querySelector('input[type="search"]');
      expect(searchInput).toBeDefined();

      // Search by partial description "Canela"
      searchInput!.value = 'Canela';
      searchInput!.dispatchEvent({ type: 'input', target: searchInput });
      await new Promise((r) => setTimeout(r, 30));

      let rows = root.querySelectorAll('tbody tr');
      expect(rows.length).toBe(1);
      expect(rows[0].getAttribute('data-sku')).toBe('MHK-001');

      // Search non-existent
      searchInput!.value = 'TOTAL-NON-EXISTENT-XYZ';
      searchInput!.dispatchEvent({ type: 'input', target: searchInput });
      await new Promise((r) => setTimeout(r, 30));

      rows = root.querySelectorAll('tbody tr');
      expect(rows.length).toBe(0);
      const emptyMsg = root.querySelector('p.muted.center');
      expect(emptyMsg?.style.display).toBe('block');
    });

    it('switches to Bitácora and filters by movement type (IN vs OUT)', async () => {
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams('tab=bitacora'));

      const movementList = root.querySelector('.movement-list');
      expect(movementList).toBeDefined();
      let items = movementList?.querySelectorAll('.m-item') || [];
      expect(items.length).toBe(2);

      // Filter by Solo Entradas (IN)
      const inChip = root.querySelectorAll('button.chip').find((b) => b.textContent?.includes('Solo Entradas'));
      expect(inChip).toBeDefined();
      inChip?.click();
      await new Promise((r) => setTimeout(r, 30));

      items = movementList?.querySelectorAll('.m-item') || [];
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('ENTRADA');
      expect(items[0].textContent).toContain('MHK-001');

      // Filter by Solo Salidas (OUT)
      const outChip = root.querySelectorAll('button.chip').find((b) => b.textContent?.includes('Solo Salidas'));
      expect(outChip).toBeDefined();
      outChip?.click();
      await new Promise((r) => setTimeout(r, 30));

      items = movementList?.querySelectorAll('.m-item') || [];
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('SALIDA');
      expect(items[0].textContent).toContain('MHK-002');
    });

    it('filters Bitácora by technician/supplier and machine/area', async () => {
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams('tab=bitacora'));

      // Reset bitacora type to ALL
      const allTypeBtn = root.querySelectorAll('button.chip').find((b) => b.textContent?.includes('Todos los tipos'));
      allTypeBtn?.click();

      const techInput = root.querySelector('input[placeholder*="técnico"]');
      expect(techInput).toBeDefined();

      techInput!.value = 'Bravo';
      techInput!.dispatchEvent({ type: 'input', target: techInput });
      await new Promise((r) => setTimeout(r, 30));

      const items = root.querySelectorAll('.movement-list .m-item');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('Tecnico Bravo');
    });

    it('preserves search query when toggling back and forth between comparative table and bitácora', async () => {
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams('tab=comparative'));

      // Set filter to 'todos'
      const todosBtn = root.querySelectorAll('.chips button.chip').find((b) => b.textContent?.includes('Todos'));
      todosBtn?.click();

      // Set search query in comparative
      const searchInput = root.querySelector('input[type="search"]');
      searchInput!.value = 'Guantes';
      searchInput!.dispatchEvent({ type: 'input', target: searchInput });
      await new Promise((r) => setTimeout(r, 30));

      // Switch to bitácora
      const bitacoraTabBtn = root.querySelectorAll('.chips button.chip').find((b) => b.textContent?.includes('Bitácora'));
      bitacoraTabBtn?.click();
      await new Promise((r) => setTimeout(r, 50));

      expect(root.querySelector('.movement-list')).toBeDefined();

      // Switch back to comparative
      const compTabBtn = root.querySelectorAll('.chips button.chip').find((b) => b.textContent?.includes('Conciliación'));
      compTabBtn?.click();
      await new Promise((r) => setTimeout(r, 50));

      // Check that table rows still match 'Guantes'
      const rows = root.querySelectorAll('tbody tr');
      expect(rows.length).toBe(1);
      expect(rows[0].getAttribute('data-sku')).toBe('MHK-002');
    });

    it('deletes movement from Bitácora with confirmation dialog and recalculates KPIs', async () => {
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams('tab=bitacora'));

      // Reset type filter
      const allTypeBtn = root.querySelectorAll('button.chip').find((b) => b.textContent?.includes('Todos los tipos'));
      allTypeBtn?.click();

      const deleteBtns = root.querySelectorAll('.movement-list .m-item button.btn.danger');
      expect(deleteBtns.length).toBe(2);

      // Click delete on first item
      deleteBtns[0].click();
      await new Promise((r) => setTimeout(r, 20));

      // Confirm dialog should be open
      const confirmDlg = docBody.querySelector('dialog');
      expect(confirmDlg).toBeDefined();

      const confirmBtn = confirmDlg?.querySelectorAll('button').find((b) => b.textContent === 'Eliminar');
      expect(confirmBtn).toBeDefined();
      confirmBtn?.click();
      await new Promise((r) => setTimeout(r, 50));

      // One movement remaining in ledger
      const remaining = await getAllMovements();
      expect(remaining.length).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Modal Lifecycle, Stepper & "Guardar y Nuevo"
  // --------------------------------------------------------------------------
  describe('Adversarial Test: Modal Lifecycle, Stepper & Consecutive Registration', () => {
    it('supports "Guardar y Nuevo" workflow keeping dialog open and resetting fields', async () => {
      await bulkPutProducts(sampleProducts);

      const dlg = (await openMovementRegistrationModal('MHK-001', 'IN')) as MockElement;
      expect(dlg).toBeDefined();
      expect(dlg.open).toBe(true);

      const qtyInput = dlg.querySelector('input[type="number"]');
      const skuInput = dlg.querySelector('#m-sku-input');
      const saveAndNewBtn = dlg.querySelectorAll('button').find((b) => b.textContent?.includes('Guardar y Nuevo'));
      expect(saveAndNewBtn).toBeDefined();

      // Save first movement (IN 1 MHK-001)
      saveAndNewBtn?.click();
      await new Promise((r) => setTimeout(r, 30));

      // Modal should STILL be open
      expect(dlg.open).toBe(true);
      // SKU and fields should be reset
      expect(skuInput?.value).toBe('');
      expect(qtyInput?.value).toBe('1');

      // Now enter second movement in same modal instance (OUT 5 MHK-002)
      skuInput!.value = 'MHK-002';
      skuInput!.dispatchEvent({ type: 'input', target: skuInput });
      qtyInput!.value = '5';

      const exitBtn = dlg.querySelectorAll('.segmented-btn').find((b) => b.textContent?.includes('Salida'));
      exitBtn?.click();

      const saveMovementBtn = dlg.querySelectorAll('button').find((b) => b.textContent?.includes('Guardar Movimiento'));
      saveMovementBtn?.click();
      await new Promise((r) => setTimeout(r, 30));

      // Ledger must have both movements
      const movements = await getAllMovements();
      expect(movements.length).toBe(2);
      expect(movements[0].sku).toBe('MHK-001');
      expect(movements[0].type).toBe('IN');
      expect(movements[0].quantity).toBe(1);

      expect(movements[1].sku).toBe('MHK-002');
      expect(movements[1].type).toBe('OUT');
      expect(movements[1].quantity).toBe(5);
    });

    it('stepper clamps negative decrements to minimum of 1', async () => {
      const dlg = (await openMovementRegistrationModal('MHK-001', 'IN')) as MockElement;
      const qtyInput = dlg.querySelector('input[type="number"]');
      const minusBtn = dlg.querySelectorAll('.stepper-btn').find((b) => b.textContent === '−');

      qtyInput!.value = '1';
      minusBtn?.click();
      expect(qtyInput?.value).toBe('1'); // clamped to 1
    });

    it('rejects saving movement with 0 or negative quantity', async () => {
      const dlg = (await openMovementRegistrationModal('MHK-001', 'IN')) as MockElement;
      const qtyInput = dlg.querySelector('input[type="number"]');
      const saveBtn = dlg.querySelectorAll('button').find((b) => b.textContent?.includes('Guardar Movimiento'));

      qtyInput!.value = '0';
      saveBtn?.click();
      await new Promise((r) => setTimeout(r, 20));

      const movements = await getAllMovements();
      expect(movements.length).toBe(0);
    });

    it('handles multiple rapid destroy() calls without exceptions', async () => {
      const root = mockDoc.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      // Open a modal
      await openMovementRegistrationModal('MHK-001', 'IN');

      // Call destroy
      await expect(movementsView.destroy()).resolves.toBeUndefined();
      // Call destroy again
      await expect(movementsView.destroy()).resolves.toBeUndefined();
    });
  });
});
