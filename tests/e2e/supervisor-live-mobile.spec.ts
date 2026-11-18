import { expect, test } from '@playwright/test';
import { clearDatabase, loadSampleCatalog } from './helpers';

test.describe('Supervisor Live Scanner Telemetry & Mobile Supervisor Mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/');
    await clearDatabase(page);
    await loadSampleCatalog(page);
  });

  test('Supervisor ve en vivo el escaneo pendiente y ajustes de cantidad antes de que el técnico presione Registrar', async ({
    page,
    context,
  }) => {
    // Usar una sala local aislada por prueba
    const roomCode = `E2E-LIVE-${Date.now().toString(36).toUpperCase()}`;

    // Asignar contador y abrir sesión de conteo en la pestaña del técnico
    await page.goto('/#/');
    await page.getByRole('button', { name: 'Cambiar' }).click();
    await page.fill('input.input', 'Carlos Tech');
    await page.getByRole('button', { name: 'Aceptar' }).click();

    await page.getByTestId('home-start-session-btn').click();
    await expect(page.locator('dialog h3')).toHaveText('Nueva sesión de conteo');
    await page.getByRole('button', { name: 'Aceptar' }).click();
    await expect(page).toHaveURL(/#\/contar/);

    // Abrir segunda pestaña como Supervisor SIN iniciar sesión local en esta pestaña?
    // En el mismo navegador comparten IndexedDB; probamos la recepción vía BroadcastChannel en /#/equipo
    // Primero configurar la sala en ajustes / equipo para ambas pestañas
    await page.evaluate(async (rc) => {
      const req = indexedDB.open('mohawk-inventario');
      await new Promise<void>((resolve, reject) => {
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['meta'], 'readwrite');
          const store = tx.objectStore('meta');
          const getReq = store.get('settings');
          getReq.onsuccess = () => {
            const cur = getReq.result || {};
            store.put({ ...cur, counterName: 'Carlos Tech', syncEnabled: true, syncRoomCode: rc, syncEndpointUrl: '' }, 'settings');
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
    }, roomCode);

    // Recargar /#/contar para tomar los ajustes de sala
    await page.reload();
    await expect(page).toHaveURL(/#\/contar/);

    const supPage = await context.newPage();
    await supPage.goto('/#/equipo');

    // Desbloquear centro de supervisor con PIN si es vista móvil
    const supToggle = supPage.getByTestId('team-supervisor-toggle');
    if (await supToggle.isVisible().catch(() => false)) {
      await supToggle.click();
      const pinInput = supPage.locator('.pin-hidden-input');
      if (await pinInput.isVisible({ timeout: 600 }).catch(() => false)) {
        await pinInput.fill('1234');
      }
    }

    await expect(supPage.getByTestId('team-live-scanners')).toBeVisible();

    // Técnico escanea WD-40 (079567011002) sin presionar Registrar todavía
    await page.evaluate(() => (window as any).__simulateScan('079567011002'));
    await expect(page.locator('#pcard')).toBeVisible();
    await page.getByTestId('count-quick-plus-5').click();

    // El supervisor debe ver al instante en team-live-scanners que Carlos Tech está confirmando cantidad = 6
    const liveStrip = supPage.getByTestId('team-live-scanners');
    await expect(liveStrip).toContainText('Carlos Tech', { timeout: 5000 });
    await expect(liveStrip).toContainText('Confirmando cantidad', { timeout: 5000 });
    await expect(liveStrip).toContainText('6', { timeout: 5000 });

    // Técnico confirma Registrar
    await page.getByRole('button', { name: 'Registrar' }).click();
    await expect(page.locator('#pcard')).toBeHidden();
    await expect(liveStrip).toContainText('Recién registrado', { timeout: 5000 });

    await supPage.close();
  });

  test('Conecta solo lectura a sala Firebase HHF-1114 y muestra datos en vivo incluso sin sesión local activa', async ({
    page,
  }) => {
    // Asegurar que no haya sesión local activa en el dispositivo del supervisor
    await page.goto('/#/');
    await clearDatabase(page);

    // Proteger HHF-1114 contra escrituras PUT/PATCH/DELETE durante la prueba E2E dejando pasar GET real
    await page.route('https://hhf-inventory-default-rtdb.firebaseio.com/**', async (route) => {
      const method = route.request().method().toUpperCase();
      if (method === 'GET' || method === 'HEAD') {
        await route.continue();
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
      }
    });

    await page.goto('/#/equipo');

    // Desbloquear centro de supervisor con PIN si es vista móvil
    const supToggle2 = page.getByTestId('team-supervisor-toggle');
    if (await supToggle2.isVisible().catch(() => false)) {
      await supToggle2.click();
      const pinInput = page.locator('.pin-hidden-input');
      if (await pinInput.isVisible({ timeout: 600 }).catch(() => false)) {
        await pinInput.fill('1234');
      }
    }

    const presetBtn = page.getByTestId('team-preset-hhf-btn');
    await expect(presetBtn).toBeVisible();
    await presetBtn.click();

    // Verifica conexión real y renderizado de la sala HHF-1114 ("Prueba", participante "Emil") sin sesión local
    await expect(page.locator('#app')).toContainText('HHF-1114', { timeout: 10000 });
    await expect(page.locator('#app')).toContainText('Emil', { timeout: 10000 });
    await expect(page.getByTestId('team-tab-techs')).toHaveClass(/active/);
  });

  test('En móvil (<900px) oculta opciones de supervisor hasta activar Modo Supervisor en Más ⋯', async ({ page }) => {
    const viewport = page.viewportSize();
    const isMobile = (viewport?.width ?? 1280) < 900;
    if (!isMobile) {
      await page.goto('/#/');
      await expect(page.getByTestId('workflow-bar')).toBeVisible();
      await expect(page.getByTestId('home-quick-unify')).toBeVisible();
      return;
    }

    await page.goto('/#/');
    await expect(page.getByTestId('workflow-bar')).toBeHidden();
    await expect(page.getByTestId('home-quick-unify')).toHaveCount(0);
    await expect(page.getByTestId('home-quick-labels')).toHaveCount(0);
    await expect(page.getByTestId('home-quick-in')).toBeVisible();
    await expect(page.getByTestId('home-quick-import')).toBeVisible();

    // Activar Modo Supervisor desde el menú "Más ⋯"
    await page.getByTestId('nav-more').click();
    await expect(page.getByTestId('mobile-supervisor-toggle')).toBeVisible();
    await page.getByTestId('mobile-supervisor-toggle').click();

    // Ingresar PIN de supervisor protegido en móvil (por defecto 1234)
    const pinInput = page.locator('.pin-hidden-input');
    if (await pinInput.isVisible({ timeout: 600 }).catch(() => false)) {
      await pinInput.fill('1234');
    }

    await expect(page.locator('#app')).toHaveAttribute('data-supervisor', 'true');
    await expect(page.getByTestId('home-quick-unify')).toBeVisible();
    await expect(page.getByTestId('home-quick-labels')).toBeVisible();
    await expect(page.getByTestId('workflow-bar')).toBeVisible();
  });

  test('Hacer clic en Reporte desde Contar con escaneo pendiente y sincronización en vivo no cuelga la app', async ({
    page,
  }) => {
    const viewport = page.viewportSize();
    if ((viewport?.width ?? 1280) < 900) return;

    const roomCode = `E2E-RPT-${Date.now().toString(36).toUpperCase()}`;
    await page.goto('/#/');
    await page.getByRole('button', { name: 'Cambiar' }).click();
    await page.fill('input.input', 'Carlos Sup');
    await page.getByRole('button', { name: 'Aceptar' }).click();

    await page.getByTestId('home-start-session-btn').click();
    await page.getByRole('button', { name: 'Aceptar' }).click();
    await expect(page).toHaveURL(/#\/contar/);

    await page.evaluate(async (rc) => {
      const req = indexedDB.open('mohawk-inventario');
      await new Promise<void>((resolve, reject) => {
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['meta'], 'readwrite');
          const store = tx.objectStore('meta');
          const getReq = store.get('settings');
          getReq.onsuccess = () => {
            const cur = getReq.result || {};
            store.put(
              { ...cur, counterName: 'Carlos Sup', syncEnabled: true, syncAuto: true, syncRoomCode: rc, syncEndpointUrl: '' },
              'settings',
            );
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
    }, roomCode);

    await page.reload();
    await expect(page).toHaveURL(/#\/contar/);

    await page.evaluate(() => (window as any).__simulateScan('079567011002'));
    await expect(page.locator('#pcard')).toBeVisible();

    await page.getByTestId('count-goto-report').click();
    await expect(page).toHaveURL(/#\/reporte/, { timeout: 5000 });
    await expect(page.getByTestId('report-export-xlsx')).toBeVisible({ timeout: 5000 });
  });
});
