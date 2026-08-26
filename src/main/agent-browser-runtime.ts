/**
 * The process-wide agent-browser singletons, and the real hooks behind them.
 *
 * This module exists for ONE reason: there must be exactly one
 * `SessionRegistry` and exactly one `DashboardDaemon` in the process, and every
 * consumer must reach the same pair. Both are stateful in ways a second copy
 * silently corrupts — the registry allocates stream ports from a set only it
 * knows about (two registries hand the same 9300 to two surfaces), and the
 * daemon refcounts a real OS process (two daemons each believe they own the
 * dashboard, and the first `release()` to reach zero stops it out from under
 * the other). So routing (`v2-browser.ts`), lifecycle and teardown all import
 * from here rather than constructing their own.
 *
 * It is deliberately a wiring module and nothing else: the interesting logic
 * lives in `agent-browser-session.ts` and `agent-browser-daemon.ts`, both of
 * which are pure/injected so they stay testable with no ports and no child
 * processes. What is added here — and only here — is the impure half.
 */
import * as net from 'net';
import { agentBrowserPath, runAgentBrowser, unwrapAgentData, type RunResult } from './agent-browser-cli';
import { DashboardDaemon } from './agent-browser-daemon';
import {
  DASHBOARD_PORT,
  isWmuxSessionName,
  SessionRegistry,
  surfaceIdFromSessionName,
  type AgentSession,
} from './agent-browser-session';
import type { SurfaceId } from '../shared/types';

/**
 * How long to wait for a TCP connect before calling the dashboard absent.
 *
 * Short on purpose: this runs before the first agent-mode browser command and
 * a loopback connect either answers immediately or is not going to. A generous
 * timeout here would be paid on every cold start as dead latency.
 */
const PROBE_TIMEOUT_MS = 500;

/** Starting a dashboard can mean downloading/launching a Chrome — be patient. */
const DASHBOARD_START_TIMEOUT_MS = 30_000;

/**
 * How long to wait for the dashboard's PORT to come up after asking it to start.
 *
 * The process exit is not the readiness signal. Measured against agent-browser
 * 0.35.0 on a cold start: `dashboard start` exits at 58ms having daemonised,
 * but :4848 does not accept a connection until ~500ms later. Waiting on the
 * exit would report success before the dashboard could serve anything, and the
 * pane — which loads the dashboard url in a webview — would race it and lose.
 *
 * Polling the port is also the only thing that stays correct if the command
 * does NOT exit promptly: `dashboard start` runs a foreground server in some
 * configurations, in which case waiting for its exit reports failure for a
 * dashboard that is running perfectly well, and would trip the retry cooldown
 * on a healthy install.
 */
const DASHBOARD_READY_MS = 8_000;

/** Gap between readiness polls. Short — this is a loopback connect. */
const DASHBOARD_POLL_MS = 200;

/** Stopping is a signal to an already-running process; it should be quick. */
const DASHBOARD_STOP_TIMEOUT_MS = 10_000;

/** surfaceId → agent-browser session. See `agent-browser-session.ts`. */
export const sessionRegistry = new SessionRegistry();

/**
 * Is something already listening on the dashboard port?
 *
 * A bare TCP connect, not an HTTP request: the question is only "is this port
 * taken", and answering it with a fetch would add a body, a parse and a set of
 * failure modes ("it answered, but with a 500") that the adopt-never-fight rule
 * has no use for. `error` and `timeout` are the same answer — nothing usable is
 * there — and the socket is destroyed on every path so a probe never leaks a
 * half-open connection.
 */
