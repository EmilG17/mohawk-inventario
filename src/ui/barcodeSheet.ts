import { type Product } from '../db/db';
import { displayBarcode } from '../io/normalize';
import { renderCode128Svg } from '../barcode/code128';
import { downloadPng, downloadSvg } from '../barcode/barcodeExport';
import { clear, h, icon, openDialog, toast } from './dom';

export type LabelTemplate = 'avery5160' | 'avery5163' | 'continuous';

export interface TemplateConfig {
  id: LabelTemplate;
  name: string;
  perSheet: number;
  columns: number;
  rows: number;
  pageClass: string;
}

export const TEMPLATES: Record<LabelTemplate, TemplateConfig> = {
  avery5160: {
    id: 'avery5160',
    name: 'Avery 5160 (30 etiquetas · 2.625" × 1")',
    perSheet: 30,
    columns: 3,
    rows: 10,
    pageClass: 'avery-5160-page',
  },
  avery5163: {
    id: 'avery5163',
    name: 'Avery 5163 (10 etiquetas · 4" × 2")',
    perSheet: 10,
    columns: 2,
    rows: 5,
    pageClass: 'avery-5163-page',
  },
  continuous: {
    id: 'continuous',
    name: 'Rollo continuo térmico (1 etiqueta)',
    perSheet: 1,
    columns: 1,
    rows: 1,
    pageClass: 'continuous-page',
  },
};

export interface LabelSlotOptions {
  showSku?: boolean;
  showUnit?: boolean;
  template?: LabelTemplate;
  border?: boolean;
}

/**
 * Divide una lista de elementos en páginas de tamaño fijo.
 */
export function paginateLabels<T>(items: T[], perSheet: number): T[][] {
  const size = Math.max(1, perSheet);
  if (items.length === 0) return [];
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  return pages;
}

/**
 * Calcula el desplazamiento de inicio en una hoja parcialmente usada.
 */
export function calculateSheetOffset(
  offset: number,
  perSheet: number,
): { sheetIndex: number; slotIndex: number; blankSlots: number } {
  const size = Math.max(1, perSheet);
  const safeOffset = Math.max(0, offset);
  const sheetIndex = Math.floor(safeOffset / size);
  const slotIndex = safeOffset % size;
  const blankSlots = slotIndex;
  return { sheetIndex, slotIndex, blankSlots };
}

/**
 * Multiplica las etiquetas según una cantidad fija o la existencia teórica.
 */
export function applyQuantityMultiplier(
  products: Product[],
  multiplier: number | 'expected' | ((p: Product) => number),
): Product[] {
  const result: Product[] = [];
  for (const p of products) {
    let count = 1;
    if (typeof multiplier === 'number') {
      count = Math.max(1, Math.floor(multiplier));
    } else if (multiplier === 'expected') {
      count = Math.max(1, Math.round(p.expectedQty ?? 1));
    } else if (typeof multiplier === 'function') {
      count = Math.max(1, Math.floor(multiplier(p)));
    }
    for (let c = 0; c < count; c++) {
      result.push(p);
    }
  }
  return result;
}

/**
 * Renderiza el DOM de un slot de etiqueta para la hoja o previsualización.
 */
export function renderLabelSlot(
  product: Product,
  options: LabelSlotOptions = {},
): HTMLElement {
  const {
    showSku = true,
    showUnit = true,
    template = 'avery5160',
    border = false,
  } = options;

  const rawCode = product.barcode;
  const codeText = rawCode.startsWith('SKU:')
    ? product.sku || rawCode.slice(4)
    : displayBarcode(rawCode);
  const descText = product.description?.trim() || 'Sin descripción';

  const barHeight =
    template === 'avery5163' ? 38 : template === 'continuous' ? 28 : 22;
  const fontSize = template === 'avery5163' ? 10 : 8;

  const svgMarkup = renderCode128Svg(codeText, codeText, {
    height: barHeight,
    fontSize,
    margin: 2,
    includeText: true,
  });

  const footerParts: string[] = [];
  if (showSku && product.sku && product.sku !== codeText) {
    footerParts.push(product.sku);
  }
  if (showUnit && product.unit) {
    footerParts.push(product.unit);
  }
  if (showUnit && product.brand) {
    footerParts.push(product.brand);
  }

  const slot = h(
    'div',
    {
      class: `sheet-label ${border ? 'with-border' : ''} template-${template}`,
    },
    h('div', { class: 'label-desc', title: descText }, descText),
    h('div', { class: 'label-barcode-wrap' }),
    footerParts.length
      ? h('div', { class: 'label-footer' }, footerParts.join(' · '))
      : null,
  );

  const wrap = slot.querySelector('.label-barcode-wrap');
  if (wrap) {
    wrap.innerHTML = svgMarkup;
    const svgEl = wrap.querySelector('svg');
    if (svgEl) {
      svgEl.classList.add('label-barcode-svg');
    }
  }

  return slot;
}

