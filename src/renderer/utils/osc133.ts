/**
 * OSC 133 — semantic prompt marks (FinalTerm, as adopted by iTerm2, VS Code,
 * WezTerm, Kitty and Windows Terminal).
 *
 * This is the boundary source for panes running a PLAIN SHELL. It answers the
 * one question every feature in issue #207 is a consumer of: where does a user
 * prompt start, where does their input end, and where does the output begin.
 *
 * Pure on purpose. The sequence arrives from a PTY — i.e. from whatever the
 * user ran, including things wmux did not install — so the parser is the piece
 * most worth testing without a terminal, a shell or an Electron window. It also
 * makes the ONE place that decides what a payload means testable against the
 * real spellings other emitters use, rather than only against wmux's own
 * scripts.
 *
 * Grammar (all forms seen in the wild):
 *
 *   ESC ] 133 ; A ST                 prompt starts here
 *   ESC ] 133 ; A ; k=i ; cl=m ST    …with parameters (ignored, but must parse)
 *   ESC ] 133 ; B ST                 prompt ends / the user's input starts here
 *   ESC ] 133 ; C ST                 the command was submitted, output starts
 *   ESC ] 133 ; C ; ST               trailing empty parameter (bash-preexec)
 *   ESC ] 133 ; D ST                 command finished, exit code unknown
 *   ESC ] 133 ; D ; 0 ST             command finished with this exit code
 *
 * xterm hands the handler everything AFTER `133;`, so `data` here is
 * `"A"`, `"D;1"`, `"A;k=i"` and so on — never the escape itself.
 */

/** The four semantic marks, in the order a well-behaved shell emits them. */
export type PromptMarkKind = 'prompt-start' | 'input-start' | 'output-start' | 'command-end';

export interface PromptMark {
  kind: PromptMarkKind;
  /**
   * Exit status carried by `D;<n>`. Null for every other kind, and for a bare
   * `D` — a shell that reports the boundary but not the status is common
   * enough (bash-preexec's minimal mode) that it must not be read as 0.
   */
  exitCode: number | null;
}

const KIND_BY_LETTER: Record<string, PromptMarkKind> = {
  A: 'prompt-start',
  B: 'input-start',
  C: 'output-start',
  D: 'command-end',
};

/**
 * Parse an OSC 133 payload, or return null if it is not one we act on.
 *
 * Returning null rather than throwing is the contract: the handler that calls
 * this runs inside xterm's parser on every byte a program writes, and an
 * unrecognised OSC 133 subtype (there are vendor extensions — iTerm2's `P`,
 * `L`, kitty's own additions) is a normal thing to see, not an error. Anything
 * this declines is passed back down xterm's handler chain untouched.
 */
export function parsePromptMark(data: string): PromptMark | null {
  if (!data) return null;
  // Split rather than slice(0,1): `A` and `A;k=i` must resolve identically, and
  // a two-letter vendor subtype like `Ps` must NOT be read as an `A`.
  const parts = data.split(';');
  const kind = KIND_BY_LETTER[parts[0]];
  if (!kind) return null;

  if (kind !== 'command-end') return { kind, exitCode: null };

  // `D;` with an empty parameter is a bare D, not exit 0 — Number('') is 0,
  // which would report every unknown-status command as a success.
  const raw = (parts[1] ?? '').trim();
  if (!raw) return { kind, exitCode: null };
  const code = Number(raw);
  return { kind, exitCode: Number.isInteger(code) ? code : null };
}