export function probeDashboardPort(port: number = DASHBOARD_PORT, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    let settled = false;
    const done = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Poll the dashboard port until it answers, or the deadline passes.
 *
 * Separate from the `start` hook, and parameterised, so the give-up path can be
 * tested in milliseconds instead of making the suite sit out a real 8s
 * deadline. Returns whether the dashboard is actually reachable.
 */
export async function waitForDashboard(
  readyMs: number = DASHBOARD_READY_MS,
  pollMs: number = DASHBOARD_POLL_MS,
): Promise<boolean> {
  const deadline = Date.now() + readyMs;
  for (;;) {
    if (await probeDashboardPort()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * How long a failed `dashboard start` suppresses the next attempt.
 *
 * Without this, every agent-mode command and every pane enable re-runs the
 * whole attempt — a probe plus up to 30s of `dashboard start` — because a
 * failure is deliberately not recorded as "held" (so that a fix is picked up
 * without a restart). `DashboardDaemon`'s own in-flight guard does not help:
 * it clears in a `finally`, so it coalesces CONCURRENT callers only and does
 * nothing for sequential ones.
 *
 * 60s is chosen against what actually breaks a dashboard start: a broken or
 * partial install, a port conflict on 4848, or a failed Chrome download. None
 * of those clear up in seconds, so retrying faster only burns a child process
 * per command; and none of them take longer than a minute to FIX once noticed,
 * so a user who installs agent-browser or frees the port sees it recover
 * without restarting wmux. It bounds the cost of a persistent outage to one
 * attempt per minute instead of one per command.
 */
export const DASHBOARD_RETRY_COOLDOWN_MS = 60_000;

/**
 * The observability dashboard, refcounted by live agent-mode surfaces.
 *
 * `start`/`stop` resolve the binary at call time rather than closing over one:
 * the user may install agent-browser while wmux is running (that is the whole
 * point of the in-app setup flow), and `agentBrowserPath()` is memoised, so
 * asking it again is cheap and can only ever get *more* correct.
 */
export const dashboardDaemon = new DashboardDaemon({
  probe: () => probeDashboardPort(),
  start: async () => {
    const binary = agentBrowserPath();
    if (!binary) return false;
    // Fire it, then ask the PORT whether it worked — see DASHBOARD_READY_MS.
    // The invocation is deliberately not awaited, and whether it succeeds is
    // not the answer to "is the dashboard up"; `waitForDashboard` is.
    runAgentBrowser(binary, ['dashboard', 'start'], DASHBOARD_START_TIMEOUT_MS).catch(() => {});
    return waitForDashboard();
  },
  stop: async () => {
    const binary = agentBrowserPath();
    if (!binary) return;
    await runAgentBrowser(binary, ['dashboard', 'stop'], DASHBOARD_STOP_TIMEOUT_MS);
  },
});

// ─── the per-surface dashboard reference ───────────────────────────────────
//
// SINGLE OWNER, on purpose. Two call paths take a dashboard reference for a
// surface — the renderer enabling agent mode on a pane (`ipc-handlers.ts`) and
// a `wmux browser` verb arriving for that pane (`v2-browser.ts`) — and they
// happen in either order, or both, for the SAME surface. When each kept its own
// Set, a surface enabled from the UI and then driven by the CLI took two
// references and gave back one, so the refcount never reached zero and the
// dashboard outlived every agent pane until app quit.
//
// The daemon's contract is one reference per LIVE AGENT-MODE SURFACE, which is
// a fact about the surface, not about who asked. So the bookkeeping belongs
// with the daemon, and both callers route through the pair below.

/** Surfaces this process currently holds a dashboard reference for. */
const heldFor = new Set<string>();

/**
 * In-flight acquisitions, keyed by surface.
 *
 * Needed because `acquireDashboardFor` is not always awaited by its caller (the
 * command path deliberately does not block a verb on the viewer starting), so
 * two calls for one surface can overlap. `heldFor` alone cannot dedupe them —
 * neither has finished, so neither is in it yet — and both would take a
 * reference for a single surface.
 */
const acquiring = new Map<string, Promise<void>>();

/** When a failed start stops being suppressed. 0 ⇒ nothing has failed. */
let cooldownUntil = 0;

/**
 * Take this surface's dashboard reference, at most once.
 *
 * Idempotent per surface: a second call while one is held, or while one is in
 * flight, takes no further reference. A surface is recorded as held only after
 * `acquire()` SUCCEEDS, so a failure is retried later rather than remembered as
 * done — but not immediately, see `DASHBOARD_RETRY_COOLDOWN_MS`.
 *
 * Rejects when the dashboard could not be started. Callers are expected to
 * treat that as non-fatal (it is observability), but they are told, so it can
 * be logged rather than vanishing.
 */
export function acquireDashboardFor(surfaceId: string, now: () => number = Date.now): Promise<void> {
  if (heldFor.has(surfaceId)) return Promise.resolve();
  const pending = acquiring.get(surfaceId);
  if (pending) return pending;
  if (now() < cooldownUntil) {
    return Promise.reject(new Error(
      `agent-browser: dashboard start failed recently; not retrying for another ${cooldownUntil - now()}ms`,
    ));
  }

  const attempt = dashboardDaemon.acquire().then(
    () => {
      heldFor.add(surfaceId);
      cooldownUntil = 0;
      acquiring.delete(surfaceId);
    },
    (err) => {
      // acquire() already rolled its own refcount back, so there is no
      // reference to give away here — only a failure to remember.
      cooldownUntil = now() + DASHBOARD_RETRY_COOLDOWN_MS;
      acquiring.delete(surfaceId);
      throw err;
    },
  );
  acquiring.set(surfaceId, attempt);
  return attempt;
}

/**
 * Give back this surface's dashboard reference, if it ever took one.
 *
 * A no-op for a surface that never acquired — including one whose acquire
 * FAILED, and one whose session exists but whose dashboard start was
 * suppressed by the cooldown. That matters more than it looks: teardown is
 * gated on the session registry, not on this Set, so without the guard a
 * surface that has a session but no reference would pay down a reference
 * belonging to a different, live surface and could stop a dashboard somebody
 * is watching. The daemon clamps at zero; it cannot detect a phantom release.
 */
export async function releaseDashboardFor(surfaceId: string): Promise<void> {
  if (!heldFor.delete(surfaceId)) return;
  await dashboardDaemon.release();
}

/** Test seam: forget all per-surface bookkeeping and any active cooldown. */
export function resetDashboardRefs(): void {
  heldFor.clear();
  acquiring.clear();
  cooldownUntil = 0;
}

// ─── stream-port bindability ───────────────────────────────────────────────

/**
 * Can a server bind this port on loopback right now?
 *
 * The impure half of `SessionRegistry.ensureBindable` — see that method for why
 * asking at all is necessary. A real `listen`, not a connect probe: "nothing is
 * listening" and "we are allowed to listen" are different questions, and only
 * the second one predicts whether agent-browser's stream server will come up.
 * A port held by a process that accepts no connections, or refused by a
 * firewall rule, answers the first question misleadingly and the second
 * correctly.
 *
 * `exclusive: true` defeats SO_REUSEADDR-style sharing, so a port another
 * process already owns reads as taken rather than as a successful bind onto
 * somebody else's socket. The server is always closed again — this is a test,
 * not a reservation, and holding it would deny the port to the very session we
 * are allocating it for.
 */
export function probeBindablePort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const done = (bindable: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        /* never listened */
      }
      resolve(bindable);
    };
    server.once('error', () => done(false));
    server.once('listening', () => done(true));
    try {
      server.listen({ port, host, exclusive: true });
    } catch {
      done(false);
    }
  });
}

