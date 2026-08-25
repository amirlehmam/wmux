/**
 * Screen-manifest detection — the evaluator.
 *
 * Pure: everything it learns is in its return value, and it touches no clock,
 * no filesystem and no globals. That is what lets `wmux detect explain --file`
 * replay a captured screen with no running wmux, which is how a rule regression
 * gets debugged.
 */
import {
  DetectionInput,
  DetectionResult,
  LIMITS,
  Manifest,
  Matcher,
  Region,
  Rule,
} from './types';

/**
 * Reject the regex shapes that backtrack exponentially.
 *
 * A quantifier applied to a group that itself contains a quantifier — `(a+)+`,
 * `(\s*\w*)*` — is the classic catastrophic form, and the only one that matters
 * at the input sizes here. This is a heuristic, not a decision procedure; the
 * real bound is MAX_LINE_CHARS, which caps the input a pattern can chew on.
 * Both together mean a bad pattern is slow, not fatal.
 *
 * Exported because manifest validation refuses a user override on this, and it
 * must be the same rule in both places.
 */
const QUANTIFIERS = new Set(['+', '*', '{']);

/** Index just past the `[...]` class starting at `open`. Escapes inside are skipped. */
function endOfCharClass(source: string, open: number): number {
  let i = open + 1;
  while (i < source.length && source[i] !== ']') {
    if (source[i] === '\\') i += 1;
    i += 1;
  }
  return i;
}

/**
 * Consume one token, returning the next cursor — or -1 when the pattern is
 * rejected. `groupHasQuantifier` is the open-group stack, mutated in place.
 */
function scanRegexToken(source: string, at: number, groupHasQuantifier: boolean[]): number {
  const ch = source[at];

  if (ch === '\\') return at + 2;
  if (ch === '[') return endOfCharClass(source, at) + 1;
  if (ch === '(') { groupHasQuantifier.push(false); return at + 1; }

  if (ch === ')') {
    const nested = groupHasQuantifier.pop() ?? false;
    return nested && QUANTIFIERS.has(source[at + 1]) ? -1 : at + 1;
  }

  if (QUANTIFIERS.has(ch) && groupHasQuantifier.length > 0) {
    groupHasQuantifier[groupHasQuantifier.length - 1] = true;
  }
  return at + 1;
}

export function isSafeRegexSource(source: string): boolean {
  if (source.length > LIMITS.MAX_MATCHER_CHARS) return false;

  // Walk once, tracking for each open group whether it contains a quantifier.
  // A nested-quantifier group is one that contained one AND is itself quantified.
  const groupHasQuantifier: boolean[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    cursor = scanRegexToken(source, cursor, groupHasQuantifier);
    if (cursor < 0) return false;
  }
  return true;
}

/** Compile once per matcher, cached by source. Invalid or unsafe → never matches. */
const regexCache = new Map<string, RegExp | null>();

function compile(source: string, ignoreCase: boolean): RegExp | null {
  const key = `${ignoreCase ? 'i' : ''}:${source}`;
  const cached = regexCache.get(key);
  if (cached !== undefined) return cached;

  let compiled: RegExp | null = null;
  if (isSafeRegexSource(source)) {
    try {
      compiled = new RegExp(source, ignoreCase ? 'iu' : 'u');
    } catch {
      // An invalid pattern is a broken rule, not a crash. It simply never fires,
      // and `explain` reports the rule as unmatched.
      compiled = null;
    }
  }
  if (regexCache.size > 512) regexCache.clear();
  regexCache.set(key, compiled);
  return compiled;
}

/** Cut the region a rule asked for out of the screen. */
export function sliceRegion(input: DetectionInput, region: Region): string[] {
  if (region.id === 'osc_title') {
    const title = input.title?.trim();
    return title ? [title] : [];
  }

  const lines = input.lines;
  const count = Math.min(region.count ?? LIMITS.MAX_REGION_LINES, LIMITS.MAX_REGION_LINES);

  switch (region.id) {
    case 'whole_recent':
      return lines.slice(-LIMITS.MAX_REGION_LINES);
    case 'bottom_lines':
      return lines.slice(-count);
    case 'bottom_non_empty_lines':
      return lines.filter((l) => l.trim().length > 0).slice(-count);
    case 'top_non_empty_lines':
      return lines.filter((l) => l.trim().length > 0).slice(0, count);
    default:
      return [];
  }
}

/** One line against one already-prepared matcher. */
function lineMatches(
  line: string,
  kind: Matcher['kind'],
  needle: string,
  ignoreCase: boolean,
  regex: RegExp | null,
): boolean {
  if (kind === 'lineRegex') return regex!.test(line);

  const haystack = ignoreCase ? line.toLowerCase() : line;
  if (kind === 'contains') return haystack.includes(needle);
  if (kind === 'lineStartsWith') return haystack.trimStart().startsWith(needle);
  return haystack.trimEnd().endsWith(needle);
}

