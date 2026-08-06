import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadUserLocales } from '../../src/main/user-locales';
import {
  DICTIONARIES,
  LANGUAGES,
  SUPPORTED_LANGUAGES,
  applyUserLocales,
  getLocaleRevision,
  getUserLocaleState,
  isLanguage,
  translate,
  type TranslationKey,
} from '../../src/renderer/i18n/core';

// The renderer half of community translations (issue #147): merging
// ~/.wmux/locales into the bundled registry. The loader's job is IO and shape;
// this module's job is key validation and the add-vs-override semantics.
//
// applyUserLocales rebuilds module-level singletons, so every test restores the
// bundled-only registry afterwards.

const BUILTIN_CODES = ['en', 'es', 'fr', 'it', 'ko', 'zh'];

function payload(...locales: Array<Record<string, unknown>>) {
  return { locales, errors: [], dir: '/home/u/.wmux/locales' };
}

afterEach(() => {
  applyUserLocales(undefined);
});

describe('applyUserLocales: adding a language (issue #147)', () => {
  it('adds an unknown code to the registry and the dropdown', () => {
    applyUserLocales(
      payload({ code: 'de', label: 'Deutsch', strings: { 'settings.title': 'Einstellungen' } }),
    );

    expect(SUPPORTED_LANGUAGES).toContain('de');
    expect(LANGUAGES.find((l) => l.code === 'de')?.label).toBe('Deutsch');
    expect(translate('de', 'settings.title')).toBe('Einstellungen');
  });

  it('accepts the new code in isLanguage, so it survives a restart', () => {
    // This is the whole reason the merge happens synchronously before the store
    // hydrates: loadPersistedLanguage() drops any code isLanguage() rejects, so
    // a user-defined language would otherwise reset to English on every launch.
    expect(isLanguage('de')).toBe(false);

    applyUserLocales(payload({ code: 'de', strings: { 'settings.title': 'Einstellungen' } }));

    expect(isLanguage('de')).toBe(true);
  });

  it('falls back to English for keys the new language does not define', () => {
    applyUserLocales(payload({ code: 'de', strings: { 'settings.title': 'Einstellungen' } }));

    expect(translate('de', 'settings.tab.general')).toBe('General');
  });

  it('names the language after its code when no label is given', () => {
    applyUserLocales(payload({ code: 'de', strings: { 'settings.title': 'Einstellungen' } }));

    expect(LANGUAGES.find((l) => l.code === 'de')?.label).toBe('de');
  });
});

describe('applyUserLocales: overriding a bundled language (issue #147)', () => {
  it('replaces individual strings and leaves the rest bundled', () => {
    // The correction path: a native speaker fixes one string without waiting
    // for a release, and does not have to restate the other 462.
    applyUserLocales(payload({ code: 'ko', strings: { 'settings.title': '환경설정' } }));

    expect(translate('ko', 'settings.title')).toBe('환경설정');
    expect(translate('ko', 'settings.tab.general')).toBe('일반');
  });

  it('does not add a duplicate row to the dropdown', () => {
    applyUserLocales(payload({ code: 'ko', strings: { 'settings.title': '환경설정' } }));

    expect(LANGUAGES.filter((l) => l.code === 'ko')).toHaveLength(1);
    expect(getUserLocaleState().overrides).toEqual(['ko']);
  });

  it('can rename a bundled language, but keeps its own name by default', () => {
    applyUserLocales(payload({ code: 'ko', strings: { 'settings.title': '환경설정' } }));
    expect(LANGUAGES.find((l) => l.code === 'ko')?.label).toBe('한국어');

    applyUserLocales(
      payload({ code: 'ko', label: '한국어 (수정본)', strings: { 'settings.title': '환경설정' } }),
    );
    expect(LANGUAGES.find((l) => l.code === 'ko')?.label).toBe('한국어 (수정본)');
  });

  it('lets a user override English, which is also the fallback', () => {
    applyUserLocales(payload({ code: 'en', strings: { 'settings.title': 'Preferences' } }));

    expect(translate('en', 'settings.title')).toBe('Preferences');
    // Bundled English still backs every key the override did not touch.
    expect(translate('en', 'settings.tab.general')).toBe('General');
  });
});

