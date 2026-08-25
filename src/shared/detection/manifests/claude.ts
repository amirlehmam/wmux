/**
 * Claude Code.
 *
 * Authored from screens captured out of a live Claude Code 2.x pane running in
 * wmux under ConPTY on Windows (`wmux read-screen`), not adapted from anyone
 * else's rule set — see tests/fixtures/detection/claude-*.txt, which are those
 * captures and which pin every rule below.
 *
 * What the UI actually looks like, and what is therefore safe to key on:
 *
 *   ✻ Unravelling… (26s · ↓ 1.4k tokens)          <- working: spinner line
 *   ──────────────────────────────────── wmux ──  <- prompt box top
 *   >                                             <- the prompt itself
 *   ──────────────────────────────────────────
 *     ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
 *
 * The spinner glyph rotates through a set, and the parenthetical differs by
 * mode — "(esc to interrupt)" by default, "(26s · ↓ 1.4k tokens)" under bypass
 * permissions. Keying on the glyph alone would false-positive on any transcript
 * quoting one, so `working` requires the glyph AND a live-run parenthetical.
 */
import { Manifest } from '../types';

/**
 * The braille/asterisk spinner frames Claude cycles.
 *
 * A character class, never a quantified group, so it cannot backtrack. Kept as
 * an explicit set rather than a Unicode block range: the block also contains
 * ordinary dingbats that appear in prose.
 */
const SPINNER = '[✳✴✵✶✷✸✹✺✻✼✽·✦✧]';

export const claudeManifest: Manifest = {
  agent: 'claude',
  version: 1,

  signatures: [
    // The mode footer. Present in every screen captured, in both modes, and
    // specific enough that no shell prints it: U+23F5 doubled.
    { kind: 'contains', value: '⏵⏵ ' },
    // The footer's wording, as a second way in when the glyph is stripped by a
    // narrow pane or a copy-paste.
    { kind: 'contains', value: 'shift+tab to cycle' },
    { kind: 'contains', value: 'bypass permissions on' },
    { kind: 'contains', value: 'accept edits on' },
  ],

  rules: [
    /**
     * Blocked — a permission prompt.
     *
     * Highest priority because it is the state that only the user can end, and
     * because the prompt is drawn OVER the normal chrome: a screen showing both
     * a spinner and a permission box is blocked, not working.
     *
     * Deliberately narrow. A rule that guessed would be worse than no rule at
     * all here: the engine falls back to `unknown`, which reads honestly, while
     * a false `blocked` would put a pane in the "needs you" queue forever —
     * wmux's blocked never expires.
     */
    {
      id: 'claude.blocked.permission',
      state: 'blocked',
      priority: 1000,
      region: { id: 'bottom_non_empty_lines', count: 14 },
      any: [
        { kind: 'contains', value: 'Do you want to proceed?' },
        { kind: 'contains', value: 'Do you want to make this edit' },
        { kind: 'contains', value: 'Do you want to create' },
        { kind: 'contains', value: 'Would you like to' },
      ],
      // The numbered answer list every one of those prompts draws. Requiring it
      // is what stops the question text being matched inside a transcript where
      // Claude is merely QUOTING a previous prompt.
      all: [
        { kind: 'lineRegex', value: '^\\s*(❯\\s*)?1\\.\\s' },
      ],
    },

    /**
     * Blocked — the trust prompt shown on a new directory.
     */
    {
      id: 'claude.blocked.trust',
      state: 'blocked',
      priority: 990,
      region: { id: 'bottom_non_empty_lines', count: 16 },
      all: [{ kind: 'contains', value: 'Do you trust the files in this folder?' }],
    },

    /**
     * Working — the spinner line.
     *
     * Both halves are required. The glyph says "a spinner frame is on screen";
     * the parenthetical says "and it belongs to a run that is happening now".
     * Either alone appears in ordinary transcript text.
     */
    {
      id: 'claude.working.spinner',
      state: 'working',
      priority: 800,
      region: { id: 'bottom_non_empty_lines', count: 10 },
      all: [{ kind: 'lineRegex', value: `^\\s*${SPINNER}\\s+\\S` }],
      any: [
        { kind: 'contains', value: 'esc to interrupt' },
        // "(26s · ↓ 1.4k tokens)" — elapsed seconds opening a parenthetical.
        { kind: 'lineRegex', value: '\\(\\d+s\\s' },
        { kind: 'lineRegex', value: '\\(\\d+m\\s' },
      ],
    },

    /**
     * Working — a tool is running, with no spinner frame captured this instant.
     *
     * The spinner blinks; a snapshot can land between frames. "esc to interrupt"
     * persists for the whole run, so it stands on its own at lower priority.
     */
    {
      id: 'claude.working.interrupt',
      state: 'working',
      priority: 780,
      region: { id: 'bottom_non_empty_lines', count: 8 },
      all: [{ kind: 'contains', value: 'esc to interrupt' }],
    },

    /**
     * Idle — an empty prompt box at the bottom of the screen.
     *
     * Lowest priority, and it is the only rule that concludes `idle`, so every
     * shape above gets to disagree first. `none` is what makes it an EMPTY
     * prompt: a run in progress leaves its footer within the same few lines.
     */
    {
      id: 'claude.idle.prompt',
      state: 'idle',
      priority: 100,
      /**
       * 12, not 5.
       *
       * The prompt box is drawn during a run TOO — the spinner sits three or
       * four lines above it, not inside it. A five-line window saw the empty
       * `>` and none of the run markers, so every working screen also satisfied
       * this rule and the two states raced on priority alone. `none` can only
       * exclude what its region can see, so the window has to be wide enough to
       * contain the evidence it is meant to veto on.
       */
      region: { id: 'bottom_non_empty_lines', count: 12 },
      all: [
        // "> " alone on its line, optionally with the cursor block after it.
        { kind: 'lineRegex', value: '^>\\s*$' },
      ],
      none: [
        { kind: 'contains', value: 'esc to interrupt' },
        { kind: 'lineRegex', value: `^\\s*${SPINNER}\\s+\\S` },
      ],
    },
  ],
};
