import type { Terminal } from '@xterm/xterm';

/**
 * Scroll anchoring — idea 3 of issue #207: "I can't start reading the beginning
 * of an answer while the agent is still writing."
 *
 * A terminal follows its newest output. That is right for a shell and wrong for
 * an agent, which emits a screenful of reasoning in one burst: by the time the
 * answer is worth reading, its first line is gone. Anchoring pins the viewport
 * at the line the prompt started on and lets the output grow BELOW the visible
 * area, with a count of how much is waiting.
 *
 * ─── ARMED vs ENGAGED, and why the distinction is the whole design ───────────
 *
 * The first version of this file released its anchor on the very first line of
 * output, so the feature never held anything. The mechanism is worth writing
 * down, because it is not visible from this file alone.
 *
 * A prompt is submitted at the BOTTOM of the buffer, so its line is `>= ydisp`.
 * xterm's `scrollToLine` on such a line takes the "scrolled to the bottom"
 * branch: it sets `isUserScrolling = false`, clamps, and does not move. Then the
 * next write scrolls, and `BufferService` does `if (!isUserScrolling) ydisp =
 * ybase` before firing `onScroll` — so the listener sees `viewportY === baseY`,
 * reads it as "the user caught up", and releases. Every time, on the first line.
 *
 * So an anchor has two states. **Armed**: recorded, but the prompt is still on
 * the first screen and there is genuinely nothing to hold back — the terminal
 * follows output exactly as it always did, and no pill appears, because nothing
 * is hidden. **Engaged**: the buffer has grown past the anchor, the viewport is
 * held above the bottom, and xterm's own `isUserScrolling` is now true so it
 * stops following on its own.
 *
 * The release rule only applies while ENGAGED. Before that, "the viewport is at
 * the bottom" is the normal state, not a gesture.
 *
 * ─── Why the line is a resolver, not a number ────────────────────────────────
 *
 * An absolute buffer line stops meaning the same row once the scrollback is full
 * and lines are trimmed off the top. The anchored prompt already has something
 * that tracks its row through that — its xterm marker — so this module asks for
 * the line each time instead of caching one. A resolver that answers null means
 * the marker is gone (the prompt scrolled out of history entirely), which is the
 * honest moment to give up rather than hold a row that no longer exists.
 *
 * ─── Why none of this is in the Zustand store ────────────────────────────────
 *
 * The pending-line count changes on every PTY chunk — several hundred times a
 * second under a busy agent. Putting it in the store would re-render every
 * subscriber at PTY speed, which is the shape of the bug issue #141 documents.
 * So the anchor lives in a module-level map, exactly like `surfaceMouseModes`,
 * and the one component that needs to see it subscribes to a THROTTLED DOM
 * event. Holding is coalesced into one animation frame for the same reason: it
 * is bounded at 60/s no matter how fast the PTY writes, and it lands after xterm
 * has finished with the chunk rather than during it.
 */

/** Where the anchored prompt currently sits, or null once it is gone. */
export type LineResolver = () => number | null;

interface AnchorState {
  resolve: LineResolver;
  /**
   * A line the USER scrolled to, which overrides the resolver.
   *
   * Once someone has chosen where to read from, holding them at the prompt
   * instead would be fighting them. Set on any non-bottom scroll they make.
   */
  override: number | null;
  /** Last line actually held. */
  line: number;
  /** Lines that exist below the bottom of the held viewport. */
  pending: number;
  /** True once the viewport has actually been held above the bottom. */
  engaged: boolean;
}

/** surfaceId → anchor, present only while that surface is anchored. */
const anchors = new Map<string, AnchorState>();

/** Surfaces with a correction owed on the next frame. */
const dirty = new Set<string>();
let frame: number | null = null;

/**
 * Set while this module is driving the viewport itself, so the scroll listener
 * does not read our own correction as a user gesture. A counter rather than a
 * boolean: two surfaces can correct in the same frame.
 */
let selfScrolling = 0;

/** The event the pill listens to. Detail is `AnchorEventDetail`. */
export const ANCHOR_EVENT = 'wmux:prompt-anchor';

export interface AnchorEventDetail {
  surfaceId: string;
  /** Whether anything is actually being held back — i.e. ENGAGED, not merely armed. */
  active: boolean;
  pending: number;
}