describe('applyUserLocales: rejecting bad input (issue #147)', () => {
  it('drops keys the UI does not have and reports the count', () => {
    applyUserLocales(
      payload({
        code: 'de',
        strings: { 'settings.title': 'Einstellungen', 'not.a.real.key': 'x', 'also.fake': 'y' },
      }),
    );

    expect(DICTIONARIES.de).toEqual({ 'settings.title': 'Einstellungen' });
    expect(getUserLocaleState().errors).toContain('de: ignored 2 unknown key(s)');
  });

  it('ignores an entry whose keys are all unknown', () => {
    applyUserLocales(payload({ code: 'de', strings: { 'not.a.real.key': 'x' } }));

    expect(SUPPORTED_LANGUAGES).not.toContain('de');
  });

  it('ignores non-string values', () => {
    applyUserLocales(
      payload({ code: 'de', strings: { 'settings.title': 'Einstellungen', 'markdown.copy': 7 } }),
    );

    expect(DICTIONARIES.de).toEqual({ 'settings.title': 'Einstellungen' });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'nonsense'],
    ['an object with no locales', {}],
    ['locales that is not an array', { locales: 'nope' }],
    ['an entry with no code', { locales: [{ strings: { 'settings.title': 'x' } }] }],
    ['an entry with no strings', { locales: [{ code: 'de' }] }],
    ['an entry whose strings is an array', { locales: [{ code: 'de', strings: [] }] }],
  ])('survives %s and keeps every bundled language', (_label, bad) => {
    applyUserLocales(bad);

    expect(SUPPORTED_LANGUAGES).toEqual(BUILTIN_CODES);
    expect(translate('ko', 'settings.title')).toBe('설정');
  });

  it('carries loader errors through to the reported state', () => {
    applyUserLocales({ locales: [], errors: ['de.json: broken'], dir: '/home/u/.wmux/locales' });

    expect(getUserLocaleState().errors).toEqual(['de.json: broken']);
    expect(getUserLocaleState().dir).toBe('/home/u/.wmux/locales');
  });
});

describe('applyUserLocales: reloading (issue #147)', () => {
  it('rebuilds from scratch, so deleting a file removes its language', () => {
    applyUserLocales(payload({ code: 'de', strings: { 'settings.title': 'Einstellungen' } }));
    expect(SUPPORTED_LANGUAGES).toContain('de');

    applyUserLocales(payload());

    expect(SUPPORTED_LANGUAGES).toEqual(BUILTIN_CODES);
    expect(isLanguage('de')).toBe(false);
  });

  it('rebuilds from scratch, so removing an override restores the bundled string', () => {
    applyUserLocales(payload({ code: 'ko', strings: { 'settings.title': '환경설정' } }));
    expect(translate('ko', 'settings.title')).toBe('환경설정');

    applyUserLocales(payload());

    expect(translate('ko', 'settings.title')).toBe('설정');
  });

  it('bumps the revision so useT can repaint', () => {
    const before = getLocaleRevision();

    applyUserLocales(payload({ code: 'de', strings: { 'settings.title': 'Einstellungen' } }));

    expect(getLocaleRevision()).toBeGreaterThan(before);
  });

  it('keeps the English → fallback → key chain intact for a user language', () => {
    applyUserLocales(payload({ code: 'de', strings: { 'settings.title': 'Einstellungen' } }));

    const missing = 'nonexistent.key' as TranslationKey;
    expect(translate('de', missing, 'My Fallback')).toBe('My Fallback');
    expect(translate('de', missing)).toBe('nonexistent.key');
  });
});

// The two halves are tested in isolation above and in user-locales.test.ts,
// which means a field renamed on one side of the IPC boundary would pass both
// suites while shipping a feature that silently does nothing. This walks the
// real seam: a file on disk → the main-process loader → the renderer merge.
describe('user locales: loader → merge seam (issue #147)', () => {
  let dir: string;

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('turns a file on disk into a selectable language', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-seam-'));
    fs.writeFileSync(
      path.join(dir, 'de.json'),
      JSON.stringify({ label: 'Deutsch', strings: { 'settings.title': 'Einstellungen' } }),
      'utf-8',
    );

    applyUserLocales(loadUserLocales(dir));

    expect(isLanguage('de')).toBe(true);
    expect(LANGUAGES.find((l) => l.code === 'de')?.label).toBe('Deutsch');
    expect(translate('de', 'settings.title')).toBe('Einstellungen');
    expect(translate('de', 'settings.tab.general')).toBe('General');
  });

  it('applies an override to a bundled language from disk', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-seam-'));
    fs.writeFileSync(
      path.join(dir, 'ko.json'),
      JSON.stringify({ 'settings.title': '환경설정' }),
      'utf-8',
    );

    applyUserLocales(loadUserLocales(dir));

    expect(getUserLocaleState().overrides).toEqual(['ko']);
    expect(translate('ko', 'settings.title')).toBe('환경설정');
    expect(translate('ko', 'settings.tab.general')).toBe('일반');
  });
});
