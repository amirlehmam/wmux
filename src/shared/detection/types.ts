/**
 * Screen-manifest detection — the data model.
 *
 * Phase 1 and 2 gave wmux "who needs me?" and "which agent is this?". Both
 * still depend on the agent COOPERATING: declared state comes from hooks and
 * the CLI, and identity from a command line. An agent that neither reports nor
 * was launched under a name wmux recognises is a pane wmux can see and cannot
 * read. This module closes that by reading the one thing every agent produces
 * unconditionally — its own UI.
 *
 * Lives under `src/shared/` because it is pure string work with no Electron and
 * no Node: the renderer runs it (that is where the xterm buffer is), main
 * validates user overrides against it, and vitest exercises it directly.
 *
 * Two deliberate divergences from the prior art this is modelled on (herdr):
 *
 *   1. The no-match fallback is `unknown`, NOT `idle`. herdr has no unknown
 *      state so it must guess, and labels the guess
 *      `default_known_agent_idle_fallback`. wmux has a real `unknown`, and
 *      invariant 1 of the declared-state protocol says `idle` is a CLAIM. An
 *      agent whose screen we failed to parse has claimed nothing.
 *   2. Detection NEVER overrides declared state. See DetectionResult.
 */

/** What a rule concludes. Detection cannot conclude `unknown` — that is absence of a conclusion. */
export type DetectedState = 'blocked' | 'working' | 'idle';

/**
 * How one matcher tests a region.
 *
 * There is intentionally no whole-buffer regex kind. Every regex here is
 * applied PER LINE, so its input is bounded by the terminal width rather than
 * by the scrollback — which is what keeps JavaScript's backtracking engine from
 * being a denial-of-service surface. The Rust prior art did not need this care:
 * the `regex` crate is linear-time by construction and cannot backtrack.
 */
export type MatcherKind = 'contains' | 'lineStartsWith' | 'lineEndsWith' | 'lineRegex';

export interface Matcher {
  kind: MatcherKind;
  /** Literal text, or a regex source for `lineRegex`. */
  value: string;
  /** Default false. Applied by lowercasing both sides, not by a regex flag. */
  ignoreCase?: boolean;
}

/**
 * Which part of the screen a rule looks at.
 *
 * `bottom*` regions are why detection survives scrollback: the snapshot is
 * taken from the END of the buffer, not from the viewport, so scrolling up to
 * read history does not change what detection sees.
 */
export type RegionId =
  | 'whole_recent'
  | 'bottom_lines'
  /** Bottom N lines with blanks dropped — agent UIs pad heavily. */
  | 'bottom_non_empty_lines'
  | 'top_non_empty_lines'
  /** The OSC 0/2 terminal title, when the surface reported one. */
  | 'osc_title';

export interface Region {
  id: RegionId;
  /** Line count for the `*_lines` regions. Ignored by the others. */
  count?: number;
}

export interface Rule {
  /** Stable, and shown by `wmux detect explain`. */
  id: string;
  state: DetectedState;
  /** Higher wins. Equal priority → first in file, so order is meaningful. */
  priority: number;
  region: Region;
  /** Every matcher must hit. */
  all?: Matcher[];
  /** At least one must hit. */
  any?: Matcher[];
  /** None may hit. The usual guard against a stale frame. */
  none?: Matcher[];
}

export interface Manifest {
  /** Canonical agent kind — must exist in AGENT_ALIASES. */
  agent: string;
  /** Bumped whenever rules change, so `explain` can name what it ran. */
  version: number;
  /**
   * Matchers that establish this agent is on screen at all.
   *
   * A fourth identity source, weaker than a command line but available where
   * no command line is: a pane with no shell integration whose process probe
   * has parked. Any one hit is enough.
   */
  signatures: Matcher[];
  /** Evaluated highest-priority-first. */
  rules: Rule[];
}

/** What the engine was given. */
export interface DetectionInput {
  /**
   * Bottom-anchored screen lines, oldest first, already trimmed of trailing
   * blanks by the caller. The LAST element is the bottom of the buffer.
   */
  lines: string[];
  /** OSC 0/2 title, when the surface reported one. */
  title?: string | null;
}

export interface DetectionResult {
  /** The manifest that claimed the screen, or null when none did. */
  agent: string | null;
  /**
   * What the screen says the agent is doing.
   *
   * `unknown` means either "no manifest recognised this screen" or "one did,
   * but no rule matched". `reason` distinguishes them.
   *
   * This is ALWAYS a separate field from declared state, all the way to the UI.
   * A caller merges them at render time; nothing merges them at store time, so
   * an operator running `wmux agent-state` can still tell a reported block from
   * a seen one.
   */
  state: DetectedState | 'unknown';
  ruleId: string | null;
  /** Machine-readable cause, for `wmux detect explain`. */
  reason:
    | 'matched'
    | 'no-agent-signature'
    | 'no-rule-matched'
    | 'empty-screen';
  manifestVersion: number | null;
  /** The lines that made the winning rule fire. Empty unless `matched`. */
  evidence: string[];
}

/**
 * Complexity caps.
 *
 * Ported from the prior art, plus two it did not need. A manifest is data that
 * can come from the user's config directory, so every dimension a hostile or
 * merely careless file could grow is bounded here rather than at each use.
 */
export const LIMITS = {
  /** Rules the engine will evaluate in one manifest. */
  MAX_RULES: 128,
  /** Characters in a single matcher value. */
  MAX_MATCHER_CHARS: 512,
  /** Lines the engine will look at, whatever the region asks for. */
  MAX_REGION_LINES: 200,
  /**
   * Characters of a single line fed to a regex.
   *
   * The real bound on backtracking. A terminal line is ~200 chars; anything
   * longer is a wrapped paste and cannot be agent chrome.
   */
  MAX_LINE_CHARS: 1_000,
} as const;