/**
 * Minimum gap between two events for the same surface, in ms.
 *
 * The pill shows an approximate count of unread lines; updating it 8×/s is
 * already faster than anyone reads a number, and it keeps a React setState off
 * the PTY write path. A state CHANGE (engaging, releasing) bypasses the
 * throttle — those are what the user is waiting on, not a counter tick.
 */
const EVENT_INTERVAL_MS = 125;
const lastEventAt = new Map<string, number>();

function emit(surfaceId: string, active: boolean, pending: number, force: boolean): void {
  const now = Date.now();
  if (!force && now - (lastEventAt.get(surfaceId) ?? 0) < EVENT_INTERVAL_MS) return;
  lastEventAt.set(surfaceId, now);
  try {
    document.dispatchEvent(
      new CustomEvent<AnchorEventDetail>(ANCHOR_EVENT, { detail: { surfaceId, active, pending } }),
    );
  } catch {
    // No DOM (unit tests, headless) — the anchor still works, nothing shows it.
  }
}

/** The live anchor for a surface, or null. */
export function anchorFor(surfaceId: string): AnchorState | null {
  return anchors.get(surfaceId) ?? null;
}

/** Whether a surface is holding its viewport back right now (not merely armed). */
export function isEngaged(surfaceId: string): boolean {
  return anchors.get(surfaceId)?.engaged ?? false;
}

/**
 * Can this terminal be anchored at all right now?
 *
 * The alt buffer has no scrollback and belongs entirely to the application
 * drawing it — vim, tmux, less. Holding a viewport there would fight a program
 * that repaints the whole screen every frame and would look like a hang.
 */
export function canAnchor(terminal: Terminal): boolean {
  try {
    return terminal.buffer.active.type === 'normal';
  } catch {
    return false;
  }
}

/** Lines below the bottom of a viewport held at `line`. */
function pendingBelow(terminal: Terminal, line: number): number {
  const buf = terminal.buffer.active;
  const lastUsed = buf.baseY + buf.cursorY;
  return Math.max(0, lastUsed - (line + terminal.rows - 1));
}

/** The line this anchor should be holding, or null if it no longer has one. */
function targetLine(state: AnchorState): number | null {
  if (state.override !== null) return state.override;
  const line = state.resolve();
  return Number.isFinite(line as number) && (line as number) >= 0 ? line : null;
}

/**
 * Arm an anchor for `surfaceId` at whatever line `resolve` reports.
 *
 * Returns false only when anchoring is impossible at all (alt buffer, or a
 * resolver with nothing to point at). It deliberately does NOT refuse a prompt
 * that is still on the first screen: that is the normal case at submission time,
 * and the anchor simply stays armed until the buffer grows past it.
 */
export function anchorAt(terminal: Terminal, surfaceId: string, resolve: LineResolver): boolean {
  if (!canAnchor(terminal)) return false;
  const state: AnchorState = { resolve, override: null, line: 0, pending: 0, engaged: false };
  const line = targetLine(state);
  if (line === null) return false;
  state.line = line;
  anchors.set(surfaceId, state);
  // Try to engage straight away: re-anchoring on a later prompt, or anchoring a
  // pane that already has a full screen of scrollback, can hold immediately.
  hold(terminal, surfaceId);
  return true;
}

/**
 * Bring one anchor up to date: resolve its line, engage if it now can, and
 * report. Runs on a frame, never on the write itself.
 */
function hold(terminal: Terminal, surfaceId: string): void {
  const state = anchors.get(surfaceId);
  if (!state) return;

  // An anchor whose terminal has switched to the alt buffer since it was set is
  // released, not held: the application owns the screen now.
  if (!canAnchor(terminal)) {
    release(surfaceId);
    return;
  }

  const line = targetLine(state);
  if (line === null) {
    // The prompt scrolled out of the scrollback entirely. There is no row left
    // to hold, and holding the last known number would pin the user to whatever
    // has since taken that index.
    release(surfaceId);
    return;
  }
  state.line = line;

  const buf = terminal.buffer.active;
  if (line >= buf.baseY) {
    // Still armed: the prompt is on the last screen, nothing is hidden below it,
    // and the terminal following output is the correct behaviour. Scrolling here
    // would be a no-op that also told xterm we are NOT user-scrolling.
    state.engaged = false;
    state.pending = 0;
    return;
  }

  selfScrolling++;
  try {
    terminal.scrollToLine(line);
    state.engaged = true;
    state.pending = pendingBelow(terminal, line);
    emit(surfaceId, true, state.pending, false);
  } catch {
    // A disposed terminal, or a line the emulator no longer has.
    anchors.delete(surfaceId);
    emit(surfaceId, false, 0, true);
  } finally {
    selfScrolling--;
  }
}

