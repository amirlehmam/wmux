/**
 * agent-browser lifecycle: nothing may outlive the surface that started it.
 *
 * Sessions are EPHEMERAL by design — a session's process lifetime equals its
 * surface's lifetime, nothing is persisted — and that single decision is what
 * makes orphan handling correct by construction rather than by heuristic: there
 * is no such thing as a legitimately-surviving wmux-owned session, so any
 * `wmux-` session with no live surface is garbage. The invariant is only worth
 * anything if every exit path actually closes what it opened, which is what is
 * pinned here:
 *
 *   • surface close      — closes exactly that session, exactly once
 *   • app quit           — closes all of them even when one fails, and still
 *                          shuts the dashboard down
 *   • a `close` that HANGS — the failure found in live testing (a session whose
 *                          daemon was killed mid-start left `close` blocking
 *                          forever while `session list` still reported it).
 *                          Teardown that can hang is not teardown.
 *   • startup            — reconciles against the CLI, which is the only ground
 *                          truth after a crash, and never touches a session
 *                          without the `wmux-` prefix
 *
 * Plus the stream-port gap the registry used to have: `nextPort()` knows only
 * what IT handed out, so it can hand a surface a port an orphan is squatting.
 *
 * Everything is dependency-injected, so none of it spawns agent-browser, opens
 * a Chrome or (except where the point IS the socket) touches a port.
 */
import { describe, it, expect, vi } from 'vitest';
import * as net from 'net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeSessionByName,
  closeSessionFor,
  parseSessionList,
  probeBindablePort,
  reconcileOrphanSessions,
  sessionCloseArgv,
  sessionListArgv,
  teardownAgentBrowser,
  withDeadline,
  QUIT_TEARDOWN_BUDGET_MS,
  SESSION_CLOSE_TIMEOUT_MS,
  type AgentBrowserTeardownDeps,
} from '../../src/main/agent-browser-runtime';
import {
  isWmuxSessionName,
  MAX_PORT_PROBES,
  SessionRegistry,
  sessionNameFor,
  sessionPrefix,
  STREAM_PORT_BASE,
  surfaceIdFromSessionName,
} from '../../src/main/agent-browser-session';
import type { RunResult } from '../../src/main/agent-browser-cli';
import type { SurfaceId } from '../../src/shared/types';

const surf = (n: string): SurfaceId => `surf-${n}` as SurfaceId;
const A = surf('aaaaaaaa-1111-2222-3333-444444444444');
const B = surf('bbbbbbbb-1111-2222-3333-444444444444');

const okRun = (data: unknown = null, stdout = ''): RunResult =>
  ({ ok: true, spawnFailed: false, data, stdout, stderr: '' });
const failRun = (stderr = 'boom'): RunResult =>
  ({ ok: false, spawnFailed: false, data: null, stdout: '', stderr });

interface Harness {
  deps: AgentBrowserTeardownDeps;
  registry: SessionRegistry;
  /** Every argv actually spawned, in order. */
  calls: string[][];
  shutdowns: number;
  warnings: string[];
}

/**
 * A teardown harness over a REAL `SessionRegistry`.
 *
 * The registry is not mocked because idempotence is a property of the pair —
 * "forget, then close" only closes once because the forget really removed the
 * entry — and a fake map would let that pass while the real one regressed.
 */
function harness(
  run?: (argv: string[]) => Promise<RunResult>,
  overrides: Partial<AgentBrowserTeardownDeps> = {},
): Harness {
  const registry = new SessionRegistry();
  const calls: string[][] = [];
  const state = { shutdowns: 0 };
  const warnings: string[] = [];
  const deps: AgentBrowserTeardownDeps = {
    binary: () => 'C:\\bin\\agent-browser.exe',
    run: async (_binary, argv) => {
      calls.push(argv);
      return run ? run(argv) : okRun();
    },
    listSessions: () => registry.all(),
    forgetSession: (id) => registry.release(id),
    hasSession: (id) => registry.get(id) !== undefined,
    shutdownDashboard: async () => { state.shutdowns++; },
    warn: (m) => warnings.push(m),
    ...overrides,
  };
  return {
    deps,
    registry,
    calls,
    warnings,
    get shutdowns() { return state.shutdowns; },
  };
}

