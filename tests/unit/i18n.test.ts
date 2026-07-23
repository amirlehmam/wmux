import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { translate, detectDefaultLanguage, LANGUAGES, SUPPORTED_LANGUAGES } from '../../src/renderer/i18n';

// The i18n layer (issue #56) backs the Settings language switcher. These cover
// the fallback chain (active language → English → key) and locale detection so a
// partial translation never renders blank.

describe('i18n: translate (issue #56)', () => {
  it('returns the translation for the active language', () => {
    expect(translate('fr', 'settings.title')).toBe('Paramètres');
    expect(translate('zh', 'settings.title')).toBe('设置');
  });

  it('falls back to English for an untranslated key', () => {
    // A key only present in English resolves to English in every language.
    expect(translate('fr', 'palette.category.actions')).toBe('Actions');
  });

  it('falls back to the provided fallback, then the key itself', () => {
    expect(translate('en', 'nonexistent.key', 'My Fallback')).toBe('My Fallback');
    expect(translate('en', 'nonexistent.key')).toBe('nonexistent.key');
  });

  it('exposes the three shipped languages', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['en', 'fr', 'zh']);
    expect(LANGUAGES.map((l) => l.label)).toEqual(['English', 'Français', '中文']);
  });
});

describe('i18n: detectDefaultLanguage (issue #56)', () => {
  it('returns a supported language', () => {
    expect(SUPPORTED_LANGUAGES).toContain(detectDefaultLanguage());
  });
});

// Issue #114: an English-display Windows machine got French tooltips because
// navigator.language follows Chromium's locale resolution (regional format /
// Accept-Language), not the OS display language. The OS preferred-languages
// list from the preload bridge must win when available.
describe('i18n: detectDefaultLanguage OS display language (issue #114)', () => {
  const g = globalThis as any;
  let savedWindow: any;

  beforeEach(() => { savedWindow = g.window; });
  afterEach(() => {
    if (savedWindow === undefined) delete g.window;
    else g.window = savedWindow;
  });

  function stubPreferred(langs: string[]): void {
    g.window = { wmux: { settings: { getPreferredLanguagesSync: () => langs } } };
  }

  it('uses the OS display language over navigator.language', () => {
    stubPreferred(['en-US', 'fr-FR']);
    expect(detectDefaultLanguage()).toBe('en');
  });

  it('maps a supported OS display language to its base tag', () => {
    stubPreferred(['fr-CA']);
    expect(detectDefaultLanguage()).toBe('fr');
    stubPreferred(['zh-Hans-CN']);
    expect(detectDefaultLanguage()).toBe('zh');
  });

  it('falls back to English (not navigator.language) when the display language is unsupported', () => {
    // The OS list is authoritative: its first entry is what the user's UI
    // shows, so a supported language further down the list must NOT win.
    stubPreferred(['de-DE', 'fr-FR']);
    expect(detectDefaultLanguage()).toBe('en');
  });

  it('falls back to navigator/en when the bridge is absent or empty', () => {
    stubPreferred([]);
    expect(SUPPORTED_LANGUAGES).toContain(detectDefaultLanguage());
    delete g.window;
    expect(SUPPORTED_LANGUAGES).toContain(detectDefaultLanguage());
  });
});
