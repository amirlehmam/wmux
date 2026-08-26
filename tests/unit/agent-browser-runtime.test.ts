import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as net from 'net';

/** An ephemeral port with nothing on it — bind, read the number, release. */
async function unusedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/**
 * Bind the REAL dashboard port for the two tests that exercise the `start`
 * hook, which probes 4848 internally and so cannot be pointed elsewhere.
 *
 * A developer actually using agent mode has a dashboard on 4848, and the bare
 * failure is an unhandled `EADDRINUSE` with no hint of what to do about it.
 * Turn that into a sentence that names the fix.
 */
async function listenOnDashboardPort(server: net.Server): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(4848, '127.0.0.1', () => resolve());
    });
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      throw new Error(
        'Port 4848 is already in use, so this test cannot bind it. An agent-browser ' +
        'dashboard is probably running — stop it with `agent-browser dashboard stop` ' +
        'and re-run. (This test exercises the start hook, which probes 4848 directly.)',
      );
    }
    throw err;
  }
}

/**
 * The dashboard daemon is the real one, driven through a stubbed `acquire` /
 * `release` so these tests exercise the per-surface bookkeeping rather than
 * child processes. `agent-browser-cli` is mocked away entirely: nothing here
 * may spawn agent-browser.
 */
const env = vi.hoisted(() => ({
  acquires: 0,
  releases: 0,
  acquireFails: false,
  binary: null as string | null,
  ran: [] as string[][],
  runImpl: async (_argv: string[]): Promise<any> =>
    ({ ok: false, spawnFailed: true, data: null, stdout: '', stderr: '' }),
}));

vi.mock('../../src/main/agent-browser-cli', () => ({
  agentBrowserPath: () => env.binary,
  runAgentBrowser: (_bin: string, argv: string[]) => {
    env.ran.push(argv);
    return env.runImpl(argv);
  },
}));

import {
  DASHBOARD_RETRY_COOLDOWN_MS,
  acquireDashboardFor,
  dashboardDaemon,
  probeDashboardPort,
  releaseDashboardFor,
  resetDashboardRefs,
  waitForDashboard,
} from '../../src/main/agent-browser-runtime';

beforeEach(() => {
  env.acquires = 0;
  env.releases = 0;
  env.acquireFails = false;
  env.binary = null;
  env.ran = [];
  env.runImpl = async () => ({ ok: false, spawnFailed: true, data: null, stdout: '', stderr: '' });
  resetDashboardRefs();
  vi.spyOn(dashboardDaemon, 'acquire').mockImplementation(async () => {
    env.acquires++;
    if (env.acquireFails) throw new Error('agent-browser: dashboard failed to start');
  });
  vi.spyOn(dashboardDaemon, 'release').mockImplementation(async () => { env.releases++; });
});

afterEach(() => vi.restoreAllMocks());

/**
 * The bug this pair exists to prevent: `v2-browser.ts` and `ipc-handlers.ts`
 * each kept their own Set of surfaces they held a dashboard reference for. A
 * pane enabled from the UI and then driven by `wmux browser open` took TWO
 * references and gave back one, so the refcount never reached zero and the
 * dashboard outlived every agent pane until app quit.
 */
describe('the per-surface dashboard reference has one owner', () => {
  it('takes one reference for a surface no matter how many times it is asked', async () => {
    await acquireDashboardFor('surf-a');
    await acquireDashboardFor('surf-a');
    await acquireDashboardFor('surf-a');
    expect(env.acquires).toBe(1);
  });

  it('takes one reference when both call paths acquire the same surface', async () => {
    // The UI enabling agent mode on the pane, and a browser verb arriving for
    // it, in either order — the same surface, so one reference.
    await Promise.all([acquireDashboardFor('surf-both'), acquireDashboardFor('surf-both')]);
    expect(env.acquires).toBe(1);

    await releaseDashboardFor('surf-both');
    expect(env.releases).toBe(1);
  });

  it('nets to zero across an acquire from one path and a release from the other', async () => {
    await acquireDashboardFor('surf-x');
    await releaseDashboardFor('surf-x');
    expect(env.acquires).toBe(1);
    expect(env.releases).toBe(1);
  });

  it('counts distinct surfaces separately', async () => {
    await acquireDashboardFor('surf-1');
    await acquireDashboardFor('surf-2');
    expect(env.acquires).toBe(2);
  });

  /**
   * Teardown is gated on the SESSION registry, not on this Set, so a surface
   * that has a session but never took a reference — its acquire failed, or the
   * cooldown suppressed it — would otherwise pay down a reference belonging to
   * a different, live surface, and could stop a dashboard somebody is watching.
   * The daemon clamps at zero; it cannot detect a phantom release.
   */
  it('is a no-op to release a surface that never acquired', async () => {
    await releaseDashboardFor('surf-never');
    expect(env.releases).toBe(0);
  });

  it('is a no-op to release twice', async () => {
    await acquireDashboardFor('surf-dbl');
    await releaseDashboardFor('surf-dbl');
    await releaseDashboardFor('surf-dbl');
    expect(env.releases).toBe(1);
  });

  it('does not record a reference it failed to take', async () => {
    env.acquireFails = true;
    await expect(acquireDashboardFor('surf-fail')).rejects.toThrow(/failed to start/);

    // No reference was taken, so none may be given back.
    await releaseDashboardFor('surf-fail');
    expect(env.releases).toBe(0);
  });

  it('lets a surface acquire again after it has released', async () => {
    await acquireDashboardFor('surf-cycle');
    await releaseDashboardFor('surf-cycle');
    await acquireDashboardFor('surf-cycle');
    expect(env.acquires).toBe(2);
    expect(env.releases).toBe(1);
  });
});