/** The line a matcher hit, or null. Returning the LINE rather than a boolean is what feeds `explain`. */
function matchLine(lines: string[], matcher: Matcher): string | null {
  if (matcher.value.length === 0 || matcher.value.length > LIMITS.MAX_MATCHER_CHARS) return null;

  const ignoreCase = !!matcher.ignoreCase;
  const needle = ignoreCase ? matcher.value.toLowerCase() : matcher.value;
  const regex = matcher.kind === 'lineRegex' ? compile(matcher.value, ignoreCase) : null;
  // An unsafe or invalid pattern is a broken rule that never fires, not a throw.
  if (matcher.kind === 'lineRegex' && !regex) return null;

  for (const raw of lines) {
    // Bounded before it reaches any matcher, regex or not: this is the real
    // guard on backtracking, and it costs one slice on an already-short string.
    const line = raw.length > LIMITS.MAX_LINE_CHARS ? raw.slice(0, LIMITS.MAX_LINE_CHARS) : raw;
    if (lineMatches(line, matcher.kind, needle, ignoreCase, regex)) return raw;
  }
  return null;
}

/** Does this rule fire, and on what evidence? */
function evaluateRule(input: DetectionInput, rule: Rule): string[] | null {
  const region = sliceRegion(input, rule.region);
  if (region.length === 0) return null;

  const evidence: string[] = [];

  for (const matcher of rule.all ?? []) {
    const hit = matchLine(region, matcher);
    if (!hit) return null;
    evidence.push(hit);
  }

  if (rule.any && rule.any.length > 0) {
    const hit = rule.any.map((m) => matchLine(region, m)).find(Boolean);
    if (!hit) return null;
    evidence.push(hit);
  }

  for (const matcher of rule.none ?? []) {
    if (matchLine(region, matcher)) return null;
  }

  // A rule with no matchers at all would fire on every screen — treat it as
  // broken rather than as a catch-all, which is the more dangerous reading.
  if (!rule.all?.length && !rule.any?.length) return null;

  return evidence;
}

/** Does any signature claim this screen? */
function manifestClaims(input: DetectionInput, manifest: Manifest): boolean {
  // Signatures deliberately look at the WHOLE recent screen rather than a tuned
  // region: identity is a slower-moving fact than state, and an agent whose
  // footer scrolled under a long tool output is still that agent.
  const region = sliceRegion(input, { id: 'whole_recent' });
  const title = input.title?.trim();
  const withTitle = title ? [...region, title] : region;
  return manifest.signatures.some((m) => matchLine(withTitle, m) !== null);
}

const EMPTY: DetectionResult = {
  agent: null, state: 'unknown', ruleId: null, reason: 'empty-screen',
  manifestVersion: null, evidence: [],
};

/**
 * Read one screen.
 *
 * `expectedAgent` narrows to a single manifest when identity is already known
 * from a command line or the process probe. That is not an optimisation: it
 * stops a Claude pane that happens to be DISPLAYING a Codex transcript from
 * being read with Codex's rules, which is a real failure mode for an agent that
 * quotes terminal output back at you.
 */
export function detectScreen(
  input: DetectionInput,
  manifests: Manifest[],
  expectedAgent?: string | null,
): DetectionResult {
  const hasScreen = input.lines.some((l) => l.trim().length > 0);
  if (!hasScreen && !input.title?.trim()) return EMPTY;

  const candidates = expectedAgent
    ? manifests.filter((m) => m.agent === expectedAgent)
    : manifests;

  const manifest = candidates.find((m) => manifestClaims(input, m))
    // A known agent whose chrome is off screen still gets its rules run: the
    // command line already established WHO, and demanding the signature too
    // would throw away the more authoritative fact.
    ?? (expectedAgent ? candidates[0] : undefined);

  if (!manifest) {
    return { ...EMPTY, reason: 'no-agent-signature' };
  }

  const rules = manifest.rules.slice(0, LIMITS.MAX_RULES);
  // Stable within a priority: `sort` is stable per spec, so equal priorities
  // keep file order and a manifest author can rank by position.
  const ordered = [...rules].sort((a, b) => b.priority - a.priority);

  for (const rule of ordered) {
    const evidence = evaluateRule(input, rule);
    if (evidence) {
      return {
        agent: manifest.agent,
        state: rule.state,
        ruleId: rule.id,
        reason: 'matched',
        manifestVersion: manifest.version,
        evidence,
      };
    }
  }

  // The divergence that matters. The prior art returns `idle` here and labels
  // it a fallback; wmux returns `unknown`, because `idle` is a claim and no one
  // made it. A new prompt shape wmux has not learned reads as "we don't know",
  // never as "nothing is happening" — which is the failure that would hide the
  // one pane that needs the user.
  return {
    agent: manifest.agent,
    state: 'unknown',
    ruleId: null,
    reason: 'no-rule-matched',
    manifestVersion: manifest.version,
    evidence: [],
  };
}
