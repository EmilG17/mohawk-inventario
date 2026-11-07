import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_BARTENDER_PROFILE,
  extractStringsFromBinary,
  getSavedBartenderProfile,
  parseBartenderBuffer,
  resetBartenderProfile,
  saveBartenderProfile,
} from '../../src/barcode/bartenderFormat';
import { renderPrecut3in1Html, renderQrCodeSvg } from '../../src/barcode/code128';
import { renderLabelSlot, TEMPLATES } from '../../src/ui/barcodeSheet';

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
  });

  it('generates scannable SVG QR code and 3-zone pre-cut BarTender HTML', () => {
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
    expect(html).toContain('SKU NUMBER XXXXX');
    expect(html).toContain('DALTILE');
    expect(html).toContain('1234567');
    expect(html).toContain('qr-code-svg');
  });
});

