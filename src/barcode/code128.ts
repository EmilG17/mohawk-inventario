import { QRCodeDecoderErrorCorrectionLevel, QRCodeEncoder } from '@zxing/library';

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
        `<rect class="barcode-bar" x="${startX}" y="${opts.margin}" width="${currentRun * opts.width}" height="${opts.height}" fill="${opts.color}" style="fill:${opts.color}!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;"/>`,
      );
      currentRun = 0;
    }
  }
  if (currentRun > 0) {
    rects.push(
      `<rect class="barcode-bar" x="${startX}" y="${opts.margin}" width="${currentRun * opts.width}" height="${opts.height}" fill="${opts.color}" style="fill:${opts.color}!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;"/>`,
    );
  }

  let textSvg = '';
  if (opts.includeText) {
    const label = escapeXml(displayText ?? text);
    const textY = opts.margin + opts.height + opts.fontSize + 1;
    textSvg = `<text x="${totalWidth / 2}" y="${textY}" text-anchor="middle" font-family="ui-monospace, monospace" font-size="${opts.fontSize}" font-weight="bold" fill="${opts.color}" style="fill:${opts.color}!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;">${label}</text>`;
  }

  const bgRect = opts.background && opts.background !== 'transparent'
    ? `<rect width="${totalWidth}" height="${totalHeight}" fill="${opts.background}"/>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${totalHeight}" width="${totalWidth}" height="${totalHeight}" class="barcode-svg" shape-rendering="crispEdges" style="-webkit-print-color-adjust:exact;print-color-adjust:exact;">${bgRect}${rects.join('')}${textSvg}</svg>`;
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

/**
 * Genera un código QR vectorial SVG nítido y escaneable usando @zxing/library.
 */
export function renderQrCodeSvg(
  text: string,
  sizePx = 68,
  marginModules = 1,
): string {
  const safeText = text?.trim() || 'MHK-000000';
  try {
    const qr = QRCodeEncoder.encode(safeText, QRCodeDecoderErrorCorrectionLevel.M);
    const matrix = qr.getMatrix();
    const w = matrix.getWidth();
    const h = matrix.getHeight();
    const totalModules = w + marginModules * 2;
    const rects: string[] = [];

    for (let y = 0; y < h; y++) {
      let run = 0;
      let startX = 0;
      for (let x = 0; x < w; x++) {
        if (matrix.get(x, y) === 1) {
          if (run === 0) startX = x + marginModules;
          run++;
        } else if (run > 0) {
          rects.push(
            `<rect class="qr-module" x="${startX}" y="${y + marginModules}" width="${run}" height="1" fill="#000000" style="fill:#000000!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;"/>`,
          );
          run = 0;
        }
      }
      if (run > 0) {
        rects.push(
          `<rect class="qr-module" x="${startX}" y="${y + marginModules}" width="${run}" height="1" fill="#000000" style="fill:#000000!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;"/>`,
        );
      }
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalModules} ${totalModules}" width="${sizePx}" height="${sizePx}" class="qr-code-svg" shape-rendering="crispEdges" style="-webkit-print-color-adjust:exact;print-color-adjust:exact;"><rect width="${totalModules}" height="${totalModules}" fill="#ffffff"/>${rects.join('')}</svg>`;
  } catch {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${sizePx}" height="${sizePx}"><rect width="24" height="24" fill="#ffffff" stroke="#000000" stroke-width="2"/></svg>`;
  }
}

export interface Precut3in1Data {
  barcode: string;
  sku?: string;
  description?: string;
  brand?: string;
  unit?: string;
}

/**
 * Genera el marcado HTML completo para la etiqueta pre-cortada 3-en-1 de BarTender
 * (1. Etiqueta Principal Superior, 2. Mini Etiqueta Inferior Izquierda, 3. Etiqueta QR Inferior Derecha)
 * calibrada milimétricamente a las zonas de troquelado de USER (3.25 in x 2.00 in · 660x406 dots @ 203 DPI).
 */
