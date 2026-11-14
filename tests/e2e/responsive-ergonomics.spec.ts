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
});
