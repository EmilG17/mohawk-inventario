/**
 * Motor Code 128 Auto (Code B / Code C) en TypeScript puro sin dependencias externas.
 * Cumple con el estándar ISO/IEC 15417.
 */

// Patrones de 107 caracteres de Code 128 (0 a 106).
// Cada patrón define las anchuras alternas de barras y espacios (suma 11 módulos, excepto Stop que suma 13).
export const CODE_PATTERNS: readonly (readonly number[])[] = [
  [2, 1, 2, 2, 2, 2], [2, 2, 2, 1, 2, 2], [2, 2, 2, 2, 2, 1], [1, 2, 1, 2, 2, 3], [1, 2, 1, 3, 2, 2],
  [1, 3, 1, 2, 2, 2], [1, 2, 2, 2, 1, 3], [1, 2, 2, 3, 1, 2], [1, 3, 2, 2, 1, 2], [2, 2, 1, 2, 1, 3],
  [2, 2, 1, 3, 1, 2], [2, 3, 1, 2, 1, 2], [1, 1, 2, 2, 3, 2], [1, 2, 2, 1, 3, 2], [1, 2, 2, 2, 3, 1],
  [1, 1, 3, 2, 2, 2], [1, 2, 3, 1, 2, 2], [1, 2, 3, 2, 2, 1], [2, 2, 3, 2, 1, 1], [2, 2, 1, 1, 3, 2],
  [2, 2, 1, 2, 3, 1], [2, 1, 3, 2, 1, 2], [2, 2, 3, 1, 1, 2], [3, 1, 2, 1, 3, 1], [3, 1, 1, 2, 2, 2],
  [3, 2, 1, 1, 2, 2], [3, 2, 1, 2, 2, 1], [3, 1, 2, 2, 1, 2], [3, 2, 2, 1, 1, 2], [3, 2, 2, 2, 1, 1],
  [2, 1, 2, 1, 2, 3], [2, 1, 2, 3, 2, 1], [2, 3, 2, 1, 2, 1], [1, 1, 1, 3, 2, 3], [1, 3, 1, 1, 2, 3],
  [1, 3, 1, 3, 2, 1], [1, 1, 2, 3, 1, 3], [1, 3, 2, 1, 1, 3], [1, 3, 2, 3, 1, 1], [2, 1, 1, 3, 1, 3],
  [2, 3, 1, 1, 1, 3], [2, 3, 1, 3, 1, 1], [1, 1, 2, 1, 3, 3], [1, 1, 2, 3, 3, 1], [1, 3, 2, 1, 3, 1],
  [1, 1, 3, 1, 2, 3], [1, 1, 3, 3, 2, 1], [1, 3, 3, 1, 2, 1], [3, 1, 3, 1, 2, 1], [2, 1, 1, 3, 3, 1],
  [2, 3, 1, 1, 3, 1], [2, 1, 3, 1, 1, 3], [2, 1, 3, 3, 1, 1], [2, 1, 3, 1, 3, 1], [3, 1, 1, 1, 2, 3],
  [3, 1, 1, 3, 2, 1], [3, 3, 1, 1, 2, 1], [3, 1, 2, 1, 1, 3], [3, 1, 2, 3, 1, 1], [3, 3, 2, 1, 1, 1],
  [3, 1, 4, 1, 1, 1], [2, 2, 1, 4, 1, 1], [4, 3, 1, 1, 1, 1], [1, 1, 1, 2, 2, 4], [1, 1, 1, 4, 2, 2],
  [1, 2, 1, 1, 2, 4], [1, 2, 1, 4, 2, 1], [1, 4, 1, 1, 2, 2], [1, 4, 1, 2, 2, 1], [1, 1, 2, 2, 1, 4],
  [1, 1, 2, 4, 1, 2], [1, 2, 2, 1, 1, 4], [1, 2, 2, 4, 1, 1], [1, 4, 2, 1, 1, 2], [1, 4, 2, 2, 1, 1],
  [2, 4, 1, 2, 1, 1], [2, 2, 1, 1, 1, 4], [4, 1, 3, 1, 1, 1], [2, 4, 1, 1, 1, 2], [1, 3, 4, 1, 1, 1],
  [1, 1, 1, 2, 4, 2], [1, 2, 1, 1, 4, 2], [1, 2, 1, 2, 4, 1], [1, 1, 4, 2, 1, 2], [1, 2, 4, 1, 1, 2],
  [1, 2, 4, 2, 1, 1], [4, 1, 1, 2, 1, 2], [4, 2, 1, 1, 1, 2], [4, 2, 1, 2, 1, 1], [2, 1, 2, 1, 4, 1],
  [2, 1, 4, 1, 2, 1], [4, 1, 2, 1, 2, 1], [1, 1, 1, 1, 4, 3], [1, 1, 1, 3, 4, 1], [1, 3, 1, 1, 4, 1],
  [1, 1, 4, 1, 1, 3], [1, 1, 4, 3, 1, 1], [4, 1, 1, 1, 1, 3], [4, 1, 1, 3, 1, 1], [1, 1, 3, 1, 4, 1],
  [1, 1, 4, 1, 3, 1], [3, 1, 1, 1, 4, 1], [4, 1, 1, 1, 3, 1], [2, 1, 1, 4, 1, 2], [2, 1, 1, 2, 1, 4],
  [2, 1, 1, 2, 3, 2], [2, 3, 3, 1, 1, 1, 2],
];