// ─── teardown ──────────────────────────────────────────────────────────────
//
// Sessions are EPHEMERAL (see agent-browser-session.ts): a session's process
// lifetime equals its surface's lifetime, nothing is persisted, and therefore
// any `wmux-` session with no live surface is garbage by construction. That
// invariant is only worth anything if every exit path actually closes what it
// opened, which is what this section is. The paths are:
//
//   • the pane going away        → `closeSessionFor` (ipc-handlers)
//   • the window/renderer dying  → `closeSessionFor` (ipc-handlers, on
//                                  webContents 'destroyed')
//   • app quit                   → `teardownAgentBrowser` below
//   • a CRASH, which reaches     → `reconcileOrphanSessions` below, at the
//     none of the above            NEXT startup
//
// Issue #139 is the reason the last one exists at all: Windows reparents a
// dead process's descendants instead of killing them, so a crashed wmux leaves
// every Chrome it started resident, and a crash-loop multiplies them.

/**
 * How long one `close` may take before we stop waiting for it.
 *
 * Measured against agent-browser 0.35.0, a real `--session <n> close` returns
 * in ~400ms including the "Browser closed" line, so this is ~7x headroom for a
 * loaded machine — but it is not sized against the happy path. It is sized
 * against the failure found in live testing: a session whose daemon was killed
 * mid-start (`⚠ Daemon version mismatch detected, restarting...`) left `close`
 * hanging INDEFINITELY while `session list` still reported the session. A
 * teardown step that can hang forever is not teardown, so every close carries
 * this deadline and moves on.
 */
