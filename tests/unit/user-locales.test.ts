import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadUserLocales, getLocalesDir } from '../../src/main/user-locales';

// Community-provided translations (issue #147): ~/.wmux/locales/<code>.json.
// This is hand-edited, untrusted input read synchronously on the startup path,
// so the contract under test is "one bad file costs you that file" — never a
// throw, never the rest of the directory.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-loc-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, 'utf-8');
}

function writeJson(name: string, value: unknown): void {
  write(name, JSON.stringify(value));
}

describe('user-locales: loading (issue #147)', () => {
  it('reads a documented { label, strings } file', () => {
    writeJson('de.json', { label: 'Deutsch', strings: { 'settings.title': 'Einstellungen' } });

    const { locales, errors } = loadUserLocales(dir);

    expect(errors).toEqual([]);
    expect(locales).toHaveLength(1);
    expect(locales[0].code).toBe('de');
    expect(locales[0].label).toBe('Deutsch');
    expect(locales[0].strings['settings.title']).toBe('Einstellungen');
  });

  it('accepts a flat top-level map, which is what people actually write', () => {
    writeJson('de.json', { 'settings.title': 'Einstellungen', 'markdown.copy': 'Kopieren' });

    const { locales, errors } = loadUserLocales(dir);

    expect(errors).toEqual([]);
    expect(locales[0].strings).toEqual({
      'settings.title': 'Einstellungen',
      'markdown.copy': 'Kopieren',
    });
    // No label given — the code stands in so the dropdown still has a name.
    expect(locales[0].label).toBe('de');
  });

  it('does not treat `label` as a translated string in the flat form', () => {
    writeJson('de.json', { label: 'Deutsch', 'settings.title': 'Einstellungen' });

    const { locales } = loadUserLocales(dir);

    expect(locales[0].label).toBe('Deutsch');
    expect(locales[0].strings).toEqual({ 'settings.title': 'Einstellungen' });
  });

  it('returns an empty result when the directory does not exist', () => {
    const missing = path.join(dir, 'nope');
    expect(loadUserLocales(missing)).toEqual({ locales: [], errors: [], dir: missing });
  });

  it('ignores non-JSON files', () => {
    write('README.md', '# not a locale');
    writeJson('de.json', { 'settings.title': 'Einstellungen' });

    const { locales, errors } = loadUserLocales(dir);

    expect(locales.map((l) => l.code)).toEqual(['de']);
    expect(errors).toEqual([]);
  });

  it('defaults the locales dir to ~/.wmux/locales, beside config.toml', () => {
    expect(getLocalesDir()).toBe(path.join(os.homedir(), '.wmux', 'locales'));
  });
});

describe('user-locales: rejecting bad input (issue #147)', () => {
  it('keeps the good files when one is malformed', () => {
    write('de.json', '{ this is not json');
    writeJson('es.json', { 'settings.title': 'Ajustes' });

    const { locales, errors } = loadUserLocales(dir);

    expect(locales.map((l) => l.code)).toEqual(['es']);
    expect(errors.some((e) => e.startsWith('de.json:'))).toBe(true);
  });

  it('rejects region subtags, which auto-detection could never select', () => {
    // detectDefaultLanguage collapses "de-AT" to "de" before matching, so a
    // de-AT.json would define a language the OS locale can never resolve to.
    writeJson('de-AT.json', { 'settings.title': 'Einstellungen' });

    const { locales, errors } = loadUserLocales(dir);

    expect(locales).toEqual([]);
    expect(errors[0]).toContain('not a base language tag');
  });

  it('rejects a top-level array', () => {
    writeJson('de.json', [{ 'settings.title': 'x' }]);

    const { locales, errors } = loadUserLocales(dir);

    expect(locales).toEqual([]);
    expect(errors[0]).toContain('expected a JSON object');
  });

  it('reports a file with no usable strings rather than adding an empty language', () => {
    writeJson('de.json', { label: 'Deutsch' });

    const { locales, errors } = loadUserLocales(dir);

    expect(locales).toEqual([]);
    expect(errors[0]).toContain('no translated strings');
  });

  it('skips non-string values and says how many', () => {
    writeJson('de.json', { 'settings.title': 'Einstellungen', 'markdown.copy': 42 });

    const { locales, errors } = loadUserLocales(dir);

    expect(locales[0].strings).toEqual({ 'settings.title': 'Einstellungen' });
    expect(errors[0]).toContain('skipped 1 non-string');
  });

  it('rejects an oversized file without reading it into memory as a locale', () => {
    write('de.json', JSON.stringify({ 'settings.title': 'x'.repeat(1024 * 1024 + 10) }));

    const { locales, errors } = loadUserLocales(dir);

    expect(locales).toEqual([]);
    expect(errors[0]).toContain('too large');
  });

  it('caps how many files it will read', () => {
    for (let i = 0; i < 60; i++) {
      // Deliberately invalid codes: what is under test is the cap message, and
      // three-letter codes keep every filename a valid candidate to be counted.
      writeJson(`l${String(i).padStart(2, '0')}.json`, { 'settings.title': 'x' });
    }

    const { errors } = loadUserLocales(dir);

    expect(errors.some((e) => e.includes('only the first 50'))).toBe(true);
  });
});
