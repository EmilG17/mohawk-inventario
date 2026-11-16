import { expect, test } from '@playwright/test';
import { clearDatabase } from './helpers';

test.describe('Device language responsiveness', () => {
  test.describe('English device locale (en-US)', () => {
    test.use({ locale: 'en-US' });

    test('renders UI in English automatically and allows switching language in Settings', async ({ page }) => {
      await page.goto('/#/');
      await clearDatabase(page);
      await page.reload();

      await expect(page.locator('html')).toHaveAttribute('lang', 'en');

      const viewport = page.viewportSize();
      const isDesktop = (viewport?.width ?? 0) >= 900;

      if (isDesktop) {
        await expect(page.getByTestId('sidebar-nav-home')).toContainText('Home');
        await expect(page.getByTestId('sidebar-nav-count')).toContainText('Count');
        await expect(page.getByTestId('sidebar-nav-catalog')).toContainText('Catalog');
        await expect(page.getByTestId('sidebar-nav-settings')).toContainText('Settings');
      } else {
        await expect(page.locator('.brand-title')).toHaveText('Consumables Inventory');
        await expect(page.getByTestId('mobile-nav-home')).toContainText('Home');
        await expect(page.getByTestId('mobile-nav-catalog')).toContainText('Catalog');
      }

      await expect(page.getByTestId('home-start-session-btn')).toContainText('Start new counting session');

      // Navigate to Settings and verify English controls + live switch to Spanish
      await page.goto('/#/ajustes');
      await expect(page.locator('h2')).toHaveText('Settings & Catalog');

      const langSelect = page.getByTestId('settings-language-select');
      await expect(langSelect).toHaveValue('auto');
      await langSelect.selectOption('es');

      await expect(page.locator('html')).toHaveAttribute('lang', 'es');
      await expect(page.locator('h2')).toHaveText('Ajustes y Catálogo');
    });
  });

  test.describe('Spanish device locale (es-MX)', () => {
    test.use({ locale: 'es-MX' });

    test('renders UI in Spanish automatically', async ({ page }) => {
      await page.goto('/#/');
      await clearDatabase(page);
      await page.reload();

      await expect(page.locator('html')).toHaveAttribute('lang', 'es');
      await expect(page.getByTestId('home-start-session-btn')).toContainText('Iniciar nueva sesión de conteo');
    });
  });
});
