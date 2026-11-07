import { expect, test } from '@playwright/test';
import { clearDatabase, getActiveSessionId, getDbCounts, getDbSessions } from './helpers';

test.describe('Challenger M1: UI State Consistency, Routing & Idle Hardware Wedge Resistance', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/');
    await clearDatabase(page);
    // Ensure activeSession is null
    await page.evaluate(async () => {
      const req = indexedDB.open('mohawk-inventario');
      await new Promise<void>((resolve, reject) => {
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('meta', 'readwrite');
          tx.objectStore('meta').delete('activeSession');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
    });
  });

  // =========================================================================
  // Test 1: Navigation between routes when activeSession is null
  // =========================================================================
  test('1. Navigation between routes (/, /contar, /reporte, /equipo) when activeSession is null', async ({ page }) => {
    // 1.1 Route / (Home)
    await page.goto('/#/');
    await expect(page.locator('.top-session')).toHaveText('Sin sesión');
    await expect(page.getByRole('heading', { level: 2, name: 'Sin sesión activa' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Iniciar nueva sesión' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ver catálogo de productos' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ver todas las sesiones' })).toBeVisible();

    // 1.2 Route /contar
    await page.goto('/#/contar');
    await expect(page.getByRole('heading', { level: 2, name: 'No hay sesión activa' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Iniciar nueva sesión' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Seleccionar o reanudar sesión' })).toBeVisible();
    // Verify scanner video and manual input are NOT mounted
    await expect(page.locator('video')).toHaveCount(0);
    await expect(page.locator('#code-input')).toHaveCount(0);
    await expect(page.locator('#pcard')).toHaveCount(0);

    // 1.3 Route /reporte with 0 sessions
    await page.goto('/#/reporte');
    await expect(page.getByRole('heading', { level: 2, name: 'No hay sesiones' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ir al inicio' })).toBeVisible();

    // 1.4 Route /equipo
    await page.goto('/#/equipo');
    await expect(page.getByRole('heading', { level: 2, name: 'Sin sesión activa' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Iniciar nueva sesión' }).first()).toBeVisible();
    await expect(page.locator('.session-list')).toBeVisible();
    await expect(page.locator('.session-list li.empty')).toHaveText('No hay sesiones registradas.');

    // 1.5 Smooth navigation between tabs via nav bar
    await page.click('button[data-path="/"]');
    await expect(page).toHaveURL(/#\//);
    await expect(page.getByRole('heading', { level: 2, name: 'Sin sesión activa' })).toBeVisible();

    await page.click('button[data-path="/contar"]');
    await expect(page).toHaveURL(/#\/contar/);
    await expect(page.getByRole('heading', { level: 2, name: 'No hay sesión activa' })).toBeVisible();

    await page.click('button[data-path="/equipo"]');
    await expect(page).toHaveURL(/#\/equipo/);
    await expect(page.getByRole('heading', { level: 2, name: 'Sin sesión activa' })).toBeVisible();

    // activeSession remains null throughout
    const active = await getActiveSessionId(page);
    expect(active).toBeNull();
  });

  // =========================================================================
  // Test 2: Report calculation and exports (Excel / CSV) for closed sessions
  // =========================================================================
  test('2. Report calculation and exports (Excel / CSV) for closed sessions when idle', async ({ page }) => {
    // Seed catalog and closed session with counts into IndexedDB
    const sessionId = 'closed-session-123';
    await page.evaluate(async (sid) => {
      const req = indexedDB.open('mohawk-inventario');
      await new Promise<void>((resolve, reject) => {
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['products', 'sessions', 'counts', 'meta'], 'readwrite');

          // Products
          tx.objectStore('products').put({
            barcode: '00071153000108',
            sku: 'MHK-001',
            description: 'Guantes de nitrilo M',
            unit: 'CJA',
            expectedQty: 50,
            unitCost: 100,
            source: 'catalogo',
          });
          tx.objectStore('products').put({
            barcode: '00079567011003',
            sku: 'MHK-010',
            description: 'WD-40 aerosol',
            unit: 'PZA',
            expectedQty: 20,
            unitCost: 150,
            source: 'catalogo',
          });

          // Closed Session
          tx.objectStore('sessions').put({
            id: sid,
            name: 'Auditoría Anual Mohawk',
            counter: 'Inspector Gómez',
            createdAt: Date.now() - 3600000,
            closed: true,
            closedAt: Date.now() - 1800000,
          });

          // Counts: Guantes counted 50 (ok), WD-40 counted 15 (short 5)
          tx.objectStore('counts').put({
            id: 'c1',
            sessionId: sid,
            barcode: '00071153000108',
            qty: 50,
            counter: 'Inspector Gómez',
            deviceId: 'dev1',
            timestamp: Date.now() - 2500000,
          });
          tx.objectStore('counts').put({
            id: 'c2',
            sessionId: sid,
            barcode: '00079567011003',
            qty: 15,
            counter: 'Inspector Gómez',
            deviceId: 'dev1',
            timestamp: Date.now() - 2400000,
          });

          // Ensure activeSession is null
          tx.objectStore('meta').put(null, 'activeSession');

          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      });
    }, sessionId);

    // Navigate to /reporte
    await page.goto(`/#/reporte?session=${sessionId}`);

    // Verify session header in report view
    await expect(page.locator('h2')).toHaveText('Auditoría Anual Mohawk');
    await expect(page.locator('.card-head .badge.info')).toHaveText('Cerrada');
    await expect(page.locator('.card-head')).toContainText('Finalizada:');

    // Verify KPIs
    const kpiCards = page.locator('.kpis .kpi');
    await expect(kpiCards).toHaveCount(6);
    await expect(page.locator('.kpis')).toContainText('Exactitud');
    await expect(page.locator('.kpis')).toContainText('Contados');
    await expect(page.locator('.kpis')).toContainText('Faltantes');

    // Verify financial difference values
    await expect(page.locator('.values-row')).toContainText('Faltante:');

    // Verify list items: Guantes is 'ok', WD-40 is 'faltante'
    await expect(page.locator('.r-item.ok')).toContainText('Guantes de nitrilo M');
    await expect(page.locator('.r-item.faltante')).toContainText('WD-40 aerosol');
    await expect(page.locator('.r-item.faltante .diff')).toContainText('-5');

    // Verify Reabrir sesión button exists for closed session
    await expect(page.getByRole('button', { name: 'Reabrir sesión' })).toBeVisible();

    // Test Excel Export download
    const [downloadXlsx] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Exportar Excel/i }).click(),
    ]);
    expect(downloadXlsx.suggestedFilename()).toMatch(/^inventario_Auditoria_Anual_Mohawk_.*\.xlsx$/);

    // Test CSV Export download
    const [downloadCsv] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /^CSV$/i }).click(),
    ]);
    expect(downloadCsv.suggestedFilename()).toMatch(/^inventario_Auditoria_Anual_Mohawk_.*\.csv$/);

    // Verify activeSession is STILL null
    expect(await getActiveSessionId(page)).toBeNull();
  });

  // =========================================================================
  // Test 3: Switching between multiple closed sessions
  // =========================================================================
  test('3. Seamless switching between multiple closed sessions without state bleed', async ({ page }) => {
    const s1Id = 'sess-alfa-1';
    const s2Id = 'sess-beta-2';

    await page.evaluate(async ({ s1, s2 }) => {
      const req = indexedDB.open('mohawk-inventario');
      await new Promise<void>((resolve, reject) => {
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['products', 'sessions', 'counts', 'meta'], 'readwrite');

          tx.objectStore('products').put({
            barcode: '00071153000108',
            sku: 'MHK-001',
            description: 'Guantes M',
            unit: 'CJA',
            expectedQty: 10,
            unitCost: 100,
            source: 'catalogo',
          });

          // Session Alfa: 10 units counted
          tx.objectStore('sessions').put({
            id: s1,
            name: 'Inventario Alfa',
            counter: 'Alicia',
            createdAt: 1700000000000,
            closed: true,
            closedAt: 1700003600000,
          });
          tx.objectStore('counts').put({
            id: 'ca1',
            sessionId: s1,
            barcode: '00071153000108',
            qty: 10,
            counter: 'Alicia',
            deviceId: 'd1',
            timestamp: 1700001000000,
          });

          // Session Beta: 25 units counted
          tx.objectStore('sessions').put({
            id: s2,
            name: 'Inventario Beta',
            counter: 'Bernardo',
            createdAt: 1700010000000,
            closed: true,
            closedAt: 1700013600000,
          });
          tx.objectStore('counts').put({
            id: 'cb1',
            sessionId: s2,
            barcode: '00071153000108',
            qty: 25,
            counter: 'Bernardo',
            deviceId: 'd2',
            timestamp: 1700011000000,
          });

          tx.objectStore('meta').put(null, 'activeSession');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      });
    }, { s1: s1Id, s2: s2Id });

    // Open Report on Alfa
    await page.goto(`/#/reporte?session=${s1Id}`);
    await expect(page.locator('h2')).toHaveText('Inventario Alfa');
    await expect(page.locator('.r-item b').first()).toHaveText('10'); // expected 10
    await expect(page.locator('.r-item b').nth(1)).toHaveText('10'); // counted 10

    // Switch dropdown to Beta
    const select = page.locator('select.input');
    await expect(select).toBeVisible();
    await select.selectOption(s2Id);

    // Verify URL updated and UI re-rendered for Beta
    await expect(page).toHaveURL(new RegExp(s2Id));
    await expect(page.locator('h2')).toHaveText('Inventario Beta');
    await expect(page.locator('.r-item b').nth(1)).toHaveText('25'); // counted 25
    await expect(page.locator('.r-item .diff b')).toHaveText('+15'); // diff +15

    // Switch back to Alfa via dropdown
    await select.selectOption(s1Id);
    await expect(page).toHaveURL(new RegExp(s1Id));
    await expect(page.locator('h2')).toHaveText('Inventario Alfa');
    await expect(page.locator('.r-item b').nth(1)).toHaveText('10');

    // Verify activeSession is STILL null
    expect(await getActiveSessionId(page)).toBeNull();
  });

  // =========================================================================
  // Test 4: Hardware wedge inputs while idle do NOT corrupt database state
  // =========================================================================
  test('4. Scanning or typing hardware wedge inputs when idle does NOT corrupt database state', async ({ page }) => {
    // Navigate across all 4 routes while idle and dispatch rapid scanner keystrokes
    const routes = ['/#/', '/#/contar', '/#/reporte', '/#/equipo'];
    const fakeBarcode = '00079567011003';

    for (const r of routes) {
      await page.goto(r);
      // Wait for route to settle
      await page.waitForTimeout(150);

      // Simulate hardware wedge barcode scanner typing characters rapidly (<30ms between keystrokes)
      for (const char of fakeBarcode) {
        await page.keyboard.press(char);
        await page.waitForTimeout(20);
      }
      await page.keyboard.press('Enter');

      // Also simulate direct scan hook if present
      await page.evaluate((code) => {
        if (typeof (window as any).__simulateScan === 'function') {
          (window as any).__simulateScan(code);
        }
      }, fakeBarcode);
    }

    // Verify counts in IndexedDB remain strictly 0
    const counts = await getDbCounts(page);
    expect(counts).toHaveLength(0);

    // Verify sessions in IndexedDB remain strictly 0
    const sessions = await getDbSessions(page);
    expect(sessions).toHaveLength(0);

    // Verify activeSession remains null
    expect(await getActiveSessionId(page)).toBeNull();
  });
});
