import { describe, it, expect, beforeEach } from 'vitest';
import {
  addToPrintQueue,
  clearPrintQueue,
  getPrintQueue,
  getPrintQueueDistinctCount,
  getPrintQueueTotalCount,
  removeFromPrintQueue,
  setPrintQueueItemQty,
  expandQueueToProducts,
  type PrintQueueItem,
} from '../../src/barcode/printQueue';
import { paginateLabels, calculateSheetOffset } from '../../src/ui/barcodeSheet';
import type { Product } from '../../src/db/db';

const sampleProdA: Product = {
  barcode: '079567011002',
  description: 'WD-40 Limpiador y Lubricante 11oz',
  sku: 'WD40-11',
  unit: 'PZA',
  brand: 'WD-40',
  source: 'catalogo',
};

const sampleProdB: Product = {
  barcode: '071153000117',
  description: 'Guantes de Nitrilo Talla L',
  sku: 'GNT-L',
  unit: 'PAR',
  brand: 'Ansell',
  source: 'catalogo',
};

const sampleProdC: Product = {
  barcode: '071641300019',
  description: 'Marcador Permanente Sharpie Negro',
  sku: 'SHRP-BLK',
  unit: 'PZA',
  brand: 'Sanford',
  source: 'catalogo',
};

describe('Barcode Print Queue & Multi-Product Sheet Logic', () => {
  beforeEach(() => {
    clearPrintQueue();
  });

  it('starts with an empty queue', () => {
    expect(getPrintQueue()).toEqual([]);
    expect(getPrintQueueTotalCount()).toBe(0);
    expect(getPrintQueueDistinctCount()).toBe(0);
  });

  it('adds a product to the queue with default quantity 1', () => {
    addToPrintQueue(sampleProdA);
    const queue = getPrintQueue();
    expect(queue.length).toBe(1);
    expect(queue[0].product.barcode).toBe(sampleProdA.barcode);
    expect(queue[0].quantity).toBe(1);
    expect(getPrintQueueTotalCount()).toBe(1);
    expect(getPrintQueueDistinctCount()).toBe(1);
  });

  it('increments quantity when the same product is added multiple times', () => {
    addToPrintQueue(sampleProdA, 2);
    addToPrintQueue(sampleProdA, 3);
    const queue = getPrintQueue();
    expect(queue.length).toBe(1);
    expect(queue[0].quantity).toBe(5);
    expect(getPrintQueueTotalCount()).toBe(5);
  });

  it('supports multiple different products in the same queue with individual quantities', () => {
    addToPrintQueue(sampleProdA, 4);
    addToPrintQueue(sampleProdB, 2);
    addToPrintQueue(sampleProdC, 7);

    const queue = getPrintQueue();
    expect(queue.length).toBe(3);
    expect(getPrintQueueDistinctCount()).toBe(3);
    expect(getPrintQueueTotalCount()).toBe(13); // 4 + 2 + 7

    expect(queue.find((i) => i.product.barcode === sampleProdA.barcode)?.quantity).toBe(4);
    expect(queue.find((i) => i.product.barcode === sampleProdB.barcode)?.quantity).toBe(2);
    expect(queue.find((i) => i.product.barcode === sampleProdC.barcode)?.quantity).toBe(7);
  });

  it('updates specific item quantity with setPrintQueueItemQty', () => {
    addToPrintQueue(sampleProdA, 2);
    addToPrintQueue(sampleProdB, 5);

    setPrintQueueItemQty(sampleProdA.barcode, 10);
    expect(getPrintQueue().find((i) => i.product.barcode === sampleProdA.barcode)?.quantity).toBe(10);
    expect(getPrintQueueTotalCount()).toBe(15);

    // Setting qty <= 0 removes the item
    setPrintQueueItemQty(sampleProdB.barcode, 0);
    expect(getPrintQueue().find((i) => i.product.barcode === sampleProdB.barcode)).toBeUndefined();
    expect(getPrintQueueDistinctCount()).toBe(1);
  });

  it('removes a single product from the queue without affecting others', () => {
    addToPrintQueue(sampleProdA, 3);
    addToPrintQueue(sampleProdB, 4);
    addToPrintQueue(sampleProdC, 1);

    removeFromPrintQueue(sampleProdB.barcode);
    const queue = getPrintQueue();
    expect(queue.length).toBe(2);
    expect(queue.some((i) => i.product.barcode === sampleProdB.barcode)).toBe(false);
    expect(queue.some((i) => i.product.barcode === sampleProdA.barcode)).toBe(true);
    expect(queue.some((i) => i.product.barcode === sampleProdC.barcode)).toBe(true);
    expect(getPrintQueueTotalCount()).toBe(4);
  });

  it('expands queue items to a flat array repeating products by their individual quantities', () => {
    const queue: PrintQueueItem[] = [
      { product: sampleProdA, quantity: 2 },
      { product: sampleProdB, quantity: 3 },
      { product: sampleProdC, quantity: 1 },
    ];

    const flat = expandQueueToProducts(queue);
    expect(flat.length).toBe(6);
    expect(flat[0].barcode).toBe(sampleProdA.barcode);
    expect(flat[1].barcode).toBe(sampleProdA.barcode);
    expect(flat[2].barcode).toBe(sampleProdB.barcode);
    expect(flat[3].barcode).toBe(sampleProdB.barcode);
    expect(flat[4].barcode).toBe(sampleProdB.barcode);
    expect(flat[5].barcode).toBe(sampleProdC.barcode);
  });

  it('renders different products together on the SAME page in an Avery 5160 sheet (30 labels/page)', () => {
    const queue: PrintQueueItem[] = [
      { product: sampleProdA, quantity: 5 },
      { product: sampleProdB, quantity: 8 },
      { product: sampleProdC, quantity: 3 },
    ];

    const flat = expandQueueToProducts(queue);
    expect(flat.length).toBe(16);

    const pages = paginateLabels(flat, 30);
    expect(pages.length).toBe(1); // Fits completely on 1 single sheet!

    const page1 = pages[0];
    expect(page1.length).toBe(16);

    // Verify all 3 distinct products appear on page 1
    const barcodesOnPage1 = new Set(page1.map((p) => p.barcode));
    expect(barcodesOnPage1.has(sampleProdA.barcode)).toBe(true);
    expect(barcodesOnPage1.has(sampleProdB.barcode)).toBe(true);
    expect(barcodesOnPage1.has(sampleProdC.barcode)).toBe(true);
  });

  it('handles pagination across multiple sheets when total quantities exceed sheet capacity', () => {
    const queue: PrintQueueItem[] = [
      { product: sampleProdA, quantity: 20 },
      { product: sampleProdB, quantity: 20 },
    ];

    const flat = expandQueueToProducts(queue); // 40 items total
    const pages = paginateLabels(flat, 30); // Avery 5160 capacity is 30

    expect(pages.length).toBe(2);
    expect(pages[0].length).toBe(30); // 20 of A + 10 of B
    expect(pages[1].length).toBe(10); // remaining 10 of B

    // Page 1 contains both Product A and Product B together
    const p1Barcodes = new Set(pages[0].map((p) => p.barcode));
    expect(p1Barcodes.has(sampleProdA.barcode)).toBe(true);
    expect(p1Barcodes.has(sampleProdB.barcode)).toBe(true);
  });

  it('correctly shifts slots when startingOffset is applied with different products', () => {
    const offset = 4;
    const { blankSlots } = calculateSheetOffset(offset, 30);
    expect(blankSlots).toBe(4);

    const queue: PrintQueueItem[] = [
      { product: sampleProdA, quantity: 2 },
      { product: sampleProdB, quantity: 2 },
    ];
    const flat = expandQueueToProducts(queue);

    const allSlots: (Product | null)[] = [];
    for (let i = 0; i < blankSlots; i++) allSlots.push(null);
    for (const p of flat) allSlots.push(p);

    expect(allSlots.length).toBe(8);
    expect(allSlots[0]).toBeNull();
    expect(allSlots[1]).toBeNull();
    expect(allSlots[2]).toBeNull();
    expect(allSlots[3]).toBeNull();
    expect(allSlots[4]?.barcode).toBe(sampleProdA.barcode);
    expect(allSlots[5]?.barcode).toBe(sampleProdA.barcode);
    expect(allSlots[6]?.barcode).toBe(sampleProdB.barcode);
    expect(allSlots[7]?.barcode).toBe(sampleProdB.barcode);
  });
});
