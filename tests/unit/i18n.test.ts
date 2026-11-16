import { afterEach, describe, expect, it, vi } from 'vitest';
import { L, applyDocumentLang, detectDeviceLang, getLang, getLocaleTag } from '../../src/i18n/i18n';
import { _resetSettings, saveSettings } from '../../src/settings';
import 'fake-indexeddb/auto';

function mockNavigatorLanguages(language: string | undefined, languages?: string[]) {
  vi.stubGlobal('navigator', {
    language,
    languages: languages ?? (language ? [language] : []),
  });
}

describe('i18n device language detection and formatting', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetSettings();
  });

  it('detects Spanish and English device locales accurately', () => {
    mockNavigatorLanguages('en-US', ['en-US', 'en']);
    expect(detectDeviceLang()).toBe('en');

    mockNavigatorLanguages('en-GB', ['en-GB']);
    expect(detectDeviceLang()).toBe('en');

    mockNavigatorLanguages('es-MX', ['es-MX', 'es']);
    expect(detectDeviceLang()).toBe('es');

    mockNavigatorLanguages('es-US', ['es-US', 'en-US']);
    expect(detectDeviceLang()).toBe('es');

    mockNavigatorLanguages('fr-FR', ['fr-FR']);
    expect(detectDeviceLang()).toBe('en');

    mockNavigatorLanguages(undefined, []);
    expect(detectDeviceLang()).toBe('es');
  });

  it('uses explicit settings override when configured and falls back to device language for auto', async () => {
    mockNavigatorLanguages('en-US', ['en-US']);
    await saveSettings({ language: 'auto' });
    expect(getLang()).toBe('en');
    expect(L('Inicio', 'Home')).toBe('Home');
    expect(getLocaleTag()).toBe('en-US');

    await saveSettings({ language: 'es' });
    expect(getLang()).toBe('es');
    expect(L('Inicio', 'Home')).toBe('Inicio');
    expect(getLocaleTag()).toBe('es-MX');

    await saveSettings({ language: 'en' });
    mockNavigatorLanguages('es-MX', ['es-MX']);
    expect(getLang()).toBe('en');
    expect(L('Ajustes', 'Settings')).toBe('Settings');
  });

  it('updates document.documentElement.lang via applyDocumentLang()', async () => {
    const attrs: Record<string, string> = {};
    vi.stubGlobal('document', {
      documentElement: {
        set lang(val: string) {
          attrs.lang = val;
        },
        get lang() {
          return attrs.lang;
        },
      },
      querySelector: () => null,
    });

    mockNavigatorLanguages('en-US', ['en-US']);
    await saveSettings({ language: 'auto' });
    applyDocumentLang();
    expect(attrs.lang).toBe('en');

    await saveSettings({ language: 'es' });
    applyDocumentLang();
    expect(attrs.lang).toBe('es');
  });
});
