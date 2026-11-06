/**
 * Normalización de códigos de barras.
 *
 * Problema típico: Excel guarda los códigos como números, así que se pierden los ceros
 * a la izquierda (012345678905 → 12345678905) o aparecen en notación científica.
 * Además, el mismo producto puede leerse como UPC-A (12 dígitos) o EAN-13 (13 dígitos, con 0 inicial).
 * Para que todo coincida, los códigos numéricos de 11 a 14 dígitos se guardan como GTIN-14.
 */
export function normalizeBarcode(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  let s: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return '';
    s = Number.isInteger(raw) ? BigInt(raw).toString() : String(raw);
  } else {
    s = String(raw);
  }
  s = s.trim().replace(/[\s\u00a0\u200b]+/g, '');
  // Prefijo de símbolo AIM que algunos lectores agregan (]E0, ]C1…)
  s = s.replace(/^\][A-Za-z]\d/, '');
  if (/^\d+(\.0+)?$/.test(s)) s = s.replace(/\.0+$/, '');
  if (/^\d{11,14}$/.test(s)) return s.padStart(14, '0');
  return s.toUpperCase();
}

/** Forma legible: GTIN-14 → UPC-A (12) o EAN-13 cuando aplica. */
export function displayBarcode(code: string): string {
  if (/^\d{14}$/.test(code)) {
    if (code.startsWith('00')) return code.slice(2);
    if (code.startsWith('0')) return code.slice(1);
  }
  return code;
}

/** true si el texto parece un número en notación científica (dato dañado por Excel). */
export function looksScientific(raw: unknown): boolean {
  return typeof raw === 'string' && /^\d+(\.\d+)?E\+\d+$/i.test(raw.trim());
}

/** Valida dígito verificador GTIN (8, 12, 13, 14). */
export function isValidGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  let sum = 0;
  digits.reverse().forEach((d, i) => (sum += d * (i % 2 === 0 ? 3 : 1)));
  return (10 - (sum % 10)) % 10 === check;
}

export function parseNumber(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  let s = String(raw).trim().replace(/[$\s]/g, '');
  // 1.234,56 → 1234.56 ; 1,234.56 → 1234.56
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
