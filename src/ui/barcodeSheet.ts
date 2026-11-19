import { allProducts, type Product } from '../db/db';
import { L } from '../i18n/i18n';
import { displayBarcode } from '../io/normalize';
import { renderCode128Svg, renderPrecut3in1Html, stripSkuNumberText } from '../barcode/code128';
import { applyPrintPageStyle, downloadPng, downloadSvg } from '../barcode/barcodeExport';
import {
  type PrintQueueItem,
  getPrintQueue,
  savePrintQueue,
  addToPrintQueue,
  removeFromPrintQueue,
  clearPrintQueue,
  setPrintQueueItemQty,
  expandQueueToProducts,
} from '../barcode/printQueue';
import {
  type BartenderFormatProfile,
  getSavedBartenderProfile,
  parseBartenderFile,
  resetBartenderProfile,
  saveBartenderProfile,
} from '../barcode/bartenderFormat';
import { clear, h, icon, openDialog, toast } from './dom';

export type LabelTemplate =
  | 'intermec_composite'
  | 'intermec325x2'
  | 'intermec325x2_full'
  | 'thermal4x2'
  | 'avery5160'
  | 'avery5163'
  | 'thermal2x1'
  | 'continuous'
  | 'intermec397x6'
  | 'intermec397x6_full'
  | 'intermec6x397';

export interface TemplateConfig {
  id: LabelTemplate;
  name: string;
  perSheet: number;
  columns: number;
  rows: number;
  pageClass: string;
  pageSize: string;
  barHeight?: number;
  fontSize?: number;
  moduleWidth?: number;
  hideFooterByDefault?: boolean;
  isComposite3in1?: boolean;
}

export const TEMPLATES: Record<LabelTemplate, TemplateConfig> = {
  intermec_composite: {
    id: 'intermec_composite',
    name: 'Intermec PM43 · Etiqueta Pre-Cortada 3-en-1 BarTender · USER (3.25 in × 2.00 in) · 1 etiqueta por página (Principal + Mini + QR)',
    perSheet: 1,
    columns: 1,
    rows: 1,
    pageClass: 'intermec-composite-page',
    pageSize: '3.25in 2in portrait',
    barHeight: 36,
    fontSize: 10,
    moduleWidth: 2.0,
    isComposite3in1: true,
  },
  intermec325x2: {
    id: 'intermec325x2',
    name: 'Intermec PM43 · receiving test.btw · USER (3.25 in × 2.00 in) Portrait · 1 etiqueta por página (Solo Descripción + Código)',
    perSheet: 1,
    columns: 1,
    rows: 1,
    pageClass: 'intermec-325x2-page bartender-layout',
    pageSize: '3.25in 2in portrait',
    barHeight: 32,
    fontSize: 10,
    moduleWidth: 2.0,
    hideFooterByDefault: true,
  },
  intermec325x2_full: {
    id: 'intermec325x2_full',
    name: 'Intermec PM43 · USER (3.25 in × 2.00 in) Portrait · 1 etiqueta por página (Con SKU, Unidad y Marca)',
    perSheet: 1,
    columns: 1,
    rows: 1,
    pageClass: 'intermec-325x2-page bartender-layout with-footer',
    pageSize: '3.25in 2in portrait',
    barHeight: 32,
    fontSize: 10,
    moduleWidth: 2.0,
    hideFooterByDefault: false,
  },
  thermal4x2: {
    id: 'thermal4x2',
    name: 'Rollo térmico estándar 4" × 2" (100mm × 50mm · Zebra, Rollo)',
    perSheet: 1,
    columns: 1,
    rows: 1,
    pageClass: 'thermal-4x2-page',
    pageSize: '4in 2in landscape',
    barHeight: 34,
    fontSize: 10,
    moduleWidth: 2.0,
  },
  avery5160: {
    id: 'avery5160',
    name: 'Avery 5160 (30 etiquetas en hoja Carta · 2.625" × 1")',
    perSheet: 30,
    columns: 3,
    rows: 10,
    pageClass: 'avery-5160-page',
    pageSize: 'letter portrait',
    barHeight: 22,
    fontSize: 8,
  },
  avery5163: {
    id: 'avery5163',
    name: 'Avery 5163 (10 etiquetas en hoja Carta · 4" × 2")',
    perSheet: 10,
    columns: 2,
    rows: 5,
    pageClass: 'avery-5163-page',
    pageSize: 'letter portrait',
    barHeight: 38,
    fontSize: 10,
  },
  thermal2x1: {
    id: 'thermal2x1',
    name: 'Rollo térmico 2.25" × 1.25" (57mm × 32mm)',
    perSheet: 1,
    columns: 1,
    rows: 1,
    pageClass: 'thermal-2x1-page',
    pageSize: '2.25in 1.25in landscape',
    barHeight: 26,
    fontSize: 8,
  },
  continuous: {
    id: 'continuous',
    name: 'Rollo continuo térmico (50mm × 30mm)',
    perSheet: 1,
    columns: 1,
    rows: 1,
    pageClass: 'continuous-page',
    pageSize: '50mm 30mm landscape',
    barHeight: 26,
    fontSize: 8,
  },
  intermec397x6: {
    id: 'intermec397x6',
    name: 'Intermec PM43 · Formato BarTender (3.97" × 6" · 1 etiqueta por página · Solo Descripción + Código)',
    perSheet: 1,
    columns: 1,
    rows: 1,
    pageClass: 'intermec-397x6-page bartender-layout',
    pageSize: '3.97in 6in portrait',
    barHeight: 32,
    fontSize: 10,
    moduleWidth: 2.2,
    hideFooterByDefault: true,
  },
  intermec397x6_full: {
    id: 'intermec397x6_full',
    name: 'Intermec PM43 · Formato Completo (3.97" × 6" · 1 etiqueta por página · Con SKU, Unidad y Marca)',
    perSheet: 1,
    columns: 1,
    rows: 1,
    pageClass: 'intermec-397x6-page bartender-layout with-footer',
    pageSize: '3.97in 6in portrait',
    barHeight: 34,
    fontSize: 10,
    moduleWidth: 2.2,
    hideFooterByDefault: false,
  },
  intermec6x397: {
    id: 'intermec6x397',
    name: 'Intermec PM43 (6" × 3.97" · Apaisado · 1 etiqueta por página)',
    perSheet: 1,
    columns: 1,
    rows: 1,
    pageClass: 'intermec-6x397-page',
    pageSize: '6in 3.97in landscape',
    barHeight: 40,
    fontSize: 11,
    moduleWidth: 2.2,
  },
};

