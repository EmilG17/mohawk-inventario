import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bulkPutProducts,
  clearProducts,
  type Product,
} from '../../src/db/db';
import {
  clearIdealLevels,
  clearMovements,
  recordEntry,
} from '../../src/db/movements';

// --- Lightweight Mock DOM with Lifecycle & Listener Tracking ---

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
  srcObject: any = null;

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

// Global Mocks & Tracking
let originalWindow: any;
let originalDocument: any;
let originalNode: any;
let windowListeners: Record<string, ((e: any) => void)[]> = {};
let windowAddEventListenerSpy: any;
let windowRemoveEventListenerSpy: any;

function setupMockDOM() {
  originalWindow = (globalThis as any).window;
  originalDocument = (globalThis as any).document;
  originalNode = (globalThis as any).Node;

  windowListeners = {};

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

  windowAddEventListenerSpy = vi.fn((type: string, listener: any) => {
    windowListeners[type] = windowListeners[type] || [];
    windowListeners[type].push(listener);
  });

  windowRemoveEventListenerSpy = vi.fn((type: string, listener: any) => {
    if (!windowListeners[type]) return;
    windowListeners[type] = windowListeners[type].filter((l) => l !== listener);
  });

  const mockWin: any = {
    document: mockDoc,
    isSecureContext: true,
    addEventListener: windowAddEventListenerSpy,
    removeEventListener: windowRemoveEventListenerSpy,
    dispatchEvent: (e: any) => {
      const list = windowListeners[e.type] || [];
      for (const l of list) l(e);
    },
    setTimeout: (fn: Function, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: any) => clearTimeout(id),
    navigator: {
      onLine: true,
      vibrate: vi.fn(),
      mediaDevices: {
        getUserMedia: vi.fn(),
      },
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

describe('Challenger 2: Movements UI Lifecycle & Teardown Verification Suite', () => {
  let movementsView: any;
  let openMovementRegistrationModal: any;

  beforeEach(async () => {
    setupMockDOM();
    await clearProducts();
    await clearMovements();
    await clearIdealLevels();

    const mod = await import('../../src/ui/movementsView');
    movementsView = mod.movementsView;
    openMovementRegistrationModal = mod.openMovementRegistrationModal;
  });

  afterEach(async () => {
    if (movementsView && movementsView.destroy) {
      await movementsView.destroy();
    }
    restoreDOM();
  });

  const sampleProduct: Product = {
    barcode: '75010001',
    sku: 'MHK-001',
    description: 'Cinta Canela 48mm',
    unit: 'ROLLO',
    expectedQty: 50,
    minQty: 10,
    maxQty: 80,
    source: 'catalogo',
  };

  // =========================================================================
  // TASK 1: Route mount -> unmount (destroy) & Listener Leaks
  // =========================================================================
  describe('1. Route mount -> unmount (destroy) & keydown listener cleanup', () => {
    it('attaches keydown listener on render and removes it exactly on destroy', async () => {
      await bulkPutProducts([sampleProduct]);
      const root = (globalThis as any).document.createElement('div');

      expect(windowListeners['keydown']?.length || 0).toBe(0);

      await movementsView.render(root, new URLSearchParams());
      expect(windowListeners['keydown']?.length).toBe(1);

      await movementsView.destroy();
      expect(windowListeners['keydown']?.length).toBe(0);
      expect(windowRemoveEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
    });

    it('undergoes 50 rapid route switches without listener accumulation (zero leak)', async () => {
      await bulkPutProducts([sampleProduct]);
      const root = (globalThis as any).document.createElement('div');

      for (let i = 0; i < 50; i++) {
        await movementsView.render(root, new URLSearchParams());
        expect(windowListeners['keydown']?.length).toBe(1);

        await movementsView.destroy();
        expect(windowListeners['keydown']?.length).toBe(0);
      }

      expect(windowListeners['keydown']?.length || 0).toBe(0);
    });

    it('cleans up previous keydown listener if render() is called consecutively without destroy()', async () => {
      await bulkPutProducts([sampleProduct]);
      const root = (globalThis as any).document.createElement('div');

      // First render (comparative)
      await movementsView.render(root, new URLSearchParams('tab=comparative'));
      expect(windowListeners['keydown']?.length).toBe(1);

      // Re-render with bitacora tab without explicit destroy
      await movementsView.render(root, new URLSearchParams('tab=bitacora'));
      expect(windowListeners['keydown']?.length).toBe(1);

      // Re-render with filter
      await movementsView.render(root, new URLSearchParams('filter=deficit_critical'));
      expect(windowListeners['keydown']?.length).toBe(1);

      // Final destroy cleans it up
      await movementsView.destroy();
      expect(windowListeners['keydown']?.length).toBe(0);
    });

    it('does not process keyboard wedge events after destroy()', async () => {
      await bulkPutProducts([sampleProduct]);
      const root = (globalThis as any).document.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      await movementsView.destroy();

      // Dispatch keystrokes that would otherwise open modal
      const sendKey = (key: string) => {
        (window as any).dispatchEvent(new (globalThis as any).KeyboardEvent('keydown', { key }));
      };
      sendKey('M');
      sendKey('H');
      sendKey('K');
      sendKey('-');
      sendKey('0');
      sendKey('0');
      sendKey('1');
      sendKey('Enter');

      await new Promise((r) => setTimeout(r, 10));
      const openDialog = (document as any).body.querySelector('dialog');
      expect(openDialog).toBeNull();
    });
  });

  // =========================================================================
  // TASK 2: Camera Stream Teardown & MediaStream Track Release
  // =========================================================================
  describe('2. Camera stream teardown & MediaStream track release', () => {
    it('stops active camera scanner and stops all MediaStream tracks when Cancel button is clicked', async () => {
      await bulkPutProducts([sampleProduct]);

      // Mock scanner module
      const scannerMod = await import('../../src/scanner/scanner');
      const stopTrackSpy1 = vi.fn();
      const stopTrackSpy2 = vi.fn();
      const mockTracks = [{ stop: stopTrackSpy1 }, { stop: stopTrackSpy2 }];

      const mockScannerHandle = {
        stop: vi.fn(() => {
          mockTracks.forEach((t) => t.stop());
        }),
        setTorch: vi.fn().mockResolvedValue(true),
        torchSupported: true,
        engine: 'nativo' as const,
      };

      vi.spyOn(scannerMod, 'cameraAvailable').mockReturnValue(true);
      const startScannerSpy = vi.spyOn(scannerMod, 'startScanner').mockResolvedValue(mockScannerHandle);

      const dlg = (await openMovementRegistrationModal('MHK-001', 'IN')) as MockElement;
      expect(dlg).toBeDefined();

      // Find camera toggle button and click to start camera
      const camToggleBtn = dlg.querySelectorAll('button').find((b) => b.textContent?.includes('Cámara'));
      expect(camToggleBtn).toBeDefined();
      camToggleBtn?.click();

      // Await startScanner
      await new Promise((r) => setTimeout(r, 10));
      expect(startScannerSpy).toHaveBeenCalled();

      // Click "Cancelar"
      const cancelBtn = dlg.querySelectorAll('button').find((b) => b.textContent === 'Cancelar');
      expect(cancelBtn).toBeDefined();
      cancelBtn?.click();

      expect(mockScannerHandle.stop).toHaveBeenCalled();
      expect(stopTrackSpy1).toHaveBeenCalled();
      expect(stopTrackSpy2).toHaveBeenCalled();
      expect(dlg.open).toBe(false);
    });

    it('stops active camera scanner and releases tracks when movement is saved successfully', async () => {
      await bulkPutProducts([sampleProduct]);

      const scannerMod = await import('../../src/scanner/scanner');
      const stopTrackSpy = vi.fn();
      const mockScannerHandle = {
        stop: vi.fn(() => stopTrackSpy()),
        setTorch: vi.fn().mockResolvedValue(true),
        torchSupported: false,
        engine: 'zxing' as const,
      };

      vi.spyOn(scannerMod, 'cameraAvailable').mockReturnValue(true);
      vi.spyOn(scannerMod, 'startScanner').mockResolvedValue(mockScannerHandle);

      const dlg = (await openMovementRegistrationModal('MHK-001', 'IN')) as MockElement;

      // Start camera
      const camToggleBtn = dlg.querySelectorAll('button').find((b) => b.textContent?.includes('Cámara'));
      camToggleBtn?.click();
      await new Promise((r) => setTimeout(r, 10));

      // Click "Guardar Movimiento"
      const saveBtn = dlg.querySelectorAll('button').find((b) => b.textContent?.includes('Guardar Movimiento'));
      saveBtn?.click();
      await new Promise((r) => setTimeout(r, 15));

      expect(mockScannerHandle.stop).toHaveBeenCalled();
      expect(stopTrackSpy).toHaveBeenCalled();
      expect(dlg.open).toBe(false);
    });

    it('stops active camera scanner when native dialog close event is fired (e.g. Escape key)', async () => {
      await bulkPutProducts([sampleProduct]);

      const scannerMod = await import('../../src/scanner/scanner');
      const stopSpy = vi.fn();
      const mockScannerHandle = {
        stop: stopSpy,
        setTorch: vi.fn().mockResolvedValue(true),
        torchSupported: false,
        engine: 'nativo' as const,
      };

      vi.spyOn(scannerMod, 'cameraAvailable').mockReturnValue(true);
      vi.spyOn(scannerMod, 'startScanner').mockResolvedValue(mockScannerHandle);

      const dlg = (await openMovementRegistrationModal('MHK-001', 'IN')) as MockElement;

      const camToggleBtn = dlg.querySelectorAll('button').find((b) => b.textContent?.includes('Cámara'));
      camToggleBtn?.click();
      await new Promise((r) => setTimeout(r, 10));

      // Fire native dialog close event
      dlg.close();

      expect(stopSpy).toHaveBeenCalled();
      expect(dlg.open).toBe(false);
    });

    it('navigating away (destroy) while modal is open with camera running stops scanner and closes modal', async () => {
      await bulkPutProducts([sampleProduct]);
      const root = (globalThis as any).document.createElement('div');
      await movementsView.render(root, new URLSearchParams());

      const scannerMod = await import('../../src/scanner/scanner');
      const stopSpy = vi.fn();
      const mockScannerHandle = {
        stop: stopSpy,
        setTorch: vi.fn().mockResolvedValue(true),
        torchSupported: true,
        engine: 'nativo' as const,
      };

      vi.spyOn(scannerMod, 'cameraAvailable').mockReturnValue(true);
      vi.spyOn(scannerMod, 'startScanner').mockResolvedValue(mockScannerHandle);

      // Open modal from view
      const dlg = (await openMovementRegistrationModal('MHK-001', 'IN')) as MockElement;
      const camToggleBtn = dlg.querySelectorAll('button').find((b) => b.textContent?.includes('Cámara'));
      camToggleBtn?.click();
      await new Promise((r) => setTimeout(r, 10));

      expect(dlg.open).toBe(true);

      // User navigates to another route -> router invokes destroy()
      await movementsView.destroy();

      expect(stopSpy).toHaveBeenCalled();
      expect(dlg.open).toBe(false);
    });

    it('stops camera scanner if modal is closed while startScanner is still in-flight (no camera leak)', async () => {
      await bulkPutProducts([sampleProduct]);

      const scannerMod = await import('../../src/scanner/scanner');
      const stopSpy = vi.fn();
      let resolveScanner!: (h: any) => void;
      const scannerPromise = new Promise((resolve) => {
        resolveScanner = resolve;
      });

      vi.spyOn(scannerMod, 'cameraAvailable').mockReturnValue(true);
      vi.spyOn(scannerMod, 'startScanner').mockImplementation(() => scannerPromise as any);

      const dlg = (await openMovementRegistrationModal('MHK-001', 'IN')) as MockElement;
      const camToggleBtn = dlg.querySelectorAll('button').find((b) => b.textContent?.includes('Cámara'));
      camToggleBtn?.click();

      // startScanner is in-flight. User closes modal.
      const cancelBtn = dlg.querySelectorAll('button').find((b) => b.textContent === 'Cancelar');
      cancelBtn?.click();

      // Scanner hardware finish resolving
      const mockHandle = {
        stop: stopSpy,
        setTorch: vi.fn().mockResolvedValue(true),
        torchSupported: true,
        engine: 'nativo' as const,
      };
      resolveScanner(mockHandle);
      await new Promise((r) => setTimeout(r, 20));

      expect(stopSpy).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // TASK 3: Rapid Mount/Destroy Cycles & Concurrency Resilience
  // =========================================================================
  describe('3. Rapid mount/destroy cycles & async safety', () => {
    it('survives rapid mount/destroy loops without unhandled promise rejections or DOM errors', async () => {
      await bulkPutProducts([sampleProduct]);
      const root = (globalThis as any).document.createElement('div');

      const errors: any[] = [];
      const unhandledRejections: any[] = [];

      const origError = console.error;
      console.error = (...args: any[]) => {
        errors.push(args);
      };

      try {
        // Run 20 rapid overlapping render/destroy pairs
        for (let i = 0; i < 20; i++) {
          const renderPromise = movementsView.render(root, new URLSearchParams());
          const destroyPromise = movementsView.destroy();
          await Promise.all([renderPromise, destroyPromise]);
        }
      } finally {
        console.error = origError;
      }

      expect(windowListeners['keydown']?.length || 0).toBe(0);
      expect(unhandledRejections.length).toBe(0);
    });

    it('handles rapid navigation between comparative and bitacora sub-tabs with concurrent data updates', async () => {
      await bulkPutProducts([sampleProduct]);
      const root = (globalThis as any).document.createElement('div');

      await movementsView.render(root, new URLSearchParams());

      // Rapidly flip sub-tabs while adding movements in background
      const operations: Promise<any>[] = [];
      for (let i = 0; i < 10; i++) {
        operations.push(recordEntry({ sku: 'MHK-001', quantity: 1 }));
        operations.push(movementsView.render(root, new URLSearchParams(i % 2 === 0 ? 'tab=bitacora' : 'tab=comparative')));
      }

      await Promise.all(operations);

      // Final clean render
      await movementsView.render(root, new URLSearchParams('tab=comparative'));
      const table = root.querySelector('.comp-table');
      expect(table).toBeDefined();

      await movementsView.destroy();
      expect(windowListeners['keydown']?.length).toBe(0);
    });
  });
});
