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
});