export interface LabelSlotOptions {
  showSku?: boolean;
  showUnit?: boolean;
  template?: LabelTemplate;
  border?: boolean;
  bartenderProfile?: BartenderFormatProfile;
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
    template = 'intermec_composite',
    border = false,
    bartenderProfile,
  } = options;

  const rawCode = product.barcode;
  const rawDisplay = rawCode.startsWith('SKU:')
    ? product.sku || rawCode.slice(4)
    : displayBarcode(rawCode);
  const codeText = stripSkuNumberText(rawDisplay) || rawDisplay;
  const cleanSku = stripSkuNumberText(product.sku || '');
  const descText = stripSkuNumberText(product.description?.trim() || '') || L('Sin descripción', 'No description');

  const tmplConfig = TEMPLATES[template] || TEMPLATES.intermec_composite;

  if (tmplConfig.isComposite3in1) {
    const compSlot = h('div', {
      class: `sheet-label composite-3in1-label ${border ? 'with-border' : ''}`,
    });
    try {
      compSlot.innerHTML = renderPrecut3in1Html({
        barcode: codeText,
        sku: cleanSku || codeText,
        description: descText,
        brand: product.brand || 'MOHAWK',
        unit: product.unit || '',
      });
    } catch {
      compSlot.innerHTML = `<span class="muted small">${L('Código no compatible con Code128', 'Code128 unsupported barcode')}</span>`;
    }
    return compSlot;
  }

  const isIntermec =
    template === 'intermec325x2' ||
    template === 'intermec325x2_full' ||
    template === 'intermec397x6' ||
    template === 'intermec397x6_full';
  const btProfile = isIntermec ? (bartenderProfile || getSavedBartenderProfile()) : null;

  const barHeight = btProfile ? btProfile.barHeightPx : (tmplConfig.barHeight ?? 24);
  const fontSize = tmplConfig.fontSize ?? 8;
  const moduleWidth = btProfile ? btProfile.moduleWidthPx : (tmplConfig.moduleWidth ?? 2);
  const includeText = btProfile ? btProfile.includeHumanReadable : true;

  let svgMarkup = '';
  try {
    svgMarkup = renderCode128Svg(codeText, codeText, {
      height: barHeight,
      fontSize,
      width: moduleWidth,
      margin: 2,
      includeText,
    });
  } catch {
    svgMarkup = `<span class="muted small">${L('Código no compatible con Code128', 'Code128 unsupported barcode')}</span>`;
  }

  const footerParts: string[] = [];
  const explicitlyControlledFooter = bartenderProfile?.includeFooter;
  const shouldHideFooter =
    explicitlyControlledFooter !== undefined
      ? !explicitlyControlledFooter
      : Boolean(
          tmplConfig.hideFooterByDefault &&
            (template === 'intermec325x2' || template === 'intermec397x6'),
        );

  if (!shouldHideFooter) {
    if (showSku && cleanSku && cleanSku !== codeText) {
      footerParts.push(cleanSku);
    }
    if (showUnit && product.unit) {
      footerParts.push(product.unit);
    }
    if (showUnit && product.brand) {
      footerParts.push(product.brand);
    }
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
export function renderBlankSlot(template: LabelTemplate = 'intermec_composite'): HTMLElement {
  return h('div', {
    class: `sheet-label blank sheet-slot-empty template-${template}`,
  });
}

export interface BarcodeSheetDialogOptions {
  products?: Product[];
  initialQuantities?: Record<string, number>;
  defaultTitle?: string;
}

/**
 * Abre el diálogo modal de configuración, previsualización e impresión de etiquetas,
 * permitiendo combinar distintos productos en la misma cola o página de impresión
 * con cantidades personalizadas para cada producto.
 */
export function openBarcodeSheetDialog(
  productsOrOptions?: Product[] | BarcodeSheetDialogOptions,
  defaultTitle = L('Generar etiquetas de códigos de barras', 'Generate barcode labels'),
): void {
  let initialProducts: Product[] = [];
  let initialQuantities: Record<string, number> = {};
  let dialogTitle = defaultTitle;
  let dialogOpen = true;

  if (Array.isArray(productsOrOptions)) {
    initialProducts = productsOrOptions;
  } else if (productsOrOptions && typeof productsOrOptions === 'object') {
    initialProducts = productsOrOptions.products ?? [];
    initialQuantities = productsOrOptions.initialQuantities ?? {};
    if (productsOrOptions.defaultTitle) dialogTitle = productsOrOptions.defaultTitle;
  }

  // Cargar cola actual persistente
  const existingQueue = getPrintQueue();
  let queue: PrintQueueItem[] = [];

  if (initialProducts.length > 0) {
    const queueMap = new Map<string, PrintQueueItem>();
    for (const item of existingQueue) {
      queueMap.set(item.product.barcode, { product: { ...item.product }, quantity: item.quantity });
    }

    for (const p of initialProducts) {
      const explicitQty = initialQuantities[p.barcode];
      const qty = explicitQty !== undefined ? Math.max(1, explicitQty) : 1;
      if (queueMap.has(p.barcode)) {
        if (explicitQty !== undefined) {
          queueMap.get(p.barcode)!.quantity = qty;
        }
      } else {
        queueMap.set(p.barcode, { product: { ...p }, quantity: qty });
      }
    }

    savePrintQueue(Array.from(queueMap.values()));
    queue = getPrintQueue();
  } else {
    queue = existingQueue;
  }

  const PREF_KEY = 'mohawk_preferred_label_template';
  const savedTemplate = (typeof localStorage !== 'undefined' ? localStorage.getItem(PREF_KEY) : null) as LabelTemplate | null;
  let selectedTemplate: LabelTemplate = (savedTemplate && TEMPLATES[savedTemplate]) ? savedTemplate : 'intermec_composite';
  let startingOffset = 0;
  const savedProfile = getSavedBartenderProfile();
  let showSku = savedTemplate === 'intermec325x2_full' || savedTemplate === 'intermec397x6_full'
    ? true
    : savedTemplate === 'intermec325x2' || savedTemplate === 'intermec397x6'
      ? Boolean(savedProfile.includeFooter)
      : true;
  let showUnit = showSku;
  let showBorder = true;

  const previewWrap = h('div', { class: 'sheet-preview-wrap', 'data-testid': 'sheet-preview' });
  const countSummary = h('span', { class: 'muted small' });
  const queueSummaryEl = h('span', { class: 'badge info' });
  const queueListContainer = h('div', { class: 'queue-items-list' });

  // Cache del catálogo completo para el buscador interactivo
  let catalogCache: Product[] = [];
  allProducts().then((prods) => {
    if (dialogOpen) catalogCache = prods;
  }).catch(() => {});

  const templateSelect = h(
    'select',
    {
      class: 'input template-picker',
      id: 'sheet-template',
      'data-testid': 'sheet-template-select',
      onchange: (e: Event) => {
        selectedTemplate = (e.target as HTMLSelectElement).value as LabelTemplate;
        if (typeof localStorage !== 'undefined') {
          try { localStorage.setItem(PREF_KEY, selectedTemplate); } catch {}
        }
        applyPrintPageStyle(TEMPLATES[selectedTemplate].pageSize);
        updatePreview();
      },
    },
    Object.values(TEMPLATES).map((tmpl) =>
      h('option', { value: tmpl.id, selected: tmpl.id === selectedTemplate }, tmpl.name),
    ),
  ) as HTMLSelectElement;

  const offsetInput = h('input', {
    class: 'input',
    type: 'number',
    name: 'offset',
    id: 'sheet-offset',
    'data-testid': 'sheet-offset-input',
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

  // Buscador interactivo para añadir productos a la cola
  const searchInput = h('input', {
    type: 'search',
    class: 'input',
    placeholder: L('Buscar y añadir otro producto a esta hoja (nombre, SKU o código)...', 'Search and add another product to this sheet (name, SKU, or code)...'),
  }) as HTMLInputElement;

  const searchDropdown = h('div', { class: 'queue-search-dropdown', style: 'display: none;' });

  const renderSearchDropdown = (query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) {
      searchDropdown.style.display = 'none';
      clear(searchDropdown);
      return;
    }

    const matches = catalogCache.filter((p) => {
      const text = `${p.description} ${p.sku} ${p.barcode} ${p.brand || ''}`.toLowerCase();
      return text.includes(q);
    }).slice(0, 10);

    if (matches.length === 0) {
      clear(
        searchDropdown,
        h('div', { class: 'muted small', style: 'padding: 10px;' }, L('No se encontraron productos coincidentes.', 'No matching products found.')),
      );
      searchDropdown.style.display = 'block';
      return;
    }

    clear(
      searchDropdown,
      matches.map((p) => {
        const itemEl = h(
          'div',
          {
            class: 'queue-search-item',
            onclick: () => {
              addOrIncrementProduct(p, 1);
              searchInput.value = '';
              searchDropdown.style.display = 'none';
              clear(searchDropdown);
              toast(`"${p.description || p.barcode}" ${L('añadido a la hoja', 'added to sheet')}`, 'ok');
            },
          },
          h(
            'div',
            { style: 'min-width: 0;' },
            h('div', { style: 'font-weight: 600; font-size: 13px;' }, p.description || L('Sin descripción', 'No description')),
            h('div', { class: 'muted small' }, `${displayBarcode(p.barcode)}${p.sku ? ` · ${p.sku}` : ''}`),
          ),
          h('button', { class: 'btn sm primary', type: 'button' }, icon('plus'), L('Añadir', 'Add')),
        );
        return itemEl;
      }),
    );
    searchDropdown.style.display = 'block';
  };

  searchInput.oninput = () => {
    renderSearchDropdown(searchInput.value);
  };

  searchInput.onfocus = () => {
    if (searchInput.value.trim()) {
      renderSearchDropdown(searchInput.value);
    }
  };

  // Función para agregar o incrementar producto en la cola sin doble mutación
  const addOrIncrementProduct = (product: Product, qty = 1) => {
    queue = addToPrintQueue(product, qty);
    refreshQueueList();
    updatePreview();
  };

  // Función para actualizar lista visual de la cola
  const refreshQueueList = () => {
    const distinctCount = queue.length;
    const totalLabels = queue.reduce((sum, item) => sum + item.quantity, 0);

    queueSummaryEl.textContent = L(
      `${distinctCount} producto(s) · ${totalLabels} etiqueta(s) totales`,
      `${distinctCount} product(s) · ${totalLabels} total label(s)`,
    );

    if (queue.length === 0) {
      clear(
        queueListContainer,
        h(
          'div',
          { class: 'empty', style: 'padding: 12px; text-align: center;' },
          L('No hay productos en la cola. Usa el buscador arriba para añadir productos a esta hoja.', 'No products in queue. Use the search bar above to add items to this sheet.'),
        ),
      );
      return;
    }

    clear(
      queueListContainer,
      queue.map((item) => {
        const prod = item.product;
        const qtyInput = h('input', {
          type: 'number',
          class: 'input sm queue-qty-input',
          value: String(item.quantity),
          min: '1',
          onchange: (e: Event) => {
            const val = parseInt((e.target as HTMLInputElement).value, 10);
            const safe = Number.isNaN(val) || val < 1 ? 1 : val;
            queue = setPrintQueueItemQty(prod.barcode, safe);
            refreshQueueList();
            updatePreview();
          },
        }) as HTMLInputElement;

        const minusBtn = h(
          'button',
          {
            type: 'button',
            class: 'btn sm ghost',
            style: 'padding: 2px 6px;',
            onclick: () => {
              if (item.quantity > 1) {
                queue = setPrintQueueItemQty(prod.barcode, item.quantity - 1);
                refreshQueueList();
                updatePreview();
              } else {
                removeProductFromQueue(prod.barcode);
              }
            },
          },
          '−',
        );

        const plusBtn = h(
          'button',
          {
            type: 'button',
            class: 'btn sm ghost',
            style: 'padding: 2px 6px;',
            onclick: () => {
              queue = setPrintQueueItemQty(prod.barcode, item.quantity + 1);
              refreshQueueList();
              updatePreview();
            },
          },
          '+',
        );

        const removeBtn = h(
          'button',
          {
            type: 'button',
            class: 'btn sm danger ghost',
            title: L('Quitar de la hoja', 'Remove from sheet'),
            onclick: () => {
              removeProductFromQueue(prod.barcode);
            },
          },
          icon('trash'),
        );

        return h(
          'div',
          { class: 'queue-item-row' },
          h(
            'div',
            { class: 'queue-item-meta' },
            h('div', { class: 'queue-item-title', title: prod.description }, prod.description || L('Sin descripción', 'No description')),
            h(
              'div',
              { class: 'queue-item-sub' },
              displayBarcode(prod.barcode),
              prod.sku ? ` · ${prod.sku}` : '',
              prod.unit ? ` · ${prod.unit}` : '',
            ),
          ),
          h(
            'div',
            { class: 'queue-item-stepper' },
            minusBtn,
            qtyInput,
            plusBtn,
            removeBtn,
          ),
        );
      }),
    );
  };

  const removeProductFromQueue = (barcode: string) => {
    queue = removeFromPrintQueue(barcode);
    refreshQueueList();
    updatePreview();
  };

  const clearEntireQueue = () => {
    clearPrintQueue();
    queue = [];
    refreshQueueList();
    updatePreview();
    toast(L('Cola de impresión vaciada', 'Print queue cleared'));
  };

  const setAllQuantities = (qty: number | 'expected') => {
    const updated = queue.map((item) => ({
      product: { ...item.product },
      quantity: qty === 'expected' ? Math.max(1, Math.round(item.product.expectedQty ?? 1)) : Math.max(1, qty),
    }));
    savePrintQueue(updated);
    queue = getPrintQueue();
    refreshQueueList();
    updatePreview();
  };

  const buildItemsList = (): Product[] => {
    return expandQueueToProducts(queue);
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
          const baseProfile = getSavedBartenderProfile();
          pageEl.appendChild(
            renderLabelSlot(slotItem, {
              showSku,
              showUnit,
              template: selectedTemplate,
              border: isForPrint ? false : showBorder,
              bartenderProfile: { ...baseProfile, includeFooter: showSku || showUnit },
            }),
          );
        }
      }

      pages.push(pageEl);
    }

    return pages;
  };

  const previewHint = h('p', { class: 'muted small' });
  const updatePreview = () => {
    const items = buildItemsList();
    const config = TEMPLATES[selectedTemplate];
    const totalPages = Math.ceil(
      (items.length + (startingOffset % config.perSheet)) / config.perSheet,
    );

    countSummary.textContent = L(
      `${items.length} etiqueta(s) · ${totalPages || 1} página(s)`,
      `${items.length} label(s) · ${totalPages || 1} page(s)`,
    );
    previewHint.textContent =
      config.perSheet === 1
        ? L(
            'Formato térmico (1 etiqueta por página): en el cuadro de impresión selecciona Margen "Ninguno" y Escala "100%".',
            'Thermal format (1 label per page): in the print dialog select Margins "None" and Scale "100%".',
          )
        : L(
            'Nota para imprimir en hoja Avery: en el cuadro de impresión selecciona Margen "Ninguno" y Escala "100%".',
            'Avery sheet note: in the print dialog select Margins "None" and Scale "100%".',
          );
    clear(previewWrap, ...renderPagesDom(false));
  };

  const preparePrintContainer = () => {
    const singleRoot = document.getElementById('single-print-root');
    if (singleRoot) {
      singleRoot.innerHTML = '';
    }

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
    if (queue.length === 0) {
      toast(L('No hay productos en la cola para imprimir', 'No products in queue to print'), 'warn');
      return;
    }
    const config = TEMPLATES[selectedTemplate];
    applyPrintPageStyle(config.pageSize);
    preparePrintContainer();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('afterprint', () => {
        const pr = document.getElementById('print-sheet-root');
        if (pr) pr.innerHTML = '';
      }, { once: true });
    }
    window.print();
  };

  const doDownloadSvg = () => {
    const first = queue[0]?.product;
    if (!first) {
      toast(L('No hay productos en la cola', 'No products in queue'), 'warn');
      return;
    }
    const rawCode = first.barcode;
    const codeText = rawCode.startsWith('SKU:') ? first.sku || rawCode.slice(4) : displayBarcode(rawCode);
    try {
      const svgMarkup = renderCode128Svg(codeText, codeText, { height: 40, includeText: true });
      downloadSvg(svgMarkup, `${codeText}_etiqueta`);
      toast(L('Etiqueta SVG descargada', 'SVG label downloaded'), 'ok');
    } catch {
      toast(L('El código contiene caracteres incompatibles con Code128', 'Code contains characters incompatible with Code128'), 'error');
    }
  };

  const doDownloadPng = async () => {
    const first = queue[0]?.product;
    if (!first) {
      toast(L('No hay productos en la cola', 'No products in queue'), 'warn');
      return;
    }
    const rawCode = first.barcode;
    const codeText = rawCode.startsWith('SKU:') ? first.sku || rawCode.slice(4) : displayBarcode(rawCode);
    try {
      const svgMarkup = renderCode128Svg(codeText, codeText, { height: 40, includeText: true });
      await downloadPng(svgMarkup, `${codeText}_etiqueta`, 3);
      toast(L('Etiqueta PNG (300 DPI) descargada', 'PNG label (300 DPI) downloaded'), 'ok');
    } catch {
      toast(L('El código contiene caracteres incompatibles con Code128', 'Code contains characters incompatible with Code128'), 'error');
    }
  };

  // Inicializar vista y dimensiones de página para impresión
  applyPrintPageStyle(TEMPLATES[selectedTemplate].pageSize);
  refreshQueueList();
  updatePreview();

  // Construir cuerpo del modal
  const body = h(
    'div',
    { class: 'barcode-sheet-modal form' },
    // Sección de gestión de productos en la cola
    h(
      'section',
      { class: 'sheet-queue-section' },
      h(
        'div',
        { class: 'sheet-queue-header' },
        h(
          'div',
          { class: 'row', style: 'gap: 8px; align-items: center;' },
          h('h4', { style: 'margin: 0;' }, 'Productos en esta hoja / cola'),
          queueSummaryEl,
        ),
        h(
          'div',
          { class: 'row', style: 'gap: 6px;' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn sm ghost',
              title: 'Poner 1 copia para cada producto',
              onclick: () => setAllQuantities(1),
            },
            'Todas a 1',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn sm ghost',
              title: 'Ajustar copias según existencia teórica de cada uno',
              onclick: () => setAllQuantities('expected'),
            },
            'Según existencia',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn sm danger ghost',
              title: 'Vaciar la cola de impresión',
              onclick: clearEntireQueue,
            },
            'Vaciar cola',
          ),
        ),
      ),
      h('div', { class: 'queue-search-box' }, searchInput, searchDropdown),
      queueListContainer,
    ),
    // Configuración de hoja y offset
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
        h('span', null, 'Iniciar en la etiqueta No. (Offset)'),
        offsetInput,
      ),
    ),
    h(
      'div',
      { class: 'row wrap', style: 'gap: 12px; align-items: center; margin: 4px 0;' },
      h(
        'label',
        { class: 'check-inline' },
        borderCheckbox,
        h('span', null, 'Mostrar bordes de corte en pantalla'),
      ),
      h(
        'label',
        { class: 'check-inline' },
        h('input', {
          type: 'checkbox',
          checked: showSku,
          onchange: (e: Event) => {
            const checked = (e.target as HTMLInputElement).checked;
            showSku = checked;
            showUnit = checked;
            saveBartenderProfile({ includeFooter: checked });
            updatePreview();
          },
        }),
        h('span', null, 'Incluir SKU, Unidad y Marca en etiqueta'),
      ),
      (() => {
        const fileInput = h('input', {
          type: 'file',
          accept: '.btw,.prn,.ipl,.zpl,.xml,.txt',
          style: 'display: none;',
          onchange: async (e: Event) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            try {
              const profile = await parseBartenderFile(file);
              saveBartenderProfile(profile);
              selectedTemplate = profile.includeFooter ? 'intermec325x2_full' : 'intermec325x2';
              templateSelect.value = selectedTemplate;
              showSku = profile.includeFooter;
              showUnit = profile.includeFooter;
              if (typeof localStorage !== 'undefined') {
                try { localStorage.setItem(PREF_KEY, selectedTemplate); } catch {}
              }
              applyPrintPageStyle(TEMPLATES[selectedTemplate].pageSize);
              updatePreview();
              toast(
                L(
                  `Formato BarTender "${file.name}" cargado (${profile.labelWidthIn}"×${profile.labelHeightIn}", 1 etiqueta por página)`,
                  `BarTender format "${file.name}" loaded (${profile.labelWidthIn}"×${profile.labelHeightIn}", 1 label per page)`,
                ),
                'ok',
              );
            } catch {
              toast(L('Error al leer el archivo BarTender', 'Failed to read BarTender file'), 'error');
            }
          },
        }) as HTMLInputElement;
        const uploadBtn = h(
          'button',
          {
            type: 'button',
            class: 'btn sm ghost',
            onclick: () => fileInput.click(),
            title: L('Importar archivo de etiqueta BarTender (.btw) o archivo de comandos (.prn, .zpl)', 'Import BarTender (.btw) or command (.prn, .zpl) file'),
          },
          icon('upload'),
          L('Cargar formato BarTender (.btw)', 'Load BarTender format (.btw)'),
        );
        return h('span', { style: 'display: contents;' }, uploadBtn, fileInput);
      })(),
    ),
    // Previsualización de la hoja
    h(
      'div',
      {
        class: 'row',
        style: 'justify-content: space-between; align-items: center; margin: 4px 0;',
      },
      h('h4', { style: 'margin: 0;' }, L('Previsualización de hoja', 'Sheet preview')),
      countSummary,
    ),
    previewHint,
    previewWrap,
    // Botones de acción
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
        L('Imprimir etiquetas', 'Print labels'),
      ),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: doDownloadSvg,
        },
        icon('download'),
        L('Descargar SVG', 'Download SVG'),
      ),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => void doDownloadPng(),
        },
        icon('download'),
        L('Descargar PNG', 'Download PNG'),
      ),
    ),
  );

  const dlg = openDialog(dialogTitle, body, [{ label: L('Cerrar', 'Close') }]);
  dlg.addEventListener('close', () => {
    dialogOpen = false;
  });
}

// Exponer en window para E2E testing
if (typeof window !== 'undefined') {
  (window as any).__paginateLabels = paginateLabels;
  (window as any).__calculateSheetOffset = calculateSheetOffset;
  (window as any).__renderLabelSlot = renderLabelSlot;
  (window as any).__applyQuantityMultiplier = applyQuantityMultiplier;
  (window as any).__openBarcodeSheetDialog = openBarcodeSheetDialog;
  (window as any).__getPrintQueue = getPrintQueue;
  (window as any).__addToPrintQueue = addToPrintQueue;
  (window as any).__clearPrintQueue = clearPrintQueue;
  (window as any).__expandQueueToProducts = expandQueueToProducts;
}
