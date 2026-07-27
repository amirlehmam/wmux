import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  translate,
  detectDefaultLanguage,
  isLanguage,
  DICTIONARIES,
  LANGUAGES,
  SUPPORTED_LANGUAGES,
  type TranslationKey,
} from '../../src/renderer/i18n';

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
    // Casts on purpose: an unknown key is a compile error since the keys became
    // typed, but the runtime chain still has to hold for keys that reach
    // translate() dynamically (persisted state, CLI, a stale cast).
    const missing = 'nonexistent.key' as TranslationKey;
    expect(translate('en', missing, 'My Fallback')).toBe('My Fallback');
    expect(translate('en', missing)).toBe('nonexistent.key');
  });

  it('exposes the shipped languages', () => {
    // Pinned on purpose: adding a language must be a deliberate edit here, so
    // the shipped set can never grow (or shrink) unnoticed.
    expect(SUPPORTED_LANGUAGES).toEqual(['en', 'fr', 'it', 'zh']);
    expect(LANGUAGES.map((l) => l.label)).toEqual(['English', 'Français', 'Italiano', '中文']);
  });
});

// The locale files are typed against English, so a stale key is normally a
// compile error. This is the runtime backstop (vitest strips types, and a cast
// or a generated file could slip one through) — and it reports coverage, which
// the type system deliberately does not, since partial translations are legal.
describe('i18n: locale registry', () => {
  const enKeys = Object.keys(DICTIONARIES.en);

  it.each(SUPPORTED_LANGUAGES.filter((c) => c !== 'en'))(
    '%s carries no key English has dropped',
    (code) => {
      const stale = Object.keys(DICTIONARIES[code]).filter((k) => !enKeys.includes(k));
      expect({ code, stale }).toEqual({ code, stale: [] });
    },
  );

  it('reports translation coverage per language', () => {
    for (const { code, label } of LANGUAGES) {
      const done = enKeys.filter((k) => k in DICTIONARIES[code]).length;
      // eslint-disable-next-line no-console
      console.log(`  ${code} (${label}): ${done}/${enKeys.length} keys`);
      expect(done).toBeGreaterThan(0);
    }
  });

  it('isLanguage narrows only shipped codes', () => {
    expect(SUPPORTED_LANGUAGES.every(isLanguage)).toBe(true);
    for (const bad of ['de', 'EN', 'fr-FR', '', null, undefined, 42]) {
      expect(isLanguage(bad)).toBe(false);
    }
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