export const SESSION_CLOSE_TIMEOUT_MS = 3_000;

/** `session list` is a local socket query; it has no reason to be slow. */
export const SESSION_LIST_TIMEOUT_MS = 5_000;

/**
 * Hard cap on how long quitting may wait for agent-browser.
 *
 * `dashboardDaemon.shutdown()` deliberately waits out an in-flight
 * `dashboard start`, which can be a 30s Chrome download, and the closes above
 * each carry their own deadline — so without an aggregate bound the worst case
 * is a wmux the user cannot quit. Past this point the process exits regardless
 * and whatever survived becomes the next startup's reconciliation problem,
 * which is exactly what that pass is for.
 */
export const QUIT_TEARDOWN_BUDGET_MS = 5_000;

/**
 * Resolve `p`, or resolve `fallback` once `ms` has passed — whichever is first.
 *
 * The timer is always cleared, including on the fast path: an outstanding
 * `setTimeout` keeps the event loop alive, and this runs at app quit.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const done = (v: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => done(fallback), ms);
    // A rejection is the same outcome as a timeout here: nothing was torn down
    // and there is nothing further this layer can do about it.
    p.then(done, () => done(fallback));
  });
}

/** Everything teardown and reconciliation touch that is not pure. */
export interface AgentBrowserTeardownDeps {
  binary: () => string | null;
  run: (binary: string, argv: string[], timeoutMs: number) => Promise<RunResult>;
  /** Sessions this process believes it owns. Ground truth for QUIT, not for startup. */
  listSessions: () => AgentSession[];
  /** Drop a surface's session from the registry, so a second close is a no-op. */
  forgetSession: (surfaceId: SurfaceId) => AgentSession | undefined;
  /** Is this surface's session live right now? Guards reconciliation against a race. */
  hasSession: (surfaceId: SurfaceId) => boolean;
  shutdownDashboard: () => Promise<void>;
  warn?: (message: string) => void;
}

/** `--session <name> close`. Named rather than surface-keyed, so reconciliation can use it too. */
export function sessionCloseArgv(sessionName: string): string[] {
  return ['--session', sessionName, 'close'];
}

/** `session list --json`. The only ground truth for what survived a crash. */
export function sessionListArgv(): string[] {
  return ['session', 'list', '--json'];
}

/**
 * Close one session by name, bounded, never throwing.
 *
 * ── The hanging-`close` fallback, and why it is "reconcile and move on" ─────
 * A `close` that never returns is a real, observed state, so the deadline here
 * is mandatory. What is NOT done on expiry is kill a PID, and that is a
 * deliberate refusal rather than an omission:
 *
 *   • agent-browser exposes no per-session PID. `session list` returns bare
 *     names (verified against 0.35.0: `{"sessions":["wmux-surf-…"]}`), and
 *     there is no pid file under its state directory. The only process-level
 *     handle available is "everything named agent-browser", which would kill
 *     sessions the user created by hand — the exact boundary the `wmux-`
 *     prefix rule exists to protect.
 *   • The daemon is SHARED. The live hang was triggered by a daemon version
 *     mismatch restart, i.e. by the process that fronts several sessions at
 *     once. Killing it to free one session takes the others with it.
 *   • Because sessions are ephemeral, a survivor is not permanent damage: it
 *     has no live surface, so the next launch's `reconcileOrphanSessions`
 *     classifies it as garbage and closes it. The cost of waiting is one
 *     leaked Chrome until then; the cost of guessing a PID is somebody else's
 *     browser. Leaking is recoverable, killing the wrong process is not.
 */
