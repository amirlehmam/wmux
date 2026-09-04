import type { ITerminalOptions } from '@xterm/xterm';

/**
 * The `windowsPty` compatibility block xterm needs when its PTY is ConPTY.
 *
 * Without it xterm grows rows the POSIX way: it pulls scrollback back DOWN into
 * the viewport (`ybase--`) and keeps the cursor pinned to the same absolute
 * buffer line. ConPTY does the opposite — it appends blank rows at the bottom
 * and leaves the cursor on the same VIEWPORT row. So after a pane grows by K
 * rows the two sides disagree about the cursor's row by exactly K, and every
 * repaint ConPTY sends afterwards lands K rows above the content it belongs to:
 * the prompt appears stranded in the middle of old output, and typing overwrites
 * whatever was there. `clear` looks like a fix only because it resyncs both
 * sides. This is the case xterm's own typings describe — "ConPTY … makes empty
 * rows at [the bottom] of the viewport. Not having this behavior can result in
 * missing data as the rows get replaced."
 *
 * The build number is not decoration: xterm gates reflow on
 * `backend === 'conpty' && buildNumber >= 21376`. Below that it also turns on
 * the "line is wrapped if it does not end in whitespace" heuristic — correct
 * for those older ConPTYs, and what every other xterm-based Windows terminal
 * ships. An UNPARSEABLE release deliberately yields a block with no
 * `buildNumber` rather than a guessed one: `backend` alone is enough to fix the
 * resize behaviour, and an absent build number leaves reflow ON, which is the
 * safer half of the trade to lose.
 *
 * node-pty is spawned with `useConpty: true` (`pty-manager.ts`), and its only
 * fallback is `useConptyDll: false` — still ConPTY — so the backend is never
 * winpty.
 *
 * @param release `os.release()`, e.g. `'10.0.26200'`.
 */
export function windowsPtyCompat(release: string): NonNullable<ITerminalOptions['windowsPty']> {
  const build = Number((release ?? '').split('.')[2]);
  return Number.isInteger(build) && build > 0
    ? { backend: 'conpty', buildNumber: build }
    : { backend: 'conpty' };
}
