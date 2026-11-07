import { test, expect } from '@playwright/test';
import { clearDatabase, loadSampleCatalog } from './helpers';

test.describe('Impresión de etiquetas de distintos productos en la misma cola u hoja', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearDatabase(page);
    await loadSampleCatalog(page);
  });

  test('Permite combinar múltiples productos distintos en la misma hoja con cantidades individuales', async ({ page }) => {
    await page.goto('/#/catalogo');
    await page.waitForSelector('.plist li');

    // 1. Abrir el modal de hoja de etiquetas desde la barra de herramientas del catálogo
    const queueBtn = page.getByRole('button', { name: /Cola de etiquetas/i });
    await expect(queueBtn).toBeVisible();
    await queueBtn.click();

    // 2. Verificar que se abrió el modal con la sección de cola de impresión
    const modal = page.locator('.barcode-sheet-modal');
    await expect(modal).toBeVisible();

    // 3. Usar el buscador interactivo para añadir el primer producto (WD-40)
    const searchInput = modal.locator('input[type="search"]');
    await searchInput.fill('WD-40');
    await page.waitForTimeout(300);

    const firstResult = modal.locator('.queue-search-item').first();
    await expect(firstResult).toBeVisible();
    await firstResult.click();

    // 4. Buscar y añadir un segundo producto distinto (Guantes)
    await searchInput.fill('Guantes');
    await page.waitForTimeout(300);
    const secondResult = modal.locator('.queue-search-item').first();
    await expect(secondResult).toBeVisible();
    await secondResult.click();

    // 5. Verificar que la lista de la cola contiene ambos productos distintos
    const queueRows = modal.locator('.queue-item-row');
    await expect(queueRows).toHaveCount(2);

    // Ajustar cantidades individuales: 3 para el primer producto, 2 para el segundo
    const firstQtyInput = queueRows.nth(0).locator('.queue-qty-input');
    await firstQtyInput.fill('3');
    await firstQtyInput.dispatchEvent('change');

    const secondQtyInput = queueRows.nth(1).locator('.queue-qty-input');
    await secondQtyInput.fill('2');
    await secondQtyInput.dispatchEvent('change');

    // 6. Verificar que la previsualización de la hoja contiene 5 etiquetas en total (3 de uno + 2 del otro)
    const previewSlots = modal.locator('.sheet-preview-wrap .sheet-label:not(.blank)');
    await expect(previewSlots).toHaveCount(5);

    // 7. Verificar que en la MISMA página aparecen ambos productos
    const page1 = modal.locator('.sheet-preview-wrap .avery-5160-page').first();
    await expect(page1).toBeVisible();

    const page1Text = await page1.textContent();
    expect(page1Text).toContain('WD-40');
    expect(page1Text).toContain('Guantes');

    // 8. Probar Offset inicial (dejar 2 espacios en blanco al inicio para hoja empezada)
    const offsetInput = modal.locator('#sheet-offset');
    await offsetInput.fill('2');
    await offsetInput.dispatchEvent('input');

    const blankSlots = modal.locator('.sheet-preview-wrap .sheet-label.blank');
    await expect(blankSlots).toHaveCount(2);

    const totalSlotsPage1 = modal.locator('.sheet-preview-wrap .sheet-label');
    await expect(totalSlotsPage1).toHaveCount(7); // 2 en blanco + 5 productos
  });

  test('Añadir a la cola desde el diálogo de edición de producto individual', async ({ page }) => {
    await page.goto('/#/catalogo');
    await page.waitForSelector('.plist li');

    // Abrir el primer producto
    const firstItem = page.locator('.plist li').first();
    await firstItem.click();

    const dlg = page.locator('dialog[open]');
    await expect(dlg).toBeVisible();

    // Presionar "Añadir a cola"
    const addQueueBtn = dlg.getByRole('button', { name: /Añadir a cola/i });
    await expect(addQueueBtn).toBeVisible();
    await addQueueBtn.click();

    // Cerrar el diálogo del producto
    await dlg.getByRole('button', { name: /Cancelar/i }).click();
    await expect(dlg).toBeHidden();

    // Abrir un segundo producto distinto
    const secondItem = page.locator('.plist li').nth(1);
    await secondItem.click();
    const dlg2 = page.locator('dialog[open]');
    await expect(dlg2).toBeVisible();

    // Presionar "Añadir a cola" en el segundo producto
    await dlg2.getByRole('button', { name: /Añadir a cola/i }).click();

    // Abrir "Hoja de etiquetas / Cola"
    const openSheetBtn = dlg2.getByRole('button', { name: /Hoja de etiquetas \/ Cola/i });
    await openSheetBtn.click();

    // Comprobar que el modal de la hoja muestra los 2 productos distintos juntos
    const modal = page.locator('.barcode-sheet-modal');
    await expect(modal).toBeVisible();

    const queueRows = modal.locator('.queue-item-row');
    await expect(queueRows).toHaveCount(2);
  });
});
