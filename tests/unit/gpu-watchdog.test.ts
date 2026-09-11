import { describe, it, expect, vi } from 'vitest';
import {
  evaluateProbe,
  noteFrame,
  initialProbeState,
  startGpuProbe,
  GPU_PROBE_DEFAULTS,
  type GpuProbeState,
} from '../../src/renderer/utils/gpu-watchdog';
import { decideGpuRestart, GPU_RESTART_DEFAULTS } from '../../src/main/gpu-watchdog';

// ─────────────────────────────────────────────────────────────────────────────
// Issue #229 — after ~2.5 days the GPU process wedged: the window kept its
// last frame, every PTY stayed alive, and killing ONLY the GPU process brought
// rendering back with nothing lost. There is no repro. What wmux can own is
// the remedy: notice that no frame has been produced while the user is
// demonstrably looking at the window, and restart its own GPU process.
//
// Detection: requestAnimationFrame is driven by BeginFrames from the display
// compositor in the GPU process, so when that process stops producing frames
// rAF stops firing while setTimeout keeps running. The renderer probe is that
// race; the main-side decision is the gate that keeps it from ever firing on a
// window nobody is looking at.
// ─────────────────────────────────────────────────────────────────────────────

const cfg = GPU_PROBE_DEFAULTS;

/** A tick where the previous frame request never came back. */
function missedTick(state: GpuProbeState, now: number, visible = true) {
  return evaluateProbe(state, { now, visible }, cfg);
}

describe('evaluateProbe', () => {
  it('starts clean: the first tick has nothing to miss and just requests a frame', () => {
    const { next, verdict } = evaluateProbe(initialProbeState(), { now: 0, visible: true }, cfg);
    expect(verdict.kind).toBe('ok');
    expect(next.framePending).toBe(true);
    expect(next.misses).toBe(0);
  });

  it('a frame that arrived clears the pending flag and keeps the run at zero', () => {
    let s = evaluateProbe(initialProbeState(), { now: 0, visible: true }, cfg).next;
    s = noteFrame(s);
    expect(s.framePending).toBe(false);
    const r = evaluateProbe(s, { now: 5000, visible: true }, cfg);
    expect(r.verdict.kind).toBe('ok');
    expect(r.next.misses).toBe(0);
  });

  it('counts a frame that never came back as a miss, while visible', () => {
    let s = evaluateProbe(initialProbeState(), { now: 0, visible: true }, cfg).next;
    const r = missedTick(s, 5000);
    expect(r.verdict).toEqual({ kind: 'miss', misses: 1 });
    expect(r.next.misses).toBe(1);
  });

  it('reports a stall only after the configured run of consecutive misses', () => {
    let s = evaluateProbe(initialProbeState(), { now: 0, visible: true }, cfg).next;
    let verdicts: string[] = [];
    for (let i = 1; i <= cfg.missesToStall; i++) {
      const r = missedTick(s, i * cfg.probeIntervalMs);
      verdicts.push(r.verdict.kind);
      s = r.next;
    }
    expect(verdicts).toEqual(['miss', 'miss', 'stall']);
  });

  it('the stall carries how long frames have been missing, measured from the tick that requested the first missed one', () => {
    let s = evaluateProbe(initialProbeState(), { now: 1000, visible: true }, cfg).next;
    let last = missedTick(s, 6000);
    s = last.next;
    last = missedTick(s, 11000);
    s = last.next;
    last = missedTick(s, 16000);
    expect(last.verdict).toEqual({ kind: 'stall', missed: 3, stalledForMs: 15000 });
  });

  it('resets after reporting, so a second report needs a fresh run — main rate-limits, the probe does not spam', () => {
    let s = evaluateProbe(initialProbeState(), { now: 0, visible: true }, cfg).next;
    for (let i = 1; i <= cfg.missesToStall; i++) s = missedTick(s, i * 5000).next;
    expect(s.misses).toBe(0);
    expect(s.stalledSince).toBeNull();
    // The very next miss is a plain miss again, not a second stall.
    expect(missedTick(s, 20000).verdict.kind).toBe('miss');
  });

  it('discards misses while the document is hidden — a minimized or occluded window legitimately gets no frames', () => {
    let s = evaluateProbe(initialProbeState(), { now: 0, visible: true }, cfg).next;
    s = missedTick(s, 5000).next;
    s = missedTick(s, 10000).next;
    expect(s.misses).toBe(2);
    const r = missedTick(s, 15000, /* visible */ false);
    expect(r.verdict.kind).toBe('hidden');
    expect(r.next.misses).toBe(0);
    expect(r.next.stalledSince).toBeNull();
  });

  it('a late frame — arriving after the miss was counted — clears the run', () => {
    // The renderer main thread can be busy for a few seconds under heavy PTY
    // output; a frame that lands late is a frame, not a wedge.
    let s = evaluateProbe(initialProbeState(), { now: 0, visible: true }, cfg).next;
    s = missedTick(s, 5000).next;
    s = missedTick(s, 10000).next;
    s = noteFrame(s);
    const r = evaluateProbe(s, { now: 15000, visible: true }, cfg);
    expect(r.verdict.kind).toBe('ok');
    expect(r.next.misses).toBe(0);
  });
});