export async function closeSessionByName(
  sessionName: string,
  deps: AgentBrowserTeardownDeps,
  timeoutMs: number = SESSION_CLOSE_TIMEOUT_MS,
): Promise<boolean> {
  const binary = deps.binary();
  if (!binary) return false;
  // Two deadlines, not one. The inner `timeoutMs` is the CLI's own (it kills
  // the child); `withDeadline` additionally bounds the PROMISE, so a `run`
  // that never settles — a wedged pipe, a mocked seam, a future rewrite —
  // still cannot hold teardown open.
  const res = await withDeadline(
    deps.run(binary, sessionCloseArgv(sessionName), timeoutMs).catch(() => null),
    timeoutMs,
    null,
  );
  if (res?.ok) return true;
  deps.warn?.(`[wmux] agent-browser: could not close session ${sessionName}`);
  return false;
}

/**
 * Close the session belonging to one surface. Idempotent.
 *
 * The registry entry is dropped BEFORE the CLI call, not after. A close takes
 * hundreds of milliseconds and this is invoked from event handlers that can
 * fire twice for one surface (an unmount racing a window teardown); forgetting
 * first makes the second call see no session and return immediately, instead of
 * launching a second `close` against the same name.
 */
export async function closeSessionFor(
  surfaceId: SurfaceId,
  deps: AgentBrowserTeardownDeps,
  timeoutMs: number = SESSION_CLOSE_TIMEOUT_MS,
): Promise<boolean> {
  const session = deps.forgetSession(surfaceId);
  if (!session) return false;
  return closeSessionByName(session.sessionName, deps, timeoutMs);
}

/**
 * Close every session this process owns, then stop the dashboard. For quit.
 *
 * Closes run CONCURRENTLY and through `allSettled`: one wedged session must not
 * decide whether the other nine get closed, and it must not cost the dashboard
 * its shutdown either — which is why the daemon step is sequenced after the
 * closes with its own share of the budget rather than being part of the same
 * race. The registry is drained by `closeSessionFor` as it goes, so a second
 * teardown (Electron re-emits `will-quit` after a `preventDefault`) finds
 * nothing to do.
 */
export async function teardownAgentBrowser(
  deps: AgentBrowserTeardownDeps,
  budgetMs: number = QUIT_TEARDOWN_BUDGET_MS,
  now: () => number = Date.now,
): Promise<void> {
  const deadline = now() + budgetMs;
  const sessions = deps.listSessions();
  if (sessions.length > 0) {
    await withDeadline(
      Promise.allSettled(
        sessions.map((s) => closeSessionFor(s.surfaceId, deps, Math.min(SESSION_CLOSE_TIMEOUT_MS, budgetMs))),
      ).then(() => undefined),
      budgetMs,
      undefined,
    );
  }
  // Whatever the closes did, the dashboard still has to come down — it is a
  // separate process with its own refcount, and quit is the last chance.
  // `Math.max(…, 1)` so an already-exhausted budget still ATTEMPTS the stop
  // rather than skipping it on a zero-length race.
  const left = Math.max(deadline - now(), 1);
  await withDeadline(deps.shutdownDashboard().catch(() => undefined), left, undefined);
}

/**
 * Session names out of a `session list` result, whichever form it took.
 *
 * `--json` gives `{success, data:{sessions:[…]}}` (verified against 0.35.0);
 * the bare form prints `Active sessions:` followed by one indented name per
 * line, or `No active sessions`. Both are parsed because the argv is one
 * `--json` away from changing and a parser that silently returns nothing would
 * turn reconciliation into a no-op without failing anything.
 *
 * Everything returned here is UNTRUSTED input — a machine-global namespace any
 * tool can write into — so this deliberately does no filtering of its own.
 * Deciding what is wmux's to close is `isWmuxSessionName`'s single job.
 */
export function parseSessionList(res: Pick<RunResult, 'data' | 'stdout'>): string[] {
  const payload = unwrapAgentData(res as RunResult) as { sessions?: unknown } | null;
  const fromJson = payload?.sessions;
  if (Array.isArray(fromJson)) return fromJson.filter((s): s is string => typeof s === 'string');
  const names: string[] = [];
  for (const line of (res.stdout ?? '').split(/\r?\n/)) {
    // Only INDENTED lines are names; `Active sessions:` and `No active
    // sessions` sit at column zero and must not be read as one.
    if (!/^\s+\S/.test(line)) continue;
    const name = line.trim();
    if (name) names.push(name);
  }
  return names;
}

