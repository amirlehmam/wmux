import type { IBuffer, IMarker, Terminal } from '@xterm/xterm';

/**
 * Keeps xterm's normal buffer laid out the way ConPTY lays out ITS buffer when a
 * resize reflows — a change of COLUMNS, which is what moving the window to a
 * monitor of a different size or DPI does, and what dragging it back does again.
 *
 * ## The disagreement
 *
 * ConPTY's buffer is exactly the viewport: it has no scrollback. When a resize
 * reflows it, the viewport's TOP row stays put — unwrapping a long line (the
 * pane got wider) pulls everything under it up and leaves blank rows at the
 * bottom, and re-wrapping one (narrower) pushes everything down into whatever
 * blank rows are left under the cursor, scrolling off the top only once those
 * run out. Windows Terminal anchors its own viewport the same way.
 *
 * xterm anchors the BOTTOM whenever it has scrollback to trade:
 * `_reflowLargerAdjustViewport` answers every row a widen removes with
 * `ybase--`, pulling a scrollback line down into view and leaving the cursor
 * where it was; `_reflowSmaller` answers every row a narrow adds with
 * `ybase++`, pushing a line into scrollback even when there are blank rows under
 * the cursor to absorb it. `windowsPty` fixes the equivalent mismatch for a
 * change of ROWS (see windows-pty.ts) but not for reflow.
 *
 * So after a column change the two sides disagree about the cursor's row by the
 * number of rows the reflow added or removed inside the viewport — measured
 * against a live bundled ConPTY: one unwrapped line strands the prompt one row
 * low, four strand it four. The bundled ConPTY sends NOTHING after a resize (it
 * no longer repaints), so nothing ever corrects it: typing lands that many rows
 * away from the prompt, over whatever old output is there, until a `clear`.
 *
 * ## The orphaned tail
 *
 * The viewport's top row can be the tail of a wrapped line whose head is in
 * scrollback — after a narrow has scrolled it off ConPTY's top, it always is.
 * ConPTY does not have that head, so from then on it reflows the tail as a line
 * of its own; xterm rejoins it to its head, and the two lay it out at different
 * heights on every later reflow. Offsetting for that once is not enough (the
 * error compounds across a round trip, measured), so the tail is ORPHANED in
 * xterm too, before a column change: the top row stops being marked as a
 * continuation. The only visible cost is that the long line it was part of,
 * now in scrollback, splits there — which is what ConPTY's copy already is.
 *
 * ## The fix
 *
 * Before the resize, orphan the top row and drop a marker on it — markers ride
 * through reflow onto the line that now holds that content. After it, move
 * xterm's viewport so that line is on top again, exactly as ConPTY did, unless
 * that would put the cursor below the bottom row (then both sides scroll it into
 * view). Growing and shrinking ROWS already agree under `windowsPty`, and for
 * them this computes a zero shift.
 *
 * It has to reach into xterm's buffer service: there is no public API that pulls
 * scrollback back into the viewport or clears a wrap flag, and writing escape
 * sequences would queue behind output that has not been parsed yet while the
 * resize has already happened. The xterm version is pinned, and every internal
 * is feature-checked: if the shape is not what this expects it does nothing,
 * which is the old behaviour rather than a crash.
 */

/** The row the viewport should start at, in absolute buffer lines. */
export function conptyViewportTop(anchorLine: number, cursorAbs: number, rows: number): number {
  return Math.max(anchorLine, cursorAbs - (rows - 1), 0);
}

/** The subset of xterm's internal BufferLine this touches. */
export interface AnchorLine {
  isWrapped: boolean;
  getTrimmedLength(): number;
}

/** The subset of xterm's internal Buffer this touches. */
export interface AnchorBuffer {
  ybase: number;
  ydisp: number;
  y: number;
  scrollTop: number;
  scrollBottom: number;
  lines: {
    readonly length: number;
    get(index: number): AnchorLine | undefined;
    pop(): unknown;
  };
}

/** The subset of xterm's internal BufferService this touches. */
export interface AnchorBufferService {
  readonly rows: number;
  readonly buffer: AnchorBuffer;
  /** Scrolls the whole buffer up one line, the way a LF on the bottom row does. */
  scroll(eraseAttr: unknown, isWrapped?: boolean): void;
}

