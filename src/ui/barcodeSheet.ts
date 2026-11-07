import { allProducts, type Product } from '../db/db';
import { displayBarcode } from '../io/normalize';
import { renderCode128Svg } from '../barcode/code128';
import { downloadPng, downloadSvg } from '../barcode/barcodeExport';
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
  defaultTitle = 'Generar etiquetas de códigos de barras',
): void {
  let initialProducts: Product[] = [];
  let initialQuantities: Record<string, number> = {};
  let dialogTitle = defaultTitle;

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
      queueMap.set(item.product.barcode, { ...item });
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

    queue = Array.from(queueMap.values());
    savePrintQueue(queue);
  } else {
    queue = existingQueue;
  }

  let selectedTemplate: LabelTemplate = 'avery5160';
  let startingOffset = 0;
  let showSku = true;
  let showUnit = true;
  let showBorder = true;

  const previewWrap = h('div', { class: 'sheet-preview-wrap' });
  const countSummary = h('span', { class: 'muted small' });
  const queueSummaryEl = h('span', { class: 'badge info' });
  const queueListContainer = h('div', { class: 'queue-items-list' });

  // Cache del catálogo completo para el buscador interactivo
  let catalogCache: Product[] = [];
  allProducts().then((prods) => {
    catalogCache = prods;
  }).catch(() => {});

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

  // Buscador interactivo para añadir productos a la cola
  const searchInput = h('input', {
    type: 'search',
    class: 'input',
    placeholder: '🔍 Buscar y añadir otro producto a esta hoja (nombre, SKU o código)...',
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
        h('div', { class: 'muted small', style: 'padding: 10px;' }, 'No se encontraron productos coincidentes.'),
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
              toast(`"${p.description || p.barcode}" añadido a la hoja`, 'ok');
            },
          },
          h(
            'div',
            { style: 'min-width: 0;' },
            h('div', { style: 'font-weight: 600; font-size: 13px;' }, p.description || 'Sin descripción'),
            h('div', { class: 'muted small' }, `${displayBarcode(p.barcode)}${p.sku ? ` · ${p.sku}` : ''}`),
          ),
          h('button', { class: 'btn sm primary', type: 'button' }, icon('plus'), 'Añadir'),
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

  // Función para agregar o incrementar producto en la cola
  const addOrIncrementProduct = (product: Product, qty = 1) => {
    const existing = queue.find((item) => item.product.barcode === product.barcode);
    if (existing) {
      existing.quantity += qty;
    } else {
      queue.push({ product: { ...product }, quantity: Math.max(1, qty) });
    }
    // Guardar en persistencia global
    addToPrintQueue(product, qty);
    refreshQueueList();
    updatePreview();
  };

  // Función para actualizar lista visual de la cola
  const refreshQueueList = () => {
    const distinctCount = queue.length;
    const totalLabels = queue.reduce((sum, item) => sum + item.quantity, 0);

    queueSummaryEl.textContent = `${distinctCount} producto(s) · ${totalLabels} etiqueta(s) totales`;

    if (queue.length === 0) {
      clear(
        queueListContainer,
        h(
          'div',
          { class: 'empty', style: 'padding: 12px; text-align: center;' },
          'No hay productos en la cola. Usa el buscador arriba para añadir productos a esta hoja.',
        ),
      );
      return;
    }

    clear(
      queueListContainer,
      queue.map((item, index) => {
        const prod = item.product;
        const qtyInput = h('input', {
          type: 'number',
          class: 'input sm queue-qty-input',
          value: String(item.quantity),
          min: '1',
          onchange: (e: Event) => {
            const val = parseInt((e.target as HTMLInputElement).value, 10);
            const safe = Number.isNaN(val) || val < 1 ? 1 : val;
            item.quantity = safe;
            setPrintQueueItemQty(prod.barcode, safe);
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
                item.quantity -= 1;
                setPrintQueueItemQty(prod.barcode, item.quantity);
                qtyInput.value = String(item.quantity);
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
              item.quantity += 1;
              setPrintQueueItemQty(prod.barcode, item.quantity);
              qtyInput.value = String(item.quantity);
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
            title: 'Quitar de la hoja',
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
            h('div', { class: 'queue-item-title', title: prod.description }, prod.description || 'Sin descripción'),
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
    queue = queue.filter((item) => item.product.barcode !== barcode);
    removeFromPrintQueue(barcode);
    refreshQueueList();
    updatePreview();
  };

  const clearEntireQueue = () => {
    queue = [];
    clearPrintQueue();
    refreshQueueList();
    updatePreview();
    toast('Cola de impresión vaciada');
  };

  const setAllQuantities = (qty: number | 'expected') => {
    for (const item of queue) {
      if (qty === 'expected') {
        item.quantity = Math.max(1, Math.round(item.product.expectedQty ?? 1));
      } else {
        item.quantity = Math.max(1, qty);
      }
      setPrintQueueItemQty(item.product.barcode, item.quantity);
    }
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
    if (queue.length === 0) {
      toast('No hay productos en la cola para imprimir', 'warn');
      return;
    }
    preparePrintContainer();
    window.print();
  };

  const doDownloadSvg = () => {
    const first = queue[0]?.product;
    if (!first) {
      toast('No hay productos en la cola', 'warn');
      return;
    }
    const rawCode = first.barcode;
    const codeText = rawCode.startsWith('SKU:') ? first.sku || rawCode.slice(4) : displayBarcode(rawCode);
    const svgMarkup = renderCode128Svg(codeText, codeText, { height: 40, includeText: true });
    downloadSvg(svgMarkup, `${codeText}_etiqueta`);
    toast('Etiqueta SVG descargada', 'ok');
  };

  const doDownloadPng = async () => {
    const first = queue[0]?.product;
    if (!first) {
      toast('No hay productos en la cola', 'warn');
      return;
    }
    const rawCode = first.barcode;
    const codeText = rawCode.startsWith('SKU:') ? first.sku || rawCode.slice(4) : displayBarcode(rawCode);
    const svgMarkup = renderCode128Svg(codeText, codeText, { height: 40, includeText: true });
    await downloadPng(svgMarkup, `${codeText}_etiqueta`, 3);
    toast('Etiqueta PNG (300 DPI) descargada', 'ok');
  };

  // Inicializar vista
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
          h('h4', { style: 'margin: 0;' }, '📋 Productos en esta hoja / cola'),
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
      { class: 'row wrap', style: 'gap: 16px; margin: 2px 0;' },
      h(
        'label',
        { class: 'check-inline' },
        borderCheckbox,
        h('span', null, 'Mostrar bordes de corte en pantalla'),
      ),
    ),
    // Previsualización de la hoja
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
      'Nota para imprimir en Avery: En el cuadro de diálogo de impresión del navegador, selecciona Margen: "Ninguno" y Escala: "100%".',
    ),
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

  openDialog(dialogTitle, body, [{ label: 'Cerrar' }]);
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