export function renderPrecut3in1Html(data: Precut3in1Data): string {
  const rawBarcode = data.barcode?.trim() || 'MHK-000000';
  const code = escapeXml(rawBarcode);
  const rawSku = (data.sku?.trim() || rawBarcode).replace(/^SKU(\s+NUMBER)?\s*:?\s*/i, '').trim() || rawBarcode;
  const skuLabel = escapeXml(rawSku.toUpperCase());

  const fullDesc = (data.description?.trim() || 'SIN DESCRIPCIÓN').toUpperCase();
  const descLine1 = escapeXml(fullDesc.slice(0, 36));
  const descLine2 = escapeXml(
    fullDesc.length > 36
      ? fullDesc.slice(36, 72)
      : data.unit
        ? `${data.unit.toUpperCase()}`
        : '',
  );
  const miniDesc = escapeXml(fullDesc.slice(0, 24));
  const brandTitle = escapeXml((data.brand?.trim() || 'MOHAWK').toUpperCase());

  const mainBarcodeSvg = renderCode128Svg(rawBarcode, '', {
    height: 72,
    width: 2.0,
    margin: 0,
    includeText: false,
  }).replace('<svg ', '<svg preserveAspectRatio="none" ');

  const miniBarcodeSvg = renderCode128Svg(rawBarcode, '', {
    height: 44,
    width: 1.5,
    margin: 0,
    includeText: false,
  }).replace('<svg ', '<svg preserveAspectRatio="none" ');

  const qrSvg = renderQrCodeSvg(rawBarcode, 84, 0);

  return `
    <div class="precut-3in1-sheet">
      <!-- ZONA 1: ETIQUETA PRINCIPAL SUPERIOR (X: 6.1%..93.8%, Y: 7.6%..60.3%) -->
      <div class="precut-zone-top">
        <div class="precut-top-banner">${skuLabel}</div>
        <div class="precut-top-descs">
          <div class="precut-top-desc">${descLine1}</div>
          <div class="precut-top-desc">${descLine2 || '&nbsp;'}</div>
        </div>
        <div class="precut-top-barcode">${mainBarcodeSvg}</div>
        <div class="precut-top-footer-bar">
          <span class="precut-brand-badge">${brandTitle}</span>
          <span class="precut-main-number">${code}</span>
        </div>
      </div>

      <!-- ZONA INFERIOR DIVIDIDA EN 2 PRE-CORTES (IZQUIERDA MINI + DERECHA QR) -->
      <div class="precut-bottom-split">
        <!-- ZONA 2: MINI ETIQUETA INFERIOR IZQUIERDA (X: 4.1%..43.2%, Y: 67.5%..95.1%) -->
        <div class="precut-zone-bl">
          <div class="precut-bl-banner">${skuLabel}</div>
          <div class="precut-bl-desc">${miniDesc}</div>
          <div class="precut-bl-barcode">${miniBarcodeSvg}</div>
          <div class="precut-bl-footer">
            <span class="precut-bl-code-inv">${code}</span>
            <span class="precut-bl-brand">${brandTitle}</span>
          </div>
        </div>

        <!-- ZONA 3: ETIQUETA QR INFERIOR DERECHA (X: 77.4%..96.1%, Y: 66.0%..93.3%) -->
        <div class="precut-zone-br">
          <div class="precut-br-sku">${skuLabel}</div>
          <div class="precut-br-qr-row">
            <span class="precut-br-vert-num">${code}</span>
            <div class="precut-br-qr-wrap">${qrSvg}</div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Exponer en window para E2E testing
if (typeof window !== 'undefined') {
  (window as any).__encodeCode128 = encodeCode128;
  (window as any).__renderCode128Svg = renderCode128Svg;
  (window as any).__renderQrCodeSvg = renderQrCodeSvg;
  (window as any).__renderPrecut3in1Html = renderPrecut3in1Html;
  (window as any).__generateInternalCode = generateInternalCode;
  (window as any).__sanitizeFilename = sanitizeFilename;
}