/**
 * Moves the viewport so it starts at `targetTop`, keeping every line where it is
 * in the buffer. Returns how many rows it actually moved (+ = content up).
 *
 * - Content up: scroll the buffer as a LF on the bottom row would, pushing the
 *   lines a widen pulled down back into scrollback and appending blank rows,
 *   and move the cursor up with the content.
 * - Content down: drop blank rows from under the cursor and bring scrollback
 *   lines back into view. Only BLANK rows BELOW the cursor are dropped — those
 *   are what ConPTY spent — so this never discards output.
 */
export function shiftViewport(service: AnchorBufferService, targetTop: number, eraseAttr: unknown): number {
  const buffer = service.buffer;
  const delta = targetTop - buffer.ybase;
  if (delta === 0) return 0;

  if (delta > 0) {
    // scroll() only pushes into scrollback for a full-height scroll region;
    // with a margin set it would shift lines in place instead. Resize resets
    // the region, so this holds unless an app set one since.
    if (buffer.scrollTop !== 0 || buffer.scrollBottom !== service.rows - 1) return 0;
    const n = Math.min(delta, buffer.y);
    for (let i = 0; i < n; i++) service.scroll(eraseAttr);
    buffer.y -= n;
    return n;
  }

  const cursorAbs = buffer.ybase + buffer.y;
  let n = 0;
  while (
    n < -delta
    && buffer.ybase - n > 0
    && buffer.lines.length - 1 - n > cursorAbs
    && (buffer.lines.get(buffer.lines.length - 1 - n)?.getTrimmedLength() ?? 1) === 0
  ) {
    n++;
  }
  if (n === 0) return 0;
  const followBottom = buffer.ydisp === buffer.ybase;
  for (let i = 0; i < n; i++) buffer.lines.pop();
  buffer.ybase -= n;
  buffer.y += n;
  buffer.ydisp = followBottom ? buffer.ybase : Math.min(buffer.ydisp, buffer.ybase);
  return -n;
}

type InternalService = AnchorBufferService & {
  buffer: AnchorBuffer & { getNullCell(): unknown };
  _onScroll?: { fire(ydisp: number): void };
};

function bufferServiceOf(terminal: Terminal): InternalService | undefined {
  const core = (terminal as unknown as { _core?: { _bufferService?: InternalService } })._core;
  const svc = core?._bufferService;
  const buf = svc?.buffer;
  if (
    !svc || typeof svc.scroll !== 'function' || typeof svc.rows !== 'number'
    || !buf || typeof buf.ybase !== 'number' || typeof buf.y !== 'number'
    || typeof buf.getNullCell !== 'function'
    || typeof buf.lines?.get !== 'function' || typeof buf.lines?.pop !== 'function'
  ) return undefined;
  return svc;
}

/**
 * Call immediately BEFORE a resize that changes the column count. Returns a
 * marker on the viewport's top line, or undefined when there is nothing to
 * anchor (the alternate screen has no scrollback and xterm does not reflow it).
 */
export function captureViewportTop(terminal: Terminal): IMarker | undefined {
  try {
    const active = terminal.buffer.active;
    if (active.type !== 'normal') return undefined;
    const svc = bufferServiceOf(terminal);
    if (!svc) return undefined;
    // Orphan the tail ConPTY no longer has the head of (see the header).
    const top = svc.buffer.lines.get(svc.buffer.ybase);
    if (top?.isWrapped) top.isWrapped = false;
    return terminal.registerMarker(-active.cursorY);
  } catch {
    return undefined;
  }
}

/**
 * Call immediately AFTER the resize, with what captureViewportTop returned.
 * Re-anchors the viewport to ConPTY's layout and disposes the marker.
 */
