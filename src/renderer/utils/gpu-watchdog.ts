/**
 * The renderer half of the GPU watchdog (issue #229).
 *
 * ## What it is for
 *
 * After ~2.5 days of uptime the reporter's window stopped painting. Nothing
 * had crashed: `Responding=True`, every PTY alive, the renderer process idle
 * and paged down to 3 MB. Killing ONLY the GPU process brought rendering back
 * instantly with the same renderer PID and nothing lost. That is the shape of
 * a wedged display compositor, which lives in Chromium's GPU process, and it
 * came with no repro — a 4-adapter hybrid + DisplayLink machine, a huge
 * transparent window, and time.
 *
 * wmux cannot fix Chromium's compositor. It CAN notice that it has stopped
 * producing frames and apply the remedy the reporter proved safe.
 *
 * ## How the probe knows
 *
 * `requestAnimationFrame` is not a timer. Its callbacks run inside the
 * BeginMainFrame the renderer's compositor schedules on a BeginFrame from the
 * display compositor in the GPU process. When that process stops producing
 * frames, BeginFrames stop, rAF stops, and `setTimeout` keeps running because
 * the renderer main thread is perfectly healthy. So the probe is a race:
 * request a frame, and at the next timer tick check whether it came.
 *
 * The reporter's numbers say the same thing from the other side: a renderer
 * with agents streaming into seven panes had 0% CPU and a trimmed working set,
 * i.e. it was not running its frame loop at all.
 *
 * ## What it deliberately does not decide
 *
 * A hidden document legitimately gets no frames (Chromium throttles rAF for
 * minimized and fully-occluded windows), so misses while hidden are discarded,
 * not accumulated. But "visible" is the document's opinion of itself and the
 * probe never acts on its own: it reports to main, which alone can see whether
 * the window is FOCUSED and whether the user has touched the machine (OS idle
 * time) — the gates that turn "no frames" into "wedged". See
 * `src/main/gpu-watchdog.ts`.
 *
 * Pure state machine + a thin loop, so the wedge can be tested without a
 * compositor to wedge.
 */

export interface GpuProbeConfig {
  /** How often a frame is requested and the previous request checked. */
  probeIntervalMs: number;
  /** Consecutive unanswered requests before main is told. */
  missesToStall: number;
}

export const GPU_PROBE_DEFAULTS: GpuProbeConfig = {
  probeIntervalMs: 5000,
  // 3 × 5 s = 15 s without a frame while visible. Long enough that a busy
  // main thread under heavy PTY output cannot fake it; short enough that a
  // user who has just noticed the freeze is not left staring at it.
  missesToStall: 3,
};

export interface GpuProbeState {
  /** Consecutive ticks at which the requested frame had not arrived. */
  misses: number;
  /** A frame was requested at the last tick and has not arrived yet. */
  framePending: boolean;
  /** The tick that requested the first frame of the current run of misses. */
  stalledSince: number | null;
  lastTickAt: number | null;
}

export interface GpuProbeTick {
  now: number;
  /** `document.visibilityState === 'visible'` at the tick. */
  visible: boolean;
}

export type GpuProbeVerdict =
  | { kind: 'ok' }
  | { kind: 'miss'; misses: number }
  /** Misses discarded: the document was hidden, so no frames is the normal state. */
  | { kind: 'hidden' }
  | { kind: 'stall'; missed: number; stalledForMs: number };

export interface GpuStallReport {
  missed: number;
  stalledForMs: number;
}

export function initialProbeState(): GpuProbeState {
  return { misses: 0, framePending: false, stalledSince: null, lastTickAt: null };
}

/** The frame requested at the last tick arrived. */
export function noteFrame(state: GpuProbeState): GpuProbeState {
  return state.framePending ? { ...state, framePending: false } : state;
}

/**
 * One timer tick: judge the previous frame request, then request the next one
 * (the returned state always has `framePending: true` — the caller issues the
 * actual rAF).
 */
export function evaluateProbe(
  state: GpuProbeState,
  tick: GpuProbeTick,
  cfg: GpuProbeConfig,
): { next: GpuProbeState; verdict: GpuProbeVerdict } {
  const requestNext = (s: Omit<GpuProbeState, 'framePending' | 'lastTickAt'>): GpuProbeState => ({
    ...s,
    framePending: true,
    lastTickAt: tick.now,
  });

  if (!state.framePending) {
    return { next: requestNext({ misses: 0, stalledSince: null }), verdict: { kind: 'ok' } };
  }

  if (!tick.visible) {
    // Evidence gathered while hidden is not evidence. Drop the run rather
    // than pause it: a window that was wedged before it was minimized will
    // build a fresh run within seconds of being shown again.
    return { next: requestNext({ misses: 0, stalledSince: null }), verdict: { kind: 'hidden' } };
  }

  const misses = state.misses + 1;
  const stalledSince = state.stalledSince ?? state.lastTickAt ?? tick.now;
  if (misses >= cfg.missesToStall) {
    // Reset after reporting. Main rate-limits restarts; the probe's job is to
    // say it once per run, not to keep shouting while main is deciding.
    return {
      next: requestNext({ misses: 0, stalledSince: null }),
      verdict: { kind: 'stall', missed: misses, stalledForMs: tick.now - stalledSince },
    };
  }
  return { next: requestNext({ misses, stalledSince }), verdict: { kind: 'miss', misses } };
}

export interface GpuProbeDeps {
  requestFrame: (cb: () => void) => void;
  isVisible: () => boolean;
  report: (stall: GpuStallReport) => void;
  config?: GpuProbeConfig;
  now?: () => number;
}

/** Run the probe loop. Returns a stop function. */
export function startGpuProbe(deps: GpuProbeDeps): () => void {
  const cfg = deps.config ?? GPU_PROBE_DEFAULTS;
  const now = deps.now ?? (() => Date.now());
  let state = initialProbeState();
  let stopped = false;
  // Each request carries its own generation so a frame that finally lands
  // after `stop()` — or after a later request superseded it — cannot clear a
  // newer pending flag. rAF callbacks cannot be reliably cancelled from a
  // wedged compositor, and they may all fire at once when it recovers.
  let generation = 0;

  const tick = (): void => {
    if (stopped) return;
    const { next, verdict } = evaluateProbe(state, { now: now(), visible: deps.isVisible() }, cfg);
    state = next;
    const gen = ++generation;
    deps.requestFrame(() => {
      if (stopped || gen !== generation) return;
      state = noteFrame(state);
    });
    if (verdict.kind === 'stall') {
      deps.report({ missed: verdict.missed, stalledForMs: verdict.stalledForMs });
    }
  };

  const timer = setInterval(tick, cfg.probeIntervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
