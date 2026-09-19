import { describe, it, expect } from 'vitest';
import { wheelForward } from '../../src/renderer/utils/wheel-forward';

// Issue #245. One wheel detent over a mouse-tracking pane moved ~5x what the
// same detent moves in any other terminal, because wmux emitted one SGR report
// per LINE and the app then applied its own per-report multiplier on top.
//
// The unit of the mouse-report branch is a STEP; the unit of the arrow branch
// is a LINE. Every case below exists to keep those two from being confused
// again — there is no assertion here that isn't about which unit is in play.

const at = (o: Partial<Parameters<typeof wheelForward>[0]> = {}) => wheelForward({
  lines: 6,
  mouseTracking: true,
  source: 'wheel',
  col: 40,
  row: 12,
  ...o,
});

describe('wheelForward', () => {
  describe('a mouse-tracking app is sent one report per EVENT', () => {
    it('collapses a six-line detent to a single report', () => {
      expect(at({ lines: 6 })).toEqual({ seq: '\x1b[<65;40;12M', repeats: 1 });
    });

    it('collapses it the same way scrolling up', () => {
      expect(at({ lines: -6 })).toEqual({ seq: '\x1b[<64;40;12M', repeats: 1 });
    });

    it('a one-line event is also one report — the count is only a gate', () => {
      expect(at({ lines: 1 })?.repeats).toBe(1);
      expect(at({ lines: -1 })?.repeats).toBe(1);
    });

    it('reports at the pointer cell', () => {
      expect(at({ col: 1, row: 1 })?.seq).toBe('\x1b[<65;1;1M');
    });
  });

  describe('a touch pan keeps one report per LINE of finger travel', () => {
    // A finger is a position, not a detent: the gesture has to track the skin.
    // wmux cannot know the app's per-report multiplier, so one report per cell
    // crossed is the closest it can get, and it is exact wherever that
    // multiplier is 1.
    it('emits one report per line', () => {
      expect(at({ source: 'touch', lines: 6 })).toEqual({ seq: '\x1b[<65;40;12M', repeats: 6 });
    });

    it('counts magnitude, not sign, when panning the other way', () => {
      expect(at({ source: 'touch', lines: -4 })).toEqual({ seq: '\x1b[<64;40;12M', repeats: 4 });
    });
  });

  describe('the arrow-key branch stays one arrow per LINE, for both sources', () => {
    // A deliberate divergence from xterm, which sends ONE arrow per wheel
    // event. wmux's own scrollback branch moves `lines` rows per event, and an
    // arrow in less/vim moves exactly one row with no app-side multiplier — so
    // per-line is what makes a non-mouse pager scroll at the same speed as the
    // scrollback right beside it. The multiplier, not the loop, was #245.
    it('loops the down arrow for a wheel detent', () => {
      expect(at({ mouseTracking: false, lines: 6 })).toEqual({ seq: '\x1b[B', repeats: 6 });
    });

    it('loops the up arrow', () => {
      expect(at({ mouseTracking: false, lines: -6 })).toEqual({ seq: '\x1b[A', repeats: 6 });
    });

    it('treats a touch pan identically', () => {
      expect(at({ mouseTracking: false, source: 'touch', lines: 3 })).toEqual({ seq: '\x1b[B', repeats: 3 });
    });
  });

  describe('nothing to send', () => {
    it('answers null on a sub-line event, whatever the branch', () => {
      expect(at({ lines: 0 })).toBeNull();
      expect(at({ lines: 0, source: 'touch' })).toBeNull();
      expect(at({ lines: 0, mouseTracking: false })).toBeNull();
    });
  });
});