/**
 * Renderiza un slot en blanco (para espacios omitidos por offset).
 */
export function renderBlankSlot(template: LabelTemplate = 'avery5160'): HTMLElement {
  return h('div', {
    class: `sheet-label blank sheet-slot-empty template-${template}`,
  });
}

/**
 * Abre el diálogo modal de configuración, previsualización e impresión masiva de etiquetas.
 */
export function openBarcodeSheetDialog(
  products: Product[],
  defaultTitle = 'Generar etiquetas de códigos de barras',
): void {
  if (!products || products.length === 0) {
    toast('No hay productos seleccionados para generar etiquetas', 'warn');
    return;
  }

  let selectedTemplate: LabelTemplate = 'avery5160';
  let copiesMode: '1' | 'expected' | '2' | '5' = '1';
  let startingOffset = 0;
  let showSku = true;
  let showUnit = true;
  let showBorder = true;

  const previewWrap = h('div', { class: 'sheet-preview-wrap' });
  const countSummary = h('span', { class: 'muted small' });

  const templateSelect = h(
    'select',
    {
      class: 'input template-picker',
      id: 'sheet-template',
      onchange: (e: Event) => {
        selectedTemplate = (e.target as HTMLSelectElement).value as LabelTemplate;
        updatePreview();
      },
    },
    Object.values(TEMPLATES).map((tmpl) =>
      h('option', { value: tmpl.id, selected: tmpl.id === selectedTemplate }, tmpl.name),
    ),
  ) as HTMLSelectElement;

  const copiesSelect = h(
    'select',
    {
      class: 'input',
      onchange: (e: Event) => {
        copiesMode = (e.target as HTMLSelectElement).value as any;
        updatePreview();
      },
    },
    h('option', { value: '1' }, '1 copia por producto'),
    h('option', { value: 'expected' }, 'Según existencia teórica'),
    h('option', { value: '2' }, '2 copias de cada uno'),
    h('option', { value: '5' }, '5 copias de cada uno'),
  ) as HTMLSelectElement;

  const offsetInput = h('input', {
    class: 'input',
    type: 'number',
    name: 'offset',
    id: 'sheet-offset',
    min: '0',
    max: '29',
    value: '0',
    oninput: (e: Event) => {
      const val = parseInt((e.target as HTMLInputElement).value, 10);
      startingOffset = Number.isNaN(val) ? 0 : Math.max(0, val);
      updatePreview();
    },
  }) as HTMLInputElement;

  const borderCheckbox = h('input', {
    type: 'checkbox',
    checked: showBorder,
    onchange: (e: Event) => {
      showBorder = (e.target as HTMLInputElement).checked;
      updatePreview();
    },
  }) as HTMLInputElement;

  const buildItemsList = (): Product[] => {
    const mult =
      copiesMode === 'expected'
        ? 'expected'
        : parseInt(copiesMode, 10) || 1;
    return applyQuantityMultiplier(products, mult);
  };

  const renderPagesDom = (isForPrint: boolean): HTMLElement[] => {
    const items = buildItemsList();
    const config = TEMPLATES[selectedTemplate];
    const pages: HTMLElement[] = [];

    // Calcular blanks por offset
    const { blankSlots } = calculateSheetOffset(
      startingOffset,
      config.perSheet,
    );

    const allSlots: (Product | null)[] = [];
    for (let b = 0; b < blankSlots; b++) {
      allSlots.push(null);
    }
    for (const p of items) {
      allSlots.push(p);
    }

    const chunked = paginateLabels(allSlots, config.perSheet);
    if (chunked.length === 0) {
      chunked.push([]);
    }

    for (let pageIdx = 0; pageIdx < chunked.length; pageIdx++) {
      const pageItems = chunked[pageIdx];
      const pageEl = h('div', {
        class: `${config.pageClass} ${isForPrint ? 'print-page' : 'preview-page'}`,
      });

      for (const slotItem of pageItems) {
        if (slotItem === null) {
          pageEl.appendChild(renderBlankSlot(selectedTemplate));
        } else {
          pageEl.appendChild(
            renderLabelSlot(slotItem, {
              showSku,
              showUnit,
              template: selectedTemplate,
              border: isForPrint ? false : showBorder,
            }),
          );
        }
      }

      pages.push(pageEl);
    }

    return pages;
  };

  const updatePreview = () => {
    const items = buildItemsList();
    const config = TEMPLATES[selectedTemplate];
    const totalPages = Math.ceil(
      (items.length + (startingOffset % config.perSheet)) / config.perSheet,
    );

    countSummary.textContent = `${items.length} etiqueta(s) · ${totalPages || 1} página(s)`;
    clear(previewWrap, ...renderPagesDom(false));
  };

  const preparePrintContainer = () => {
    let printRoot = document.getElementById('print-sheet-root');
    if (!printRoot) {
      printRoot = document.createElement('div');
      printRoot.id = 'print-sheet-root';
      printRoot.className = 'print-sheet-root';
      document.body.appendChild(printRoot);
    }

    clear(printRoot, ...renderPagesDom(true));
  };

  const doPrint = () => {
    preparePrintContainer();
    window.print();
  };

  const doDownloadSvg = () => {
    const first = products[0];
    if (!first) return;
    const rawCode = first.barcode;
    const codeText = rawCode.startsWith('SKU:') ? first.sku || rawCode.slice(4) : displayBarcode(rawCode);
    const svgMarkup = renderCode128Svg(codeText, codeText, { height: 40, includeText: true });
    downloadSvg(svgMarkup, `${codeText}_etiqueta`);
    toast('Etiqueta SVG descargada', 'ok');
  };

  const doDownloadPng = async () => {
    const first = products[0];
    if (!first) return;
    const rawCode = first.barcode;
    const codeText = rawCode.startsWith('SKU:') ? first.sku || rawCode.slice(4) : displayBarcode(rawCode);
    const svgMarkup = renderCode128Svg(codeText, codeText, { height: 40, includeText: true });
    await downloadPng(svgMarkup, `${codeText}_etiqueta`, 3);
    toast('Etiqueta PNG (300 DPI) descargada', 'ok');
  };

  updatePreview();

  const body = h(
    'div',
    { class: 'barcode-sheet-modal form' },
    h(
      'div',
      { class: 'grid2' },
      h(
        'label',
        { class: 'field' },
        h('span', null, 'Plantilla de etiqueta'),
        templateSelect,
      ),
      h(
        'label',
        { class: 'field' },
        h('span', null, 'Copias por artículo'),
        copiesSelect,
      ),
    ),
    h(
      'div',
      { class: 'grid2' },
      h(
        'label',
        { class: 'field' },
        h('span', null, 'Iniciar en la etiqueta No. (Offset)'),
        offsetInput,
      ),
      h(
        'label',
        { class: 'check-inline', style: 'align-self: center; margin-top: 18px;' },
        borderCheckbox,
        h('span', null, 'Mostrar bordes de corte en pantalla'),
      ),
    ),
    h(
      'div',
      {
        class: 'row',
        style: 'justify-content: space-between; align-items: center; margin: 4px 0;',
      },
      h('h4', { style: 'margin: 0;' }, 'Previsualización de hoja'),
      countSummary,
    ),
    h(
      'p',
      { class: 'muted small' },
      'Nota para imprimir en Avery: En el cuadro de diálogo de impresión, selecciona Margen: "Ninguno" y Escala: "100%".',
    ),
    previewWrap,
    h(
      'div',
      { class: 'row wrap', style: 'margin-top: 12px; gap: 8px;' },
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: doPrint,
        },
        icon('scan'),
        'Imprimir etiquetas',
      ),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: doDownloadSvg,
        },
        icon('download'),
        'Descargar SVG',
      ),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => void doDownloadPng(),
        },
        icon('download'),
        'Descargar PNG',
      ),
    ),
  );

  openDialog(defaultTitle, body, [{ label: 'Cerrar' }]);
}

// Exponer en window para E2E testing
if (typeof window !== 'undefined') {
  (window as any).__paginateLabels = paginateLabels;
  (window as any).__calculateSheetOffset = calculateSheetOffset;
  (window as any).__renderLabelSlot = renderLabelSlot;
  (window as any).__applyQuantityMultiplier = applyQuantityMultiplier;
  (window as any).__openBarcodeSheetDialog = openBarcodeSheetDialog;
}
