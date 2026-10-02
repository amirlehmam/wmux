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
 *
 * Where it is not 1 (opencode's `scroll_speed` is 3) the screen outruns the
 * finger, and no value of the app's own setting serves both gestures: the wheel
 * wants 3 rows per detent, the finger wants 1 row per cell (#267). So the PAN
 * has a gain, `terminalPrefs.touchPanGain` — reports per cell crossed, 1/3 for
 * that app — and `touchPanReports` carries the fraction so a slow drag still
 * moves. Two things it deliberately does not touch: scrollback and the arrow
 * branch (already 1:1, nothing multiplies them), and the FLING, which is its
 * own source for exactly this reason — its distance was tuned as shipped
 * (#248) and a gain that slowed the tracking pan would otherwise shorten the
 * glide by the same factor.
 */

/** Which gesture produced the wheel event — see the Touch note above. */
export type WheelSource = 'wheel' | 'touch' | 'fling';

export const TOUCH_PAN_GAIN_MIN = 0.05;
export const TOUCH_PAN_GAIN_MAX = 4;

/**
 * The pan gain as something safe to multiply by. The value arrives from a
 * hand-edited TOML file and from a persisted pref blob, so anything that is
 * not a positive finite number is the default (1 — one report per cell), and
 * the rest is clamped: 0 would make a finger inert with no visible cause.
 */
export function normalizeTouchPanGain(gain: unknown): number {
  if (typeof gain !== 'number' || !Number.isFinite(gain) || gain <= 0) return 1;
  return Math.min(TOUCH_PAN_GAIN_MAX, Math.max(TOUCH_PAN_GAIN_MIN, gain));
}

/**
 * Lines of finger travel → whole reports, with the fraction carried to the
 * next event. Signed throughout, so reversing direction first spends the
 * carry it built up rather than jumping.
 */
export function touchPanReports(lines: number, gain: number, carry: number): { reports: number; carry: number } {
  const total = carry + lines * normalizeTouchPanGain(gain);
  const reports = Math.trunc(total);
  return { reports, carry: total - reports };
}

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
      // One step per EVENT for a real wheel; one per LINE for a finger (and
      // for the fling that continues it).
      repeats: source === 'wheel' ? 1 : Math.abs(lines),
    };
  }

  return {
    seq: lines < 0 ? '\x1b[A' : '\x1b[B', // arrow keys for non-mouse pagers
    repeats: Math.abs(lines),
  };
}