describe('startGpuProbe', () => {
  function harness() {
    vi.useFakeTimers();
    let wedged = false;
    const frameCallbacks: Array<() => void> = [];
    const requestFrame = (cb: () => void) => {
      if (!wedged) setTimeout(cb, 16);
      else frameCallbacks.push(cb);
    };
    const report = vi.fn();
    const stop = startGpuProbe({
      requestFrame,
      isVisible: () => true,
      report,
      config: cfg,
    });
    return {
      report,
      stop,
      wedge: () => { wedged = true; },
      unwedge: () => { wedged = false; frameCallbacks.splice(0).forEach((cb) => cb()); },
    };
  }

  it('is silent while frames arrive', () => {
    const h = harness();
    vi.advanceTimersByTime(cfg.probeIntervalMs * 20);
    expect(h.report).not.toHaveBeenCalled();
    h.stop();
    vi.useRealTimers();
  });

  it('reports once frames stop for the configured run, and again only after a fresh run', () => {
    const h = harness();
    vi.advanceTimersByTime(cfg.probeIntervalMs * 2);
    h.wedge();
    vi.advanceTimersByTime(cfg.probeIntervalMs * (cfg.missesToStall + 1));
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report.mock.calls[0][0]).toMatchObject({ missed: cfg.missesToStall });
    vi.advanceTimersByTime(cfg.probeIntervalMs * cfg.missesToStall);
    expect(h.report).toHaveBeenCalledTimes(2);
    h.stop();
    vi.useRealTimers();
  });

  it('recovers when frames come back and stops when told to', () => {
    const h = harness();
    h.wedge();
    vi.advanceTimersByTime(cfg.probeIntervalMs * 2);
    h.unwedge();
    vi.advanceTimersByTime(cfg.probeIntervalMs * 10);
    expect(h.report).not.toHaveBeenCalled();
    h.stop();
    h.wedge();
    vi.advanceTimersByTime(cfg.probeIntervalMs * 10);
    expect(h.report).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Main-side decision. The probe says "no frames"; only main can say "and the
// user is actually there". Every gate below is a false positive that would
// otherwise cost a GPU restart — and enough restarts in a row make Chromium
// give up on hardware acceleration for the rest of the session.
// ─────────────────────────────────────────────────────────────────────────────

const ok = {
  now: 1_000_000,
  enabled: true,
  gpuPid: 4242,
  focused: true,
  visible: true,
  minimized: false,
  idleSeconds: 3,
  lastRestartAt: null as number | null,
  ...GPU_RESTART_DEFAULTS,
};

describe('decideGpuRestart', () => {
  it('restarts when the user is active, the window is focused and there is a GPU process to kill', () => {
    expect(decideGpuRestart(ok)).toEqual({ action: 'restart', pid: 4242 });
  });

  it('is inert when the pref turns it off', () => {
    expect(decideGpuRestart({ ...ok, enabled: false })).toEqual({ action: 'skip', reason: 'disabled' });
  });

  it('never kills anything when no GPU process is listed — software compositing, or already gone', () => {
    expect(decideGpuRestart({ ...ok, gpuPid: null })).toEqual({ action: 'skip', reason: 'no-gpu-process' });
  });

  it('requires the window to be the one the user is looking at', () => {
    // A focused window cannot be minimized or fully occluded, which is what
    // makes "no frames" mean "wedged" rather than "throttled".
    expect(decideGpuRestart({ ...ok, focused: false })).toEqual({ action: 'skip', reason: 'unfocused' });
    expect(decideGpuRestart({ ...ok, minimized: true })).toEqual({ action: 'skip', reason: 'minimized' });
    expect(decideGpuRestart({ ...ok, visible: false })).toEqual({ action: 'skip', reason: 'hidden' });
  });

  it('requires recent input at the OS level — a locked or unattended machine must never trip it', () => {
    expect(decideGpuRestart({ ...ok, idleSeconds: GPU_RESTART_DEFAULTS.maxIdleSeconds + 1 }))
      .toEqual({ action: 'skip', reason: 'idle' });
    expect(decideGpuRestart({ ...ok, idleSeconds: GPU_RESTART_DEFAULTS.maxIdleSeconds }).action).toBe('restart');
  });

  it('rate-limits: a second restart inside the interval is refused', () => {
    const just = ok.now - GPU_RESTART_DEFAULTS.minIntervalMs + 1;
    expect(decideGpuRestart({ ...ok, lastRestartAt: just })).toEqual({ action: 'skip', reason: 'rate-limited' });
    const longAgo = ok.now - GPU_RESTART_DEFAULTS.minIntervalMs;
    expect(decideGpuRestart({ ...ok, lastRestartAt: longAgo }).action).toBe('restart');
  });
});
