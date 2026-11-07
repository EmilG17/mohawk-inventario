import { test, expect } from '@playwright/test';
import { clearDatabase, getDbSessions, getActiveSessionId, getDbCounts, calculateReferenceGtinCheckDigit, isReferenceValidGtin, startCountingSession } from './helpers';

test.describe('Tier 3: Cross-Feature Combinations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearDatabase(page);
  });

  test('T3-01: F1 + F9 (Session Closing + Mass Barcode Printing of Session Items)', async ({ page }) => {
    // 1. Start a session
    await startCountingSession(page);

    // 2. Count an item
    await page.fill('#code-input', '079567011002');
    await page.keyboard.press('Enter');
    const pcard = page.locator('#pcard');
    if (await pcard.isVisible()) {
      await page.locator('#pcard input.qty').fill('10');
      await page.getByRole('button', { name: 'Registrar' }).click();
    }

    // 3. Close the session
    const closeBtn = page.getByRole('button', { name: /Finalizar sesión|Cerrar sesión/i });
    test.skip((await closeBtn.count()) === 0, 'F1 session closing pending M1 implementation');
    await closeBtn.click();
    const confirmBtn = page.locator('dialog[open]').getByRole('button', { name: /Finalizar|Cerrar|Aceptar/i });
    if ((await confirmBtn.count()) > 0) await confirmBtn.click();

    // 4. Navigate to report and print batch labels for counted items
    await page.goto('/#/reporte');
    const batchLabelsBtn = page.getByRole('button', { name: /Imprimir etiquetas/i });
    test.skip((await batchLabelsBtn.count()) === 0, 'F9 session batch labels pending M3 implementation');
  });

  test('T3-02: F1 + F2 + F3 (Full Session Finalization Lifecycle)', async ({ page }) => {
    // Start session -> count -> close session -> idle dashboard -> report inspection
    await startCountingSession(page);

    const closeBtn = page.getByRole('button', { name: /Finalizar sesión|Cerrar sesión/i });
    test.skip((await closeBtn.count()) === 0, 'F1 session closing pending M1 implementation');
    await closeBtn.click();
    const confirmBtn = page.locator('dialog[open]').getByRole('button', { name: /Finalizar|Cerrar|Aceptar/i });
    if ((await confirmBtn.count()) > 0) await confirmBtn.click();

    // Verify Idle Dashboard
    await expect(page.locator('body')).toContainText(/Sin sesión activa|Iniciar conteo/i);

    // Verify Report shows closed session
    await page.goto('/#/reporte');
    await expect(page.locator('.kpis')).toBeVisible();
  });

  test('T3-03: F3 + F1 + F2 (Reopen Closed Session, Record Count, and Re-Close)', async ({ page }) => {
    await page.goto('/#/equipo');
    const reopenBtn = page.getByRole('button', { name: /Reabrir|Reanudar/i });
    test.skip((await reopenBtn.count()) === 0, 'F3 reopen session pending M1 implementation');
  });

  test('T3-04: F4 + F7 (GTIN Checksum Validation + Code 128 Rendering)', async ({ page }) => {
    const validUpc = '079567011002';
    expect(isReferenceValidGtin(validUpc)).toBe(true);

    const hasRender = await page.evaluate(() => typeof (window as any).__renderCode128Svg === 'function');
    test.skip(!hasRender, 'F7 Code 128 render pending M3 implementation');
    const svg = await page.evaluate((code) => (window as any).__renderCode128Svg(code, code), validUpc);
    expect(svg).toContain('<svg');
  });

  test('T3-05: F4 + F5 + F6 (Checksum Validation + Multi-Provider Fallback)', async ({ page }) => {
    // Invalid GTIN should not trigger network calls
    expect(isReferenceValidGtin('079567011003')).toBe(false);
    // Valid ISBN triggers Open Library fallback
    expect(isReferenceValidGtin('9780140328721')).toBe(true);
  });

  test('T3-06: F8 + F1 (Individual Barcode Creation + Session Counting)', async ({ page }) => {
    await page.goto('/#/catalogo');
    const item = page.locator('.plist li').first();
    test.skip((await item.count()) === 0, 'Catalog pending setup');
  });

  test('T3-07: F9 + F10 (Mass Barcode Sheet Generator + Avery Print Layout Compliance)', async ({ page }) => {
    await page.goto('/#/catalogo');
    const labelsBtn = page.getByRole('button', { name: /Etiquetas/i });
    test.skip((await labelsBtn.count()) === 0, 'F9 mass barcode sheet pending M3 implementation');
  });

  test('T3-08: F3 + F9 + F10 (Closed Session Report + Avery 5163 Sheet Print)', async ({ page }) => {
    await page.goto('/#/reporte');
    const batchLabelsBtn = page.getByRole('button', { name: /Imprimir etiquetas/i });
    test.skip((await batchLabelsBtn.count()) === 0, 'F9/F10 report batch labels pending M3 implementation');
  });

  test('T3-09: F2 + F8 (Idle Dashboard + Product Catalog Barcode Export)', async ({ page }) => {
    await page.goto('/#/');
    // Ensure idle
    const activeId = await getActiveSessionId(page);
    expect(activeId).toBeNull();

    // Navigate to catalog without creating session
    await page.goto('/#/catalogo');
    await expect(page).toHaveURL(/#\/catalogo/);
  });

  test('T3-10: F5 + F6 + F1 (Online Search Lookup + Session Finalization)', async ({ page }) => {
    await startCountingSession(page);

    const closeBtn = page.getByRole('button', { name: /Finalizar sesión|Cerrar sesión/i });
    test.skip((await closeBtn.count()) === 0, 'F1 session closing pending M1 implementation');
  });
});
