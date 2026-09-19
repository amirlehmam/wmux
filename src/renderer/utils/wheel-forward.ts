/**
 * What a scroll gesture writes into a PTY that owns the screen (issue #245).
 *
 * Pure, and separated from `useTerminal.ts` for the reason the rest of the
 * renderer's pure halves are: the bug this fixes is a COUNT, invisible in a
 * screenshot and reproducible only by watching an app's own row arithmetic on a
 * touchscreen ThinkPad. The count is the thing worth pinning, and pinning it
 * needs no xterm, no PTY and no DOM.
 *
 * ## The bug
 *
 * wmux emitted one report per LINE:
 *
 *     for (let i = 0; i < Math.abs(count); i++) pty.write(ptyId, seq);
 *
 * where `count` is `wheelDeltaToLines(...)`. A Windows detent is ~100px of
 * `deltaY`, which against a ~17px cell is 5-6 lines — so one detent became 5-6
 * app-level wheel reports. A mouse-tracking app then applies its OWN rows-per-
 * report multiplier on top (opencode's `scroll_speed`, 3 by default), and the
 * detent moved 15-18 rows where every other terminal moves ~3. The workaround
 * users found — dropping `scroll_speed` to 0.25 — fixed the wheel by breaking
 * the touch pan, which shares that multiplier.
 *
 * ## The rule
 *
 * The two branches speak different units, and conflating them is the whole bug:
 *
 * | branch        | unit  | why                                                |
 * |---------------|-------|----------------------------------------------------|
 * | mouse report  | STEP  | the app decides how far a step goes                 |
 * | arrow keys    | LINE  | an arrow IS one line; nobody scales it              |
 *
 * So a mouse-tracking app gets exactly ONE report per wheel event, and the line
 * count is demoted to a gate — "did this event cross a line at all?". That is
 * what xterm does (`Terminal._bindMouse`, `case 'wheel'`: `consumeWheelEvent()`
 * is tested against 0 and then a single `triggerMouseEvent` is sent) and it is
 * why every other terminal moves one step per detent.
 *
 * The arrow branch keeps looping, and this is a DELIBERATE divergence from
 * xterm, which sends one arrow per event there too. wmux's own scrollback
 * branch moves `lines` rows per event, so one arrow per detent would make a
 * pager in an alt-screen pane crawl at a fifth of the speed of the scrollback
 * in the pane beside it. #245 was the multiplier, and the arrow branch has
 * none.
 *
 * ## Touch
 *
 * A finger is a position, not a detent, so the touch stream keeps one report
 * per line: the gesture has to track the skin, and re-deriving that from a
 * per-event report would tie pan speed to the frame rate. wmux cannot know the
 * app's rows-per-report multiplier, so one report per cell crossed is the
 * closest it can get — and it is exact wherever that multiplier is 1.
 */

/** Which gesture produced the wheel event — see the Touch note above. */
export type WheelSource = 'wheel' | 'touch';

export interface WheelForwardOptions {
  /** Whole lines this event is worth, sign preserved. 0 means "sub-line". */
  lines: number;
  /** Is an app tracking the mouse (SGR reports), or is this a plain pager? */
  mouseTracking: boolean;
  source: WheelSource;
  /** 1-based pointer cell, for the SGR report's origin. */
  col: number;
  row: number;
}

/** The bytes to write, and how many times — or null when there is nothing to send. */
export interface WheelForward {
  seq: string;
  repeats: number;
}

export function wheelForward(opts: WheelForwardOptions): WheelForward | null {
  const { lines, mouseTracking, source, col, row } = opts;
  if (lines === 0) return null;

  if (mouseTracking) {
    const btn = lines < 0 ? 64 : 65; // 64 = wheel-up, 65 = wheel-down
    return {
      seq: `\x1b[<${btn};${col};${row}M`,
      // One step per EVENT for a real wheel; one per LINE for a finger.
      repeats: source === 'touch' ? Math.abs(lines) : 1,
    };
  }

  return {
    seq: lines < 0 ? '\x1b[A' : '\x1b[B', // arrow keys for non-mouse pagers
    repeats: Math.abs(lines),
  };
}
