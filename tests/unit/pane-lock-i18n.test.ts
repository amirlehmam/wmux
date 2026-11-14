import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { en } from '../../src/renderer/i18n/locales/en';
import { cs } from '../../src/renderer/i18n/locales/cs';
import { de } from '../../src/renderer/i18n/locales/de';
import { es } from '../../src/renderer/i18n/locales/es';
import { fr } from '../../src/renderer/i18n/locales/fr';
import { hi } from '../../src/renderer/i18n/locales/hi';
import { it as itLocale } from '../../src/renderer/i18n/locales/it';
import { ja } from '../../src/renderer/i18n/locales/ja';
import { ko } from '../../src/renderer/i18n/locales/ko';
import { nl } from '../../src/renderer/i18n/locales/nl';
import { pl } from '../../src/renderer/i18n/locales/pl';
import { pt } from '../../src/renderer/i18n/locales/pt';
import { ru } from '../../src/renderer/i18n/locales/ru';
import { sv } from '../../src/renderer/i18n/locales/sv';
import { tr } from '../../src/renderer/i18n/locales/tr';
import { uk } from '../../src/renderer/i18n/locales/uk';
import { zh } from '../../src/renderer/i18n/locales/zh';
import { zhTW } from '../../src/renderer/i18n/locales/zh-TW';

const KEYS = ['surfaceTab.lockPane', 'surfaceTab.unlockPane', 'surfaceTab.lockedTooltip', 'palette.allPanesLocked'] as const;

const LOCALES: Record<string, Partial<Record<string, string>>> = {
  cs, de, es, fr, hi, it: itLocale, ja, ko, nl, pl, pt, ru, sv, tr, uk, zh, 'zh-TW': zhTW,
};

const placeholders = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort();

describe('pane lock translations', () => {
  it('covers every locale file in the folder', () => {
    const files = readdirSync(join(__dirname, '../../src/renderer/i18n/locales'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/, ''))
      .sort();
    expect(files).toEqual(['en', ...Object.keys(LOCALES)].sort());
    expect(files).toHaveLength(18);
  });

  it('defines the English source strings', () => {
    expect(en['surfaceTab.lockPane']).toBe('Lock pane');
    expect(en['surfaceTab.unlockPane']).toBe('Unlock pane');
    expect(en['surfaceTab.lockedTooltip'].length).toBeGreaterThan(0);
    expect(en['palette.allPanesLocked']).toBe('All panes are locked. Unlock one to open a file.');
  });

  for (const [code, strings] of Object.entries(LOCALES)) {
    it(`${code} translates every key, non-empty, same placeholders`, () => {
      for (const key of KEYS) {
        const value = strings[key];
        expect(value, `${code} missing ${key}`).toBeDefined();
        expect(value!.trim().length, `${code} ${key}`).toBeGreaterThan(0);
        expect(value, `${code} ${key} is an English copy`).not.toBe(en[key]);
        expect(placeholders(value!), `${code} ${key}`).toEqual(placeholders(en[key]));
      }
    });
  }
});