// ─── surface close ─────────────────────────────────────────────────────────

describe('closeSessionFor', () => {
  it('closes exactly that surface, and leaves the others alone', async () => {
    const h = harness();
    h.registry.ensure(A);
    h.registry.ensure(B);

    await closeSessionFor(A, h.deps);

    expect(h.calls).toEqual([sessionCloseArgv(`wmux-${A}`)]);
    expect(h.registry.get(A)).toBeUndefined();
    expect(h.registry.get(B)).toBeDefined();
  });

  /**
   * The load-bearing one. This is reached from a React unmount AND from a
   * webContents being destroyed, which can fire for the same surface in either
   * order — so a second call must not launch a second `close` against a name
   * the first one is already closing.
   */
  it('is idempotent: a second call spawns nothing', async () => {
    const h = harness();
    h.registry.ensure(A);

    await closeSessionFor(A, h.deps);
    const after = await closeSessionFor(A, h.deps);

    expect(after).toBe(false);
    expect(h.calls).toHaveLength(1);
  });

  it('does nothing at all for a surface that never had a session', async () => {
    const h = harness();
    expect(await closeSessionFor(A, h.deps)).toBe(false);
    expect(h.calls).toEqual([]);
  });

  // The registry entry has to go even when the CLI cannot be run, or the
  // surface would be stuck advertising a session nothing can ever close.
  it('forgets the session even with no binary installed', async () => {
    const h = harness(undefined, { binary: () => null });
    h.registry.ensure(A);
    expect(await closeSessionFor(A, h.deps)).toBe(false);
    expect(h.registry.get(A)).toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it('reports a close that the CLI refused, without throwing', async () => {
    const h = harness(async () => failRun());
    h.registry.ensure(A);
    expect(await closeSessionFor(A, h.deps)).toBe(false);
    expect(h.warnings.join('\n')).toContain(`wmux-${A}`);
  });

  it('survives a run that rejects outright', async () => {
    const h = harness(async () => { throw new Error('spawn exploded'); });
    h.registry.ensure(A);
    await expect(closeSessionFor(A, h.deps)).resolves.toBe(false);
  });
});

// ─── app quit ──────────────────────────────────────────────────────────────

describe('teardownAgentBrowser', () => {
  it('closes every session and then shuts the dashboard down', async () => {
    const h = harness();
    h.registry.ensure(A);
    h.registry.ensure(B);

    await teardownAgentBrowser(h.deps);

    expect(h.calls).toHaveLength(2);
    expect(h.calls.map((c) => c[1]).sort()).toEqual([`wmux-${A}`, `wmux-${B}`].sort());
    expect(h.registry.size).toBe(0);
    expect(h.shutdowns).toBe(1);
  });

  /**
   * One wedged session must not decide whether the others get closed, and must
   * not cost the dashboard its shutdown either — that is why the closes run
   * concurrently through allSettled and the daemon step is sequenced after
   * them rather than racing alongside.
   */
  it('closes the rest, and still shuts down, when one close fails', async () => {
    const h = harness(async (argv) => {
      if (argv[1] === `wmux-${A}`) throw new Error('this one is wedged');
      return okRun();
    });
    h.registry.ensure(A);
    h.registry.ensure(B);

    await teardownAgentBrowser(h.deps);

    expect(h.calls).toHaveLength(2);
    expect(h.shutdowns).toBe(1);
  });

  it('still shuts the dashboard down when there are no sessions at all', async () => {
    const h = harness();
    await teardownAgentBrowser(h.deps);
    expect(h.calls).toEqual([]);
    expect(h.shutdowns).toBe(1);
  });

  it('does not fail teardown when the dashboard shutdown itself rejects', async () => {
    const h = harness(undefined, { shutdownDashboard: async () => { throw new Error('nope'); } });
    h.registry.ensure(A);
    await expect(teardownAgentBrowser(h.deps)).resolves.toBeUndefined();
    expect(h.registry.size).toBe(0);
  });

  /**
   * THE hang. Observed live: a session whose daemon was killed mid-start left
   * `close` blocking indefinitely while `session list` still listed it. Quit
   * runs after `will-quit` has already preventDefault()ed, so a teardown that
   * never resolves is a wmux the user cannot quit.
   */
  it('gives up on a close that never returns, and still shuts down', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(() => new Promise<RunResult>(() => { /* never settles */ }));
      h.registry.ensure(A);

      const done = teardownAgentBrowser(h.deps, 200);
      // Nothing has resolved on its own; only the deadline can end this.
      await vi.advanceTimersByTimeAsync(500);
      await done;

      expect(h.shutdowns).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a dashboard shutdown that never returns', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(undefined, {
        shutdownDashboard: () => new Promise<void>(() => { /* waits out an in-flight start, forever */ }),
      });
      const done = teardownAgentBrowser(h.deps, 200);
      await vi.advanceTimersByTimeAsync(500);
      await expect(done).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // Electron re-enters `will-quit` after the preventDefault, and index.ts also
  // guards with a flag — but the drain has to be real, not just guarded.
  it('leaves nothing for a second pass to do', async () => {
    const h = harness();
    h.registry.ensure(A);
    await teardownAgentBrowser(h.deps);
    const before = h.calls.length;
    await teardownAgentBrowser(h.deps);
    expect(h.calls).toHaveLength(before);
  });

  it('keeps the quit budget short enough to be a quit and not a hang', () => {
    expect(SESSION_CLOSE_TIMEOUT_MS).toBeLessThanOrEqual(QUIT_TEARDOWN_BUDGET_MS);
    expect(QUIT_TEARDOWN_BUDGET_MS).toBeLessThanOrEqual(10_000);
  });
});

describe('withDeadline', () => {
  it('passes the real answer through when it arrives in time', async () => {
    await expect(withDeadline(Promise.resolve('real'), 1_000, 'fallback')).resolves.toBe('real');
  });

  it('treats a rejection as the timeout outcome', async () => {
    await expect(withDeadline(Promise.reject(new Error('x')), 1_000, 'fallback')).resolves.toBe('fallback');
  });

  it('answers with the fallback once the deadline passes', async () => {
    vi.useFakeTimers();
    try {
      const p = withDeadline(new Promise<string>(() => {}), 100, 'fallback');
      await vi.advanceTimersByTimeAsync(150);
      await expect(p).resolves.toBe('fallback');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── startup reconciliation ────────────────────────────────────────────────

describe('parseSessionList', () => {
  it('reads the --json envelope', () => {
    const res = okRun({ success: true, data: { sessions: ['wmux-surf-a', 'mine'] }, error: null });
    expect(parseSessionList(res)).toEqual(['wmux-surf-a', 'mine']);
  });

  it('reads the bare text form, ignoring its heading', () => {
    const res = okRun(null, 'Active sessions:\n  wmux-surf-a\n  mine\n');
    expect(parseSessionList(res)).toEqual(['wmux-surf-a', 'mine']);
  });

  it('answers nothing for the empty bare form', () => {
    expect(parseSessionList(okRun(null, 'No active sessions\n'))).toEqual([]);
  });

  it('answers nothing for an empty json list', () => {
    expect(parseSessionList(okRun({ success: true, data: { sessions: [] } }))).toEqual([]);
  });

  // The list is a machine-global namespace anything can write into, so a
  // non-string entry is a real input rather than a hypothetical one.
  it('drops non-string entries rather than passing them on', () => {
    const res = okRun({ success: true, data: { sessions: ['wmux-surf-a', 42, null] } });
    expect(parseSessionList(res)).toEqual(['wmux-surf-a']);
  });
});

describe('isWmuxSessionName', () => {
  it('accepts exactly what sessionNameFor mints', () => {
    expect(isWmuxSessionName(`wmux-${A}`)).toBe(true);
    expect(surfaceIdFromSessionName(`wmux-${A}`)).toBe(A);
  });

  it('rejects anything without the prefix', () => {
    for (const name of ['mine', 'surf-abc', 'agent-browser', '', 'WMUX-surf-a']) {
      expect(isWmuxSessionName(name)).toBe(false);
    }
  });

  /**
   * The prefix alone is not enough. This value goes back onto a command line as
   * `--session <name>`, so a name that merely STARTS with `wmux-` but continues
   * into something wmux could never have minted is rejected: wmux only ever
   * produces `wmux-surf-<uuid>`.
   */
  it('rejects a prefixed name that is not a surface id', () => {
    for (const name of ['wmux-', 'wmux- --all', 'wmux-;calc', 'wmux-../evil', 'wmux-surf a']) {
      expect(isWmuxSessionName(name)).toBe(false);
    }
  });

  it('rejects a non-string', () => {
    expect(isWmuxSessionName(undefined)).toBe(false);
    expect(isWmuxSessionName(42)).toBe(false);
  });
});

describe('reconcileOrphanSessions', () => {
  /** A harness whose `session list` answers with `names`. */
  function listing(names: string[], overrides: Partial<AgentBrowserTeardownDeps> = {}): Harness {
    return harness(
      async (argv) =>
        argv[0] === 'session'
          ? okRun({ success: true, data: { sessions: names } })
          : okRun(),
      overrides,
    );
  }

  it('asks the CLI, not the registry — the registry is empty after a crash', async () => {
    const h = listing([`wmux-${A}`]);
    expect(h.registry.size).toBe(0);

    const closed = await reconcileOrphanSessions(h.deps);

    expect(h.calls[0]).toEqual(sessionListArgv());
    expect(closed).toEqual([`wmux-${A}`]);
  });

  /**
   * THE security boundary of this pass, stated as bluntly as it can be.
   *
   * A session without the `wmux-` prefix is a human's or another tool's, and
   * closing it kills a browser wmux never started. There is no severity of
   * orphan cleanup that justifies it, so this is asserted as "not one argv
   * mentions it" rather than as "the return value omits it".
   */
  it('NEVER closes a session without the wmux- prefix', async () => {
    const strangers = ['mine', 'default', 'research', 'wmux', 'surf-abc'];
    const h = listing([...strangers, `wmux-${A}`]);

    const closed = await reconcileOrphanSessions(h.deps);

    expect(closed).toEqual([`wmux-${A}`]);
    const spawned = h.calls.flat().join(' ');
    for (const stranger of strangers) {
      expect(spawned.split(' ')).not.toContain(stranger);
    }
    // One list, one close. Nothing else was even attempted.
    expect(h.calls).toHaveLength(2);
  });

  it('closes every wmux- session it finds, since none of them can be live', async () => {
    const h = listing([`wmux-${A}`, `wmux-${B}`]);
    const closed = await reconcileOrphanSessions(h.deps);
    expect(closed).toEqual([`wmux-${A}`, `wmux-${B}`]);
  });

  /**
   * Reconciliation runs unawaited alongside session restore, so a pane restored
   * into agent mode can mint its session while the list is still in flight.
   * Re-asking the registry immediately before each close is what keeps this
   * pass from closing a session THIS run just created.
   */
  it('skips a session this run currently owns', async () => {
    const h = listing([`wmux-${A}`, `wmux-${B}`]);
    h.registry.ensure(A);

    const closed = await reconcileOrphanSessions(h.deps);

    expect(closed).toEqual([`wmux-${B}`]);
    expect(h.registry.get(A)).toBeDefined();
  });

  it('does nothing, and spawns nothing, with no binary installed', async () => {
    const h = listing([`wmux-${A}`], { binary: () => null });
    expect(await reconcileOrphanSessions(h.deps)).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  // A list we could not read is not evidence that anything is garbage.
  it('closes nothing when the list command fails', async () => {
    const h = harness(async () => failRun());
    expect(await reconcileOrphanSessions(h.deps)).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });

  it('closes nothing when the list command hangs', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(() => new Promise<RunResult>(() => {}));
      const done = reconcileOrphanSessions(h.deps);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(done).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('closeSessionByName', () => {
  it('builds the session-scoped close argv', async () => {
    const h = harness();
    await closeSessionByName('wmux-surf-x', h.deps);
    expect(h.calls).toEqual([['--session', 'wmux-surf-x', 'close']]);
  });
});

// ─── stream-port bindability ───────────────────────────────────────────────

describe('SessionRegistry.ensureBindable', () => {
  /** Ports `taken` cannot be bound; everything else can. */
  const probeOver = (taken: number[]) => async (port: number) => !taken.includes(port);

  it('takes the base port when nothing is squatting it', async () => {
    const r = new SessionRegistry();
    const s = await r.ensureBindable(A, probeOver([]));
    expect(s.streamPort).toBe(STREAM_PORT_BASE);
    expect(s.dashboardUrl).toContain(`?port=${STREAM_PORT_BASE}`);
  });

  /**
   * The gap this closes: `nextPort()` tracks only what the registry itself
   * handed out, so an orphan from a previous wmux — or an unrelated program —
   * can hold a port it believes is free. The session then launches with
   * `AGENT_BROWSER_STREAM_PORT=<taken>`, its stream never binds, and the
   * dashboard deep-link points at nothing, silently.
   */
  it('advances past a port it cannot bind', async () => {
    const r = new SessionRegistry();
    const s = await r.ensureBindable(A, probeOver([STREAM_PORT_BASE, STREAM_PORT_BASE + 1]));
    expect(s.streamPort).toBe(STREAM_PORT_BASE + 2);
  });

  it('never hands a rejected port to the next surface either', async () => {
    const r = new SessionRegistry();
    const probe = probeOver([STREAM_PORT_BASE]);
    const first = await r.ensureBindable(A, probe);
    const second = await r.ensureBindable(B, probe);
    expect(first.streamPort).toBe(STREAM_PORT_BASE + 1);
    expect(second.streamPort).toBe(STREAM_PORT_BASE + 2);
  });

  /**
   * Bounded, because the probe is the only thing between a squatting process
   * and an unbounded scan — a machine where every port is refused would
   * otherwise walk to 65535 one loopback listen at a time, on the path that
   * opens a browser pane.
   */
  it('gives up after a bounded number of probes', async () => {
    const r = new SessionRegistry();
    const probed: number[] = [];
    const s = await r.ensureBindable(A, async (p) => { probed.push(p); return false; });
    expect(probed.length).toBe(MAX_PORT_PROBES - 1);
    expect(probed.length).toBeLessThan(64);
    // Degraded, not failed: the pane still gets a browser, it just may not get
    // a live viewer. Refusing here would cost the user the browser itself.
    expect(s.streamPort).toBe(STREAM_PORT_BASE + MAX_PORT_PROBES - 1);
  });

  it('honours a caller-supplied probe budget', async () => {
    const r = new SessionRegistry();
    const probed: number[] = [];
    await r.ensureBindable(A, async (p) => { probed.push(p); return false; }, 3);
    expect(probed).toEqual([STREAM_PORT_BASE, STREAM_PORT_BASE + 1]);
  });

  /**
   * An already-known session short-circuits before any probing. Its port is
   * bound by our OWN stream server, so probing it would answer "unbindable"
   * and move a perfectly working pane to a port Chrome is not streaming on.
   */
  it('never re-probes a session it already has', async () => {
    const r = new SessionRegistry();
    const first = await r.ensureBindable(A, probeOver([]));
    let probes = 0;
    const again = await r.ensureBindable(A, async () => { probes++; return false; });
    expect(again).toBe(first);
    expect(probes).toBe(0);
  });

  it('refuses an invalid surface id before spending a single probe', async () => {
    const r = new SessionRegistry();
    let probes = 0;
    await expect(
      r.ensureBindable('--evil' as SurfaceId, async () => { probes++; return true; }),
    ).rejects.toThrow(/invalid surface id/);
    expect(probes).toBe(0);
  });

  it('frees a released port for reuse', async () => {
    const r = new SessionRegistry();
    const s = await r.ensureBindable(A, probeOver([]));
    r.release(A);
    const next = await r.ensureBindable(B, probeOver([]));
    expect(next.streamPort).toBe(s.streamPort);
  });
});

describe('probeBindablePort', () => {
  /**
   * The one test here that really opens a socket, because the whole point of
   * this function is that it asks the OS rather than a bookkeeping set. A
   * `listen` and not a connect probe: "nothing is listening" and "we may
   * listen" are different questions and only the second predicts whether
   * agent-browser's stream server will come up.
   */
  it('answers false for a port something else is holding', async () => {
    const server = net.createServer();
    const port: number = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
    try {
      expect(await probeBindablePort(port)).toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
    // And free again once the squatter is gone.
    expect(await probeBindablePort(port)).toBe(true);
  });

  it('leaves the port free after saying yes', async () => {
    const server = net.createServer();
    const port: number = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
    await new Promise((r) => server.close(r));

    expect(await probeBindablePort(port)).toBe(true);
    // A probe that kept the port would deny it to the very session it was
    // allocated for.
    expect(await probeBindablePort(port)).toBe(true);
  });

  it('answers false rather than throwing for a port it cannot ask about', async () => {
    await expect(probeBindablePort(-1)).resolves.toBe(false);
  });
});

// ─── the wiring ────────────────────────────────────────────────────────────
//
// Source-level, in the style of the pane's structural guards, and for the same
// reason: `will-quit` and `webContents 'destroyed'` are Electron events that
// vitest (`environment: 'node'`, no Electron) cannot raise, while the property
// at stake in each is structural — WHERE the call sits, and what guards it.
// These are the paths that leak a real Chrome when they are wrong, so leaving
// them entirely unpinned would be the worst place in this change to save
// effort.

const MAIN_DIR = join(__dirname, '../../src/main');
const INDEX = readFileSync(join(MAIN_DIR, 'index.ts'), 'utf8');
const IPC = readFileSync(join(MAIN_DIR, 'ipc-handlers.ts'), 'utf8');

describe('app quit wiring', () => {
  const willQuit = (): string => {
    const start = INDEX.indexOf("app.on('will-quit'");
    expect(start, 'will-quit is not in index.ts any more').toBeGreaterThan(-1);
    return INDEX.slice(start, INDEX.indexOf("app.on('window-all-closed'", start));
  };

  /**
   * `will-quit` is SYNCHRONOUS and closing a session is not, so the only way to
   * do it at quit is to preventDefault the first pass, run the async teardown,
   * and quit again. Without the preventDefault the process exits mid-close and
   * every agent pane's Chrome is orphaned — on Windows a dead parent does not
   * take its descendants with it (issue #139).
   */
  it('defers the quit rather than firing teardown into a closing process', () => {
    const body = willQuit();
    expect(body).toContain('event.preventDefault()');
    expect(body).toContain('teardownAgentBrowser(agentBrowserTeardownDeps)');
  });

  it('re-enters exactly once, so the second pass cannot prevent the quit again', () => {
    const body = willQuit();
    // Two separate facts since #214, because the quit is now deferred for PTY
    // draining as well as for agent-browser: "have the sessions been closed"
    // and "is a teardown in flight" stopped being the same question, and
    // conflating them let a second pass shorten the first pass's drain.
    expect(body).toContain('!agentBrowserTornDown && agentBrowserNeedsTeardown()');
    expect(body).toContain('alreadyDeferred: quitDeferred');
    expect(INDEX).toContain('let agentBrowserTornDown = false;');
    expect(INDEX).toContain('let quitDeferred = false;');
  });

  /**
   * #150's whole mitigation is that the PTY callbacks fire while the
   * environment is still healthy. Nothing added here may push `killAll()`
   * later than it happens today, so it must stay ahead of the deferral.
   */
  it('still kills the PTYs first, before anything is deferred', () => {
    const body = willQuit();
    expect(body.indexOf('ptyManager.killAll()')).toBeLessThan(body.indexOf('event.preventDefault()'));
  });

  it('quits on both outcomes of the teardown, not only on success', () => {
    expect(willQuit()).toMatch(/teardownAgentBrowser\(agentBrowserTeardownDeps\)\.then\(finish, finish\)/);
  });

  /**
   * Bounded twice: `teardownAgentBrowser` caps itself, and this caps IT. The
   * one outcome worse than leaking a browser is a wmux the user cannot quit.
   */
  it('force-quits if the teardown itself never returns', () => {
    const body = willQuit();
    expect(body).toMatch(/setTimeout\(leave, QUIT_TEARDOWN_BUDGET_MS \+ [\d_]+\)/);
    expect(body).toContain('clearTimeout(forceQuit)');
  });

  // A machine that never opened an agent pane must not pay a deferred quit for
  // a feature it does not use. planQuit owns that decision now — and answers
  // "nothing outstanding" only when there are no PTYs EITHER (issue #214);
  // quit-sequence.test.ts pins the decision itself.
  it('does not defer at all when there is nothing to tear down', () => {
    const body = willQuit();
    expect(body).toContain('agentBrowserPending, alreadyDeferred: quitDeferred');
    expect(body).toContain('if (!plan.defer) return;');
  });

  /**
   * Issue #214. Every one of the six reported 0xc0000409 aborts sits on a
   * `will-quit` line in the reporter's main.log — the process reached shutdown
   * and died inside this handler, racing node-pty's ConPTY exit callbacks
   * against Node's environment teardown. Two properties close it, and both are
   * easy to delete by accident while refactoring this handler:
   */
  it('drains before leaving, and leaves via app.exit rather than unwinding', () => {
    const body = willQuit();
    // The drain: the callbacks get a healthy environment to land in.
    expect(body).toMatch(/setTimeout\(leave, plan\.drainMs\)/);
    // The hard exit: whatever did not land never sees the teardown at all.
    expect(body).toContain('app.exit(0)');
    // And app.quit() must NOT come back — it re-enters this handler and unwinds,
    // which is precisely the path that aborts. Comments stripped first: the
    // code says why it is not app.quit(), and naming it there is not using it.
    const code = body.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    expect(code).not.toContain('app.quit()');
  });
});

describe('startup reconciliation wiring', () => {
  it('runs unawaited, so startup never blocks on the CLI', () => {
    expect(INDEX).toMatch(/reconcileOrphanSessions\(agentBrowserTeardownDeps\)\.catch\(/);
    expect(INDEX).not.toMatch(/await reconcileOrphanSessions/);
  });

  // Beside the PTY reap, which is the same problem for the same reason.
  it('sits with the other orphan cleanup', () => {
    const reap = INDEX.indexOf('reapOrphanedPtys();');
    const reconcile = INDEX.indexOf('reconcileOrphanSessions(agentBrowserTeardownDeps)');
    expect(reap).toBeGreaterThan(-1);
    expect(reconcile).toBeGreaterThan(reap);
    expect(reconcile - reap).toBeLessThan(1_200);
  });
});

describe('surface close wiring', () => {
  /**
   * Browser surfaces never reach `ownSurface` — that is the PTY create path —
   * so a window closed while a pane sat in agent mode leaks its Chrome: the
   * renderer is killed outright and BrowserPane's unmount effect never runs.
   * `webContents 'destroyed'` is the only teardown signal main gets for it.
   */
  it('sweeps an agent surface when its renderer is destroyed', () => {
    const start = IPC.indexOf('function ownAgentBrowserSurface');
    expect(start, 'the agent-browser owner map is gone').toBeGreaterThan(-1);
    const body = IPC.slice(start, IPC.indexOf('\n}', start));
    expect(body).toContain("webContents.once('destroyed'");
    expect(body).toContain('closeAgentBrowserSession(ownedSurfaceId)');
  });

  it('records the owner before enable can start anything', () => {
    const start = IPC.indexOf('IPC_CHANNELS.AGENT_BROWSER_ENABLE');
    const body = IPC.slice(start, start + 600);
    expect(body.indexOf('ownAgentBrowserSurface(')).toBeLessThan(body.indexOf('enableAgentBrowser('));
  });

  // The PTY kill path is the model, and it is where every other per-surface
  // resource is dropped.
  it('hangs off the same forgetSurface every other surface resource does', () => {
    const start = IPC.indexOf('function forgetSurface');
    const body = IPC.slice(start, IPC.indexOf('\n}', start));
    expect(body).toContain('closeAgentBrowserSession(surfaceId)');
  });

  it('never lets teardown throw into a close path', () => {
    const start = IPC.indexOf('export function closeAgentBrowserSession');
    const body = IPC.slice(start, IPC.indexOf('\n}', start));
    expect(body).toContain('.catch(');
    // Fire-and-forget: a close is hundreds of milliseconds and nothing in a
    // teardown path may wait on it.
    expect(body).not.toContain('await ');
  });
});

// ─── side-by-side wmux instances ───────────────────────────────────────────
//
// `WMUX_INSTANCE=<name>` runs a second wmux beside the first (the documented
// case is a dev build alongside an installed one). agent-browser's session
// namespace is MACHINE-global with no such suffix, so without an instance
// segment in the name, reconciliation — whose premise is "every wmux- session
// with no live surface is garbage" — would close the OTHER instance's live
// browsers on startup. Another wmux is exactly as much "not us" as a human's
// hand-made session is.

describe('sessionPrefix', () => {
  it('leaves the default instance exactly as it was', () => {
    expect(sessionPrefix({})).toBe('wmux-');
    expect(sessionPrefix({ WMUX_INSTANCE: '  ' })).toBe('wmux-');
    expect(sessionNameFor(A, {})).toBe(`wmux-${A}`);
  });

  it('carves out its own namespace for a named instance', () => {
    expect(sessionPrefix({ WMUX_INSTANCE: 'dev' })).toBe('wmux-dev-');
    expect(sessionNameFor(A, { WMUX_INSTANCE: 'dev' })).toBe(`wmux-dev-${A}`);
  });

  // WMUX_INSTANCE is user-supplied and this value reaches a command line, so
  // it is filtered rather than trusted — and bounded, because an unbounded
  // pattern is not a boundary.
  it('filters and bounds whatever the environment says', () => {
    expect(sessionPrefix({ WMUX_INSTANCE: 'de v;--all' })).toBe('wmux-dev--all-');
    expect(sessionPrefix({ WMUX_INSTANCE: '$(calc)' })).toBe('wmux-calc-');
    expect(sessionPrefix({ WMUX_INSTANCE: '/\\.' })).toBe('wmux-');
    expect(sessionPrefix({ WMUX_INSTANCE: 'x'.repeat(500) })).toBe(`wmux-${'x'.repeat(32)}-`);
  });

  /**
   * The two forms cannot be confused in EITHER direction, and that falls out of
   * `SURFACE_ID_RE` anchoring on `surf-` rather than from a special case.
   */
  it('never claims the other instance sessions', () => {
    const dev = { WMUX_INSTANCE: 'dev' };
    expect(isWmuxSessionName(`wmux-dev-${A}`, {})).toBe(false);
    expect(isWmuxSessionName(`wmux-${A}`, dev)).toBe(false);
    expect(isWmuxSessionName(`wmux-dev-${A}`, dev)).toBe(true);
    expect(surfaceIdFromSessionName(`wmux-dev-${A}`, dev)).toBe(A);
  });
});
