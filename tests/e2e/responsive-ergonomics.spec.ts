import { expect, test } from '@playwright/test';
import { clearDatabase, loadSampleCatalog } from './helpers';

test.describe('Ergonomía diferenciada Móvil (<900px) vs PC (>=900px)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/');
    await clearDatabase(page);
    await loadSampleCatalog(page);
  });

  test('Navegación responsiva: barra 4 + Más en móvil y sidebar + atajos Alt+1..7 en PC', async ({ page }) => {
    const viewport = page.viewportSize();
    const isDesktop = (viewport?.width ?? 0) >= 900;

    if (isDesktop) {
      await expect(page.locator('.app-sidebar')).toBeVisible();
      await expect(page.locator('.app-nav')).toBeHidden();

      // Alt+4 debe navegar a Catálogo
      await page.keyboard.press('Alt+4');
      await expect(page).toHaveURL(/#\/catalogo/);

      // Alt+2 dentro de un input no debe navegar fuera
      const search = page.getByTestId('catalog-search');
      await search.click();
      await search.press('Alt+2');
      await expect(page).toHaveURL(/#\/catalogo/);

      // Clic en sidebar a Supervisor y Ajustes
      await page.getByTestId('sidebar-nav-team').click();
      await expect(page).toHaveURL(/#\/equipo/);
      await page.getByTestId('sidebar-nav-settings').click();
      await expect(page).toHaveURL(/#\/ajustes/);

      // Ocultar y volver a mostrar el panel lateral en PC
      await page.getByTestId('sidebar-collapse-btn').click();
      await expect(page.locator('#app')).toHaveAttribute('data-sidebar-hidden', 'true');
      await expect(page.locator('.app-sidebar')).toBeHidden();
      await page.getByTestId('sidebar-toggle-btn').click();
      await expect(page.locator('#app')).toHaveAttribute('data-sidebar-hidden', 'false');
      await expect(page.locator('.app-sidebar')).toBeVisible();
    } else {
      await expect(page.locator('.app-nav')).toBeVisible();
      await expect(page.locator('.app-sidebar')).toBeHidden();

      // Solo 4 botones directos + botón Más visibles en barra inferior
      await expect(page.locator('.app-nav .nav-btn')).toHaveCount(5);
      await expect(page.getByTestId('nav-more')).toBeVisible();

      // Abrir hoja "Más" para ir a Reporte, Supervisor y Ajustes
      await page.getByTestId('nav-more').click();
      await expect(page.getByTestId('mobile-more-sheet')).toBeVisible();
      await page.getByTestId('mobile-nav-team').click();
      await expect(page).toHaveURL(/#\/equipo/);
      await expect(page.getByTestId('mobile-more-sheet')).toBeHidden();

      await page.getByTestId('nav-more').click();
      await page.getByTestId('mobile-nav-settings').click();
      await expect(page).toHaveURL(/#\/ajustes/);
    }
  });

  test('Catálogo, Kardex y Ajustes sin desbordamiento horizontal y con encabezados tabulares en PC', async ({ page }) => {
    const viewport = page.viewportSize();
    const isDesktop = (viewport?.width ?? 0) >= 900;

    for (const route of ['/', '/#/catalogo', '/#/movimientos', '/#/ajustes']) {
      await page.goto(route);
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `Overflow en ${route}`).toBeLessThanOrEqual(1);
    }

    await page.goto('/#/catalogo');
    await page.waitForSelector('.plist li');
    if (isDesktop) {
      await expect(page.locator('.plist-table-head')).toBeVisible();
    } else {
      await expect(page.locator('.plist-table-head')).toBeHidden();
    }
  });

  test('Terminal compacta Honeywell CK65 (320×533): barra de cámara compacta y cero desbordamiento', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 533 });

    // Definir contador y cargar catálogo de ejemplo para validar Inventario Ideal en 320×533
    await page.goto('/#/');
    await page.getByRole('button', { name: 'Cambiar' }).click();
    await page.fill('input.input', 'Operador CK65');
    await page.getByRole('button', { name: 'Aceptar' }).click();

    await page.goto('/#/ajustes');
    await page.getByRole('button', { name: 'Cargar catálogo de ejemplo' }).click();
    await expect(page).toHaveURL(/#\/catalogo/);

    // Activar Modo Supervisor en móvil + Mostrar teórico/ideal para verificar Inventario Ideal en #pcard a 320px
    await page.goto('/#/ajustes');
    await page.getByTestId('settings-supervisor-mode-toggle').check();
    await page.getByRole('checkbox', { name: /Mostrar teórico/i }).check();

    await page.goto('/#/');
    await page.getByTestId('home-start-session-btn').click();
    await expect(page.locator('dialog[open] h3')).toHaveText('Nueva sesión de conteo');
    await page.getByRole('button', { name: 'Aceptar' }).click();
    await expect(page).toHaveURL(/#\/contar/);

    const videoBox = await page.locator('.video-wrap.off').boundingBox();
    expect(videoBox).not.toBeNull();
    expect(videoBox!.height).toBeLessThanOrEqual(56);

    // Escanear producto en 320x533 y confirmar que Inventario Ideal y Registrar caben sin desborde
    await page.evaluate(() => (window as any).__simulateScan('079567011002'));
    await expect(page.locator('#pcard')).toBeVisible();
    await expect(page.locator('#pcard')).toContainText('Ideal: 24');
    const overflowCountScan = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflowCountScan).toBeLessThanOrEqual(1);

    await page.locator('#pcard').getByRole('button', { name: 'Registrar' }).click();
    await expect(page.locator('#pcard')).toBeHidden();

    for (const route of ['/', '/#/contar', '/#/catalogo', '/#/movimientos', '/#/reporte', '/#/ajustes']) {
      await page.goto(route);
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `Overflow en CK65 320px para ${route}`).toBeLessThanOrEqual(1);
    }
  });
});
