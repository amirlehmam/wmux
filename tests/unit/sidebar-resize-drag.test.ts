import { describe, it, expect, vi } from 'vitest';
import { createResizeDrag, FrameScheduler } from '../../src/renderer/components/Sidebar/resize-drag';

/** Hand-cranked rAF: frames only run when the test says so. */
function fakeFrames() {
  const queued = new Map<number, () => void>();
  let next = 1;
  const scheduler: FrameScheduler = {
    request: (cb) => { const h = next++; queued.set(h, cb); return h; },
    cancel: (h) => { queued.delete(h); },
  };
  return {
    scheduler,
    pending: () => queued.size,
    run: () => { const cbs = [...queued.values()]; queued.clear(); cbs.forEach(cb => cb()); },
  };
}

describe('createResizeDrag', () => {
  it('coalesces a burst of mousemoves into one update per frame', () => {
    const emit = vi.fn();
    const frames = fakeFrames();
    const drag = createResizeDrag(100, emit, frames.scheduler);

    // A ~1s drag at 60Hz used to be 60 width updates, each one resizing every
    // PTY in the window (issue 07).
    for (let x = 101; x <= 160; x++) drag.move(x);
    expect(emit).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(1);

    frames.run();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(60); // the LAST position, not the first
  });

  it('emits again on the next frame, so the width still tracks the cursor', () => {
    const emit = vi.fn();
    const frames = fakeFrames();
    const drag = createResizeDrag(100, emit, frames.scheduler);

    drag.move(110);
    frames.run();
    drag.move(130);
    frames.run();

    expect(emit.mock.calls).toEqual([[10], [30]]);
  });

  it('flushes the pending position on stop so the settled width is where the cursor was released', () => {
    const emit = vi.fn();
    const frames = fakeFrames();
    const drag = createResizeDrag(100, emit, frames.scheduler);

    drag.move(140);
    drag.stop();

    expect(emit).toHaveBeenCalledExactlyOnceWith(40);
    expect(frames.pending()).toBe(0); // the frame was cancelled, not left to fire
  });

  it('stops emitting once the drag is over', () => {
    const emit = vi.fn();
    const frames = fakeFrames();
    const drag = createResizeDrag(100, emit, frames.scheduler);

    drag.move(140);
    drag.stop();
    emit.mockClear();

    drag.move(200);
    frames.run();
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits nothing when the pointer never moved', () => {
    const emit = vi.fn();
    const frames = fakeFrames();
    const drag = createResizeDrag(100, emit, frames.scheduler);

    drag.stop();
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not re-emit a position already delivered by its frame', () => {
    const emit = vi.fn();
    const frames = fakeFrames();
    const drag = createResizeDrag(100, emit, frames.scheduler);

    drag.move(140);
    frames.run();
    drag.stop();

    expect(emit).toHaveBeenCalledExactlyOnceWith(40);
  });
});
