/**
 * OpenAI Codex CLI.
 *
 * Authored from screens captured out of a live `codex` v0.98 pane in wmux
 * (tests/fixtures/detection/codex-*.txt).
 *
 * DELIBERATELY INCOMPLETE. The capture session could not reach a running turn —
 * the install's refresh token had already been used, so Codex refused every
 * request — which means no `working` screen was ever observed. Rather than
 * write a `working` rule from memory and ship a rule nobody has run, this
 * manifest carries only what was seen. A Codex pane mid-turn therefore reads as
 * `unknown`, which is the honest answer and exactly what the engine's
 * no-rule-matched fallback exists to say.
 *
 * To finish it: run `wmux detect explain --file <capture> --agent codex`
 * against a captured working screen and add the rule the evidence supports.
 */
import { Manifest } from '../types';

export const codexManifest: Manifest = {
  agent: 'codex',
  version: 1,

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
     * Idle — the composer footer with no run in progress.
     *
     * `? for shortcuts` is drawn beside the context gauge only while Codex is
     * waiting for input. It is also a signature above, which is fine: a
     * signature answers WHO and a rule answers WHAT, and one line can carry
     * both facts.
     */
    {
      id: 'codex.idle.composer',
      state: 'idle',
      priority: 100,
      region: { id: 'bottom_non_empty_lines', count: 4 },
      all: [{ kind: 'contains', value: '? for shortcuts' }],
      none: [
        // The startup menu is a blocked screen that also carries the footer on
        // some builds; never let it be read as idle.
        { kind: 'contains', value: 'Press enter to continue' },
      ],
    },
  ],
};
