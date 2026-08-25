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
import { agentBrowserPath, runAgentBrowser } from './agent-browser-cli';
import { DashboardDaemon } from './agent-browser-daemon';
import { DASHBOARD_PORT, SessionRegistry } from './agent-browser-session';

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
    const res = await runAgentBrowser(binary, ['dashboard', 'start'], DASHBOARD_START_TIMEOUT_MS);
    return res.ok;
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
