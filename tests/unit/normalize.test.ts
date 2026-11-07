import { describe, expect, it } from 'vitest';
import {
  calculateGtinCheckDigit,
  displayBarcode,
  isValidGtin,
  looksScientific,
  normalizeBarcode,
  parseNumber,
} from '../../src/io/normalize';

describe('normalizeBarcode', () => {
  it('rellena con ceros a la izquierda códigos numéricos (GTIN-14)', () => {
    // UPC-A (12 dígitos) se normaliza a 14
    expect(normalizeBarcode('071153000100')).toBe('00071153000100');
    // EAN-13 (13 dígitos) se normaliza a 14
    expect(normalizeBarcode('7501006559385')).toBe('07501006559385');
    // Ya de 14 dígitos
    expect(normalizeBarcode('00071153000100')).toBe('00071153000100');
    // GTIN-8 (8 dígitos) se normaliza a 14
    expect(normalizeBarcode('12345670')).toBe('00000012345670');
  });

  it('recupera códigos cuando Excel los guardó como número', () => {
    // Excel quita el cero inicial de 071153000100 → 71153000100 (11 dígitos)
    expect(normalizeBarcode(71153000100)).toBe('00071153000100');
    // O como string con .0
    expect(normalizeBarcode('71153000100.00')).toBe('00071153000100');
    // GTIN-8 guardado por Excel como 7 dígitos
    expect(normalizeBarcode(1234567)).toBe('00000001234567');
  });

  it('elimina espacios, caracteres invisibles y prefijos AIM de escáner', () => {
    expect(normalizeBarcode('  071153 000100  ')).toBe('00071153000100');
    expect(normalizeBarcode(']E0071153000100')).toBe('00071153000100');
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
  it('muestra GTIN-8 de 8 dígitos si empezaba con 000000', () => {
    expect(displayBarcode('00000012345670')).toBe('12345670');
  });

  it('muestra UPC-A de 12 dígitos si empezaba con 00', () => {
    expect(displayBarcode('00071153000100')).toBe('071153000100');
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

describe('calculateGtinCheckDigit', () => {
  it('calcula correctamente dígito verificador para GTIN-8 (7 dígitos de datos)', () => {
    expect(calculateGtinCheckDigit('1234567')).toBe(0);
    expect(calculateGtinCheckDigit('9638507')).toBe(4);
  });

  it('calcula correctamente dígito verificador para GTIN-12 / UPC-A (11 dígitos de datos)', () => {
    // Ansell M: 07115300010 -> 0
    expect(calculateGtinCheckDigit('07115300010')).toBe(0);
    // Ansell L: 07115300011 -> 7
    expect(calculateGtinCheckDigit('07115300011')).toBe(7);
    // WD-40: 07956701100 -> 2
    expect(calculateGtinCheckDigit('07956701100')).toBe(2);
    // Sharpie: 07164130001 -> 9
    expect(calculateGtinCheckDigit('07164130001')).toBe(9);
    // Stanley Cutter: 07617410005 -> 1
    expect(calculateGtinCheckDigit('07617410005')).toBe(1);
    // Repuesto Stanley: 07617411921 -> 3
    expect(calculateGtinCheckDigit('07617411921')).toBe(3);
    // Energizer AA: 07630889211 -> 1
    expect(calculateGtinCheckDigit('07630889211')).toBe(1);
  });

  it('calcula correctamente dígito verificador para GTIN-13 / EAN-13 (12 dígitos de datos)', () => {
    // Rex Desengrasante: 750100655938 -> 5
    expect(calculateGtinCheckDigit('750100655938')).toBe(5);
    // Nutella: 301762042200 -> 3
    expect(calculateGtinCheckDigit('301762042200')).toBe(3);
  });

  it('calcula correctamente dígito verificador para GTIN-14 (13 dígitos de datos)', () => {
    expect(calculateGtinCheckDigit('0007956701100')).toBe(2);
  });

  it('lanza error ante entradas vacías o no numéricas', () => {
    expect(() => calculateGtinCheckDigit('')).toThrow();
    expect(() => calculateGtinCheckDigit('12345A7')).toThrow();
    expect(() => calculateGtinCheckDigit('   ')).toThrow();
  });
});

describe('isValidGtin', () => {
  it('valida dígito verificador real en distintas longitudes', () => {
    // GTIN-8
    expect(isValidGtin('12345670')).toBe(true);
    expect(isValidGtin('12345679')).toBe(false);

    // GTIN-12 (UPC-A)
    expect(isValidGtin('049000042566')).toBe(true);
    expect(isValidGtin('079567011002')).toBe(true); // WD-40 corregido
    expect(isValidGtin('079567011003')).toBe(false); // WD-40 corrupto previo
    expect(isValidGtin('071153000100')).toBe(true); // Ansell M corregido
    expect(isValidGtin('071153000108')).toBe(false); // Ansell M corrupto previo

    // GTIN-13 (EAN-13)
    expect(isValidGtin('3017620422003')).toBe(true);
    expect(isValidGtin('7501006559385')).toBe(true);
    expect(isValidGtin('7501006559384')).toBe(false);

    // GTIN-14
    expect(isValidGtin('00079567011002')).toBe(true);
    expect(isValidGtin('00079567011003')).toBe(false);
  });

  it('retorna false para formatos o longitudes no GTIN', () => {
    expect(isValidGtin('')).toBe(false);
    expect(isValidGtin('12345')).toBe(false);
    expect(isValidGtin('ABC123456789')).toBe(false);
    expect(isValidGtin('123456789012345')).toBe(false); // 15 dígitos
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