export const CODE_START_A = 103;
export const CODE_START_B = 104;
export const CODE_START_C = 105;
export const CODE_STOP = 106;
export const CODE_CODE_B = 100;
export const CODE_CODE_C = 99;
export const CODE_SHIFT = 98;
export const CODE_FNC_1 = 102;

export interface BarcodeRenderOptions {
  width?: number; // ancho de módulo en px (por defecto: 2)
  height?: number; // altura de las barras en px (por defecto: 50)
  includeText?: boolean; // mostrar texto legible bajo el código (por defecto: true)
  fontSize?: number; // tamaño de fuente (por defecto: 12)
  margin?: number; // zona de silencio / márgenes en px (por defecto: 10)
  color?: string; // color de las barras (por defecto: #000000)
  background?: string; // color de fondo (por defecto: #ffffff)
}

export interface Code128EncodingResult {
  bars: string; // secuencia binaria ('1' = barra negra, '0' = espacio blanco)
  checksum: number; // suma de verificación módulo 103 (0..102)
  codes: number[]; // secuencia de índices de caracteres codificados
}

/**
 * Codifica una cadena de texto en Code 128 Auto (conmutando entre Set B y Set C).
 * - Cadenas numéricas de 4 o más dígitos se codifican en Set C (alta densidad, 2 dígitos por símbolo).
 * - Cadenas alfanuméricas usan Set B.
 * - Calcula la suma de verificación Modulo-103 estándar según ISO/IEC 15417.
 */
