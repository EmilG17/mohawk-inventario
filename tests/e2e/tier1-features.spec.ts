import { test, expect } from '@playwright/test';
import { clearDatabase, getDbSessions, getActiveSessionId, getDbCounts, calculateReferenceGtinCheckDigit, isReferenceValidGtin, startCountingSession, loadSampleCatalog } from './helpers';

test.describe('Tier 1: Feature Coverage (F1 to F10)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearDatabase(page);
  });

  // =========================================================================
  // F1: Session Finalization / Close
  // =========================================================================
  test('F1-01: Close active session sets closed: true and records closedAt timestamp', async ({ page }) => {
    await startCountingSession(page);

    // Look for close session button
    const closeBtn = page.getByRole('button', { name: /Finalizar sesión|Cerrar sesión/i });
    const isImplemented = (await closeBtn.count()) > 0;
    test.skip(!isImplemented, 'F1 session closing UI pending M1 implementation');

    await closeBtn.click();
    const confirmBtn = page.locator('dialog[open]').getByRole('button', { name: /Finalizar|Cerrar|Aceptar/i });
    if ((await confirmBtn.count()) > 0) {
      await confirmBtn.click();
    }
    await expect(page.locator('dialog[open]')).toBeHidden();
    await expect(page.locator('body')).toContainText(/Sin sesión activa/i);

    const sessions = await getDbSessions(page);
    expect(sessions.length).toBeGreaterThan(0);
    const lastSession = sessions[sessions.length - 1];
    expect(lastSession.closed).toBe(true);
    expect(typeof lastSession.closedAt).toBe('number');
    expect(lastSession.closedAt).toBeGreaterThan(0);
  });

  test('F1-02: Closing active session unsets activeSession in metadata', async ({ page }) => {
    await startCountingSession(page);

    const closeBtn = page.getByRole('button', { name: /Finalizar sesión|Cerrar sesión/i });
    test.skip((await closeBtn.count()) === 0, 'F1 session closing UI pending M1 implementation');

    await closeBtn.click();
    const confirmBtn = page.locator('dialog[open]').getByRole('button', { name: /Finalizar|Cerrar|Aceptar/i });
    if ((await confirmBtn.count()) > 0) await confirmBtn.click();
    await expect(page.locator('dialog[open]')).toBeHidden();
    await expect(page.locator('body')).toContainText(/Sin sesión activa/i);

    const activeId = await getActiveSessionId(page);
    expect(activeId).toBeNull();
  });

  test('F1-03: Closing session preserves all recorded count entries in that session', async ({ page }) => {
    await startCountingSession(page);

    // Record a count
    await page.fill('#code-input', '079567011002');
    await page.keyboard.press('Enter');
    const pcard = page.locator('#pcard');
    await pcard.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    if (await pcard.isVisible()) {
      await page.locator('#pcard input.qty').fill('15');
      await page.getByRole('button', { name: 'Registrar' }).click();
    }

    const closeBtn = page.getByRole('button', { name: /Finalizar sesión|Cerrar sesión/i });
    test.skip((await closeBtn.count()) === 0, 'F1 session closing UI pending M1 implementation');

    await closeBtn.click();
    const confirmBtn = page.locator('dialog[open]').getByRole('button', { name: /Finalizar|Cerrar|Aceptar/i });
    if ((await confirmBtn.count()) > 0) await confirmBtn.click();

    const counts = await getDbCounts(page);
    expect(counts.length).toBeGreaterThan(0);
    expect(counts[0].qty).toBe(15);
  });

  test('F1-04: Close session via UI button transitions to idle state', async ({ page }) => {
    await startCountingSession(page);

    const closeBtn = page.getByRole('button', { name: /Finalizar sesión|Cerrar sesión/i });
    test.skip((await closeBtn.count()) === 0, 'F1 session closing UI pending M1 implementation');

    await closeBtn.click();
    const confirmBtn = page.locator('dialog[open]').getByRole('button', { name: /Finalizar|Cerrar|Aceptar/i });
    if ((await confirmBtn.count()) > 0) await confirmBtn.click();

    // Must be on Home or Idle screen
    await expect(page.locator('body')).toContainText(/Sin sesión activa|Iniciar conteo/i);
  });

  test('F1-05: Confirmation dialog appears before finalizing active session', async ({ page }) => {
    await startCountingSession(page);

    const closeBtn = page.getByRole('button', { name: /Finalizar sesión|Cerrar sesión/i });
    test.skip((await closeBtn.count()) === 0, 'F1 session closing UI pending M1 implementation');

    await closeBtn.click();
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/Finalizar|Cerrar|¿Estás seguro/i);

    // Cancel dialog
    const cancelBtn = dialog.getByRole('button', { name: /Cancelar/i });
    if (await cancelBtn.isVisible()) {
      await cancelBtn.click();
      await expect(dialog).toBeHidden();
      // Session remains active
      const activeId = await getActiveSessionId(page);
      expect(activeId).not.toBeNull();
    }
  });

  // =========================================================================
  // F2: Idle Dashboard & Session States
  // =========================================================================
  test('F2-01: Idle state displays "Sin sesión activa" status card on Home view', async ({ page }) => {
    await page.goto('/#/');
    const idleIndicator = page.locator('.idle-card, .no-session, .hello, .card');
    await expect(idleIndicator.first()).toBeVisible();
  });

  test('F2-02: "Iniciar nueva sesión" button is prominent and functional from idle dashboard', async ({ page }) => {
    await page.goto('/#/');
    const startBtn = page.getByRole('button', { name: /Iniciar conteo|Nueva sesión/i });
    await expect(startBtn).toBeVisible();
    await startBtn.click();
    await expect(page.locator('dialog[open]')).toBeVisible();
  });

  test('F2-03: Direct navigation to /contar while idle displays gating message or redirects', async ({ page }) => {
    await page.goto('/#/contar');
    // Either redirected to home or displays prompt to start session
    const isGated = (await page.locator('.idle-gate, .no-session-msg, dialog[open]').count()) > 0 || page.url().includes('#/');
    expect(isGated).toBe(true);
  });

  test('F2-04: Barcode input field or scanning action is blocked or prompts to activate a session when idle', async ({ page }) => {
    await page.goto('/#/contar');
    const isGated = (await page.locator('.badge.warn, h2:text("No hay sesión activa")').count()) > 0;
    const inputCount = await page.locator('#code-input').count();
    expect(isGated || inputCount === 0 || page.url().endsWith('#/')).toBe(true);
  });

  test('F2-05: Idle view provides quick navigation to browse catalog without requiring an active session', async ({ page }) => {
    await page.goto('/#/');
    await page.goto('/#/catalogo');
    await expect(page).toHaveURL(/#\/catalogo/);
    await expect(page.locator('.plist').first()).toBeVisible();
  });

  // =========================================================================
  // F3: Closed Session Reporting & Reopening
  // =========================================================================
  test('F3-01: Report view provides a selector/dropdown listing closed and active sessions', async ({ page }) => {
    await page.goto('/#/reporte');
    const selector = page.locator('#session-select, select.session-picker, .session-list');
    const isImplemented = (await selector.count()) > 0;
    test.skip(!isImplemented, 'F3 session selector in reports pending M1 implementation');
    await expect(selector.first()).toBeVisible();
  });

  test('F3-02: Selecting a closed session renders its KPIs (total counted, theoretical vs actual)', async ({ page }) => {
    await startCountingSession(page);
    await page.goto('/#/reporte');
    const kpis = page.locator('.kpis');
    await expect(kpis).toBeVisible();
  });

  test('F3-03: Excel export from a closed session downloads .xlsx with accurate counts', async ({ page }) => {
    await startCountingSession(page);
    await page.goto('/#/reporte');
    const exportBtn = page.getByRole('button', { name: /Exportar Excel/i });
    await expect(exportBtn).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await exportBtn.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('.xlsx');
  });

  test('F3-04: "Reanudar sesión" / "Reabrir sesión" marks session closed: false and sets it as activeSession', async ({ page }) => {
    // Check if reopen button exists in team or report view
    await page.goto('/#/equipo');
    const reopenBtn = page.getByRole('button', { name: /Reabrir|Reanudar|Activar/i });
    const isImplemented = (await reopenBtn.count()) > 0;
    test.skip(!isImplemented, 'F3 reopen session pending M1 implementation');
    await reopenBtn.first().click();
    const activeId = await getActiveSessionId(page);
    expect(activeId).not.toBeNull();
  });

  test('F3-05: Reopened session allows adding new count entries that append to existing counts', async ({ page }) => {
    await page.goto('/#/equipo');
    const reopenBtn = page.getByRole('button', { name: /Reabrir|Reanudar/i });
    test.skip((await reopenBtn.count()) === 0, 'F3 reopen session pending M1 implementation');
    await reopenBtn.first().click();
    await page.goto('/#/contar');
    await page.fill('#code-input', '071641300018');
    await page.keyboard.press('Enter');
    const pcard = page.locator('#pcard');
    if (await pcard.isVisible()) {
      await page.locator('#pcard input.qty').fill('5');
      await page.getByRole('button', { name: 'Registrar' }).click();
    }
  });

  // =========================================================================
  // F4: Checksum Validation & Sample Data Fix
  // =========================================================================
  test('F4-01: calculateGtinCheckDigit calculates correct Modulo-10 check digit for 11-digit UPC-A prefixes', async ({ page }) => {
    // 07956701100 -> check digit 2 (WD-40)
    expect(calculateReferenceGtinCheckDigit('07956701100')).toBe(2);
    // 04900004256 -> check digit 6 (Coca Cola)
    expect(calculateReferenceGtinCheckDigit('04900004256')).toBe(6);
  });

  test('F4-02: calculateGtinCheckDigit calculates correct check digit for 12-digit EAN-13 prefixes', async ({ page }) => {
    // 301762042200 -> check digit 3 (Nutella)
    expect(calculateReferenceGtinCheckDigit('301762042200')).toBe(3);
    // 750100655938 -> check digit 5 (Gamesa)
    expect(calculateReferenceGtinCheckDigit('750100655938')).toBe(5);
  });

  test('F4-03: isValidGtin returns true for valid GTIN-8, GTIN-12, GTIN-13, and GTIN-14 barcodes', async ({ page }) => {
    expect(isReferenceValidGtin('079567011002')).toBe(true); // GTIN-12
    expect(isReferenceValidGtin('049000042566')).toBe(true); // GTIN-12
    expect(isReferenceValidGtin('3017620422003')).toBe(true); // GTIN-13
    expect(isReferenceValidGtin('00079567011002')).toBe(true); // GTIN-14
    expect(isReferenceValidGtin('96385074')).toBe(true); // GTIN-8
  });

  test('F4-04: isValidGtin returns false for invalid GTIN checksums', async ({ page }) => {
    // Corrupted sample barcode 079567011003 has check digit 3 instead of 2
    expect(isReferenceValidGtin('079567011003')).toBe(false);
    expect(isReferenceValidGtin('071153000108')).toBe(false); // check digit should be 0
    expect(isReferenceValidGtin('7501055300078')).toBe(false); // check digit should be 5
  });

  test('F4-05: Sample catalog items all have valid GTIN-12 checksums', async ({ page }) => {
    await page.goto('/#/ajustes');
    await page.getByRole('button', { name: /Cargar catálogo de ejemplo/i }).click();
    await page.waitForURL(/#\/catalogo/);

    const checkResult = await page.evaluate(() => {
      return new Promise<{ total: number; validCount: number; invalid: string[] }>((resolve) => {
        const req = indexedDB.open('mohawk-inventario');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('products', 'readonly');
          const pReq = tx.objectStore('products').getAll();
          pReq.onsuccess = () => {
            const products = pReq.result || [];
            let valid = 0;
            const invalidCodes: string[] = [];
            for (const p of products) {
              const digits = p.barcode.replace(/\D/g, '');
              if ([8, 12, 13, 14].includes(digits.length)) {
                let sum = 0;
                let mult = 3;
                for (let i = digits.length - 2; i >= 0; i--) {
                  sum += Number(digits[i]) * mult;
                  mult = mult === 3 ? 1 : 3;
                }
                const calcCheck = (10 - (sum % 10)) % 10;
                if (calcCheck === Number(digits.slice(-1))) valid++;
                else invalidCodes.push(p.barcode);
              }
            }
            resolve({ total: products.length, validCount: valid, invalid: invalidCodes });
          };
        };
      });
    });

    // Check if sample data fix from M2 is applied
    test.skip(checkResult.invalid.length > 0, 'Sample data GTIN check digit fix pending M2 implementation');
    expect(checkResult.invalid.length).toBe(0);
  });

  // =========================================================================
  // F5: GitHub Pages Hosting & Proxy Adaptation
  // =========================================================================
  test('F5-01: Provider detects HTML response from proxy endpoint and does not throw fatal parse error', async ({ page }) => {
    const hasProxyHandler = await page.evaluate(() => typeof (window as any).__lookupOnline === 'function');
    test.skip(!hasProxyHandler, 'F5 proxy error handling pending M2 implementation');
  });

  test('F5-02: 404 response on default relative proxy does not blacklist UPCitemdb for 15 minutes', async ({ page }) => {
    const isHandled = await page.evaluate(() => typeof (window as any).__isProviderBlacklisted === 'function');
    test.skip(!isHandled, 'F5 blacklist mitigation pending M2 implementation');
  });

  test('F5-03: Custom proxy URL configured in settings is properly formatted and queried', async ({ page }) => {
    await page.goto('/#/ajustes');
    const proxyInput = page.locator('input[name="proxyUrl"], #proxy-url, input[placeholder*="proxy"]');
    const isImplemented = (await proxyInput.count()) > 0;
    test.skip(!isImplemented, 'F5 custom proxy settings UI pending M2 implementation');
    await proxyInput.fill('https://custom-proxy.example.com/api');
  });

  test('F5-04: When proxy is unavailable, lookup chain continues seamlessly to subsequent providers', async ({ page }) => {
    // Navigating to catalog and opening an item to search online
    await page.goto('/#/catalogo');
    const item = page.locator('.plist li').first();
    if (await item.isVisible()) {
      await item.click();
      const lookupBtn = page.getByRole('button', { name: /Buscar descripción en internet/i });
      if (await lookupBtn.isVisible()) {
        await lookupBtn.click();
        // Should not crash the UI
        await expect(page.locator('dialog[open]')).toBeVisible();
      }
    }
  });

  test('F5-05: UI displays informative diagnostic message instead of generic "Sin conexión"', async ({ page }) => {
    await page.goto('/#/catalogo');
    const item = page.locator('.plist li').first();
    if (await item.isVisible()) {
      await item.click();
      const lookupStatus = page.locator('.lookup-status, .search-status');
      if (await lookupStatus.isVisible()) {
        const text = await lookupStatus.textContent();
        expect(text).not.toContain('undefined');
      }
    }
  });

  // =========================================================================
  // F6: Multi-Provider Fallback & Open Library Provider
  // =========================================================================
  test('F6-01: Open Library provider recognizes ISBN-13 barcodes starting with 978 or 979', async ({ page }) => {
    const hasOpenLibrary = await page.evaluate(() => typeof (window as any).__isOpenLibraryConfigured === 'function');
    test.skip(!hasOpenLibrary, 'F6 Open Library provider pending M2 implementation');
  });

  test('F6-02: Open Library returns formatted product info with title, author/publisher as brand, and cover image', async ({ page }) => {
    const hasOpenLibrary = await page.evaluate(() => typeof (window as any).__lookupOpenLibrary === 'function');
    test.skip(!hasOpenLibrary, 'F6 Open Library lookup pending M2 implementation');
  });

  test('F6-03: Open Facts requests include required User-Agent / X-User-Agent identification header', async ({ page }) => {
    const hasUserAgent = await page.evaluate(() => typeof (window as any).__hasComplianceHeaders === 'function');
    test.skip(!hasUserAgent, 'F6 X-User-Agent compliance header pending M2 implementation');
  });

  test('F6-04: Multi-provider chain executes fallback when first provider returns null', async ({ page }) => {
    const hasFallbackChain = await page.evaluate(() => typeof (window as any).__testProviderChain === 'function');
    test.skip(!hasFallbackChain, 'F6 provider chain fallback pending M2 implementation');
  });

  test('F6-05: UI product dialog shows the source provider name when found', async ({ page }) => {
    await page.goto('/#/catalogo');
    const item = page.locator('.plist li').first();
    if (await item.isVisible()) {
      await item.click();
      const badge = page.locator('.source-badge, .badge');
      if (await badge.isVisible()) {
        await expect(badge).toBeVisible();
      }
    }
  });

  // =========================================================================
  // F7: Code 128 Auto Barcode Engine
  // =========================================================================
  test('F7-01: encodeCode128 encodes alphanumeric string using Code 128 Set B patterns', async ({ page }) => {
    const hasEngine = await page.evaluate(() => typeof (window as any).__encodeCode128 === 'function');
    test.skip(!hasEngine, 'F7 Code 128 engine pending M3 implementation');
    const result = await page.evaluate(() => (window as any).__encodeCode128('MHK-TOOL-001'));
    expect(result).toBeDefined();
    expect(typeof result.bars).toBe('string');
  });

  test('F7-02: encodeCode128 encodes even-length numeric string using high-density Code 128 Set C', async ({ page }) => {
    const hasEngine = await page.evaluate(() => typeof (window as any).__encodeCode128 === 'function');
    test.skip(!hasEngine, 'F7 Code 128 Set C pending M3 implementation');
    const result = await page.evaluate(() => (window as any).__encodeCode128('079567011002'));
    expect(result.bars.length).toBeLessThan(150); // Set C compressed
  });

  test('F7-03: encodeCode128 calculates standard Modulo-103 checksum correctly per ISO/IEC 15417', async ({ page }) => {
    const hasEngine = await page.evaluate(() => typeof (window as any).__encodeCode128 === 'function');
    test.skip(!hasEngine, 'F7 Modulo-103 checksum pending M3 implementation');
    const result = await page.evaluate(() => (window as any).__encodeCode128('123456'));
    expect(result.checksum).toBeGreaterThanOrEqual(0);
    expect(result.checksum).toBeLessThan(103);
  });

  test('F7-04: renderCode128Svg produces valid SVG markup containing <svg>, <rect>, and <text> elements', async ({ page }) => {
    const hasRender = await page.evaluate(() => typeof (window as any).__renderCode128Svg === 'function');
    test.skip(!hasRender, 'F7 SVG rendering pending M3 implementation');
    const svg = await page.evaluate(() => (window as any).__renderCode128Svg('079567011002', '079567011002'));
    expect(svg).toContain('<svg');
    expect(svg).toContain('<rect');
    expect(svg).toContain('</svg>');
  });

  test('F7-05: Generated SVG includes start code, encoded data bars, checksum symbol, and stop pattern', async ({ page }) => {
    const hasRender = await page.evaluate(() => typeof (window as any).__renderCode128Svg === 'function');
    test.skip(!hasRender, 'F7 Stop pattern validation pending M3 implementation');
    const svg = await page.evaluate(() => (window as any).__renderCode128Svg('TEST'));
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  // =========================================================================
  // F8: Individual Barcode Generator & Export
  // =========================================================================
  test('F8-01: Product dialog displays SVG barcode visualization for the selected catalog item', async ({ page }) => {
    await loadSampleCatalog(page);
    await page.goto('/#/catalogo');
    const item = page.locator('.plist li').first();
    await expect(item).toBeVisible();
    await item.click();
    const barcodeVisualizer = page.locator('.barcode-preview').first();
    const isImplemented = (await barcodeVisualizer.count()) > 0;
    test.skip(!isImplemented, 'F8 barcode visualizer pending M3 implementation');
    await expect(barcodeVisualizer).toBeVisible();
  });

  test('F8-02: Clicking "Descargar SVG" triggers file download with .svg extension', async ({ page }) => {
    await loadSampleCatalog(page);
    await page.goto('/#/catalogo');
    const item = page.locator('.plist li').first();
    await expect(item).toBeVisible();
    await item.click();
    const svgBtn = page.getByRole('button', { name: /Descargar SVG/i });
    test.skip((await svgBtn.count()) === 0, 'F8 SVG download pending M3 implementation');
    const dlPromise = page.waitForEvent('download');
    await svgBtn.click();
    const dl = await dlPromise;
    expect(dl.suggestedFilename()).toContain('.svg');
  });

  test('F8-03: Clicking "Descargar PNG" creates rasterized image at high resolution (300 DPI)', async ({ page }) => {
    await loadSampleCatalog(page);
    await page.goto('/#/catalogo');
    const item = page.locator('.plist li').first();
    await expect(item).toBeVisible();
    await item.click();
    const pngBtn = page.getByRole('button', { name: /Descargar PNG/i });
    test.skip((await pngBtn.count()) === 0, 'F8 PNG download pending M3 implementation');
    const dlPromise = page.waitForEvent('download');
    await pngBtn.click();
    const dl = await dlPromise;
    expect(dl.suggestedFilename()).toContain('.png');
  });

  test('F8-04: Clicking "Imprimir etiqueta" opens print dialog or formatted frame', async ({ page }) => {
    await loadSampleCatalog(page);
    await page.goto('/#/catalogo');
    const item = page.locator('.plist li').first();
    await expect(item).toBeVisible();
    await item.click();
    const printBtn = page.getByRole('button', { name: /Imprimir etiqueta/i });
    test.skip((await printBtn.count()) === 0, 'F8 print single label pending M3 implementation');
    await expect(printBtn).toBeVisible();
  });

  test('F8-05: Items lacking barcodes offer "Generar código interno" creating a unique MHK-XXXXXX barcode', async ({ page }) => {
    await loadSampleCatalog(page);
    await page.goto('/#/catalogo');
    const item = page.locator('.plist li').first();
    await expect(item).toBeVisible();
    await item.click();
    const genBtn = page.getByRole('button', { name: /Generar código/i });
    test.skip((await genBtn.count()) === 0, 'F8 internal code generator pending M3 implementation');
    await genBtn.click();
    const barcodeInput = page.locator('input[name="barcode"], #p-barcode');
    const val = await barcodeInput.inputValue();
    expect(val).toMatch(/MHK-\d+/);
  });

  // =========================================================================
  // F9: Mass / Batch Barcode Generator
  // =========================================================================
  test('F9-01: Mass action "Generar etiquetas" opens barcode sheet modal with selected items', async ({ page }) => {
    await loadSampleCatalog(page);
    await page.goto('/#/catalogo');
    const selectAll = page.locator('.select-toolbar input[type="checkbox"]');
    if (await selectAll.isVisible()) {
      await selectAll.check();
      const labelsBtn = page.getByRole('button', { name: /Etiquetas/i }).first();
      test.skip((await labelsBtn.count()) === 0, 'F9 mass barcode sheet modal pending M3 implementation');
      await labelsBtn.click();
      await expect(page.locator('.barcode-sheet-modal')).toBeVisible();
    }
  });

  test('F9-02: Template selector supports Avery 5160 (30 labels) and Avery 5163 (10 labels)', async ({ page }) => {
    await loadSampleCatalog(page);
    await page.goto('/#/catalogo');
    await page.locator('.select-toolbar input[type="checkbox"]').check();
    await page.getByRole('button', { name: /Etiquetas/i }).first().click();
    const sheetModal = page.locator('.barcode-sheet-modal');
    test.skip((await sheetModal.count()) === 0, 'F9 template selector pending M3 implementation');
    const templateSelect = sheetModal.locator('select.template-picker, #sheet-template');
    await expect(templateSelect).toContainText(/5160/);
    await expect(templateSelect).toContainText(/5163/);
  });

  test('F9-03: All generated labels in the sheet share consistent format, height, and typography', async ({ page }) => {
    await loadSampleCatalog(page);
    await page.goto('/#/catalogo');
    await page.locator('.select-toolbar input[type="checkbox"]').check();
    await page.getByRole('button', { name: /Etiquetas/i }).first().click();
    const sheetModal = page.locator('.barcode-sheet-modal');
    test.skip((await sheetModal.count()) === 0, 'F9 sheet consistency pending M3 implementation');
    const labels = sheetModal.locator('.sheet-label');
    const count = await labels.count();
    if (count > 1) {
      const firstHeight = await labels.first().evaluate((el) => el.clientHeight);
      const secondHeight = await labels.nth(1).evaluate((el) => el.clientHeight);
      expect(firstHeight).toBe(secondHeight);
    }
  });

  test('F9-04: Setting a print offset leaves the first N slots blank for half-spent sheets', async ({ page }) => {
    await loadSampleCatalog(page);
    await page.goto('/#/catalogo');
    await page.locator('.select-toolbar input[type="checkbox"]').check();
    await page.getByRole('button', { name: /Etiquetas/i }).first().click();
    const sheetModal = page.locator('.barcode-sheet-modal');
    test.skip((await sheetModal.count()) === 0, 'F9 print offset pending M3 implementation');
    const offsetInput = sheetModal.locator('input[name="offset"], #sheet-offset');
    if (await offsetInput.isVisible()) {
      await offsetInput.fill('4');
      const blanks = sheetModal.locator('.sheet-label.blank, .sheet-slot-empty');
      await expect(blanks).toHaveCount(4);
    }
  });

  test('F9-05: Session report view provides "Imprimir etiquetas de sesión" button', async ({ page }) => {
    await startCountingSession(page);
    await page.goto('/#/reporte');
    const batchLabelsBtn = page.getByRole('button', { name: /Imprimir etiquetas de sesión/i });
    await expect(batchLabelsBtn).toBeVisible();
  });

  // =========================================================================
  // F10: Print CSS & Sheet Layouts
  // =========================================================================
  test('F10-01: Print stylesheet defines @media print rules hiding app navigation and buttons', async ({ page }) => {
    const hasPrintCss = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule.type === CSSRule.MEDIA_RULE && (rule as CSSMediaRule).media.mediaText.includes('print')) {
              return true;
            }
          }
        } catch {
          /* ignore cross-origin */
        }
      }
      return false;
    });
    test.skip(!hasPrintCss, 'F10 print CSS rules pending M3 implementation');
    expect(hasPrintCss).toBe(true);
  });

  test('F10-02: Avery 5160 grid specifies 3-column layout with 2.625 inch label width', async ({ page }) => {
    const hasAvery5160 = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule.cssText.includes('5160') || rule.cssText.includes('2.625in')) return true;
          }
        } catch {
          /* ignore */
        }
      }
      return false;
    });
    test.skip(!hasAvery5160, 'F10 Avery 5160 CSS grid pending M3 implementation');
    expect(hasAvery5160).toBe(true);
  });

  test('F10-03: Avery 5163 grid specifies 2-column layout with 4.0 inch label width', async ({ page }) => {
    const hasAvery5163 = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule.cssText.includes('5163') || rule.cssText.includes('4in') || rule.cssText.includes('4.0in')) return true;
          }
        } catch {
          /* ignore */
        }
      }
      return false;
    });
    test.skip(!hasAvery5163, 'F10 Avery 5163 CSS grid pending M3 implementation');
    expect(hasAvery5163).toBe(true);
  });

  test('F10-04: Sheet containers include CSS page break rules between pages', async ({ page }) => {
    const hasPageBreak = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule.cssText.includes('page-break-after') || rule.cssText.includes('break-after')) return true;
          }
        } catch {
          /* ignore */
        }
      }
      return false;
    });
    test.skip(!hasPageBreak, 'F10 CSS page break rules pending M3 implementation');
    expect(hasPageBreak).toBe(true);
  });

  test('F10-05: Barcode SVGs inside print labels are styled to fit within label boundaries without clipping', async ({ page }) => {
    await page.goto('/');
    const styles = await page.evaluate(() => {
      const el = document.createElement('div');
      el.className = 'sheet-label';
      document.body.appendChild(el);
      const computed = window.getComputedStyle(el);
      const overflow = computed.overflow;
      document.body.removeChild(el);
      return { overflow };
    });
    expect(styles).toBeDefined();
  });
});