/**
 * Correct every dirty surface once, on the next frame.
 *
 * Terminals are looked up through a resolver rather than held here, so this
 * module never keeps a reference to a Terminal that may be disposed — the same
 * reason `surfaceTerminalRegistry` exists and is cleared on unmount.
 */
function scheduleHold(resolveTerminal: (surfaceId: string) => Terminal | undefined): void {
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    const due = Array.from(dirty);
    dirty.clear();
    for (const surfaceId of due) {
      const terminal = resolveTerminal(surfaceId);
      if (terminal) hold(terminal, surfaceId);
    }
  });
}

/**
 * Called after each PTY chunk reaches xterm. Cheap and allocation-free for the
 * overwhelming majority of surfaces, which are not anchored.
 */
export function noteOutput(
  surfaceId: string,
  resolveTerminal: (surfaceId: string) => Terminal | undefined,
): void {
  if (!anchors.has(surfaceId)) return;
  dirty.add(surfaceId);
  scheduleHold(resolveTerminal);
}

/**
 * Release the anchor and follow output again.
 *
 * `terminal` is optional so a teardown path can release without one; when it is
 * given, the viewport jumps to the bottom, which is what every caller reacting
 * to a user gesture ("show me the rest") wants.
 */
export function release(surfaceId: string, terminal?: Terminal): void {
  const had = anchors.delete(surfaceId);
  dirty.delete(surfaceId);
  if (terminal) {
    try { terminal.scrollToBottom(); } catch { /* disposed — nothing to scroll */ }
  }
  if (had) emit(surfaceId, false, 0, true);
}

/**
 * Release every live anchor.
 *
 * Exists for one case that is otherwise a trap: switching the feature off in
 * Settings. Turning off the producer stops NEW anchors, but a pane that is
 * already held stays held, with the pill still on it and nothing in the panel
 * the user just used to explain why (#207 review). Terminals are resolved
 * rather than passed, so every released pane also jumps back to the bottom.
 */
export function releaseAll(resolveTerminal: (surfaceId: string) => Terminal | undefined): void {
  for (const surfaceId of Array.from(anchors.keys())) {
    release(surfaceId, resolveTerminal(surfaceId));
  }
}

/**
 * Handle a scroll that xterm reported for an anchored surface.
 *
 * Two gates, and both matter. `selfScrolling` skips our own correction. The
 * ENGAGED check skips xterm's follow-the-output scroll, which fires with the
 * viewport at the bottom and would otherwise release the anchor on the first
 * line of output — see the header.
 *
 * Once engaged, releasing on "reached the bottom" is unambiguous: xterm has
 * stopped following (its own `isUserScrolling` is true), so a viewport back at
 * the bottom can only be the user putting it there.
 */
export function handleScroll(terminal: Terminal, surfaceId: string): void {
  if (selfScrolling > 0) return;
  const state = anchors.get(surfaceId);
  if (!state || !state.engaged) return;
  try {
    const buf = terminal.buffer.active;
    if (buf.viewportY >= buf.baseY) {
      release(surfaceId);
      return;
    }
    // The user moved but is not caught up. Follow them — and stop consulting the
    // resolver, because from here on the line they chose is the anchor.
    state.override = buf.viewportY;
    state.line = buf.viewportY;
    state.pending = pendingBelow(terminal, state.line);
    emit(surfaceId, true, state.pending, false);
  } catch {
    release(surfaceId);
  }
}

/** Drop everything for a surface (PTY exit, pane close, terminal disposal). */
export function forgetSurface(surfaceId: string): void {
  const had = anchors.delete(surfaceId);
  dirty.delete(surfaceId);
  lastEventAt.delete(surfaceId);
  if (had) emit(surfaceId, false, 0, true);
}

/** Test seam: drop all state without touching the DOM. */
export function __resetAnchors(): void {
  anchors.clear();
  dirty.clear();
  lastEventAt.clear();
  selfScrolling = 0;
  if (frame !== null) {
    cancelAnimationFrame(frame);
    frame = null;
  }
}

/** Test seam: run the pending frame's work synchronously. */
export function __holdNow(terminal: Terminal, surfaceId: string): void {
  dirty.delete(surfaceId);
  hold(terminal, surfaceId);
}
