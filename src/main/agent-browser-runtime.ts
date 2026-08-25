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
