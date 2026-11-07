import { downloadFile } from '../ui/dom';
import { renderPrecut3in1Html, sanitizeFilename, stripSkuNumberText } from './code128';

/**
 * Descarga una cadena SVG como archivo .svg.
 */
export function downloadSvg(svgString: string, filename: string): void {
  const base = filename.replace(/\.svg$/i, '');
  const safeName = `${sanitizeFilename(base)}.svg`;
  downloadFile(svgString, safeName, 'image/svg+xml;charset=utf-8');
}

/**
 * Rasteriza un SVG en un canvas offscreen en alta resolución (por defecto factor 3x / ~300 DPI)
 * y lo descarga como archivo .png.
 */
export async function downloadPng(
  svgString: string,
  filename: string,
  scale = 3,
): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const base = filename.replace(/\.png$/i, '');
  const safeName = `${sanitizeFilename(base)}.png`;

  // Extraer dimensiones del SVG
  const vbMatch = svgString.match(
    /viewBox=["']\s*0\s+0\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*["']/i,
  );
  const wMatch = svgString.match(/width=["'](\d+(?:\.\d+)?)["']/i);
  const hMatch = svgString.match(/height=["'](\d+(?:\.\d+)?)["']/i);

  const baseWidth = vbMatch
    ? parseFloat(vbMatch[1])
    : wMatch
      ? parseFloat(wMatch[1])
      : 300;
  const baseHeight = vbMatch
    ? parseFloat(vbMatch[2])
    : hMatch
      ? parseFloat(hMatch[2])
      : 120;

  const canvasWidth = Math.max(1, Math.round(baseWidth * scale));
  const canvasHeight = Math.max(1, Math.round(baseHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Fondo blanco opaco para garantizar legibilidad al imprimir o visualizar
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Error al cargar SVG en Canvas'));
      img.src = url;
    });

    ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);

    await new Promise<void>((resolve) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) {
          downloadFile(pngBlob, safeName, 'image/png');
        }
        resolve();
      }, 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface PrintLabelOptions {
  barcode?: string;
  sku?: string;
  unit?: string;
  brand?: string;
  pageSize?: string;
  hideFooter?: boolean;
  customClass?: string;
  precut3in1?: boolean;
}

/**
 * Inyecta dinámicamente la regla @page con las dimensiones exactas del papel y margen 0.
 * Esto evita que las impresoras térmicas (4"x2", continuo) interpreten el documento
 * como papel Carta (Letter 11"), empujando el código fuera del papel.
 */
export function applyPrintPageStyle(pageSize = '4in 2in landscape'): void {
  if (typeof document === 'undefined') return;
  let styleEl = document.getElementById('print-page-style') as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'print-page-style';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `
    @page {
      size: ${pageSize};
      margin: 0 !important;
    }
  `;
}

/**
 * Envía una etiqueta individual inmediatamente a la ventana de impresión del navegador.
 * Limpia cualquier cola previa, inyecta las dimensiones de página correctas y renderiza
 * la etiqueta optimizada para impresoras térmicas o estándar.
 */
export function printLabel(
  svgString: string,
  title?: string,
  options?: PrintLabelOptions,
): void {
  if (typeof document === 'undefined') return;

  // Limpiar cualquier residuo de impresión de hojas para evitar páginas en blanco previas
  const sheetRoot = document.getElementById('print-sheet-root');
  if (sheetRoot) {
    sheetRoot.innerHTML = '';
  }

  let printRoot = document.getElementById('single-print-root');
  if (!printRoot) {
    printRoot = document.createElement('div');
    printRoot.id = 'single-print-root';
    printRoot.className = 'single-print-root';
    document.body.appendChild(printRoot);
  }

  if (options?.precut3in1) {
    const pageSize = options?.pageSize || '3.25in 2in portrait';
    applyPrintPageStyle(pageSize);
    const cleanBarcode = stripSkuNumberText(options.barcode || '') || 'MHK-000000';
    const cleanSku = stripSkuNumberText(options.sku || '') || cleanBarcode;
    const precutHtml = renderPrecut3in1Html({
      barcode: cleanBarcode,
      sku: cleanSku,
      description: stripSkuNumberText(title || ''),
      brand: options.brand || 'MOHAWK',
      unit: options.unit || '',
    });
    printRoot.innerHTML = `
      <div class="single-label-print intermec-composite-page">
        <div class="sheet-label composite-3in1-label">${precutHtml}</div>
      </div>
    `;
    window.print();
    return;
  }

  // Inyectar tamaño de página (por defecto 3.97" x 6" para Intermec PM43 o 4" x 2" landscape)
  const pageSize = options?.pageSize || '4in 2in landscape';
  applyPrintPageStyle(pageSize);

  const footerParts: string[] = [];
  if (!options?.hideFooter) {
    const cleanSku = stripSkuNumberText(options?.sku || '');
    if (cleanSku) footerParts.push(cleanSku);
    if (options?.unit) footerParts.push(options.unit);
    if (options?.brand) footerParts.push(options.brand);
  }

  const footerHtml = footerParts.length > 0
    ? `<div class="label-footer">${escapeHtml(footerParts.join(' · '))}</div>`
    : '';

  const isIntermec = pageSize.includes('3.97') || pageSize.includes('3.25');
  const printClass = options?.customClass || (isIntermec ? 'intermec-397x6 bartender-layout' : 'thermal-4x2');

  printRoot.innerHTML = `
    <div class="single-label-print ${printClass}">
      ${title ? `<div class="label-desc" title="${escapeHtml(title)}">${escapeHtml(title)}</div>` : ''}
      <div class="single-barcode-wrap">${svgString}</div>
      ${footerHtml}
    </div>
  `;

  // Disparar ventana nativa de impresión
  window.print();
}

// Exponer en window para E2E testing
if (typeof window !== 'undefined') {
  (window as any).__downloadSvg = downloadSvg;
  (window as any).__downloadPng = downloadPng;
  (window as any).__printLabel = printLabel;
  (window as any).__applyPrintPageStyle = applyPrintPageStyle;
}
