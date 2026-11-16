import { settingsSync } from '../settings';

export type AppLang = 'es' | 'en';
export type LangPref = 'auto' | AppLang;

/**
 * Detects the device/browser preferred language ('es' or 'en').
 * Falls back to 'es' if navigator is absent/empty (e.g. headless Node test mocks),
 * and to 'en' for non-Spanish explicit browser locales.
 */
export function detectDeviceLang(): AppLang {
  if (typeof navigator === 'undefined') return 'es';
  const list: string[] = [];
  if (Array.isArray(navigator.languages)) {
    for (const item of navigator.languages) {
      if (typeof item === 'string' && item.trim()) list.push(item.trim());
    }
  }
  if (typeof navigator.language === 'string' && navigator.language.trim()) {
    list.push(navigator.language.trim());
  }
  if (list.length === 0) return 'es';

  for (const tag of list) {
    const lower = tag.toLowerCase();
    if (lower === 'es' || lower.startsWith('es-')) return 'es';
    if (lower === 'en' || lower.startsWith('en-')) return 'en';
  }
  return 'en';
}

/**
 * Active application language, honoring explicit Settings override or device language ('auto').
 */
export function getLang(): AppLang {
  const pref = settingsSync().language;
  if (pref === 'es' || pref === 'en') return pref;
  return detectDeviceLang();
}

/**
 * Active BCP-47 locale tag for number, currency, and date/time formatting.
 */
export function getLocaleTag(): string {
  const lang = getLang();
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
    const nav = navigator.language.trim();
    if (lang === 'en' && /^en(-|$)/i.test(nav)) return nav;
    if (lang === 'es' && /^es(-|$)/i.test(nav)) return nav === 'es-US' ? 'es-MX' : nav;
  }
  return lang === 'en' ? 'en-US' : 'es-MX';
}

/**
 * Bilingual string selector using the active device or configured language.
 */
export function L(es: string, en: string): string {
  return getLang() === 'en' ? en : es;
}

/**
 * Updates `<html lang>` and document meta description to match the active language.
 */
export function applyDocumentLang(): void {
  if (typeof document === 'undefined') return;
  const lang = getLang();
  document.documentElement.lang = lang;
  const metaDesc = document.querySelector?.('meta[name="description"]');
  if (metaDesc) {
    metaDesc.setAttribute(
      'content',
      lang === 'en'
        ? 'Scanning, control, and unified consumables inventory reporting'
        : 'Escaneo, control y reporte unificado de inventario de consumibles',
    );
  }
}

export function isEn(): boolean {
  return getLang() === 'en';
}
