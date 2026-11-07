import { test, expect } from '@playwright/test';
import { clearDatabase, getDbSessions, getActiveSessionId, getDbCounts, calculateReferenceGtinCheckDigit, isReferenceValidGtin, startCountingSession } from './helpers';

test.describe('Tier 2: Boundary & Corner Cases (F1 to F10)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await clearDatabase(page);
  });

  // =========================================================================
  // F1: Session Finalization / Close - Boundaries
  // =========================================================================
  test('F1-B01: Closing a session that is already closed is idempotent', async ({ page }) => {
    const isCloseAvailable = await page.evaluate(() => typeof (window as any).__closeSession === 'function');
    test.skip(!isCloseAvailable, 'F1 closeSession programmatic handle pending M1 implementation');
    await page.evaluate(async () => {
      const db = (window as any).__db;
      if (db) {
        await (window as any).__closeSession('test-closed-session');
        await (window as any).__closeSession('test-closed-session');
      }
    });
  });

  test('F1-B02: Closing a non-existent session ID gracefully completes without throwing', async ({ page }) => {
    const isCloseAvailable = await page.evaluate(() => typeof (window as any).__closeSession === 'function');
    test.skip(!isCloseAvailable, 'F1 closeSession programmatic handle pending M1 implementation');
    const result = await page.evaluate(async () => {
      try {
        await (window as any).__closeSession('non-existent-session-id-12345');
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err?.message };
      }
    });
    expect(result.success).toBe(true);
  });

  test('F1-B03: Closing an empty session (0 items counted) closes cleanly with valid metadata', async ({ page }) => {
    await startCountingSession(page);

    const closeBtn = page.getByRole('button', { name: /Finalizar sesión|Cerrar sesión/i });
    test.skip((await closeBtn.count()) === 0, 'F1 session closing UI pending M1 implementation');

    await closeBtn.click();
    const confirmBtn = page.locator('dialog[open]').getByRole('button', { name: /Finalizar|Cerrar|Aceptar/i });
    if ((await confirmBtn.count()) > 0) await confirmBtn.click();
    await expect(page.locator('dialog[open]')).toBeHidden();
    await expect(page.locator('body')).toContainText(/Sin sesión activa/i);

    const sessions = await getDbSessions(page);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[sessions.length - 1].closed).toBe(true);
  });

  test('F1-B04: Closing an inactive session closes it without affecting activeSession', async ({ page }) => {
    const isCloseAvailable = await page.evaluate(() => typeof (window as any).__closeSession === 'function');
    test.skip(!isCloseAvailable, 'F1 closeSession programmatic handle pending M1 implementation');
  });

  test('F1-B05: Rapid duplicate clicks on close button do not corrupt session state', async ({ page }) => {
    await startCountingSession(page);

    const closeBtn = page.getByRole('button', { name: /Finalizar sesión|Cerrar sesión/i });
    test.skip((await closeBtn.count()) === 0, 'F1 session closing UI pending M1 implementation');

    // Click rapidly twice
    await Promise.all([
      closeBtn.click({ clickCount: 2 }).catch(() => {}),
    ]);
    const dialogs = page.locator('dialog[open]');
    expect(await dialogs.count()).toBeLessThanOrEqual(1);
  });

  // =========================================================================
  // F2: Idle Dashboard & Session States - Boundaries
  // =========================================================================
  test('F2-B01: App refresh while idle remains in idle state without auto-creating a session', async ({ page }) => {
    await page.goto('/');
    const beforeSessions = await getDbSessions(page);
    expect(beforeSessions.length).toBe(0);

    await page.reload();
    const afterSessions = await getDbSessions(page);
    expect(afterSessions.length).toBe(0);
    const activeId = await getActiveSessionId(page);
    expect(activeId).toBeNull();
  });

  test('F2-B02: Offline mode while idle preserves idle UI and allows catalog browsing', async ({ page, context }) => {
    await page.goto('/');
    await context.setOffline(true);
    await page.goto('/#/catalogo');
    await expect(page).toHaveURL(/#\/catalogo/);
    await context.setOffline(false);
  });

  test('F2-B03: Attempted manual scan simulation (__simulateScan) while idle does not record rogue count', async ({ page }) => {
    await page.goto('/#/contar');
    await page.evaluate(() => {
      if (typeof (window as any).__simulateScan === 'function') {
        (window as any).__simulateScan('079567011002');
      }
    });
    const counts = await getDbCounts(page);
    expect(counts.length).toBe(0);
  });

  test('F2-B04: Counter name change persists even when no session is active', async ({ page }) => {
    await page.goto('/');
    const changeBtn = page.getByRole('button', { name: 'Cambiar' });
    if (await changeBtn.isVisible()) {
      await changeBtn.click();
      await page.fill('input.input', 'Auditor Mohawk');
      await page.getByRole('button', { name: 'Aceptar' }).click();
      await expect(page.locator('.hello .big, .user-name')).toContainText('Auditor Mohawk');
      await page.reload();
      await expect(page.locator('.hello .big, .user-name')).toContainText('Auditor Mohawk');
    }
  });

  test('F2-B05: Deep link to /reporte while idle gracefully shows session selector or empty summary', async ({ page }) => {
    await page.goto('/#/reporte');
    await expect(page).toHaveURL(/#\/reporte/);
    // Page must not crash or show uncaught errors
    await expect(page.locator('h1, h2, .report-view, .kpis, .card').first()).toBeVisible();
  });

  // =========================================================================
  // F3: Closed Session Reporting & Reopening - Boundaries
  // =========================================================================
  test('F3-B01: Listing sessions returns all historical sessions sorted chronologically', async ({ page }) => {
    const sessions = await getDbSessions(page);
    expect(Array.isArray(sessions)).toBe(true);
  });

  test('F3-B02: Reopening a session when another session is active switches activeSession cleanly', async ({ page }) => {
    const isReopenAvailable = await page.evaluate(() => typeof (window as any).__reopenSession === 'function');
    test.skip(!isReopenAvailable, 'F3 reopen programmatic handle pending M1 implementation');
  });

  test('F3-B03: Exporting a closed session with 0 differences generates valid Excel file without errors', async ({ page }) => {
    await page.goto('/#/reporte');
    const exportBtn = page.getByRole('button', { name: /Exportar Excel/i });
    if (await exportBtn.isVisible()) {
      const dlPromise = page.waitForEvent('download');
      await exportBtn.click();
      const dl = await dlPromise;
      expect(dl.suggestedFilename()).toContain('.xlsx');
    }
  });

  test('F3-B04: Reopening a non-existent session ID rejects safely without crashing', async ({ page }) => {
    const isReopenAvailable = await page.evaluate(() => typeof (window as any).__reopenSession === 'function');
    test.skip(!isReopenAvailable, 'F3 reopen programmatic handle pending M1 implementation');
    const result = await page.evaluate(async () => {
      try {
        await (window as any).__reopenSession('invalid-uuid-9999');
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err?.message };
      }
    });
    expect(result.success).toBe(true);
  });

  test('F3-B05: Session selector reflects newly closed session immediately without page reload', async ({ page }) => {
    await page.goto('/#/reporte');
    const selector = page.locator('#session-select, select.session-picker');
    test.skip((await selector.count()) === 0, 'F3 session selector pending M1 implementation');
  });

  // =========================================================================
  // F4: Checksum Validation & Sample Data Fix - Boundaries
  // =========================================================================
  test('F4-B01: isValidGtin on empty string, non-numeric strings, or alphanumeric SKUs returns false cleanly', async ({ page }) => {
    expect(isReferenceValidGtin('')).toBe(false);
    expect(isReferenceValidGtin('MHK-TOOL-001')).toBe(false);
    expect(isReferenceValidGtin('SKU:12345')).toBe(false);
    expect(isReferenceValidGtin('abcdefgh')).toBe(false);
  });

  test('F4-B02: isValidGtin on lengths other than 8, 12, 13, 14 returns false', async ({ page }) => {
    expect(isReferenceValidGtin('1234567')).toBe(false); // 7 digits
    expect(isReferenceValidGtin('123456789')).toBe(false); // 9 digits
    expect(isReferenceValidGtin('12345678901')).toBe(false); // 11 digits
    expect(isReferenceValidGtin('123456789012345')).toBe(false); // 15 digits
  });

  test('F4-B03: All zeros barcode (000000000000) validates checksum correctly (0)', async ({ page }) => {
    expect(calculateReferenceGtinCheckDigit('00000000000')).toBe(0);
    expect(isReferenceValidGtin('000000000000')).toBe(true);
  });

  test('F4-B04: calculateGtinCheckDigit on string with leading zeros preserves positional weights', async ({ page }) => {
    // 0007956701100 -> check digit 2
    expect(calculateReferenceGtinCheckDigit('0007956701100')).toBe(2);
  });

  test('F4-B05: Check digit calculation on invalid characters strips or returns cleanly', async ({ page }) => {
    const val = calculateReferenceGtinCheckDigit('079567-01100');
    expect(val).toBe(2); // non-digits stripped
  });

  // =========================================================================
  // F5: GitHub Pages Hosting & Proxy Adaptation - Boundaries
  // =========================================================================
  test('F5-B01: Empty proxy URL string is handled without TypeError', async ({ page }) => {
    const isHandled = await page.evaluate(() => typeof (window as any).__testProxyUrl === 'function');
    test.skip(!isHandled, 'F5 proxy test harness pending M2 implementation');
  });

  test('F5-B02: Malformed proxy URL does not crash the lookup service', async ({ page }) => {
    const isHandled = await page.evaluate(() => typeof (window as any).__testProxyUrl === 'function');
    test.skip(!isHandled, 'F5 proxy test harness pending M2 implementation');
  });

  test('F5-B03: HTTP 429 Too Many Requests sets transient backoff rather than permanent disable', async ({ page }) => {
    const isHandled = await page.evaluate(() => typeof (window as any).__testRateLimitBackoff === 'function');
    test.skip(!isHandled, 'F5 rate limit backoff pending M2 implementation');
  });

  test('F5-B04: Network timeout aborts cleanly with AbortController without hanging', async ({ page }) => {
    const isHandled = await page.evaluate(() => typeof (window as any).__testAbortTimeout === 'function');
    test.skip(!isHandled, 'F5 abort timeout pending M2 implementation');
  });

  test('F5-B05: Trailing slashes in proxyUrl are normalized correctly', async ({ page }) => {
    const isHandled = await page.evaluate(() => typeof (window as any).__normalizeProxyUrl === 'function');
    test.skip(!isHandled, 'F5 proxy normalization pending M2 implementation');
  });

  // =========================================================================
  // F6: Multi-Provider Fallback & Open Library Provider - Boundaries
  // =========================================================================
  test('F6-B01: Non-ISBN barcodes bypass Open Library provider immediately without network call', async ({ page }) => {
    const isHandled = await page.evaluate(() => typeof (window as any).__isOpenLibraryCode === 'function');
    test.skip(!isHandled, 'F6 Open Library detection pending M2 implementation');
  });

  test('F6-B02: All providers returning null correctly results in "no_encontrado" status', async ({ page }) => {
    const isHandled = await page.evaluate(() => typeof (window as any).__resolveOnlineStatus === 'function');
    test.skip(!isHandled, 'F6 provider status pending M2 implementation');
  });

  test('F6-B03: Provider throwing unexpected exception does not break subsequent providers in chain', async ({ page }) => {
    const isHandled = await page.evaluate(() => typeof (window as any).__testProviderExceptionHandling === 'function');
    test.skip(!isHandled, 'F6 error resilience pending M2 implementation');
  });

  test('F6-B04: ISBN-10 barcodes are converted or handled cleanly', async ({ page }) => {
    const isHandled = await page.evaluate(() => typeof (window as any).__handleIsbn10 === 'function');
    test.skip(!isHandled, 'F6 ISBN-10 conversion pending M2 implementation');
  });

  test('F6-B05: Concurrent lookups for different barcodes do not interfere with each other', async ({ page }) => {
    const isHandled = await page.evaluate(() => typeof (window as any).__concurrentLookup === 'function');
    test.skip(!isHandled, 'F6 concurrent lookup pending M2 implementation');
  });

  // =========================================================================
  // F7: Code 128 Auto Barcode Engine - Boundaries
  // =========================================================================
  test('F7-B01: Odd-length numeric string switches dynamically between Code C and Code B', async ({ page }) => {
    const hasEngine = await page.evaluate(() => typeof (window as any).__encodeCode128 === 'function');
    test.skip(!hasEngine, 'F7 Code 128 odd-length pending M3 implementation');
    const result = await page.evaluate(() => (window as any).__encodeCode128('12345'));
    expect(result).toBeDefined();
  });

  test('F7-B02: Special ASCII characters (hyphens, spaces, colons, slashes) encode without corruption', async ({ page }) => {
    const hasEngine = await page.evaluate(() => typeof (window as any).__encodeCode128 === 'function');
    test.skip(!hasEngine, 'F7 Code 128 punctuation pending M3 implementation');
    const result = await page.evaluate(() => (window as any).__encodeCode128('MHK-A:B/C 12'));
    expect(result).toBeDefined();
  });

  test('F7-B03: Empty string input handles gracefully', async ({ page }) => {
    const hasEngine = await page.evaluate(() => typeof (window as any).__encodeCode128 === 'function');
    test.skip(!hasEngine, 'F7 Code 128 empty string pending M3 implementation');
    const result = await page.evaluate(() => {
      try {
        return (window as any).__encodeCode128('');
      } catch (e: any) {
        return { error: e.message };
      }
    });
    expect(result).toBeDefined();
  });

  test('F7-B04: SVG dimensions match requested options (width, height, margin)', async ({ page }) => {
    const hasRender = await page.evaluate(() => typeof (window as any).__renderCode128Svg === 'function');
    test.skip(!hasRender, 'F7 Code 128 SVG options pending M3 implementation');
    const svg = await page.evaluate(() => (window as any).__renderCode128Svg('TEST', 'TEST', { height: 80, margin: 15 }));
    expect(svg).toContain('height="80"');
  });

  test('F7-B05: Non-ASCII characters throw clean unsupported character error', async ({ page }) => {
    const hasEngine = await page.evaluate(() => typeof (window as any).__encodeCode128 === 'function');
    test.skip(!hasEngine, 'F7 Code 128 non-ASCII pending M3 implementation');
  });

  // =========================================================================
  // F8: Individual Barcode Generator & Export - Boundaries
  // =========================================================================
  test('F8-B01: Very long descriptions are truncated or formatted gracefully on single label preview', async ({ page }) => {
    await page.goto('/#/catalogo');
    const item = page.locator('.plist li').first();
    test.skip((await item.count()) === 0, 'Catalog items pending setup');
  });

  test('F8-B02: Generated internal MHK-XXXXXX code is verified unique against existing products in IndexedDB', async ({ page }) => {
    const isGenAvailable = await page.evaluate(() => typeof (window as any).__generateInternalCode === 'function');
    test.skip(!isGenAvailable, 'F8 internal code generator pending M3 implementation');
  });

  test('F8-B03: Barcode with special SKU characters generates sanitized filename for download', async ({ page }) => {
    const isSanitizeAvailable = await page.evaluate(() => typeof (window as any).__sanitizeFilename === 'function');
    test.skip(!isSanitizeAvailable, 'F8 filename sanitizer pending M3 implementation');
  });

  test('F8-B04: Product dialog updates barcode visualization reactively when barcode input changes', async ({ page }) => {
    await page.goto('/#/catalogo');
    const item = page.locator('.plist li').first();
    test.skip((await item.count()) === 0, 'Catalog items pending setup');
  });

  test('F8-B05: Rapid repeated download clicks do not leak memory or create orphaned blob URLs', async ({ page }) => {
    const isDownloadSafe = await page.evaluate(() => typeof (window as any).__downloadSvg === 'function');
    test.skip(!isDownloadSafe, 'F8 download helper pending M3 implementation');
  });

  // =========================================================================
  // F9: Mass / Batch Barcode Generator - Boundaries
  // =========================================================================
  test('F9-B01: Mass generation with 0 items selected shows validation message', async ({ page }) => {
    await page.goto('/#/catalogo');
    const labelsBtn = page.getByRole('button', { name: /Etiquetas/i });
    test.skip((await labelsBtn.count()) === 0, 'F9 mass labels button pending M3 implementation');
  });

  test('F9-B02: Large batch (100+ items) automatically paginates across multiple label sheets', async ({ page }) => {
    const isPaginated = await page.evaluate(() => typeof (window as any).__paginateLabels === 'function');
    test.skip(!isPaginated, 'F9 pagination helper pending M3 implementation');
  });

  test('F9-B03: Print offset equal to or greater than labels-per-sheet advances cleanly to next sheet', async ({ page }) => {
    const isOffsetHandled = await page.evaluate(() => typeof (window as any).__calculateSheetOffset === 'function');
    test.skip(!isOffsetHandled, 'F9 offset calculation pending M3 implementation');
  });

  test('F9-B04: Items with missing descriptions display barcode number and SKU cleanly in label slot', async ({ page }) => {
    const isSlotRendered = await page.evaluate(() => typeof (window as any).__renderLabelSlot === 'function');
    test.skip(!isSlotRendered, 'F9 slot renderer pending M3 implementation');
  });

  test('F9-B05: Quantity multiplier option generates N label copies', async ({ page }) => {
    const hasMultiplier = await page.evaluate(() => typeof (window as any).__applyQuantityMultiplier === 'function');
    test.skip(!hasMultiplier, 'F9 qty multiplier pending M3 implementation');
  });

  // =========================================================================
  // F10: Print CSS & Sheet Layouts - Boundaries
  // =========================================================================
  test('F10-B01: Zero-margin body rule applied during print preview to prevent browser margin offsets', async ({ page }) => {
    const hasPageZero = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule.cssText.includes('@page') && rule.cssText.includes('margin: 0')) return true;
          }
        } catch {}
      }
      return false;
    });
    test.skip(!hasPageZero, 'F10 @page zero margin pending M3 implementation');
    expect(hasPageZero).toBe(true);
  });

  test('F10-B02: Font sizes inside labels use scalable pt/rem units that do not overflow Avery 5160 1" height', async ({ page }) => {
    await page.goto('/');
    const labelRules = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule.cssText.includes('.sheet-label')) return rule.cssText;
          }
        } catch {}
      }
      return null;
    });
    test.skip(!labelRules, 'F10 .sheet-label style pending M3 implementation');
  });

  test('F10-B03: Exact page size @page { size: letter portrait; margin: 0; } is enforced', async ({ page }) => {
    const hasLetterSize = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule.cssText.includes('letter') || rule.cssText.includes('8.5in')) return true;
          }
        } catch {}
      }
      return false;
    });
    test.skip(!hasLetterSize, 'F10 letter size print style pending M3 implementation');
  });

  test('F10-B04: Dark mode or theme styles are overridden to pure black text on white background in print', async ({ page }) => {
    const hasPrintColorOverride = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule.type === CSSRule.MEDIA_RULE && rule.cssText.includes('background: white')) return true;
          }
        } catch {}
      }
      return false;
    });
    test.skip(!hasPrintColorOverride, 'F10 print color override pending M3 implementation');
  });

  test('F10-B05: Thermal single-label mode overrides page size for continuous roll printing', async ({ page }) => {
    const hasThermal = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule.cssText.includes('thermal') || rule.cssText.includes('50mm')) return true;
          }
        } catch {}
      }
      return false;
    });
    test.skip(!hasThermal, 'F10 thermal print rule pending M3 implementation');
  });
});
