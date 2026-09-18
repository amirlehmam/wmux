import { describe, it, expect } from 'vitest';
import {
  createTouchPanTracker,
  TAP_SLOP_PX,
  MAX_PAN_STEP_PX,
} from '../../src/renderer/utils/touch-pan';

// Issue #243. The device that reproduces this (a ThinkPad Z16 touchscreen) is
// not the machine CI runs on, so every rule the gesture has is pinned here
// rather than checked by hand.

describe('touch pan tracker', () => {
  describe('a tap must never scroll', () => {
    it('emits nothing while inside the slop', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 100);
      expect(t.move(1, 100, 100 + TAP_SLOP_PX - 1)).toBe(0);
      expect(t.move(1, 100 + TAP_SLOP_PX - 1, 100)).toBe(0);
      expect(t.phase).toBe('tracking');
      expect(t.panning).toBe(false);
    });

    it('a clean tap leaves the tracker idle', () => {
      const t = createTouchPanTracker();
      t.down(1, 50, 50);
      t.move(1, 51, 52);
      t.up(1);
      expect(t.phase).toBe('idle');
    });
  });

  describe('direction is natural — the content follows the finger', () => {
    it('dragging DOWN scrolls toward older content (negative delta)', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 100);
      const delta = t.move(1, 100, 140);
      expect(delta).toBeLessThan(0);
      // Measured from the gesture ORIGIN, so the content sits under the finger
      // rather than lagging it by the slop.
      expect(delta).toBe(-40);
    });

    it('dragging UP scrolls toward newer content (positive delta)', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 200);
      expect(t.move(1, 100, 160)).toBe(40);
    });

    it('subsequent moves are relative to the previous point, not the origin', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 100);
      expect(t.move(1, 100, 140)).toBe(-40);
      expect(t.move(1, 100, 150)).toBe(-10);
      expect(t.move(1, 100, 145)).toBe(5);
    });

    it('a move with no travel emits nothing', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 100);
      t.move(1, 100, 140);
      expect(t.move(1, 100, 140)).toBe(0);
    });
  });

  describe('axis lock', () => {
    it('a horizontal swipe stays inert for its whole life', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 100);
      expect(t.move(1, 160, 100)).toBe(0);
      expect(t.phase).toBe('rejected');
      // Even once it turns vertical — re-deciding per move makes a diagonal
      // drag flicker between scrolling and not.
      expect(t.move(1, 160, 300)).toBe(0);
      expect(t.phase).toBe('rejected');
    });

    it('an exactly diagonal break-out goes to horizontal, not vertical', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 100);
      expect(t.move(1, 100 + 20, 100 + 20)).toBe(0);
      expect(t.phase).toBe('rejected');
    });

    it('a mostly-vertical diagonal still pans', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 100);
      expect(t.move(1, 105, 140)).toBe(-40);
      expect(t.phase).toBe('panning');
    });

    it('the lock survives the axis reversing later in the gesture', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 100);
      expect(t.move(1, 100, 140)).toBe(-40);
      // Now drag sideways: still a pan, and only the vertical component counts.
      expect(t.move(1, 400, 140)).toBe(0);
      expect(t.move(1, 400, 150)).toBe(-10);
    });
  });

  describe('multi-touch is refused, not guessed at', () => {
    it('a second finger rejects the gesture', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 100);
      t.down(2, 200, 100);
      expect(t.phase).toBe('rejected');
      expect(t.move(1, 100, 200)).toBe(0);
    });

    it('a pinch stays rejected until the LAST finger lifts', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 100);
      t.down(2, 200, 100);
      t.up(1);
      expect(t.phase).toBe('rejected');
      // The survivor is not promoted to a pan mid-pinch.
      expect(t.move(2, 200, 300)).toBe(0);
      t.up(2);
      expect(t.phase).toBe('idle');
    });

    it('a mid-pan second finger stops the pan', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 100);
      expect(t.move(1, 100, 140)).toBe(-40);
      t.down(2, 300, 100);
      expect(t.move(1, 100, 200)).toBe(0);
    });

    it('a stray pointer id is ignored rather than adopted', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 100);
      expect(t.move(9, 100, 400)).toBe(0);
      expect(t.phase).toBe('tracking');
    });
  });

  describe('clamping', () => {
    it('one pathological jump cannot become thousands of arrow keys', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 100);
      expect(t.move(1, 100, 100 + 50_000)).toBe(-MAX_PAN_STEP_PX);
      t.reset();
      t.down(1, 100, 50_000);
      expect(t.move(1, 100, 0)).toBe(MAX_PAN_STEP_PX);
    });
  });

  describe('lifecycle', () => {
    it('a fresh gesture pans again after the last one ended', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 100);
      t.move(1, 160, 100); // rejected: horizontal
      t.up(1);
      expect(t.phase).toBe('idle');
      t.down(1, 100, 100);
      expect(t.move(1, 100, 140)).toBe(-40);
    });

    it('reset drops a live gesture', () => {
      const t = createTouchPanTracker();
      t.down(1, 100, 100);
      t.move(1, 100, 140);
      expect(t.panning).toBe(true);
      t.reset();
      expect(t.phase).toBe('idle');
      expect(t.move(1, 100, 200)).toBe(0);
    });

    it('an up for a pointer that never went down cannot drive contacts negative', () => {
      const t = createTouchPanTracker();
      t.up(7);
      t.down(1, 100, 100);
      expect(t.move(1, 100, 140)).toBe(-40);
    });
  });
});