/**
 * Close everything a previous wmux left behind. Runs at startup.
 *
 * Ground truth is `agent-browser session list`, never the registry: the
 * registry is in-memory and starts EMPTY after a crash, so the sessions that
 * actually survived are precisely the ones it cannot see. Every `wmux-` session
 * found is garbage by the ephemeral invariant — a wmux session with no live
 * surface cannot legitimately exist — and everything else is untouchable.
 *
 * The `hasSession` check is not redundant with "the registry starts empty":
 * this runs unawaited alongside session restore, so a pane restored in agent
 * mode can mint `wmux-surf-X` while the list is still in flight. Re-asking the
 * registry immediately before each close is what keeps reconciliation from
 * closing a session this run just created.
 */
export async function reconcileOrphanSessions(
  deps: AgentBrowserTeardownDeps,
): Promise<string[]> {
  const binary = deps.binary();
  // Nothing installed ⇒ nothing could have been started ⇒ nothing to reconcile.
  // Checked first so a machine without agent-browser pays literally nothing.
  if (!binary) return [];

  const listed = await withDeadline(
    deps.run(binary, sessionListArgv(), SESSION_LIST_TIMEOUT_MS).catch(() => null),
    SESSION_LIST_TIMEOUT_MS,
    null,
  );
  if (!listed?.ok) return [];

  const closed: string[] = [];
  for (const name of parseSessionList(listed)) {
    // THE security boundary. A session without the wmux prefix belongs to a
    // human or another tool and is never wmux's to close, whatever else is
    // true about it.
    if (!isWmuxSessionName(name)) continue;
    const surfaceId = surfaceIdFromSessionName(name);
    if (surfaceId && deps.hasSession(surfaceId)) continue; // this run's, not a leftover
    if (await closeSessionByName(name, deps)) closed.push(name);
  }
  if (closed.length > 0) {
    deps.warn?.(`[wmux] closed ${closed.length} agent-browser session(s) orphaned by a previous run (issue #139)`);
  }
  return closed;
}

/**
 * The real machine behind `AgentBrowserTeardownDeps`.
 *
 * Lives here rather than in ipc-handlers.ts for the reason the whole module
 * does: the registry and the daemon are singletons, and teardown is reached
 * from BOTH ipc-handlers (surface close) and index.ts (quit, startup). A second
 * copy of this object would be a second opinion about which sessions exist.
 */
export const agentBrowserTeardownDeps: AgentBrowserTeardownDeps = {
  binary: () => agentBrowserPath(),
  run: (binary, argv, timeoutMs) => runAgentBrowser(binary, argv, timeoutMs),
  listSessions: () => sessionRegistry.all(),
  forgetSession: (surfaceId) => sessionRegistry.release(surfaceId),
  hasSession: (surfaceId) => sessionRegistry.get(surfaceId) !== undefined,
  shutdownDashboard: () => dashboardDaemon.shutdown(),
  warn: (message) => console.warn(message),
};

/**
 * Is there anything for quit to tear down?
 *
 * Quit has to hand control to an async teardown to close sessions, which means
 * `preventDefault()`ing `will-quit` and re-entering it. That is a real (if
 * small) risk to take on every quit, and there is no reason to take it on the
 * overwhelmingly common machine that has never opened an agent-mode pane: no
 * sessions and no dashboard means teardown has literally nothing to do.
 */
export function agentBrowserNeedsTeardown(): boolean {
  return sessionRegistry.size > 0 || dashboardDaemon.isAvailable;
}

/**
 * A session for this surface whose stream port the OS agreed we could bind.
 *
 * The one production caller of `SessionRegistry.ensureBindable`; `v2-browser.ts`
 * stays on the synchronous `ensure()` because it only needs a NAME to route a
 * verb, while this is the path that actually launches a browser with
 * `AGENT_BROWSER_STREAM_PORT` set and therefore the only one where the port has
 * to be real.
 */
export function ensureBindableSession(surfaceId: SurfaceId): Promise<AgentSession> {
  return sessionRegistry.ensureBindable(surfaceId, (port) => probeBindablePort(port));
}
