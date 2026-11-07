import { type Product } from '../db/db';

export interface PrintQueueItem {
  product: Product;
  quantity: number;
}

const STORAGE_KEY = 'mohawk_label_print_queue';
const listeners = new Set<() => void>();
let memoryQueue: PrintQueueItem[] | null = null;

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (e) {
      console.error('Error in print queue listener:', e);
    }
  }
}

/**
 * Carga los elementos de la cola de impresión desde la memoria o localStorage.
 */
export function getPrintQueue(): PrintQueueItem[] {
  if (memoryQueue !== null) {
    return [...memoryQueue];
  }

  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          memoryQueue = parsed
            .filter((item) => item && item.product && typeof item.product.barcode === 'string')
            .map((item) => ({
              product: item.product,
              quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
            }));
          return [...memoryQueue];
        }
      }
    } catch {
      // Fallback a memoria
    }
  }

  memoryQueue = [];
  return [...memoryQueue];
}

/**
 * Guarda los elementos de la cola en memoria y en almacenamiento local.
 */
export function savePrintQueue(items: PrintQueueItem[]): void {
  const valid = items
    .filter((item) => item && item.product && item.quantity > 0)
    .map((item) => ({
      product: item.product,
      quantity: Math.max(1, Math.floor(item.quantity)),
    }));

  memoryQueue = valid;

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(valid));
    } catch (e) {
      console.warn('Failed to save print queue to localStorage', e);
    }
  }
  notify();
}

/**
 * Añade un producto a la cola de impresión con la cantidad especificada.
 * Si el producto ya existía, suma la cantidad indicada.
 */
export function addToPrintQueue(product: Product, quantity = 1): PrintQueueItem[] {
  const current = getPrintQueue();
  const safeQty = Math.max(1, Math.floor(quantity));
  const existingIndex = current.findIndex((item) => item.product.barcode === product.barcode);

  if (existingIndex >= 0) {
    current[existingIndex].quantity += safeQty;
    current[existingIndex].product = { ...current[existingIndex].product, ...product };
  } else {
    current.push({
      product: { ...product },
      quantity: safeQty,
    });
  }

  savePrintQueue(current);
  return getPrintQueue();
}

/**
 * Establece la cantidad exacta de un producto en la cola. Si la cantidad es <= 0, se elimina.
 */
export function setPrintQueueItemQty(barcode: string, quantity: number): PrintQueueItem[] {
  const current = getPrintQueue();
  const safeQty = Math.floor(quantity);
  const existingIndex = current.findIndex((item) => item.product.barcode === barcode);

  if (existingIndex >= 0) {
    if (safeQty <= 0) {
      current.splice(existingIndex, 1);
    } else {
      current[existingIndex].quantity = safeQty;
    }
  }

  savePrintQueue(current);
  return getPrintQueue();
}

/**
 * Elimina un producto de la cola según su código de barras.
 */
export function removeFromPrintQueue(barcode: string): PrintQueueItem[] {
  const current = getPrintQueue().filter((item) => item.product.barcode !== barcode);
  savePrintQueue(current);
  return getPrintQueue();
}

/**
 * Vacía completamente la cola de impresión de etiquetas.
 */
export function clearPrintQueue(): void {
  savePrintQueue([]);
}

/**
 * Retorna el número total de etiquetas a imprimir (sumatoria de cantidades de todos los productos).
 */
export function getPrintQueueTotalCount(): number {
  return getPrintQueue().reduce((sum, item) => sum + item.quantity, 0);
}

/**
 * Retorna el número de productos distintos presentes en la cola.
 */
export function getPrintQueueDistinctCount(): number {
  return getPrintQueue().length;
}

/**
 * Expande la lista de elementos de la cola a un arreglo plano de productos
 * donde cada producto se repite tantas veces como su cantidad especificada.
 */
export function expandQueueToProducts(queue: PrintQueueItem[]): Product[] {
  const flat: Product[] = [];
  for (const item of queue) {
    const qty = Math.max(1, Math.floor(item.quantity));
    for (let i = 0; i < qty; i++) {
      flat.push(item.product);
    }
  }
  return flat;
}

/**
 * Permite suscribirse a cambios en la cola de impresión (para actualizar badges, listas, etc.).
 */
export function subscribePrintQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
