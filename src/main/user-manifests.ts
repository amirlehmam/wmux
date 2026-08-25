/**
 * User-authored detection manifests.
 *
 * `%APPDATA%\wmux\agent-detection\<agent>.json`, one file per agent, replacing
 * the bundled manifest for that agent entirely.
 *
 * This is the hotfix path, and it is the ONLY part of the prior art's manifest
 * distribution wmux adopts. What is deliberately NOT adopted is remote fetching:
 * theirs downloads rule updates from a hardcoded host with no signature and no
 * checksum — trust is 100% curl's TLS — and its catalog URL env var accepts
 * `file://`. wmux is an unsigned Electron app already fighting SmartScreen;
 * adding a network-fetched rule feed to it is a bad trade for a feature nobody
 * asked for. A user whose agent changed its prompt shape edits one JSON file, or
 * waits for a release, which wmux cuts often.
 *
 * Every failure here degrades to "use the bundled manifest" with a warning.
 * A malformed override must never take detection down with it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { Manifest, Matcher, Rule, LIMITS } from '../shared/detection/types';
import { isSafeRegexSource } from '../shared/detection/engine';
import { AGENT_ALIASES } from './agent-argv';

export function userManifestDir(): string {
  return path.join(app.getPath('userData'), 'agent-detection');
}

const STATES = new Set(['blocked', 'working', 'idle']);
const REGIONS = new Set([
  'whole_recent', 'bottom_lines', 'bottom_non_empty_lines', 'top_non_empty_lines', 'osc_title',
]);

/**
 * Matcher kinds a USER override may use.
 *
 * `lineRegex` is absent, and that is the point. Every bundled regex is written
 * and reviewed by a maintainer and pinned by a fixture; a hand-edited one is
 * neither, and JavaScript's RegExp backtracks catastrophically where the Rust
 * engine the prior art uses cannot. isSafeRegexSource rejects the classic
 * nested-quantifier shape, but it is a heuristic and this loop runs several
 * times a second over every pane. Literal matchers cannot backtrack at all, so
 * the override path gets the kinds that are safe by construction.
 */
const USER_MATCHER_KINDS = new Set(['contains', 'lineStartsWith', 'lineEndsWith']);

function validMatcher(raw: unknown, allowRegex: boolean): Matcher | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const kind = typeof m.kind === 'string' ? m.kind : '';
  const value = typeof m.value === 'string' ? m.value : '';

  if (!value || value.length > LIMITS.MAX_MATCHER_CHARS) return null;
  if (kind === 'lineRegex') {
    if (!allowRegex || !isSafeRegexSource(value)) return null;
  } else if (!USER_MATCHER_KINDS.has(kind)) {
    return null;
  }

  return { kind: kind as Matcher['kind'], value, ignoreCase: m.ignoreCase === true };
}

function validMatchers(raw: unknown, allowRegex: boolean): Matcher[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.map((m) => validMatcher(m, allowRegex)).filter((m): m is Matcher => m !== null);
  return out.length > 0 ? out : undefined;
}

function validRule(raw: unknown, allowRegex: boolean): Rule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const id = typeof r.id === 'string' ? r.id : '';
  const state = typeof r.state === 'string' ? r.state : '';
  if (!id || !STATES.has(state)) return null;

  const region = (r.region ?? {}) as Record<string, unknown>;
  const regionId = typeof region.id === 'string' ? region.id : '';
  if (!REGIONS.has(regionId)) return null;

  const all = validMatchers(r.all, allowRegex);
  const any = validMatchers(r.any, allowRegex);
  // Same rule as the engine's: a rule with no positive matcher would fire on
  // every screen, which is the more dangerous reading of "no conditions".
  if (!all && !any) return null;

  return {
    id,
    state: state as Rule['state'],
    priority: typeof r.priority === 'number' && Number.isFinite(r.priority) ? r.priority : 500,
    region: {
      id: regionId as Rule['region']['id'],
      count: typeof region.count === 'number' ? Math.max(1, Math.floor(region.count)) : undefined,
    },
    all,
    any,
    none: validMatchers(r.none, allowRegex),
  };
}

/**
 * Parse and validate one override.
 *
 * Exported and pure so it can be tested without a filesystem, and so the same
 * validation runs in `wmux detect explain --file`.
 */
export function parseUserManifest(
  json: unknown,
  options: { allowRegex?: boolean } = {},
): { manifest: Manifest | null; errors: string[] } {
  const errors: string[] = [];
  if (!json || typeof json !== 'object') return { manifest: null, errors: ['not an object'] };

  const raw = json as Record<string, unknown>;
  const agent = typeof raw.agent === 'string' ? raw.agent : '';
  if (!agent) return { manifest: null, errors: ['missing "agent"'] };
  // Bound to agents wmux can otherwise name, so an override cannot invent a
  // kind that no other layer will ever agree with.
  if (!(agent in AGENT_ALIASES)) {
    return { manifest: null, errors: [`unknown agent "${agent}" — see AGENT_ALIASES`] };
  }

  const allowRegex = options.allowRegex === true;
  const signatures = validMatchers(raw.signatures, allowRegex);
  if (!signatures) errors.push('no valid "signatures"');

  const rulesRaw = Array.isArray(raw.rules) ? raw.rules.slice(0, LIMITS.MAX_RULES) : [];
  const rules: Rule[] = [];
  rulesRaw.forEach((r, i) => {
    const rule = validRule(r, allowRegex);
    if (rule) rules.push(rule);
    else errors.push(`rule[${i}] rejected`);
  });

  if (!signatures || rules.length === 0) {
    errors.push('override ignored — falling back to the bundled manifest');
    return { manifest: null, errors };
  }

  return {
    manifest: {
      agent,
      version: typeof raw.version === 'number' ? raw.version : 0,
      signatures,
      rules,
    },
    errors,
  };
}

export interface LoadedOverrides {
  manifests: Manifest[];
  warnings: string[];
}

/**
 * Read every override in the config directory.
 *
 * Never throws. A missing directory is the normal case and produces no warning;
 * anything else produces one and is skipped.
 */
export function loadUserManifests(dir = userManifestDir()): LoadedOverrides {
  const manifests: Manifest[] = [];
  const warnings: string[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch {
    return { manifests, warnings };
  }

  for (const entry of entries.slice(0, 64)) {
    const file = path.join(dir, entry);
    try {
      const parsed = parseUserManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (parsed.manifest) manifests.push(parsed.manifest);
      for (const error of parsed.errors) warnings.push(`${entry}: ${error}`);
    } catch (err) {
      warnings.push(`${entry}: ${(err as Error).message}`);
    }
  }

  return { manifests, warnings };
}

/**
 * Overrides replace bundled manifests by agent; unmatched bundled ones survive.
 *
 * Replace rather than merge: a partial merge would leave the user guessing
 * which of their rules is competing with which of ours, and "my file did not
 * take effect" is the one failure mode a hotfix path cannot afford.
 */
export function mergeManifests(bundled: Manifest[], overrides: Manifest[]): Manifest[] {
  const byAgent = new Map(bundled.map((m) => [m.agent, m]));
  for (const override of overrides) byAgent.set(override.agent, override);
  return [...byAgent.values()];
}
