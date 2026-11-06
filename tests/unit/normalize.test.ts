import { describe, expect, it } from 'vitest';
import { displayBarcode, isValidGtin, looksScientific, normalizeBarcode, parseNumber } from '../../src/io/normalize';

describe('normalizeBarcode', () => {
  it('rellena con ceros a la izquierda códigos numéricos (GTIN-14)', () => {
    // UPC-A (12 dígitos) se normaliza a 14
    expect(normalizeBarcode('071153000108')).toBe('00071153000108');
    // EAN-13 (13 dígitos) se normaliza a 14
    expect(normalizeBarcode('7501006559385')).toBe('07501006559385');
    // Ya de 14 dígitos
    expect(normalizeBarcode('00071153000108')).toBe('00071153000108');
  });

  it('recupera códigos cuando Excel los guardó como número', () => {
    // Excel quita el cero inicial de 071153000108 → 71153000108 (11 dígitos)
    expect(normalizeBarcode(71153000108)).toBe('00071153000108');
    // O como string con .0
    expect(normalizeBarcode('71153000108.00')).toBe('00071153000108');
  });

  it('elimina espacios, caracteres invisibles y prefijos AIM de escáner', () => {
    expect(normalizeBarcode('  071153 000108  ')).toBe('00071153000108');
    expect(normalizeBarcode(']E0071153000108')).toBe('00071153000108');
  });

  it('conserva códigos alfanuméricos en mayúsculas (Code128, QR, SKUs)', () => {
    expect(normalizeBarcode('mhk-ppe-001')).toBe('MHK-PPE-001');
    expect(normalizeBarcode('PART-1234-A')).toBe('PART-1234-A');
  });

  it('maneja valores nulos o vacíos', () => {
    expect(normalizeBarcode('')).toBe('');
    expect(normalizeBarcode(null)).toBe('');
    expect(normalizeBarcode(undefined)).toBe('');
  });
});

describe('displayBarcode', () => {
  it('muestra UPC-A de 12 dígitos si empezaba con 00', () => {
    expect(displayBarcode('00071153000108')).toBe('071153000108');
  });

  it('muestra EAN-13 de 13 dígitos si empezaba con 0', () => {
    expect(displayBarcode('07501006559385')).toBe('7501006559385');
  });

  it('respeta códigos alfanuméricos', () => {
    expect(displayBarcode('MHK-001')).toBe('MHK-001');
  });
});

describe('looksScientific', () => {
  it('detecta notación científica de Excel', () => {
    expect(looksScientific('7.501E+12')).toBe(true);
    expect(looksScientific('7.501006559385E+12')).toBe(true);
    expect(looksScientific('7501006559385')).toBe(false);
    expect(looksScientific('ABC-123')).toBe(false);
  });
});

describe('isValidGtin', () => {
  it('valida dígito verificador real', () => {
    // 049000042566 (UPC-A) y 3017620422003 (EAN-13)
    expect(isValidGtin('049000042566')).toBe(true);
    expect(isValidGtin('3017620422003')).toBe(true);
    // alterado el último dígito
    expect(isValidGtin('049000042567')).toBe(false);
  });
});

describe('parseNumber', () => {
  it('parsea números en distintos formatos culturales y con signos de moneda', () => {
    expect(parseNumber(42)).toBe(42);
    expect(parseNumber('42')).toBe(42);
    expect(parseNumber(' 1,234.50 ')).toBe(1234.5);
    expect(parseNumber('$1,234.50')).toBe(1234.5);
    expect(parseNumber('1.234,50')).toBe(1234.5); // formato europeo/latam
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber('abc')).toBeUndefined();
    expect(parseNumber(null)).toBeUndefined();
  });
});
