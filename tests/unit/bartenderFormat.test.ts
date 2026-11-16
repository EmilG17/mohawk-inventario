import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_BARTENDER_PROFILE,
  extractStringsFromBinary,
  getSavedBartenderProfile,
  parseBartenderBuffer,
  resetBartenderProfile,
  saveBartenderProfile,
} from '../../src/barcode/bartenderFormat';
import { printLabel } from '../../src/barcode/barcodeExport';
import { renderPrecut3in1Html, renderQrCodeSvg } from '../../src/barcode/code128';
import { renderBlankSlot, renderLabelSlot, TEMPLATES } from '../../src/ui/barcodeSheet';

describe('BarTender Format Importer & Intermec PM43 Calibration', () => {
  beforeEach(() => {
    resetBartenderProfile();
  });

  it('provides accurate default BarTender profile for Intermec PM43 Stock USER (3.25 in x 2.00 in, 203 DPI)', () => {
    const profile = getSavedBartenderProfile();
    expect(profile.labelWidthIn).toBe(3.25);
    expect(profile.labelHeightIn).toBe(2.0);
    expect(profile.dpi).toBe(203);
    expect(profile.barHeightPx).toBe(32);
    expect(profile.moduleWidthPx).toBe(2.0);
    expect(profile.includeFooter).toBe(false);
  });

  it('extracts ASCII, UTF-16LE, and USER (3.25 in x 2.00 in) stock dimensions from .btw buffer', () => {
    const encoder = new TextEncoder();
    const asciiPart = encoder.encode('BarTender Format Intermec PM43 203 DPI USER (3.25 in x 2.00 in) BEIGE TONE/ PICKLE');
    // Simulate UTF-16LE string 'Calibri'
    const utf16Part = new Uint8Array([
      0x00, 0x00,
      0x43, 0x00, 0x61, 0x00, 0x6c, 0x00, 0x69, 0x00, 0x62, 0x00, 0x72, 0x00, 0x69, 0x00,
      0x00, 0x00,
    ]);
    const combined = new Uint8Array(asciiPart.length + utf16Part.length);
    combined.set(asciiPart, 0);
    combined.set(utf16Part, asciiPart.length);

    const strings = extractStringsFromBinary(combined.buffer);
    expect(strings.some((s) => s.includes('Intermec PM43'))).toBe(true);
    expect(strings.some((s) => s.includes('Calibri'))).toBe(true);

    const profile = parseBartenderBuffer(combined.buffer, 'receiving test.btw');
    expect(profile.fileName).toBe('receiving test.btw');
    expect(profile.labelWidthIn).toBe(3.25);
    expect(profile.labelHeightIn).toBe(2.0);
    expect(profile.dpi).toBe(203);
    expect(profile.detectedFonts).toContain('Calibri');
  });

  it('saves and persists custom BarTender profile options (both compact and full SKU options)', () => {
    saveBartenderProfile({ includeFooter: true, barHeightPx: 36 });
    const saved = getSavedBartenderProfile();
    expect(saved.includeFooter).toBe(true);
    expect(saved.barHeightPx).toBe(36);
  });

  it('configures all BarTender templates: USER 3.25x2.00 (Clean & Full), Composite 3-in-1, and 3.97x6', () => {
    const tmpl325Clean = TEMPLATES.intermec325x2;
    const tmpl325Full = TEMPLATES.intermec325x2_full;
    const tmplComposite = TEMPLATES.intermec_composite;

    expect(tmpl325Clean).toBeDefined();
    expect(tmpl325Clean.pageSize).toBe('3.25in 2in portrait');
    expect(tmpl325Clean.hideFooterByDefault).toBe(true);

    expect(tmpl325Full).toBeDefined();
    expect(tmpl325Full.pageSize).toBe('3.25in 2in portrait');
    expect(tmpl325Full.hideFooterByDefault).toBe(false);

    expect(tmplComposite).toBeDefined();
    expect(tmplComposite.isComposite3in1).toBe(true);
    expect(tmplComposite.perSheet).toBe(1);

    // Ninguna plantilla de Intermec puede tener 2 o más etiquetas por página
    const intermecTemplates = Object.values(TEMPLATES).filter((t) => t.id.startsWith('intermec'));
    expect(intermecTemplates.length).toBeGreaterThanOrEqual(5);
    for (const tmpl of intermecTemplates) {
      expect(tmpl.perSheet).toBe(1);
      expect(tmpl.columns).toBe(1);
      expect(tmpl.rows).toBe(1);
    }

    // Las opciones de 6" deben ser las últimas de TEMPLATES
    const templateKeys = Object.keys(TEMPLATES);
    expect(templateKeys.slice(-3)).toEqual([
      'intermec397x6',
      'intermec397x6_full',
      'intermec6x397',
    ]);
  });

  it('generates scannable SVG QR code and 3-zone pre-cut BarTender HTML without SKU NUMBER prefix', () => {
    const qrSvg = renderQrCodeSvg('1234567', 84, 0);
    expect(qrSvg).toContain('<svg');
    expect(qrSvg).toContain('class="qr-code-svg"');
    expect(qrSvg).toContain('class="qr-module"');

    const html = renderPrecut3in1Html({
      barcode: '1234567',
      sku: 'XXXXX',
      description: 'BEIGE TONE/ PICKLE (12X24)',
      brand: 'DALTILE',
      unit: 'PZA',
    });
    expect(html).toContain('precut-zone-top');
    expect(html).toContain('precut-zone-bl');
    expect(html).toContain('precut-zone-br');
    expect(html).toContain('>XXXXX<');
    expect(html).not.toContain('SKU NUMBER');
    expect(html).toContain('DALTILE');
    expect(html).toContain('1234567');
    expect(html).toContain('qr-code-svg');
  });

  it('defaults renderLabelSlot, renderBlankSlot, and printLabel to Intermec 3-in-1 format', () => {
    const prevDoc = (globalThis as any).document;
    const prevWin = (globalThis as any).window;
    const prevNode = (globalThis as any).Node;
    const elementsById = new Map<string, any>();

    class FakeNode {
      textContent = '';
    }
    class FakeEl extends FakeNode {
      tagName: string;
      _id = '';
      _className = '';
      innerHTML = '';
      children: any[] = [];
      attrs: Record<string, string> = {};
      classList = {
        add: (...cls: string[]) => {
          const set = new Set(this._className.split(/\s+/).filter(Boolean));
          cls.forEach((c) => set.add(c));
          this._className = Array.from(set).join(' ');
        },
        contains: (c: string) => this._className.split(/\s+/).includes(c),
      };
      get id() {
        return this._id;
      }
      set id(v: string) {
        if (this._id) elementsById.delete(this._id);
        this._id = v;
        if (v) elementsById.set(v, this);
      }
      get className() {
        return this._className;
      }
      set className(v: string) {
        this._className = v;
      }
      constructor(tag: string) {
        super();
        this.tagName = tag.toUpperCase();
      }
      setAttribute(k: string, v: string) {
        this.attrs[k] = v;
        if (k === 'id') {
          this.id = v;
        }
      }
      appendChild(child: any) {
        this.children.push(child);
        return child;
      }
      addEventListener() {}
      remove() {
        if (this.id) elementsById.delete(this.id);
      }
    }

    const fakeHead = new FakeEl('head');
    const fakeBody = new FakeEl('body');
    const printSpy = vi.fn();

    (globalThis as any).Node = FakeNode;
    (globalThis as any).document = {
      head: fakeHead,
      body: fakeBody,
      createElement: (tag: string) => new FakeEl(tag),
      createTextNode: (t: string) => Object.assign(new FakeNode(), { textContent: t }),
      getElementById: (id: string) => elementsById.get(id) ?? null,
    };
    (globalThis as any).window = {
      print: printSpy,
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    try {
      const slot = renderLabelSlot({
        id: '1',
        barcode: '1234567',
        sku: 'SKU-3IN1',
        description: 'CERAMIC TILE 12X24',
        brand: 'DALTILE',
        unit: 'PZA',
        idealStock: 10,
        createdAt: '',
        updatedAt: '',
      }) as unknown as FakeEl;
      expect(slot.classList.contains('composite-3in1-label')).toBe(true);
      expect(slot.innerHTML).toContain('precut-3in1-sheet');
      expect(slot.innerHTML).toContain('qr-code-svg');

      const blank = renderBlankSlot() as unknown as FakeEl;
      expect(blank.classList.contains('template-intermec_composite')).toBe(true);

      printLabel('', 'CERAMIC TILE 12X24', { barcode: '1234567', sku: 'SKU-3IN1' });
      expect(printSpy).toHaveBeenCalledTimes(1);
      const pageStyle = elementsById.get('print-page-style');
      expect(pageStyle?.textContent).toContain('3.25in 2in portrait');
      const root = elementsById.get('single-print-root');
      expect(root?.innerHTML).toContain('intermec-composite-page');
      expect(root?.innerHTML).toContain('precut-3in1-sheet');
    } finally {
      (globalThis as any).document = prevDoc;
      (globalThis as any).window = prevWin;
      (globalThis as any).Node = prevNode;
    }
  });
});

