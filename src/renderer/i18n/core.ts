// ─── wmux UI internationalization — pure core (issue #56) ────────────────────
// Registry and pure helpers with NO store dependency. The settings slice
// imports from here (for the default-language detection at store-creation
// time); keeping this module store-free avoids a circular import between the
// store and the `useT` hook (which lives in ./index and *does* read the store).
//
// The dictionaries live one per file in ./locales. Coverage is intentionally
// pragmatic ("main UI"): Settings chrome, the General panel, command palette,
// titlebar, markdown pane, and the workspace context menu. Any key missing from
// the active language falls back to English, then to the literal key, so a
// partial translation never renders blank.

import { en, type Translation, type TranslationKey } from './locales/en';
import { fr } from './locales/fr';
import { it } from './locales/it';
import { zh } from './locales/zh';

// Adding a language = one ./locales/xx.ts file + one row here. `Language`,
// SUPPORTED_LANGUAGES, the Settings dropdown and the persistence guard all
// derive from this table, so there is no second list to keep in sync.
const REGISTRY = [
  { code: 'en', label: 'English', dict: en as Translation },
  { code: 'fr', label: 'Français', dict: fr },
  { code: 'it', label: 'Italiano', dict: it },
  { code: 'zh', label: '中文', dict: zh },
] as const;

export type Language = (typeof REGISTRY)[number]['code'];
export type { Translation, TranslationKey };

export const LANGUAGES: ReadonlyArray<{ code: Language; label: string }> = REGISTRY.map(
  ({ code, label }) => ({ code, label }),
);

export const SUPPORTED_LANGUAGES: ReadonlyArray<Language> = REGISTRY.map((l) => l.code);

/** Exported for the coverage/stale-key test; components should use `useT`. */
export const DICTIONARIES = Object.fromEntries(REGISTRY.map((l) => [l.code, l.dict])) as Record<
  Language,
  Translation
>;

/** Translate a key for an explicit language (English → fallback → key chain). */
export function translate(lang: Language, key: TranslationKey, fallback?: string): string {
  return DICTIONARIES[lang]?.[key] ?? DICTIONARIES.en[key] ?? fallback ?? key;
}

/** Narrow an untrusted value (persisted setting, CLI arg) to a shipped language. */
export function isLanguage(value: unknown): value is Language {
  return SUPPORTED_LANGUAGES.includes(value as Language);
}

/** "fr-FR" / "fr_FR" → "fr"; returns undefined for unsupported languages. */
function toSupported(tag: unknown): Language | undefined {
  const base = String(tag ?? '').toLowerCase().split(/[-_]/)[0];
  return isLanguage(base) ? base : undefined;
}

/**
 * Best-effort default from the OS locale so first-launch users (e.g. the
 * Chinese reporter of issue #56) see their language without touching Settings.
 *
 * The OS display-language list (GetUserPreferredUILanguages via the preload
 * bridge) is consulted FIRST: navigator.language follows Chromium's locale
 * resolution, which can pick up regional-format/Accept-Language settings and
 * disagree with the language Windows actually displays — issue #114 was an
 * English-display machine getting French tooltips this way. The first entry
 * in a supported language wins; anything unsupported falls back to English.
 */
export function detectDefaultLanguage(): Language {
  try {
    const preferred: unknown = (globalThis as any).window?.wmux?.settings?.getPreferredLanguagesSync?.();
    if (Array.isArray(preferred) && preferred.length) {
      // The OS list is authoritative when present — match the display language
      // (entry 0), not "any supported language anywhere in the list", so a
      // machine displaying English with French further down stays English.
      return toSupported(preferred[0]) ?? 'en';
    }
  } catch {
    /* preload bridge unavailable (tests) */
  }
  try {
    const lang = toSupported((globalThis as any).navigator?.language);
    if (lang) return lang;
  } catch {
    /* navigator unavailable (tests) */
  }
  return 'en';
}
