/**
 * Frame-coalesced sidebar drag (issue 07).
 *
 * A raw `mousemove` handler fires ~60 times a second, and every sidebar width
 * change relayouts the workspace — so each one wakes every terminal's
 * ResizeObserver, calls `fit()` and `pty.resize()`, and makes ConPTY re-emit
 * the visible screen as a Repaint. One drag was doing sixty rounds of that.
 *
 * The scheduler is injected rather than calling `requestAnimationFrame`
 * directly so the coalescing is testable in Node (there is no DOM in the unit
 * suite).
 */

export interface FrameScheduler {
  request: (cb: () => void) => number;
  cancel: (handle: number) => void;
}

export const rafScheduler: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export interface ResizeDrag {
  /** Record a pointer position; at most one `emit` lands per frame. */
  move: (clientX: number) => void;
  /** End the drag, delivering the final position immediately. */
  stop: () => void;
}

/**
 * Collect pointer positions and emit the drag delta at most once per frame.
 * `stop()` flushes a position still waiting for its frame, so the width settles
 * where the cursor was released rather than a frame behind it.
 */
export function createResizeDrag(
  startX: number,
  emit: (delta: number) => void,
  scheduler: FrameScheduler = rafScheduler,
): ResizeDrag {
  let frame: number | null = null;
  let latestX: number | null = null;
  let stopped = false;

  const flush = (): void => {
    frame = null;
    if (latestX === null) return;
    const delta = latestX - startX;
    latestX = null;
    emit(delta);
  };

  return {
    move(clientX: number): void {
      if (stopped) return;
      latestX = clientX;
      if (frame === null) frame = scheduler.request(flush);
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (frame !== null) {
        scheduler.cancel(frame);
        frame = null;
      }
      flush();
    },
  };
}
