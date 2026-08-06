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
//
// On top of the bundled set, users can add or correct languages at runtime by
// dropping JSON into ~/.wmux/locales (issue #147) — see applyUserLocales below.

import { en, type Translation, type TranslationKey } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { it } from './locales/it';
import { ko } from './locales/ko';
import { zh } from './locales/zh';

// Adding a bundled language = one ./locales/xx.ts file + one row here.
// `Language`, SUPPORTED_LANGUAGES, the Settings dropdown and the persistence
// guard all derive from this table, so there is no second list to keep in sync.
const BUILTIN = [
  { code: 'en', label: 'English', dict: en as Translation },
  { code: 'es', label: 'Español', dict: es },
  { code: 'fr', label: 'Français', dict: fr },
  { code: 'it', label: 'Italiano', dict: it },
  { code: 'ko', label: '한국어', dict: ko },
  { code: 'zh', label: '中文', dict: zh },
] as const;

/** The codes wmux ships with. User locales may add more at runtime. */
export type BuiltinLanguage = (typeof BUILTIN)[number]['code'];

/**
 * A language code. Bundled codes still autocomplete; the `string & {}` arm
 * keeps that list suggestible while accepting the arbitrary codes a user can
 * introduce via ~/.wmux/locales. Runtime validation is `isLanguage`, which
 * checks the *merged* registry — never a hardcoded list.
 */
export type Language = BuiltinLanguage | (string & {});
export type { Translation, TranslationKey };

/** Every key the UI may ask for — used to reject unknown user-supplied keys. */
const EN_KEYS = new Set(Object.keys(en));

// Mutated in place rather than reassigned, so `import { LANGUAGES }` keeps
// working across a reload without relying on ES-module live bindings. The
// exported types are Readonly, so callers can't scribble on them.
const languages: Array<{ code: Language; label: string }> = [];
const supported: Language[] = [];

export const LANGUAGES: ReadonlyArray<{ code: Language; label: string }> = languages;
export const SUPPORTED_LANGUAGES: ReadonlyArray<Language> = supported;

/** Exported for the coverage/stale-key test; components should use `useT`. */
// Keyed by `string`, not `Language`: the set of codes is only known at runtime
// once ~/.wmux/locales has been merged, so a total Record would be a lie.
export const DICTIONARIES: Record<string, Translation> = {};

/** What the last ~/.wmux/locales load produced — surfaced by `wmux locales`. */
export interface UserLocaleState {
  /** Codes that came from disk, in load order. */
  codes: Language[];
  /** Codes that overrode a bundled language rather than adding a new one. */
  overrides: Language[];
  /** Loader errors plus any unknown-key reports from the merge. */
  errors: string[];
  /** The directory that was scanned. */
  dir: string;
}

let userLocaleState: UserLocaleState = { codes: [], overrides: [], errors: [], dir: '' };

export function getUserLocaleState(): UserLocaleState {
  return userLocaleState;
}

/**
 * Bumped whenever the dictionaries change. `useT` folds this into its
 * subscription so a `wmux reload-config` repaints translated UI; without it the
 * store never changes and React has no reason to re-render.
 */
let revision = 0;
export function getLocaleRevision(): number {
  return revision;
}

/** Shape of one entry from the main process's user-locale loader. */
interface RawUserLocale {
  code?: unknown;
  label?: unknown;
  strings?: unknown;
}

/**
 * Rebuild the registry from the bundled table plus `payload` (the main
 * process's ~/.wmux/locales scan). Idempotent and total: it always produces a
 * registry containing every bundled language, so a broken user file can widen
 * the error list but can never remove a shipped language.
 *
 * A user entry whose code matches a bundled one *overrides* individual strings
 * (the bundled dictionary stays underneath as the fallback); a new code adds a
 * language, falling back to English for whatever it doesn't translate.
 */
/**
 * Narrow one raw entry to the keys the UI actually has. Returns null when
 * there is nothing usable left; `errors` collects what was dropped and why.
 */
