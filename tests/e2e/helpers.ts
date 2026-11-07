import { Page, expect } from '@playwright/test';

/**
 * Reset all IndexedDB stores to ensure clean test isolation.
 */
export async function clearDatabase(page: Page): Promise<void> {
  await page.evaluate(async () => {
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('mohawk-inventario');
      req.onsuccess = async () => {
        const db = req.result;
        try {
          const storeNames = Array.from(db.objectStoreNames);
          if (storeNames.length === 0) {
            resolve();
            return;
          }
          const tx = db.transaction(storeNames, 'readwrite');
          for (const name of storeNames) {
            tx.objectStore(name).clear();
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        } catch (e) {
          resolve(); // stores may not exist yet on fresh start
        }
      };
      req.onerror = () => reject(req.error);
    });
  });
}

/**
 * Seed the sample catalog via settings page or fallback.
 */
export async function loadSampleCatalog(page: Page): Promise<void> {
  await page.goto('/#/ajustes');
  const btn = page.getByRole('button', { name: /Cargar catálogo de ejemplo/i });
  if (await btn.isVisible()) {
    await btn.click();
    await page.waitForURL(/#\/catalogo/);
    await page.locator('.plist li').first().waitFor({ state: 'visible', timeout: 5000 });
  }
}

/**
 * Initialize a counting session through UI.
 */
export async function startCountingSession(page: Page, sessionName = 'Sesión de Prueba', counter = 'Roberto Martinez'): Promise<void> {
  await page.goto('/#/');
  // Check if counter name is missing (shows 'Cambiar' or prompt dialog)
  const changeBtn = page.getByRole('button', { name: 'Cambiar' });
  if (await changeBtn.isVisible()) {
    await changeBtn.click();
    const input = page.locator('dialog[open] input.input, dialog[open] input[type="text"]');
    if (await input.isVisible()) {
      await input.fill(counter);
      await page.locator('dialog[open]').getByRole('button', { name: 'Aceptar' }).click();
      await expect(page.locator('dialog[open]')).toBeHidden().catch(() => {});
    }
  }

  const startBtn = page.getByRole('button', { name: /Iniciar conteo|Iniciar nueva sesión|Nueva sesión/i });
  if (await startBtn.isVisible()) {
    await startBtn.click();
    for (let step = 0; step < 2; step++) {
      const dlg = page.locator('dialog[open]');
      try {
        await dlg.waitFor({ state: 'visible', timeout: 2500 });
        const title = (await dlg.locator('h3').textContent().catch(() => '')) || '';
        if (title.includes('¿Quién')) {
          await dlg.locator('input').fill(counter);
          await dlg.getByRole('button', { name: 'Aceptar' }).click();
          await page.waitForTimeout(300);
        } else if (title.includes('sesión') || title.includes('Sesión')) {
          const nameInput = dlg.locator('input.input, input[type="text"]');
          if (await nameInput.isVisible()) {
            await nameInput.fill(sessionName);
          }
          await dlg.getByRole('button', { name: 'Aceptar' }).click();
          await expect(dlg).toBeHidden({ timeout: 2000 }).catch(() => {});
          break;
        }
      } catch {
        break;
      }
    }
  }
  await page.waitForURL(/#\/contar/, { timeout: 7000 }).catch(() => {});
}

/**
 * Retrieve all sessions from IndexedDB in the browser.
 */
export async function getDbSessions(page: Page): Promise<any[]> {
  return page.evaluate(async () => {
    return new Promise<any[]>((resolve, reject) => {
      const req = indexedDB.open('mohawk-inventario');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('sessions')) {
          resolve([]);
          return;
        }
        const tx = db.transaction('sessions', 'readonly');
        const reqAll = tx.objectStore('sessions').getAll();
        reqAll.onsuccess = () => resolve(reqAll.result || []);
        reqAll.onerror = () => reject(reqAll.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
}

/**
 * Retrieve active session ID from meta store.
 */
export async function getActiveSessionId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    return new Promise<string | null>((resolve, reject) => {
      const req = indexedDB.open('mohawk-inventario');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) {
          resolve(null);
          return;
        }
        const tx = db.transaction('meta', 'readonly');
        const reqGet = tx.objectStore('meta').get('activeSession');
        reqGet.onsuccess = () => resolve(reqGet.result ?? null);
        reqGet.onerror = () => reject(reqGet.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
}

/**
 * Retrieve all count entries from IndexedDB.
 */
export async function getDbCounts(page: Page): Promise<any[]> {
  return page.evaluate(async () => {
    return new Promise<any[]>((resolve, reject) => {
      const req = indexedDB.open('mohawk-inventario');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('counts')) {
          resolve([]);
          return;
        }
        const tx = db.transaction('counts', 'readonly');
        const reqAll = tx.objectStore('counts').getAll();
        reqAll.onsuccess = () => resolve(reqAll.result || []);
        reqAll.onerror = () => reject(reqAll.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
}

/**
 * Reference GTIN Modulo-10 checksum calculator (Authoritative Oracle).
 */
export function calculateReferenceGtinCheckDigit(codeWithoutCheck: string): number {
  const digits = codeWithoutCheck.replace(/\D/g, '').split('').map(Number);
  let sum = 0;
  // Starting from rightmost digit moving left: odd positions (from right) multiply by 3, even by 1
  let mult = 3;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += digits[i] * mult;
    mult = mult === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Reference GTIN validator (Authoritative Oracle).
 */
export function isReferenceValidGtin(code: string): boolean {
  const clean = code.replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(clean.length)) return false;
  const body = clean.slice(0, -1);
  const checkDigit = Number(clean.slice(-1));
  return calculateReferenceGtinCheckDigit(body) === checkDigit;
}
