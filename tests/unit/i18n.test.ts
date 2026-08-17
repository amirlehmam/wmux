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
    expect(translate('es', 'settings.title')).toBe('Ajustes');
    expect(translate('zh', 'settings.title')).toBe('设置');
    expect(translate('ko', 'settings.title')).toBe('설정');
    expect(translate('ru', 'settings.title')).toBe('Настройки');
    expect(translate('uk', 'settings.title')).toBe('Параметри');
    expect(translate('pl', 'settings.title')).toBe('Ustawienia');
    expect(translate('tr', 'settings.title')).toBe('Ayarlar');
    expect(translate('sv', 'settings.title')).toBe('Inställningar');
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
    expect(SUPPORTED_LANGUAGES).toEqual(['en', 'fr', 'es', 'de', 'pt', 'it', 'pl', 'tr', 'ru', 'uk', 'zh', 'ja', 'ko', 'hi', 'sv']);
    expect(LANGUAGES.map((l) => l.label)).toEqual([
      'English',
      'Français',
      'Español',
      'Deutsch',
      'Português',
      'Italiano',
      'Polski',
      'Türkçe',
      'Русский',
      'Українська',
      '中文',
      '日本語',
      '한국어',
      'हिन्दी',
      'Svenska',
    ]);
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
    for (const bad of ['tt', 'EN', 'fr-FR', '', null, undefined, 42]) {
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
    stubPreferred(['es-ES']);
    expect(detectDefaultLanguage()).toBe('es');
    stubPreferred(['zh-Hans-CN']);
    expect(detectDefaultLanguage()).toBe('zh');
    // issue #147: a Korean-display machine lands on Korean without touching Settings.
    stubPreferred(['ko-KR']);
    expect(detectDefaultLanguage()).toBe('ko');
    // A Portuguese-display machine (Brazil or Portugal) collapses to the base tag.
    stubPreferred(['pt-BR']);
    expect(detectDefaultLanguage()).toBe('pt');
    // A German-display machine (Germany or Austria) collapses to the base tag.
    stubPreferred(['de-AT']);
    expect(detectDefaultLanguage()).toBe('de');
    // A Japanese-display machine collapses to the base tag.
    stubPreferred(['ja-JP']);
    expect(detectDefaultLanguage()).toBe('ja');
    // A Hindi-display machine (India) collapses to the base tag.
    stubPreferred(['hi-IN']);
    expect(detectDefaultLanguage()).toBe('hi');
    // A Russian-display machine collapses to the base tag.
    stubPreferred(['ru-RU']);
    expect(detectDefaultLanguage()).toBe('ru');
    // A Ukrainian-display machine collapses to the base tag.
    stubPreferred(['uk-UA']);
    expect(detectDefaultLanguage()).toBe('uk');
    // A Polish-display machine collapses to the base tag.
    stubPreferred(['pl-PL']);
    expect(detectDefaultLanguage()).toBe('pl');
    // A Turkish-display machine collapses to the base tag.
    stubPreferred(['tr-TR']);
    expect(detectDefaultLanguage()).toBe('tr');
    // A Swedish-display machine collapses to the base tag.
    stubPreferred(['sv-SE']);
    expect(detectDefaultLanguage()).toBe('sv');
  });

  it('falls back to English (not navigator.language) when the display language is unsupported', () => {
    // The OS list is authoritative: its first entry is what the user's UI
    // shows, so a supported language further down the list must NOT win.
    // (German used to be that "unsupported" example; now that de is bundled,
    // Tatar stands in as a language wmux will never ship.)
    stubPreferred(['tt-RU', 'fr-FR']);
    expect(detectDefaultLanguage()).toBe('en');
  });

  it('falls back to navigator/en when the bridge is absent or empty', () => {
    stubPreferred([]);
    expect(SUPPORTED_LANGUAGES).toContain(detectDefaultLanguage());
    delete g.window;
    expect(SUPPORTED_LANGUAGES).toContain(detectDefaultLanguage());
  });
});
