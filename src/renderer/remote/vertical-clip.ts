/**
 * Which slice of the mirrored grid the phone shows when the grid is TALLER
 * than its box (issue #265).
 *
 * The mirror keeps the desktop's cols×rows (the phone never resizes a PTY, I4)
 * and fit.ts picks the font from the WIDTH alone, so nothing bounds the height:
 * a 40-row pane at a readable font is taller than what is left of a phone
 * screen once the key bar, the composer and the on-screen keyboard have taken
 * their share. The box clipped the overflow at the BOTTOM — which is where an
 * agent TUI keeps its input row and its question, i.e. the one part of the
 * screen the user opened the console to see. It was reported as "the buttons
 * hide the line below", and the buttons were never over it: the rows were cut
 * off above them.
 *
 * So the box is a window over the grid, `offset` px from the grid's top, and:
 *
 *  - it is PINNED to the bottom by default, and stays pinned across layout
 *    changes (the keyboard opening makes the box shorter, and the input row
 *    must still be the row above the keyboard);
 *  - a finger reaches the rest. The grid and the scrollback above it behave as
 *    ONE document: dragging towards older content first slides the window to
 *    the grid's top, then scrolls the scrollback; coming back, the scrollback
 *    returns to its bottom first and only then does the window slide down.
 *    On the alternate screen there is no scrollback and the window is all
 *    there is, which is also the first time a finger does anything there.
 *
 * Pure, like fit.ts: the numbers come from the DOM, the decisions do not.
 */

export interface ClipState {
  /** Px of the grid hidden above the box. 0 = the grid's top row is visible. */
  offset: number;
  /** The largest offset: grid height minus box height, never negative. */
  max: number;
}

export const UNCLIPPED: ClipState = { offset: 0, max: 0 };

/** Sub-pixel slack: scrollHeight and clientHeight are rounded independently. */
const PIN_SLACK_PX = 1;

function sane(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function isPinned(s: ClipState): boolean {
  return s.offset >= s.max - PIN_SLACK_PX;
}

/** A layout change: the overflow is now `max`. A pinned window stays pinned. */
export function reclip(prev: ClipState, max: number): ClipState {
  const m = sane(max);
  return { offset: isPinned(prev) ? m : Math.min(prev.offset, m), max: m };
}

export function pinClip(s: ClipState): ClipState {
  return { offset: s.max, max: s.max };
}

/**
 * One pan delta, in px; positive is towards newer content (the same sign
 * `term.scrollLines` takes). Returns the new window and `rest`, the px that
 * still belong to the scrollback.
 */
export function panClip(s: ClipState, px: number, scrollbackAtBottom: boolean): { state: ClipState; rest: number } {
  if (!Number.isFinite(px) || px === 0 || s.max <= 0) return { state: s, rest: Number.isFinite(px) ? px : 0 };
  if (px < 0) {
    const take = Math.max(px, -s.offset);
    return { state: { offset: s.offset + take, max: s.max }, rest: px - take };
  }
  if (!scrollbackAtBottom) return { state: s, rest: px };
  const take = Math.min(px, s.max - s.offset);
  return { state: { offset: s.offset + take, max: s.max }, rest: px - take };
}
