import { describe, it, expect } from 'vitest';
import { DashboardDaemon } from '../../src/main/agent-browser-daemon';

/** A daemon whose process control and port probe are both stubbed. */
function daemonWith(portAlreadyOpen: boolean) {
  const calls: string[] = [];
  const d = new DashboardDaemon({
    probe: async () => portAlreadyOpen,
    start: async () => { calls.push('start'); return true; },
    stop: async () => { calls.push('stop'); },
  });
  return { d, calls };
}

describe('DashboardDaemon', () => {
  it('starts on the first acquire and stops when the last is released', async () => {
    const { d, calls } = daemonWith(false);
    await d.acquire();
    await d.acquire();
    expect(calls).toEqual(['start']);
    await d.release();
    expect(calls).toEqual(['start']);
    await d.release();
    expect(calls).toEqual(['start', 'stop']);
  });

  it('adopts a dashboard someone else started, and never stops it', async () => {
    const { d, calls } = daemonWith(true);
    await d.acquire();
    expect(calls).toEqual([]);
    expect(d.adopted).toBe(true);
    await d.release();
    expect(calls).toEqual([]);
  });

  it('never lets the refcount go negative', async () => {
    const { d, calls } = daemonWith(false);
    await d.release();
    await d.release();
    expect(calls).toEqual([]);
    await d.acquire();
    expect(calls).toEqual(['start']);
  });

  it('shutdown stops an owned dashboard regardless of refcount', async () => {
    const { d, calls } = daemonWith(false);
    await d.acquire();
    await d.acquire();
    await d.shutdown();
    expect(calls).toEqual(['start', 'stop']);
  });

  it('shutdown leaves an adopted dashboard running', async () => {
    const { d, calls } = daemonWith(true);
    await d.acquire();
    await d.shutdown();
    expect(calls).toEqual([]);
  });

  // --- (a) concurrency: two surfaces flipping to agent mode at once must not
  // race hooks.start() twice. ---
  it('coalesces concurrent acquires into a single start', async () => {
    const calls: string[] = [];
    let resolveProbe!: (v: boolean) => void;
    const probeGate = new Promise<boolean>((r) => { resolveProbe = r; });
    const d = new DashboardDaemon({
      probe: () => probeGate,
      start: async () => { calls.push('start'); return true; },
      stop: async () => { calls.push('stop'); },
    });

    // Both calls issued before either probe/start resolves.
    const p1 = d.acquire();
    const p2 = d.acquire();
    resolveProbe(false); // port not open: both callers should share ONE start attempt
    await Promise.all([p1, p2]);

    expect(calls).toEqual(['start']);
    // Both acquires succeeded, so it takes two releases to stop it.
    await d.release();
    expect(calls).toEqual(['start']);
    await d.release();
    expect(calls).toEqual(['start', 'stop']);
  });

  // --- (b) a failed start must not leave a phantom ref behind. ---
  it('rolls back the refcount when start fails, and lets a later acquire retry', async () => {
    const calls: string[] = [];
    let shouldFail = true;
    const d = new DashboardDaemon({
      probe: async () => false,
      start: async () => { calls.push('start'); return !shouldFail; },
      stop: async () => { calls.push('stop'); },
    });

    await expect(d.acquire()).rejects.toThrow();
    expect(calls).toEqual(['start']);

    // If the failed attempt had left refs at 1, a single release here would
    // wrongly believe a dashboard is running and call stop() on nothing.
    shouldFail = false;
    await d.acquire();
    expect(calls).toEqual(['start', 'start']);

    // Exactly one successful acquire is outstanding: one release stops it.
    await d.release();
    expect(calls).toEqual(['start', 'start', 'stop']);
  });

  // --- (c) `adopted` must not be externally writable. ---
  it('adopted is read-only from the outside', async () => {
    const { d } = daemonWith(true);
    await d.acquire();
    expect(d.adopted).toBe(true);
    expect(() => {
      // @ts-expect-error -- adopted has no public setter; this is the point.
      d.adopted = false;
    }).toThrow();
    expect(d.adopted).toBe(true);
  });

  // --- Regression: release()/shutdown() racing an in-flight acquire() ---
  //
  // Without waiting for an in-flight `starting` attempt to settle,
  // release()/shutdown() read `running`/`adopted` while both are still
  // false, conclude "nothing to stop", and return — and THEN the attempt
  // finishes and sets `running = true` with zero live refs, leaking a
  // dashboard process nothing will ever stop. Each pair below uses the same
  // manual-gate technique as the (a) concurrency test so the interleaving is
  // real, not just two sequential calls.

  it('release() arriving while a start is still in flight still stops it once settled', async () => {
    const calls: string[] = [];
    let resolveProbe!: (v: boolean) => void;
    const probeGate = new Promise<boolean>((r) => { resolveProbe = r; });
    const d = new DashboardDaemon({
      probe: () => probeGate,
      start: async () => { calls.push('start'); return true; },
      stop: async () => { calls.push('stop'); },
    });

    const acquirePromise = d.acquire(); // refs -> 1, probe pending
    const releasePromise = d.release(); // refs -> 0 while the start is still in flight

    resolveProbe(false); // let beginStart proceed to hooks.start()
    await Promise.all([acquirePromise, releasePromise]);

    expect(calls).toEqual(['start', 'stop']);
    expect(d.isAvailable).toBe(false);
  });

  it('shutdown() arriving while a start is still in flight does not leak the process past quit', async () => {
    const calls: string[] = [];
    let resolveProbe!: (v: boolean) => void;
    const probeGate = new Promise<boolean>((r) => { resolveProbe = r; });
    const d = new DashboardDaemon({
      probe: () => probeGate,
      start: async () => { calls.push('start'); return true; },
      stop: async () => { calls.push('stop'); },
    });

    const acquirePromise = d.acquire();
    const shutdownPromise = d.shutdown(); // app quit while probe/start is still pending

    resolveProbe(false);
    await Promise.all([acquirePromise, shutdownPromise]);

    // The whole point: shutdown() must not resolve believing there's nothing
    // to stop, only for the in-flight start to finish AFTER wmux has already
    // exited and spawn a dashboard process nothing will ever reap.
    expect(calls).toEqual(['start', 'stop']);
    expect(d.isAvailable).toBe(false);
  });

  it('release() arriving while an adoption is in flight leaves the dashboard alone', async () => {
    const calls: string[] = [];
    let resolveProbe!: (v: boolean) => void;
    const probeGate = new Promise<boolean>((r) => { resolveProbe = r; });
    const d = new DashboardDaemon({
      probe: () => probeGate,
      start: async () => { calls.push('start'); return true; },
      stop: async () => { calls.push('stop'); },
    });

    const acquirePromise = d.acquire();
    const releasePromise = d.release();

    resolveProbe(true); // someone else already has the dashboard: adopt, don't stop
    await Promise.all([acquirePromise, releasePromise]);

    expect(calls).toEqual([]);
    expect(d.adopted).toBe(true);
  });

  it('shutdown() arriving while an adoption is in flight leaves the dashboard alone', async () => {
    const calls: string[] = [];
    let resolveProbe!: (v: boolean) => void;
    const probeGate = new Promise<boolean>((r) => { resolveProbe = r; });
    const d = new DashboardDaemon({
      probe: () => probeGate,
      start: async () => { calls.push('start'); return true; },
      stop: async () => { calls.push('stop'); },
    });

    const acquirePromise = d.acquire();
    const shutdownPromise = d.shutdown();

    resolveProbe(true);
    await Promise.all([acquirePromise, shutdownPromise]);

    expect(calls).toEqual([]);
    expect(d.adopted).toBe(true);
  });

  // --- Regression: a failing start racing a release to zero must not drive
  // the refcount negative (see the clamp comment in acquire()'s catch block).
  it('clamps the refcount at zero when a failing start races a release to empty', async () => {
    const calls: string[] = [];
    let shouldFail = true;
    let resolveFirstProbe!: (v: boolean) => void;
    const firstProbeGate = new Promise<boolean>((r) => { resolveFirstProbe = r; });
    let probeCalls = 0;
    const d = new DashboardDaemon({
      probe: async () => {
        probeCalls++;
        return probeCalls === 1 ? firstProbeGate : false;
      },
      start: async () => { calls.push('start'); return !shouldFail; },
      stop: async () => { calls.push('stop'); },
    });

    const acquirePromise = d.acquire();
    const releasePromise = d.release(); // refs -> 0 while the (about to fail) start is in flight
    const acquireFailure = expect(acquirePromise).rejects.toThrow();

    resolveFirstProbe(false);
    await Promise.all([acquireFailure, releasePromise]);
    expect(calls).toEqual(['start']); // failed; nothing to stop

    // If refs had been driven to -1 by the race, this single acquire()/
    // release() pair would leave something still "owed" instead of landing
    // back at a clean zero — i.e. this last release() would fail to reach
    // the stop() call below.
    shouldFail = false;
    await d.acquire();
    expect(calls).toEqual(['start', 'start']);
    await d.release();
    expect(calls).toEqual(['start', 'start', 'stop']);
  });
});
