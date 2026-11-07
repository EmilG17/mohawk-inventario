import { expect, test } from '@playwright/test';
import * as path from 'node:path';

const outDir = '/home/antigravity/.gemini/jetski/brain/v1/default/jetski_remote_agents_3p/2686878c-c31c-480f-b2a2-f62d97551a18/screenshots';

test.describe('Flujo completo de inventario en teléfono', () => {
  test('inicio -> catálogo de prueba -> conteo -> reporte -> offline', async ({ page, context }) => {
    // 1. Abrir la app
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Inventario Mohawk');
    await page.screenshot({ path: path.join(outDir, '01_inicio_vacio.png') });

    // 2. Asignar nombre del contador
    await page.getByRole('button', { name: 'Cambiar' }).click();
    await page.fill('input.input', 'Roberto Martinez');
    await page.getByRole('button', { name: 'Aceptar' }).click();
    await expect(page.locator('.hello .big')).toHaveText('Roberto Martinez');

    // 3. Iniciar una nueva sesión de conteo
    await page.getByRole('button', { name: 'Iniciar conteo' }).click();
    await expect(page.locator('dialog h3')).toHaveText('Nueva sesión de conteo');
    await page.getByRole('button', { name: 'Aceptar' }).click();

    // 4. Debe navegar automáticamente a la pantalla de conteo
    await expect(page).toHaveURL(/#\/contar/);
    await expect(page.locator('.session-bar')).toContainText('Roberto Martinez');

    // 5. Cargar el catálogo de ejemplo desde Ajustes
    await page.goto('/#/ajustes');
    await page.getByRole('button', { name: 'Cargar catálogo de ejemplo' }).click();
    await expect(page).toHaveURL(/#\/catalogo/);
    await expect(page.locator('.plist li').first()).toBeVisible();
    await page.screenshot({ path: path.join(outDir, '02_catalogo.png') });

    // 6. Volver a Contar y escanear productos usando el hook de prueba
    await page.goto('/#/contar');

    // Escanear WD-40 (079567011003): cantidad 24
    await page.evaluate(() => (window as any).__simulateScan('079567011003'));
    const pcard = page.locator('#pcard');
    await expect(pcard).toBeVisible();
    await expect(pcard).toContainText('WD-40');
    await page.screenshot({ path: path.join(outDir, '03_conteo_tarjeta.png') });

    // Validar regla "solo un producto a la vez": mientras la tarjeta está abierta, se ignora todo nuevo escaneo
    await page.evaluate(() => (window as any).__simulateScan('071153000115'));
    await expect(pcard).toContainText('WD-40');
    await expect(page.locator('.cam-cooldown')).toContainText('1 producto a la vez');

    // Cambiar cantidad a 20 (teórico era 24, así que quedará faltante de 4)
    await page.locator('#pcard input.qty').fill('20');
    await page.getByRole('button', { name: 'Registrar' }).click();
    await expect(pcard).toBeHidden();

    // Validar regla "pausa forzosa de 2 segundos": inmediatamente tras registrar, el escáner ignora lecturas
    await page.evaluate(() => (window as any).__simulateScan('071153000115'));
    await expect(pcard).toBeHidden();
    await expect(page.locator('.cam-cooldown')).toContainText('Pausa');

    // Esperar a que se cumplan los 2 segundos de pausa
    await page.waitForTimeout(2100);

    // Ahora que la pausa terminó, escanea Guantes L (071153000115): teórico 30, registramos 35 (sobrante de 5)
    await page.evaluate(() => (window as any).__simulateScan('071153000115'));
    await expect(pcard).toBeVisible();
    await expect(pcard).toContainText('Guantes de nitrilo');
    await page.locator('#pcard input.qty').fill('35');
    await page.getByRole('button', { name: 'Registrar' }).click();

    // Probar entrada manual de producto que NO está en el catálogo (no catalogado)
    await page.fill('#code-input', '7501055300078');
    await page.keyboard.press('Enter');
    await expect(pcard).toBeVisible();
    await expect(pcard).toContainText('No catalogado');
    await page.locator('#pcard input.qty').fill('3');
    await page.getByRole('button', { name: 'Registrar' }).click();
    await page.screenshot({ path: path.join(outDir, '04_conteo_lista.png') });

    // 7. Ir a la pantalla de Reporte y validar diferencias
    await page.goto('/#/reporte');
    await expect(page.locator('.kpis')).toBeVisible();
    await page.screenshot({ path: path.join(outDir, '05_reporte.png') });

    // 8. Pantalla de Equipo / Consolidación
    await page.goto('/#/equipo');
    await expect(page.locator('.card').first()).toBeVisible();
    await page.screenshot({ path: path.join(outDir, '06_equipo.png') });

    // 9. Probar descarga de Excel (capturando el evento de descarga)
    await page.goto('/#/reporte');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Exportar Excel/ }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('.xlsx');

    // 10. Probar modo offline
    await context.setOffline(true);
    await page.goto('/#/contar');
    await expect(page.locator('#recent li')).toHaveCount(3);
    await page.fill('#code-input', '071641300018'); // Sharpie
    await page.keyboard.press('Enter');
    await expect(pcard).toContainText('Sharpie');
    await page.getByRole('button', { name: 'Registrar' }).click();
    await expect(page.locator('#recent li')).toHaveCount(4);
  });

  test('gestión masiva del catálogo: selección, modificación masiva y vaciado', async ({ page }) => {
    // 1. Cargar catálogo de ejemplo
    await page.goto('/#/ajustes');
    await page.getByRole('button', { name: 'Cargar catálogo de ejemplo' }).click();
    await expect(page).toHaveURL(/#\/catalogo/);
    await expect(page.locator('.plist li').first()).toBeVisible();

    // 2. Verificar barra de herramientas de selección
    const selectAll = page.locator('.select-toolbar input[type="checkbox"]');
    await expect(selectAll).toBeVisible();

    // 3. Seleccionar todos los visibles
    await selectAll.check();
    const massBar = page.locator('.mass-bar');
    await expect(massBar).toBeVisible();
    await expect(massBar.locator('.mass-info')).toContainText('seleccionado');

    // 4. Modificación masiva: cambiar unidad a PAQ
    await massBar.getByRole('button', { name: 'Modificar' }).click();
    await expect(page.locator('dialog[open] h3')).toContainText('Modificación masiva');

    // Activar casilla de unidad y escribir PAQ
    await page.locator('.mass-form .mass-field-block').first().locator('input[type="checkbox"]').check();
    await page.locator('.mass-form .mass-field-block').first().locator('input[type="text"]').fill('PAQ');
    await page.getByRole('button', { name: 'Aplicar cambios' }).click();
    await expect(page.locator('dialog[open]')).toBeHidden();

    // Verificar que los ítems ahora muestran PAQ
    await expect(page.locator('.plist li').first()).toContainText('PAQ');

    // 5. Eliminación masiva: seleccionar un ítem con su checkbox y eliminarlo
    const firstItemCheck = page.locator('.plist li .item-check').first();
    await firstItemCheck.check();
    await expect(massBar).toBeVisible();
    await expect(massBar.locator('.mass-info')).toContainText('1 seleccionado');

    await massBar.getByRole('button', { name: 'Eliminar' }).click();
    await expect(page.locator('dialog[open] h3')).toHaveText('Eliminar seleccionados');
    await page.locator('dialog[open]').getByRole('button', { name: 'Eliminar' }).click();
    await expect(page.locator('dialog[open]')).toBeHidden();

    // 6. Eliminación total del catálogo vía Acciones Masivas
    await page.locator('.select-toolbar button').click();
    await expect(page.locator('dialog[open] h3')).toHaveText('Acciones masivas del catálogo');
    await page.getByRole('button', { name: 'Opciones de eliminación masiva' }).click();
    await expect(page.locator('dialog[open] h3')).toHaveText('Eliminación masiva del catálogo');
    await page.getByRole('button', { name: 'Vaciar todo' }).click();
    await expect(page.locator('dialog[open] h3')).toHaveText('Vaciar catálogo completo');
    await page.locator('dialog[open]').getByRole('button', { name: 'Vaciar catálogo' }).click();

    // 7. Catálogo debe estar completamente vacío
    await expect(page.locator('.plist .empty')).toHaveText('Catálogo vacío');
  });
});