export function encodeCode128(text: string): Code128EncodingResult {
  if (text === '' || text === null || text === undefined) {
    return { bars: '', checksum: 0, codes: [] };
  }

  // Validación de caracteres ASCII compatibles
  for (let idx = 0; idx < text.length; idx++) {
    const code = text.charCodeAt(idx);
    if (code < 32 || code > 126) {
      throw new Error(`Caracter no soportado en Code 128: "${text[idx]}" (código ${code})`);
    }
  }

  const countDigits = (start: number): number => {
    let k = start;
    while (k < text.length && text[k] >= '0' && text[k] <= '9') k++;
    return k - start;
  };

  const codes: number[] = [];
  let i = 0;

  // Selección de modo inicial (si empieza con 4+ dígitos, comenzar en Code C)
  let inCodeC = countDigits(0) >= 4;
  codes.push(inCodeC ? CODE_START_C : CODE_START_B);

  while (i < text.length) {
    if (inCodeC) {
      const remainingDigits = countDigits(i);
      if (remainingDigits >= 2) {
        const pair = parseInt(text.slice(i, i + 2), 10);
        codes.push(pair);
        i += 2;
      } else {
        // Dígito impar remanente o caracter no numérico: cambiar a Code B
        codes.push(CODE_CODE_B);
        inCodeC = false;
        codes.push(text.charCodeAt(i) - 32);
        i++;
      }
    } else {
      const remainingDigits = countDigits(i);
      if (remainingDigits >= 4) {
        // 4 o más dígitos consecutivos: conviene cambiar a Code C
        codes.push(CODE_CODE_C);
        inCodeC = true;
        const pair = parseInt(text.slice(i, i + 2), 10);
        codes.push(pair);
        i += 2;
      } else {
        codes.push(text.charCodeAt(i) - 32);
        i++;
      }
    }
  }

  // Cálculo de checksum Modulo 103:
  // Checksum = (StartCode + Sum(i * Code_i)) mod 103
  let sum = codes[0];
  for (let j = 1; j < codes.length; j++) {
    sum += codes[j] * j;
  }
  const checksum = sum % 103;
  codes.push(checksum);
  codes.push(CODE_STOP);

  // Conversión de códigos a cadena binaria de barras ('1' barra, '0' espacio)
  let bars = '';
  for (const c of codes) {
    const pattern = CODE_PATTERNS[c];
    if (!pattern) continue;
    for (let pIdx = 0; pIdx < pattern.length; pIdx++) {
      const bit = pIdx % 2 === 0 ? '1' : '0';
      bars += bit.repeat(pattern[pIdx]);
    }
  }

  return { bars, checksum, codes };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Genera el marcado vectorial SVG completo para un código de barras en formato Code 128.
 */
export function renderCode128Svg(
  text: string,
  displayText?: string,
  options?: BarcodeRenderOptions,
): string {
  if (!text) {
    const w = 100;
    const h = options?.height ?? 50;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"></svg>`;
  }

  const opts: Required<BarcodeRenderOptions> = {
    width: options?.width ?? 2,
    height: options?.height ?? 50,
    includeText: options?.includeText ?? true,
    fontSize: options?.fontSize ?? 12,
    margin: options?.margin ?? 10,
    color: options?.color ?? '#000000',
    background: options?.background ?? '#ffffff',
  };

  const { bars } = encodeCode128(text);
  if (!bars) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 ${opts.height}" width="100" height="${opts.height}"></svg>`;
  }

  const barcodeWidth = bars.length * opts.width;
  const totalWidth = barcodeWidth + opts.margin * 2;
  const textSpace = opts.includeText ? opts.fontSize + 4 : 0;
  const totalHeight = opts.height + opts.margin * 2 + textSpace;

  // Agrupar '1's consecutivos en rectángulos para optimizar el peso y renderizado SVG
  const rects: string[] = [];
  let currentRun = 0;
  let startX = 0;

  for (let i = 0; i < bars.length; i++) {
    if (bars[i] === '1') {
      if (currentRun === 0) {
        startX = opts.margin + i * opts.width;
      }
      currentRun++;
    } else if (currentRun > 0) {
      rects.push(
        `<rect x="${startX}" y="${opts.margin}" width="${currentRun * opts.width}" height="${opts.height}" fill="${opts.color}"/>`,
      );
      currentRun = 0;
    }
  }
  if (currentRun > 0) {
    rects.push(
      `<rect x="${startX}" y="${opts.margin}" width="${currentRun * opts.width}" height="${opts.height}" fill="${opts.color}"/>`,
    );
  }

  let textSvg = '';
  if (opts.includeText) {
    const label = escapeXml(displayText ?? text);
    const textY = opts.margin + opts.height + opts.fontSize + 1;
    textSvg = `<text x="${totalWidth / 2}" y="${textY}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="${opts.fontSize}" fill="${opts.color}">${label}</text>`;
  }

  const bgRect = opts.background
    ? `<rect width="${totalWidth}" height="${totalHeight}" fill="${opts.background}"/>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" width="${totalWidth}" height="${totalHeight}" class="barcode-svg" shape-rendering="crispEdges">${bgRect}${rects.join('')}${textSvg}</svg>`;
}

/**
 * Crea un elemento DOM SVGSVGElement a partir de un texto.
 */
export function createBarcodeSvgElement(
  text: string,
  displayText?: string,
  options?: BarcodeRenderOptions,
): SVGSVGElement {
  const svgMarkup = renderCode128Svg(text, displayText, options);
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgMarkup, 'image/svg+xml');
  const svgEl = doc.documentElement as unknown as SVGSVGElement;
  return svgEl;
}

/**
 * Genera un código de barras interno único con formato `MHK-XXXXXX` (6 dígitos).
 */
export function generateInternalCode(existingCodes?: readonly string[] | Set<string>): string {
  const existing = existingCodes instanceof Set ? existingCodes : new Set(existingCodes ?? []);
  for (let attempt = 0; attempt < 10000; attempt++) {
    const num = Math.floor(100000 + Math.random() * 900000);
    const code = `MHK-${num}`;
    if (!existing.has(code)) {
      return code;
    }
  }
  // Fallback garantizado con timestamp
  return `MHK-${Date.now().toString().slice(-6)}`;
}

/**
 * Sanitiza un texto para usarlo como nombre de archivo seguro.
 */
export function sanitizeFilename(name: string): string {
  if (!name) return 'barcode';
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80) || 'barcode';
}

// Exponer en window para E2E testing
if (typeof window !== 'undefined') {
  (window as any).__encodeCode128 = encodeCode128;
  (window as any).__renderCode128Svg = renderCode128Svg;
  (window as any).__generateInternalCode = generateInternalCode;
  (window as any).__sanitizeFilename = sanitizeFilename;
}