function sanitizeEntry(
  entry: RawUserLocale,
  errors: string[],
): { code: Language; label?: string; kept: Translation } | null {
  const code = typeof entry?.code === 'string' ? entry.code : '';
  if (!code) return null;

  const strings = entry?.strings;
  if (!strings || typeof strings !== 'object' || Array.isArray(strings)) return null;

  const kept: Translation = {};
  let unknown = 0;
  for (const [key, value] of Object.entries(strings as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    // Unknown keys are almost always typos or keys stranded by an English
    // rename. Dropping them keeps a stale community file from bloating the
    // dictionary, and the count tells the translator to go look.
    if (EN_KEYS.has(key)) kept[key as TranslationKey] = value;
    else unknown++;
  }
  if (unknown > 0) errors.push(`${code}: ignored ${unknown} unknown key(s)`);
  if (Object.keys(kept).length === 0) return null;

  const rawLabel = entry?.label;
  const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : undefined;
  return { code, label, kept };
}

export function applyUserLocales(payload: unknown): UserLocaleState {
  const raw = (payload ?? {}) as { locales?: unknown; errors?: unknown; dir?: unknown };
  const incoming = Array.isArray(raw.locales) ? (raw.locales as RawUserLocale[]) : [];
  const errors: string[] = Array.isArray(raw.errors)
    ? raw.errors.filter((e) => typeof e === 'string')
    : [];
  const codes: Language[] = [];
  const overrides: Language[] = [];

  // Start from the bundled set; every rebuild is from scratch so removing a
  // file from ~/.wmux/locales actually removes its effect on the next reload.
  const merged = new Map<Language, { label: string; dict: Translation }>();
  for (const { code, label, dict } of BUILTIN) {
    merged.set(code, { label, dict });
  }

  for (const entry of incoming) {
    const clean = sanitizeEntry(entry, errors);
    if (!clean) continue;
    const existing = merged.get(clean.code);
    if (existing) overrides.push(clean.code);
    codes.push(clean.code);
    merged.set(clean.code, {
      label: clean.label ?? existing?.label ?? clean.code,
      // User strings win; the bundled dictionary remains the fallback beneath.
      dict: { ...(existing?.dict ?? {}), ...clean.kept },
    });
  }

  languages.length = 0;
  supported.length = 0;
  for (const key of Object.keys(DICTIONARIES)) delete DICTIONARIES[key];
  for (const [code, { label, dict }] of merged) {
    languages.push({ code, label });
    supported.push(code);
    DICTIONARIES[code] = dict;
  }

  revision++;
  translators.clear();
  userLocaleState = { codes, overrides, errors, dir: typeof raw.dir === 'string' ? raw.dir : '' };
  return userLocaleState;
}

/** Translate a key for an explicit language (English → fallback → key chain). */
export function translate(lang: Language, key: TranslationKey, fallback?: string): string {
  return DICTIONARIES[lang]?.[key] ?? DICTIONARIES.en?.[key] ?? fallback ?? key;
}

export type Translator = (key: TranslationKey, fallback?: string) => string;

// One translator per language, kept until the dictionaries change (there are a
// handful of languages). The identity has to be stable: `useT()`'s result is
// fed into `useCallback` and `useEffect` dependency arrays across the renderer,
// and a fresh closure per render invalidates every one of them. That is how the
// diff pane's 2s poll degenerated into a render-speed loop spawning `git.exe`
// (issue #141). A locale reload clears the cache on purpose — that is a real
// content change, and it happens only on an explicit `wmux reload-config`.
const translators = new Map<Language, Translator>();

/** The translator for `lang` — same function object on every call. */
export function makeT(lang: Language): Translator {
  let t = translators.get(lang);
  if (!t) {
    t = (key, fallback) => translate(lang, key, fallback);
    translators.set(lang, t);
  }
  return t;
}

/** Narrow an untrusted value (persisted setting, CLI arg) to a known language. */
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && supported.includes(value);
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

/**
 * Read ~/.wmux/locales through the preload bridge and merge it in. Called once
 * at module load — before the settings slice reads the persisted language, so
 * a user-defined code survives a restart instead of being reset to English by
 * the `isLanguage` guard.
 */
export function loadUserLocalesFromBridge(): void {
  let payload: unknown;
  try {
    payload = (globalThis as any).window?.wmux?.settings?.getUserLocalesSync?.();
  } catch {
    payload = undefined; /* preload bridge unavailable (tests) */
  }
  applyUserLocales(payload);
}

loadUserLocalesFromBridge();
