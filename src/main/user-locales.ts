/**
 * user-locales.ts — Community-provided UI translations (issue #147).
 *
 * Anyone can add or correct a language without waiting for a wmux release by
 * dropping a JSON file into `~/.wmux/locales/`, next to `config.toml`:
 *
 *   ~/.wmux/locales/de.json      → adds German to the language dropdown
 *   ~/.wmux/locales/ko.json      → overrides individual bundled Korean strings
 *
 * File shape (`label` optional, `strings` may be flattened to the top level):
 *
 *   { "label": "Deutsch", "strings": { "settings.title": "Einstellungen" } }
 *
 * This module owns IO and *shape* only. It deliberately does not know the set
 * of valid translation keys — that lives in the renderer's English dictionary,
 * which is also where unknown keys get dropped and reported. Splitting it that
 * way keeps the main process free of renderer imports.
 *
 * Everything here is defensive: one unreadable or malformed file costs you that
 * file and produces an error string, never the rest of the directory and never
 * a throw. A user's hand-edited JSON is untrusted input on a startup path.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** A translation file that parsed successfully. */
export interface UserLocale {
  /** Base language tag taken from the filename, e.g. `de` (always lowercase). */
  code: string;
  /** Display name for the Settings dropdown. Defaults to the code. */
  label: string;
  /** Raw key → string map. Unknown keys are filtered out in the renderer. */
  strings: Record<string, string>;
  /** Absolute path the entry was read from (for diagnostics). */
  path: string;
}

export interface UserLocalesResult {
  locales: UserLocale[];
  /** Non-fatal problems, surfaced via `wmux locales`. */
  errors: string[];
  /** The directory that was scanned, whether or not it exists. */
  dir: string;
}

/**
 * Base tags only (`de`, not `de-AT`). Language detection collapses the OS
 * locale to its base tag before matching, so a region-subtagged file would
 * define a language that auto-detection could never select — better to reject
 * it with a message than to ship a language that silently never activates.
 */
const CODE_RE = /^[a-z]{2,3}$/;

/** Defensive ceilings — this runs synchronously on the startup path. */
const MAX_FILES = 50;
const MAX_BYTES = 1024 * 1024;

export function getLocalesDir(): string {
  return path.join(os.homedir(), '.wmux', 'locales');
}

/** A per-file outcome: either a locale, or the reason it was rejected. */
type FileResult = { locale: UserLocale; warnings: string[] } | { error: string };

/** Read and JSON-parse one file, enforcing the size/type ceilings. */
function readJsonObject(file: string): Record<string, unknown> | { error: string } {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { error: 'not a regular file' };
    if (stat.size > MAX_BYTES) return { error: 'too large (max 1 MB)' };
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'expected a JSON object' };
    }
    return parsed as Record<string, unknown>;
  } catch (e: any) {
    return { error: String(e?.message || e) };
  }
}

/**
 * Pull the key → string map out of a parsed file. `strings` is the documented
 * shape; a flat top-level map is accepted too, because that is what a
 * translator writes when they skim the example rather than read it.
 */
function extractStrings(obj: Record<string, unknown>): {
  strings: Record<string, string>;
  skipped: number;
} {
  const nested = obj.strings;
  const isNested = !!nested && typeof nested === 'object' && !Array.isArray(nested);
  const source = isNested ? (nested as Record<string, unknown>) : obj;

  const strings: Record<string, string> = {};
  let skipped = 0;
  for (const [key, value] of Object.entries(source)) {
    if (!isNested && (key === 'label' || key === 'strings')) continue;
    if (typeof value === 'string') strings[key] = value;
    else skipped++;
  }
  return { strings, skipped };
}

/** Validate one `<code>.json` entry into a locale or a rejection reason. */
function loadOne(dir: string, entry: string): FileResult {
  const code = entry.slice(0, -'.json'.length).toLowerCase();
  if (!CODE_RE.test(code)) {
    return {
      error: `"${code}" is not a base language tag (expected 2–3 letters, e.g. de.json)`,
    };
  }

  const file = path.join(dir, entry);
  const obj = readJsonObject(file);
  if ('error' in obj) return { error: obj.error as string };

  const { strings, skipped } = extractStrings(obj);
  if (Object.keys(strings).length === 0) return { error: 'no translated strings found' };

  const rawLabel = obj.label;
  const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : code;

  return {
    locale: { code, label, strings, path: file },
    warnings: skipped > 0 ? [`skipped ${skipped} non-string value(s)`] : [],
  };
}

/** List the `*.json` entries in the locales dir, capped and sorted. */
function listEntries(dir: string): { entries: string[]; errors: string[] } {
  let entries: string[];
  try {
    if (!fs.existsSync(dir)) return { entries: [], errors: [] };
    entries = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch (e: any) {
    return { entries: [], errors: [`${dir}: read failed: ${e?.message || e}`] };
  }

  entries.sort();
  if (entries.length > MAX_FILES) {
    return {
      entries: entries.slice(0, MAX_FILES),
      errors: [`${dir}: ${entries.length} files found, only the first ${MAX_FILES} were read`],
    };
  }
  return { entries, errors: [] };
}

export function loadUserLocales(dir: string = getLocalesDir()): UserLocalesResult {
  const { entries, errors } = listEntries(dir);
  const locales: UserLocale[] = [];

  for (const entry of entries) {
    const result = loadOne(dir, entry);
    if ('error' in result) {
      errors.push(`${entry}: ${result.error}`);
      continue;
    }
    for (const warning of result.warnings) errors.push(`${entry}: ${warning}`);
    locales.push(result.locale);
  }

  return { locales, errors, dir };
}