/**
 * Without a cooldown every agent-mode command re-ran the whole attempt — a
 * probe plus up to 30s of `dashboard start` — because a failure is deliberately
 * not recorded as held. `DashboardDaemon`'s own in-flight guard clears in a
 * `finally`, so it coalesces CONCURRENT callers only and does nothing at all
 * for the sequential case, which is what a stream of commands is.
 */
describe('a failed dashboard start is not retried on the very next command', () => {
  it('makes exactly one attempt for N commands inside the cooldown', async () => {
    env.acquireFails = true;
    for (let i = 0; i < 10; i++) {
      await acquireDashboardFor(`surf-${i}`).catch(() => {});
    }
    expect(env.acquires).toBe(1);
  });

  it('still tells every suppressed caller that there is no dashboard', async () => {
    env.acquireFails = true;
    await acquireDashboardFor('surf-first').catch(() => {});
    await expect(acquireDashboardFor('surf-second')).rejects.toThrow(/not retrying/);
  });

  it('retries once the cooldown has elapsed', async () => {
    env.acquireFails = true;
    let now = 1_000_000;
    const clock = () => now;

    await acquireDashboardFor('surf-a', clock).catch(() => {});
    expect(env.acquires).toBe(1);

    now += DASHBOARD_RETRY_COOLDOWN_MS - 1;
    await acquireDashboardFor('surf-a', clock).catch(() => {});
    expect(env.acquires).toBe(1);

    now += 2;
    env.acquireFails = false;
    await acquireDashboardFor('surf-a', clock);
    expect(env.acquires).toBe(2);
  });

  it('clears the cooldown once a start succeeds', async () => {
    env.acquireFails = true;
    let now = 1_000_000;
    const clock = () => now;
    await acquireDashboardFor('surf-a', clock).catch(() => {});

    now += DASHBOARD_RETRY_COOLDOWN_MS + 1;
    env.acquireFails = false;
    await acquireDashboardFor('surf-a', clock);

    // A different surface must not be suppressed by the long-gone failure.
    await acquireDashboardFor('surf-b', clock);
    expect(env.acquires).toBe(3);
  });
});

/**
 * The daemon's `start` hook must decide readiness from the PORT, never from the
 * process exiting.
 *
 * Measured against agent-browser 0.35.0, cold: `dashboard start` exits at 58ms
 * having daemonised, but :4848 does not accept a connection until ~500ms later
 * — so treating the exit as success reports a dashboard that cannot yet serve
 * the pane. And in configurations where the command instead runs the server in
 * the foreground and never exits, awaiting it reports FAILURE for a dashboard
 * that is running perfectly well, tripping the retry cooldown on a healthy
 * install. Polling the port is the one signal correct under both.
 */
describe('the dashboard start hook', () => {
  // `dashboardDaemon.acquire` is spied out above; reach the real hook directly.
  const startHook = () => (dashboardDaemon as any).hooks.start as () => Promise<boolean>;

  it('reports failure without spawning anything when nothing is installed', async () => {
    env.binary = null;
    expect(await startHook()()).toBe(false);
    expect(env.ran).toEqual([]);
  });

  it('asks the port, not the process, and does not wait for the command to exit', async () => {
    env.binary = 'C:/bin/agent-browser.exe';
    // Reproduce the foreground-server shape: the invocation never settles.
    env.runImpl = () => new Promise(() => {});

    const server = net.createServer();
    await listenOnDashboardPort(server);
    try {
      const started = Date.now();
      expect(await startHook()()).toBe(true);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(env.ran).toEqual([['dashboard', 'start']]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('waits for a port that comes up after the command has already exited', async () => {
    env.binary = 'C:/bin/agent-browser.exe';
    env.runImpl = async () => ({ ok: true, spawnFailed: false, data: null, stdout: '', stderr: '' });

    const server = net.createServer();
    // The measured shape: process gone long before the socket is listening.
    const listening = new Promise<void>((r) => {
      setTimeout(() => { listenOnDashboardPort(server).then(r, r); }, 600);
    });
    try {
      expect(await startHook()()).toBe(true);
    } finally {
      await listening;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  // Tested through `waitForDashboard` rather than the hook so the give-up path
  // costs milliseconds instead of making the suite sit out a real 8s deadline.
  it('gives up when the port never comes up', async () => {
    // An ephemeral port nothing is listening on. Deliberately NOT 4848: a
    // developer running agent mode has a real dashboard there, and this would
    // then pass for the wrong reason.
    const started = Date.now();
    expect(await waitForDashboard(250, 50, await unusedPort())).toBe(false);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(200); // it really did keep trying
    expect(elapsed).toBeLessThan(4000);
  });

  it('answers true as soon as the port is up, without burning the deadline', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as net.AddressInfo;
    try {
      const started = Date.now();
      expect(await waitForDashboard(10000, 200, port)).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('probeDashboardPort', () => {
  it('says true when something is listening', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(await probeDashboardPort(port)).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('says false when nothing is listening', async () => {
    // Bind and immediately close, so the port is almost certainly free and we
    // are not guessing at a number some other process might own.
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));

    expect(await probeDashboardPort(port)).toBe(false);
  });

  // Whichever way a dead port answers on this machine — refused outright, or
  // silently dropped until the socket timeout fires — the probe must resolve
  // false promptly rather than stall the command that is waiting on it.
  it('gives up rather than hanging on a port that does not answer', async () => {
    const started = Date.now();
    expect(await probeDashboardPort(9, 150)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('leaves no socket behind on either answer', async () => {
    const before = process.getActiveResourcesInfo?.().length ?? 0;
    await probeDashboardPort(1, 150);
    await new Promise((r) => setTimeout(r, 50));
    const after = process.getActiveResourcesInfo?.().length ?? 0;
    expect(after).toBeLessThanOrEqual(before);
  });
});
