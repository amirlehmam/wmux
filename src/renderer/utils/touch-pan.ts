/**
 * Touch pan → wheel, the recognition half (issue #243).
 *
 * A finger dragged over a terminal pane scrolled nothing. The cause is upstream
 * and precise: wmux pins `@xterm/xterm` 6.0.0, which is where xterm replaced its
 * native overflow scroller (a finger could drag it) with the VS Code
 * `SmoothScrollableElement` — a custom overlay scrollbar that is wheel-only, and
 * it shipped no touch replacement (xtermjs/xterm.js#5489). The fix for that,
 * xtermjs/xterm.js#5563, is milestoned 7.0.0 and is in no stable release.
 *
 * A dependency bump would not have been the whole fix anyway, and would have
 * been the wrong fix here for a reason specific to wmux: the upstream repair
 * only moves the scrollable position, which drives SCROLLBACK, and the alternate
 * buffer has no scrollback. The panes wmux exists to show — opencode, Claude
 * Code, Codex — all switch to the alt screen (`\x1b[?1049h`), so upstream's fix
 * would leave a finger inert in exactly those panes.
 *
 * wmux does not use xterm's wheel pipeline at all. `handleTerminalWheel` in
 * `useTerminal.ts` takes the wheel on the CAPTURE phase and already decides
 * between the three outcomes — scrollback, SGR wheel reports, and arrow keys for
 * a non-mouse pager on the alt screen. So the whole fix is to put the gesture
 * into that existing pipeline as a synthetic `WheelEvent`, and every behaviour
 * the wheel has is inherited rather than re-derived. That is also why this
 * module measures NOTHING in cells: `wheelDeltaToLines` already keeps a
 * per-surface fractional accumulator against the user's measured cell height,
 * and a second accumulator here would be a second answer to one question, free
 * to drift from the first.
 *
 * What is left is gesture recognition, and it is pure so it can be tested with
 * no DOM, no Electron and no touchscreen — the machine that reproduces this bug
 * is not the one CI runs on.
 *
 * The state machine mirrors the prompt anchor's armed/engaged distinction for
 * the same reason it exists there: the interesting states are the ones BEFORE
 * the feature acts.
 *
 *   idle      nothing down
 *   tracking  a finger is down but has not moved past the tap slop — it may
 *             still turn out to be a tap, and a tap must never scroll
 *   panning   it moved past the slop, vertically — emit wheel deltas
 *   rejected  it moved past the slop the WRONG way (horizontal), or a second
 *             finger landed (pinch/zoom). Inert until every finger lifts, which
 *             is deliberate: re-arming mid-gesture would make a pinch stutter
 *             the viewport every time the two fingers drifted apart vertically.
 */

/**
 * How far a finger may travel before the gesture stops being a tap.
 *
 * A finger is not a mouse: a "stationary" touch wanders a few pixels from skin
 * deformation and sensor noise alone, so a zero threshold would scroll on every
 * tap. 8px is the conventional Android/Chromium touch slop, and it is smaller
 * than one terminal cell at every font size wmux ships, so nothing is lost by
 * discarding it.
 */
export const TAP_SLOP_PX = 8;

/**
 * Ceiling on one move's contribution, in pixels.
 *
 * Not for ordinary flicks — a pointermove carries at most a frame of travel, so
 * even a fast flick is tens of pixels. This is for the pathological jump: a
 * pointer capture lost and regained, or a coalesced burst after the renderer
 * stalls, arriving as one enormous delta. On the alt screen `writeWheelToPty`
 * turns each line into an arrow key in a `for` loop, so an unclamped delta is
 * not a big scroll, it is thousands of keystrokes written to a PTY.
 */
export const MAX_PAN_STEP_PX = 600;

type PanPhase = 'idle' | 'tracking' | 'panning' | 'rejected';

export interface TouchPanTracker {
  /** Current phase — exported for the tests and for the `touch-action` decision. */
  readonly phase: PanPhase;
  /** True once the gesture is a vertical pan, i.e. pointermove must be prevented. */
  readonly panning: boolean;
  /** A finger landed. */
  down(pointerId: number, x: number, y: number): void;
  /** A finger moved. Returns the wheel deltaY in pixels to dispatch, or 0. */
  move(pointerId: number, x: number, y: number): number;
  /** A finger lifted or its gesture was cancelled. */
  up(pointerId: number): void;
  /** Drop all state (teardown, or the pane losing its element). */
  reset(): void;
}

export function createTouchPanTracker(): TouchPanTracker {
  let phase: PanPhase = 'idle';
  let activeId: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastY = 0;
  // Fingers currently down, so a pinch stays rejected until the LAST one lifts
  // rather than re-arming when the first does.
  let contacts = 0;

  return {
    get phase() { return phase; },
    get panning() { return phase === 'panning'; },

    down(pointerId, x, y) {
      contacts++;
      if (activeId !== null) {
        // A second finger. Whatever this is — pinch, zoom, a stray palm — it is
        // not the one-finger pan this translates, and guessing is worse than
        // doing nothing.
        phase = 'rejected';
        return;
      }
      activeId = pointerId;
      startX = x;
      startY = y;
      lastY = y;
      phase = 'tracking';
    },

    move(pointerId, x, y) {
      if (pointerId !== activeId) return 0;

      if (phase === 'tracking') {
        const dx = x - startX;
        const dy = y - startY;
        if (Math.abs(dx) < TAP_SLOP_PX && Math.abs(dy) < TAP_SLOP_PX) return 0;
        // Axis lock, decided once at the moment the slop is crossed and never
        // revisited. A pan that starts sideways stays inert for its whole life:
        // re-deciding per move would let a diagonal drag flicker between
        // scrolling and not, which reads as a stuttering terminal.
        //
        // Ties go to horizontal (`<=`), so an exactly-diagonal drag does
        // nothing rather than something arbitrary.
        if (Math.abs(dy) <= Math.abs(dx)) {
          phase = 'rejected';
          return 0;
        }
        phase = 'panning';
        // Emit from the gesture ORIGIN, not from here, so the content ends up
        // exactly under the finger instead of lagging it by the slop distance.
        lastY = startY;
      }

      if (phase !== 'panning') return 0;

      const travel = y - lastY;
      lastY = y;
      if (travel === 0) return 0;
      // Natural direction: the content follows the finger. Dragging DOWN must
      // reveal what is ABOVE, which is a NEGATIVE wheel delta — `scrollLines`
      // and the `\x1b[A` arrow branch both read positive as "toward newer".
      const delta = -travel;
      return Math.max(-MAX_PAN_STEP_PX, Math.min(MAX_PAN_STEP_PX, delta));
    },

    up(pointerId) {
      if (contacts > 0) contacts--;
      const wasActive = pointerId === activeId;
      if (wasActive) activeId = null;
      // A gesture stays rejected while any finger is still down; only an empty
      // screen returns to idle. Read `wasActive` and not `activeId` here — it
      // has just been cleared, and testing it again is a branch that can never
      // be taken.
      if (contacts === 0) {
        activeId = null;
        phase = 'idle';
      } else if (wasActive) {
        // The panning finger lifted while others remain. Do NOT promote one of
        // them to the pan: the user is mid-pinch, and adopting a survivor would
        // resume scrolling from a position the finger never started at.
        phase = 'rejected';
      }
    },

    reset() {
      phase = 'idle';
      activeId = null;
      contacts = 0;
    },
  };
}
