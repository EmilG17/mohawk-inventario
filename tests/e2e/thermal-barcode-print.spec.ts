import { test, expect } from '@playwright/test';
import { clearDatabase, loadSampleCatalog } from './helpers';

test.describe('Impresión de código de barras y etiquetas térmicas 4x2', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearDatabase(page);
    await loadSampleCatalog(page);
  });

  test('Impresión individual genera layout térmico 4" × 2" con @page dinámica y barras nítidas', async ({ page }) => {
    await page.goto('/#/catalogo');
    await page.waitForSelector('.plist li');

    // Mockear window.print para capturar la llamada sin bloquear el navegador
    await page.evaluate(() => {
      (window as any).__printed = false;
      window.print = () => {
        (window as any).__printed = true;
      };
    });

    // Abrir el primer producto (ej. "Fibra abrasiva verde")
    const firstItem = page.locator('.plist li').first();
    await firstItem.click();

    const dlg = page.locator('dialog[open]');
    await expect(dlg).toBeVisible();

    // Presionar "Imprimir etiqueta" individual
    const printBtn = dlg.getByRole('button', { name: /Imprimir etiqueta/i }).first();
    await expect(printBtn).toBeVisible();
    await printBtn.click();

    // Verificar que window.print fue invocado
    const wasPrinted = await page.evaluate(() => (window as any).__printed);
    expect(wasPrinted).toBe(true);

    // Verificar que el estilo de página dinámica fue inyectado con tamaño 3.25in 2in portrait, 3.97in 6in o 4in 2in y margen 0
    const printPageStyle = await page.locator('#print-page-style').textContent();
    expect(printPageStyle).toMatch(/size:\s*(3\.25in 2in portrait|3\.97in 6in|4in 2in landscape)/);
    expect(printPageStyle).toContain('margin: 0 !important');

    // Verificar el contenedor de impresión individual (Pre-Cut 3-in-1 BarTender por defecto)
    const singlePrintRoot = page.locator('#single-print-root');
    await expect(singlePrintRoot).toBeAttached();

    const thermalLabel = singlePrintRoot.locator('.single-label-print');
    await expect(thermalLabel).toBeAttached();

    // Verificar las 3 zonas pre-cortadas (Principal Superior, Mini Inferior Izquierda y QR Inferior Derecha)
    await expect(thermalLabel.locator('.precut-zone-top')).toBeAttached();
    await expect(thermalLabel.locator('.precut-zone-bl')).toBeAttached();
    await expect(thermalLabel.locator('.precut-zone-br')).toBeAttached();

    const desc = thermalLabel.locator('.precut-top-desc').first();
    await expect(desc).toBeAttached();
    expect((await desc.textContent())?.length).toBeGreaterThan(0);

    const svg = thermalLabel.locator('.precut-top-barcode svg');
    await expect(svg).toBeAttached();

    const qrSvg = thermalLabel.locator('.precut-br-qr-wrap svg.qr-code-svg');
    await expect(qrSvg).toBeAttached();

    // Verificar que las barras SVG incluyen -webkit-print-color-adjust: exact para impresoras térmicas
    const rectStyle = await svg.locator('rect.barcode-bar').first().getAttribute('style');
    expect(rectStyle).toContain('-webkit-print-color-adjust:exact');
    expect(rectStyle).toContain('print-color-adjust:exact');

    // Verificar emulación de medios de impresión: #app y dialog deben ocultarse, .single-print-root visible
    await page.emulateMedia({ media: 'print' });
    const isSingleRootVisibleInPrint = await page.evaluate(() => {
      const el = document.getElementById('single-print-root');
      if (!el) return false;
      const display = window.getComputedStyle(el).display;
      return display !== 'none';
    });
    expect(isSingleRootVisibleInPrint).toBe(true);

    const isAppVisibleInPrint = await page.evaluate(() => {
      const el = document.getElementById('app');
      if (!el) return false;
      const display = window.getComputedStyle(el).display;
      return display === 'none';
    });
    expect(isAppVisibleInPrint).toBe(true);
  });

  test('Plantilla de rollo térmico 4" × 2" en la hoja / cola de etiquetas se persiste y aplica formato correcto', async ({ page }) => {
    await page.goto('/#/catalogo');
    await page.waitForSelector('.plist li');

    await page.evaluate(() => {
      (window as any).__printed = false;
      window.print = () => {
        (window as any).__printed = true;
      };
    });

    // Abrir el modal de hoja de etiquetas
    const queueBtn = page.getByTestId('catalog-queue-btn');
    await queueBtn.click();

    const modal = page.locator('.barcode-sheet-modal');
    await expect(modal).toBeVisible();

    // Añadir un producto mediante búsqueda
    const searchInput = modal.locator('input[type="search"]');
    await searchInput.fill('WD-40');
    await page.waitForTimeout(300);
    await modal.locator('.queue-search-item').first().click();

    // Cambiar la plantilla a "Rollo térmico 4" × 2""
    const templateSelect = modal.locator('#sheet-template');
    await templateSelect.selectOption('thermal4x2');

    // Verificar que en la previsualización se muestra .thermal-4x2-page
    const thermalPage = modal.locator('.sheet-preview-wrap .thermal-4x2-page').first();
    await expect(thermalPage).toBeVisible();

    // Verificar que la preferencia quedó almacenada en localStorage
    const savedPref = await page.evaluate(() => localStorage.getItem('mohawk_preferred_label_template'));
    expect(savedPref).toBe('thermal4x2');

    // Verificar que el estilo dinámico se actualizó a 4in 2in landscape
    const printPageStyle = await page.locator('#print-page-style').textContent();
    expect(printPageStyle).toContain('size: 4in 2in landscape');

    // Hacer clic en "Imprimir etiquetas"
    const printBtn = modal.getByRole('button', { name: /Imprimir etiquetas/i });
    await printBtn.click();

    const wasPrinted = await page.evaluate(() => (window as any).__printed);
    expect(wasPrinted).toBe(true);

    // Comprobar el contenedor de impresión #print-sheet-root
    const printSheetRoot = page.locator('#print-sheet-root');
    await expect(printSheetRoot).toBeAttached();
    const sheetThermalPage = printSheetRoot.locator('.thermal-4x2-page');
    await expect(sheetThermalPage).toBeAttached();

    // Comprobar que el svg del código de barras tiene las barras nítidas con color-adjust exact
    const barRect = sheetThermalPage.locator('rect.barcode-bar').first();
    const barStyle = await barRect.getAttribute('style');
    expect(barStyle).toContain('print-color-adjust:exact');
  });
});
