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

/**
 * The line Claude prints when a turn is over: "✻ Cooked for 2m 1s · done 3:44 PM".
 * It shares the spinner glyph with the working line and differs by having no
 * live-run parenthetical — which is why `working` never fires on it.
 */
const TURN_DONE = `^\\s*${SPINNER}\\s+\\S+ for \\d+[ms]\\b.*\\bdone\\b`;

/**
 * The first line of one of Claude's messages or tool calls: "● Done." Windows
 * builds draw U+25CF; elsewhere Claude Code draws U+23FA in the same place.
 */
const MESSAGE_START = '^[●⏺]\\s';

export const claudeManifest: Manifest = {
  agent: 'claude',
  version: 2,

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
     * Question — the turn finished on an ordinary question for the user.
     *
     * All three halves are required, and together they say "current": the
     * completed-turn marker says the run is over, the prompt box says Claude
     * is waiting for input, and the question itself must sit in the last
     * three non-empty lines of the message that the LAST marker closes.
     *
     * The prompt line may carry text, and that is deliberate. After a closed
     * question Claude Code pre-fills a suggested answer there ("> Oui, c'est
     * réussi.", in dim text, cursor on its first character), and a screen read
     * as plain text cannot tell that from typing. Requiring an empty prompt
     * lost the question on two live tries out of three. So the question stays
     * current until the answer is SENT, which is when the transcript moves on.
     *
     * That third half is anchored on purpose. "A `?` somewhere near the bottom"
     * also matches a question from the previous turn that the user already
     * answered, when the turn after it was short. Anchored above the last
     * marker, an answered question is by construction above an older marker.
     *
     * It is also bounded by the message. The region opens no higher than the
     * line that starts Claude's last message, so a one-line answer does not
     * lend its window to the user's wrapped prompt above it — whose
     * continuation lines carry no prompt glyph to exclude them by.
     *
     * The question mark must be followed by ordinary text or end the line. It
     * may be ASCII, Arabic `؟` or full-width `？`; CJK text runs on after the
     * full-width one with no space, so only that one waives the space. One
     * followed by a closing quote is Claude QUOTING a question, a line that
     * starts with the prompt glyph is the user's own submitted text, and one
     * that starts with `⎿` is a tool's output.
     *
     * Known limits, stated rather than papered over: a turn too short for
     * Claude to print the marker is not seen at all, a past question retold
     * without quotes in the closing lines reads as current, and so does a
     * question on a tool output's second line, when the turn ends on the tool.
     */
    {
      id: 'claude.question.pending',
      state: 'question',
      priority: 500,
      region: { id: 'bottom_non_empty_lines', count: 12 },
      all: [
        { kind: 'lineRegex', value: TURN_DONE },
        // The prompt box, empty or not. Live it is ">" followed by U+00A0,
        // which `\s` covers under the engine's `u` flag.
        { kind: 'lineRegex', value: '^>(\\s|$)' },
        {
          kind: 'lineRegex',
          value: '^\\s*[^>❯⎿\\s].*([?؟](\\s+[^\\s»"”]|\\s*$)|？\\s*([^\\s»"”」』]|$))',
          region: {
            id: 'non_empty_lines_above',
            count: 3,
            anchor: { kind: 'lineRegex', value: TURN_DONE },
            start: { kind: 'lineRegex', value: MESSAGE_START },
          },
        },
      ],
      none: [{ kind: 'contains', value: 'esc to interrupt' }],
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
