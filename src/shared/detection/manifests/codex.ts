/**
 * OpenAI Codex CLI.
 *
 * Authored from screens captured out of live `codex` panes in wmux
 * (tests/fixtures/detection/codex-*.txt): v0.98 for the update menu and the
 * idle composer, v0.159.3 for the working screen. That last capture keeps
 * every line of Codex chrome byte-for-byte; its transcript, working directory
 * and thread title were replaced with neutral text. The 0.159 footer it shows
 * is the one the idle rule keys on, and the end-of-turn separator is pinned by
 * a test built from Codex's own separators_tests.rs.
 *
 * What a turn looks like at the bottom of the screen:
 *
 *   Working (3m 52s • esc to interrupt)            <- status row, only mid-turn
 *     └ Tip: You can run any shell command ...
 *   › Ask Codex to do anything                     <- composer, drawn throughout
 *     gpt-5.5 xhigh · ~/project · thread title
 *     ? for shortcuts            ⚠ 2 warnings · f2 to view
 *
 * The footer is drawn during a turn TOO. v1 of this manifest read
 * `? for shortcuts` as idle on its own and had no working rule at all (no
 * running turn had been captured), so every Codex pane said "Idle" for the
 * whole of every turn. The status row is the evidence that tells them apart.
 */
import { Manifest, Matcher, Region } from '../types';

/**
 * The status row's clock, opening the parenthetical: "(12s • ", "(3m 05s • ",
 * "(1h 02m 03s • ".
 *
 * Codex's `fmt_elapsed_compact` pads minutes and seconds to two digits after
 * the leading unit, which is what lets each shape be a flat pattern. Three
 * matchers rather than one with optional groups: a quantified group containing
 * a quantifier is exactly what `isSafeRegexSource` refuses.
 *
 * Keyed on the clock and the U+2022 bullet, never on the words around them.
 * The header is "Working" only until the model's reasoning names its step
 * ("Mapping the app structure"), the key can be remapped ("f12 to interrupt"),
 * and a narrow pane truncates the tail ("(0s • esc…"). Claude's run line uses
 * U+00B7 there, so this does not collide with it.
 */
const RUN_CLOCK: Matcher[] = [
  { kind: 'lineRegex', value: '\\(\\d+s • ' },
  { kind: 'lineRegex', value: '\\(\\d+m \\d\\ds • ' },
  { kind: 'lineRegex', value: '\\(\\d+h \\d\\dm \\d\\ds • ' },
];

/**
 * How far up both the working rule and the idle veto look.
 *
 * The status row sits above the composer, not in the footer: wrapped status
 * details, the tip line, queued messages and a multi-line draft can all come
 * between them. Shared so the idle rule's veto can always see what the working
 * rule would have matched.
 */
const RUN_REGION: Region = { id: 'bottom_non_empty_lines', count: 16 };

export const codexManifest: Manifest = {
  agent: 'codex',
  version: 2,

  signatures: [
    // The banner box drawn at startup.
    { kind: 'contains', value: '>_ OpenAI Codex' },
    // The persistent footer, which survives once the banner scrolls away.
    { kind: 'contains', value: '? for shortcuts' },
    { kind: 'lineRegex', value: '\\d+% context left' },
  ],

  rules: [
    /**
     * Blocked — a numbered menu with an explicit "press enter" instruction.
     *
     * Observed on the update prompt Codex shows at startup. Both halves are
     * required: the menu shape alone appears in transcripts, and the
     * instruction alone appears in prose.
     */
    {
      id: 'codex.blocked.menu',
      state: 'blocked',
      priority: 1000,
      region: { id: 'bottom_non_empty_lines', count: 12 },
      all: [
        { kind: 'lineRegex', value: '^\\s*›\\s*1\\.\\s' },
        { kind: 'contains', value: 'Press enter to continue' },
      ],
    },

    /**
     * Working — the status row's clock.
     *
     * Codex draws the row for the length of a turn and removes it when the turn
     * ends; while an approval or another modal view is up, the view replaces
     * the row and this rule steps aside. The end-of-turn separator
     * ("Worked for 3m 52s • 2:32 PM") has the clock and the bullet but no
     * parenthesis, so a finished turn left in the transcript does not read as
     * a running one.
     */
    {
      id: 'codex.working.status',
      state: 'working',
      priority: 800,
      region: RUN_REGION,
      any: RUN_CLOCK,
    },

    /**
     * Idle — the composer footer with no run in progress.
     *
     * `? for shortcuts` is also a signature above, which is fine: a signature
     * answers WHO and a rule answers WHAT, and one line can carry both facts.
     * `lineStartsWith` rather than `contains`, because the region is wide
     * enough to reach into the transcript and only the footer starts a line
     * with it.
     */
    {
      id: 'codex.idle.composer',
      state: 'idle',
      priority: 100,
      region: RUN_REGION,
      all: [{ kind: 'lineStartsWith', value: '? for shortcuts' }],
      none: [
        // The footer stays on screen for the whole turn; a live status row
        // means the composer is waiting on Codex, not on the user.
        ...RUN_CLOCK,
        // The startup menu is a blocked screen that also carries the footer on
        // some builds; never let it be read as idle.
        { kind: 'contains', value: 'Press enter to continue' },
      ],
    },
  ],
};
