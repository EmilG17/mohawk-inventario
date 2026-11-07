import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_BARTENDER_PROFILE,
  extractStringsFromBinary,
  getSavedBartenderProfile,
  parseBartenderBuffer,
  resetBartenderProfile,
  saveBartenderProfile,
} from '../../src/barcode/bartenderFormat';
import { renderLabelSlot, TEMPLATES } from '../../src/ui/barcodeSheet';

describe('BarTender Format Importer & Intermec PM43 Calibration', () => {
  beforeEach(() => {
    resetBartenderProfile();
  });

  it('provides accurate default BarTender profile for Intermec PM43 (3.97" x 6", 203 DPI)', () => {
    const profile = getSavedBartenderProfile();
    expect(profile.labelWidthIn).toBe(3.97);
    expect(profile.labelHeightIn).toBe(6.0);
    expect(profile.dpi).toBe(203);
    expect(profile.barHeightPx).toBe(32);
    expect(profile.moduleWidthPx).toBe(2.2);
    expect(profile.includeFooter).toBe(false);
  });

  it('extracts ASCII and UTF-16LE strings from simulated .btw binary buffer', () => {
    const encoder = new TextEncoder();
    const asciiPart = encoder.encode('BarTender Format Intermec PM43 203 DPI BEIGE TONE/ PICKLE');
    // Simulate UTF-16LE string 'Arial'
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

    const profile = parseBartenderBuffer(combined.buffer, 'mohawk_etiqueta.btw');
    expect(profile.fileName).toBe('mohawk_etiqueta.btw');
    expect(profile.dpi).toBe(203);
    expect(profile.detectedFonts).toContain('Calibri');
  });

  it('saves and persists custom BarTender profile options (both compact and full SKU options)', () => {
    saveBartenderProfile({ includeFooter: true, barHeightPx: 36 });
    const saved = getSavedBartenderProfile();
    expect(saved.includeFooter).toBe(true);
    expect(saved.barHeightPx).toBe(36);
  });

  it('configures both BarTender options: Option 1 (Description + Barcode only) and Option 2 (With SKU, Unit, Brand)', () => {
    const tmplCompact = TEMPLATES.intermec397x6;
    const tmplFull = TEMPLATES.intermec397x6_full;

    expect(tmplCompact).toBeDefined();
    expect(tmplCompact.hideFooterByDefault).toBe(true);
    expect(tmplCompact.barHeight).toBe(32);
    expect(tmplCompact.moduleWidth).toBe(2.2);
    expect(tmplCompact.pageClass).toContain('bartender-layout');

    expect(tmplFull).toBeDefined();
    expect(tmplFull.hideFooterByDefault).toBe(false);
    expect(tmplFull.barHeight).toBe(34);
    expect(tmplFull.moduleWidth).toBe(2.2);
    expect(tmplFull.pageClass).toContain('with-footer');
  });
});