export function anchorViewportLikeConpty(terminal: Terminal, top: IMarker | undefined): void {
  if (!top) return;
  try {
    if (top.isDisposed || top.line < 0) return;
    if (terminal.buffer.active.type !== 'normal') return;
    const svc = bufferServiceOf(terminal);
    if (!svc) return;
    const buffer = svc.buffer;
    const target = conptyViewportTop(top.line, buffer.ybase + buffer.y, svc.rows);
    const moved = shiftViewport(svc, target, buffer.getNullCell());
    if (moved === 0) return;
    // scroll() announces itself; the pull-down path set ybase/ydisp by hand, and
    // the viewport's scroll area only follows an onScroll.
    if (moved < 0) svc._onScroll?.fire(buffer.ydisp);
    terminal.refresh(0, terminal.rows - 1);
  } catch {
    // Leave xterm's own layout in place rather than fail a resize.
  } finally {
    top.dispose();
  }
}

/**
 * Where the cursor sits inside the logical line it is on (issue #273): a marker
 * on the line's first row, and the cursor's offset in cells from its start.
 */
export interface CursorLineAnchor {
  start: IMarker;
  offset: number;
}

/**
 * Cells a row of a wrapped line contributes to it. A row is full except when a
 * wide character did not fit in its last cell and was carried to the next row,
 * which leaves that cell empty — the same rule xterm's reflow measures by.
 */
function wrappedRowLength(buffer: IBuffer, y: number, cols: number): number {
  const line = buffer.getLine(y);
  const next = buffer.getLine(y + 1);
  if (line && next?.isWrapped && line.getCell(cols - 1)?.getChars() === '' && next.getCell(0)?.getWidth() === 2) {
    return cols - 1;
  }
  return cols;
}

/**
 * Call BEFORE a resize that changes the column count, after captureViewportTop
 * (so a tail it orphaned counts as the line's start, as it does for ConPTY).
 *
 * ConPTY reflows the line the cursor is on along with every other one, and sends
 * nothing afterwards. xterm, by default, leaves the cursor's line alone —
 * `reflowCursorLine` is off "because shells usually handle this themselves",
 * which is a bash/zsh answer to SIGWINCH and not one PowerShell gives. So a
 * prompt first drawn in a narrower pane stayed broken at that width forever,
 * while PSReadLine, which positions with absolute CUPs off ConPTY's reflowed
 * layout, typed into cells that were not where xterm showed them. Turning the
 * option on moves the TEXT; it does not move the cursor, so this records where
 * in the line the cursor was and restoreCursorLine puts it back there.
 */
export function captureCursorLine(terminal: Terminal): CursorLineAnchor | undefined {
  try {
    const active = terminal.buffer.active;
    if (active.type !== 'normal') return undefined;
    const cursorAbs = active.baseY + active.cursorY;
    let startAbs = cursorAbs;
    while (startAbs > 0 && active.getLine(startAbs)?.isWrapped) startAbs--;
    let offset = active.cursorX;
    for (let y = startAbs; y < cursorAbs; y++) offset += wrappedRowLength(active, y, terminal.cols);
    const start = terminal.registerMarker(startAbs - cursorAbs);
    return start ? { start, offset } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Call immediately AFTER the resize (before anchorViewportLikeConpty, which
 * reads the cursor row), with what captureCursorLine returned.
 */
export function restoreCursorLine(terminal: Terminal, anchor: CursorLineAnchor | undefined): void {
  if (!anchor) return;
  try {
    if (anchor.start.isDisposed || anchor.start.line < 0) return;
    const active = terminal.buffer.active;
    if (active.type !== 'normal') return;
    const svc = bufferServiceOf(terminal) as (InternalService & { buffer: { x: number } }) | undefined;
    if (!svc || typeof svc.buffer.x !== 'number') return;
    const cols = terminal.cols;
    let y = anchor.start.line;
    let remaining = anchor.offset;
    // Walk the reflowed line row by row. At exactly a row's length the cursor
    // goes to the next row's start if the line continues there, and otherwise
    // stays in the wrap-pending column at the end of this one.
    while (remaining >= wrappedRowLength(active, y, cols) && active.getLine(y + 1)?.isWrapped) {
      remaining -= wrappedRowLength(active, y, cols);
      y++;
    }
    const row = y - svc.buffer.ybase;
    if (row < 0 || row >= terminal.rows) return;
    svc.buffer.y = row;
    svc.buffer.x = Math.min(remaining, cols);
  } catch {
    // Leave the cursor where xterm put it rather than fail a resize.
  } finally {
    anchor.start.dispose();
  }
}
