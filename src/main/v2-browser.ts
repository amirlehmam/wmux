/**
 * v2-browser.ts — Per-caller browser routing for V2 pipe handlers (issue #62).
 *
 * Each distinct caller (an agent's terminal surface, identified by its
 * WMUX_SURFACE_ID and sent as `params.caller`) is bound to its OWN browser
 * surface, created in that caller's workspace. The CDPBridge tracks every
 * attached browser independently, so concurrent agents no longer share — and
 * clobber — a single browser window. With no caller (manual human use) we fall
 * back to the legacy shared browser.
 *
 * ── Two engines, one set of verbs ─────────────────────────────────────────
 * A browser surface is backed either by the Electron <webview> (`web`, the
 * default and the only thing that existed before) or by vercel-labs
 * agent-browser driving a real Chrome (`agent`). The engine is a property of
 * the SURFACE, resolved here — never of the command. That is the whole design
 * goal: the global CLAUDE.md wmux writes to every machine keeps saying
 * `wmux browser open <url>`, so no agent anywhere has to be re-educated, and
 * only what happens underneath changes. Consequently the two engines must be
 * indistinguishable to a caller in everything it can observe — verb names,
 * result shapes, and the error for a verb neither supports.
 */
import { BrowserWindow } from 'electron';
import { cdpBridge } from './ipc-handlers';
import { agentBrowserPath, runAgentBrowser, type RunResult } from './agent-browser-cli';
import { acquireDashboardFor, sessionRegistry } from './agent-browser-runtime';
import type { AgentSession } from './agent-browser-session';
import { toAgentBrowserArgv } from './agent-browser-verbs';
import type { BrowserEngine, SurfaceId } from '../shared/types';

type Respond = (result: any) => void;
type RespondError = (code: number, message: string) => void;

/**
 * A resolved place to run a browser verb.
 *
 * `web` carries the guest webContents id the CDPBridge addresses; `agent`
 * carries the agent-browser session every argv is pinned to. Resolution
 * produces one of these once, and the command runner switches on it once — so
 * there is exactly one place in the codebase that knows an engine exists.
 */
export type BrowserTarget =
  | { kind: 'web'; wcId: number }
  | { kind: 'agent'; session: AgentSession };

/**
 * Injected so routing is unit-testable with no Electron, no CDP and no daemon
 * — the two things this module does that are hard to fake are precisely the
 * two things behind this interface.
 */
export interface BrowserDeps {
  bridge: typeof cdpBridge;
  runAgent: (argv: string[], timeoutMs: number) => Promise<RunResult>;
}

function firstWindow(): BrowserWindow | null {
  const win = BrowserWindow.getAllWindows()[0];
  return win && !win.isDestroyed() ? win : null;
}

/**
 * Auto-create a shared browser panel if none exists, then wait for CDP to
 * attach. Legacy single-browser path used when a command has no caller context.
 */
async function ensureBrowserPanel(): Promise<boolean> {
  if (cdpBridge.isAttached) return true;
  const win = firstWindow();
  if (!win) return false;
  await win.webContents.executeJavaScript(
    `window.__wmux_splitPane?.({ direction: 'horizontal', type: 'browser' })`,
  );
  const deadline = Date.now() + 5000;
  while (!cdpBridge.isAttached && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return cdpBridge.isAttached;
}

// caller terminal surface → its own browser surface. boundBrowserSurfaces tracks
// which browser surfaces are already owned so a second agent never adopts the
// first agent's browser.
const callerBrowserSurface = new Map<string, string>();
const boundBrowserSurfaces = new Set<string>();

async function pollSurfaceWcId(surfaceId: string, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const wcId = cdpBridge.wcIdForSurface(surfaceId);
    if (wcId !== null) return wcId;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cdpBridge.wcIdForSurface(surfaceId);
}

async function legacyWcId(): Promise<number | null> {
  return (await ensureBrowserPanel()) ? cdpBridge.attachedWebContentsId : null;
}

/**
 * Resolve which browser webContents a command should run against, creating /
 * binding a per-caller browser surface as needed. Returns the wcId, or null if
 * no browser could be readied.
 */
async function resolveBrowserWcId(caller?: string): Promise<number | null> {
  const win = firstWindow();
  if (!win) return null;
  if (!caller) return legacyWcId();

  // Reuse this caller's already-bound browser if it's still live.
  const bound = callerBrowserSurface.get(caller);
  if (bound) {
    const wcId = cdpBridge.wcIdForSurface(bound);
    if (wcId !== null) return wcId;
    callerBrowserSurface.delete(caller);
    boundBrowserSurfaces.delete(bound);
  }

  const workspaceId: string | null = await win.webContents.executeJavaScript(
    `window.__wmux_getWorkspaceIdForSurface?.(${JSON.stringify(caller)}) ?? null`,
  );
  if (!workspaceId) return legacyWcId();

  // Adopt an existing unowned browser surface in the workspace (e.g. one the user
  // opened manually); otherwise spawn a fresh browser pane in that workspace.
  const existing: string[] = await win.webContents.executeJavaScript(
    `window.__wmux_listBrowserSurfaces?.(${JSON.stringify(workspaceId)}) ?? []`,
  );
  let browserSurfaceId = existing.find((id) => !boundBrowserSurfaces.has(id)) ?? null;
  if (!browserSurfaceId) {
    const created = await win.webContents.executeJavaScript(
      `window.__wmux_splitPane?.({ direction: 'horizontal', type: 'browser', workspaceId: ${JSON.stringify(workspaceId)} }) ?? null`,
    );
    browserSurfaceId = created?.surfaceId ?? null;
  }
  if (!browserSurfaceId) return legacyWcId();

  callerBrowserSurface.set(caller, browserSurfaceId);
  boundBrowserSurfaces.add(browserSurfaceId);
  // An agent-mode surface is not driven over CDP, so waiting for a wcId to
  // attach is pure latency — up to the full 5s, on the first command a caller
  // ever issues, every time. Give up immediately instead; `resolveBrowserTarget`
  // re-reads this binding and routes it to the agent engine. The answer is the
  // same either way, it just arrives 5s sooner, which matters because the CLI's
  // client-side deadline is spending that time too.
  if ((await engineForSurface(browserSurfaceId)) === 'agent') return null;
  return pollSurfaceWcId(browserSurfaceId, 5000);
}

/**
 * Which engine backs this browser surface?
 *
 * Asked of the RENDERER, because the split tree lives in the Zustand store and
 * main has no copy of it. Three details are load-bearing:
 *
 *  - EVERY window is asked, first affirmative answer wins. `firstWindow()` is
 *    `getAllWindows()[0]`, and the surface may live in window 2 — the #143
 *    "window ≠ workspace" mistake. `resolveBrowserWcId` has the same shape, but
 *    its wrong answer is a benign fall-back to the shared browser, whereas a
 *    wrong answer HERE dispatches to the wrong engine silently.
 *  - `?.` and `?? 'web'` let this ship before the renderer half exists: a
 *    renderer that has never heard of `__wmux_getBrowserEngine` degrades to
 *    exactly today's behaviour instead of throwing on every browser command.
 *  - a rejected `executeJavaScript` (renderer reloading, webContents destroyed
 *    mid-flight) is 'web', not a failure. This runs on the hot path of every
 *    command, where it previously did no renderer IPC at all; without the catch
 *    it would be a brand-new way for a working command to fail -32000.
 */
async function engineForSurface(surfaceId: string): Promise<BrowserEngine> {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const engine = await win.webContents
      .executeJavaScript(`window.__wmux_getBrowserEngine?.(${JSON.stringify(surfaceId)}) ?? 'web'`)
      .catch(() => 'web');
    if (engine === 'agent') return 'agent';
  }
  return 'web';
}

/**
 * Ready an agent-mode surface: its session, and the dashboard that displays it.
 *
 * The dashboard reference is taken but NOT awaited, and that is the whole
 * point. agent-browser drives Chrome perfectly well without its viewer, so the
 * verb has nothing to gain by waiting — while a cold `dashboard start` can take
 * 30s, which is longer than the CLI's entire client-side deadline for most
 * verbs (see AGENT_*_MS below). Blocking here would turn "the viewer is slow"
 * into "every browser command times out", which is precisely the failure
 * `tests/unit/browser-timeout.test.ts` exists to prevent.
 *
 * The failure is logged rather than swallowed: it is invisible to the user
 * otherwise. It is deliberately not fatal — but it is also not harmless. After
 * Task 8 the pane loads the dashboard url in its webview, so a dashboard that
 * never started renders ERR_CONNECTION_REFUSED, which reads as "my browser is
 * broken" rather than "an optional viewer did not start". A console line is the
 * least this can do; naming the situation in the pane is Task 8's to fix.
 */
function agentTargetFor(surfaceId: string): BrowserTarget {
  // Deliberately NOT awaited — see above. `.catch` is what keeps an unawaited
  // rejection from surfacing as an unhandled promise rejection.
  acquireDashboardFor(surfaceId).catch((err: Error) => {
    console.warn('[wmux] agent-browser dashboard did not start:', err?.message);
  });
  return { kind: 'agent', session: sessionRegistry.ensure(surfaceId as SurfaceId) };
}

/**
 * Resolve where a command should run: which browser, on which engine.
 *
 * The engine is checked for whichever surface ends up bound, on EVERY outcome
 * — not only when there was no wcId. That is the correctness core of this
 * function, and the obvious shortcut is wrong:
 *
 * A surface TOGGLED from web to agent keeps its CDP registration. Nothing calls
 * `cdp.detach` on a toggle, and `pruneDead()` only drops destroyed webContents,
 * so `wcIdForSurface` keeps returning a perfectly valid, NON-null id for it.
 * Checking the engine only on the null branch therefore misses the toggled case
 * entirely: `resolveBrowserWcId` adopts the surface, polls, gets that stale id,
 * and the command drives CDP against agent-browser's own dashboard SPA —
 * corrupting the pane the user is watching, silently.
 *
 * The pre-check on an already-bound caller is a separate matter, and also not
 * cosmetic: it keeps `resolveBrowserWcId` from reading an agent surface's
 * missing wcId as "my browser died" and dropping a live #62 binding.
 */
export async function resolveBrowserTarget(caller?: string): Promise<BrowserTarget | null> {
  const bound = caller ? callerBrowserSurface.get(caller) : undefined;
  if (bound && (await engineForSurface(bound)) === 'agent') return agentTargetFor(bound);

  const wcId = await resolveBrowserWcId(caller);

  // Whatever `resolveBrowserWcId` settled on — a surface it just adopted, one
  // it created, or a rebind after the old one died — is the surface this
  // command will actually run against, so it is the one whose engine decides.
  // `bound` was already checked above and is skipped rather than re-asked.
  const settled = caller ? callerBrowserSurface.get(caller) : undefined;
  if (settled && settled !== bound && (await engineForSurface(settled)) === 'agent') {
    return agentTargetFor(settled);
  }

  return wcId === null ? null : { kind: 'web', wcId };
}

/** Does `data` actually carry `key`, as opposed to merely not contradicting it?
 *
 *  A `??` chain cannot answer this: `data.result ?? fallback` replaces a
 *  perfectly good `false`, `0` or `''` with the fallback, which for
 *  `browser.eval` means an agent that evaluated `document.hidden` gets the raw
 *  stdout instead of `false`. */
function hasField(data: unknown, key: string): boolean {
  return !!data && typeof data === 'object' && key in (data as Record<string, unknown>);
}

/**
 * Coerce an agent-browser result into the shape the WEB engine returns for the
 * same verb, so a caller written against one engine keeps working against the
 * other. This is the second half of engine indistinguishability (the first
 * being the shared `-32601`), and the reason it lives next to the web switch:
 * the two must be read together, and a shape changed on one side without the
 * other is the bug this function exists to make obvious.
 *
 * `stdout` is the fallback throughout because not every agent-browser verb
 * emits JSON — `read` in particular prints agent-readable text directly.
 */
function agentResultShape(method: string, res: RunResult): any {
  switch (method) {
    case 'browser.snapshot':
      return res.data ?? { tree: res.stdout, refCount: 0 };
    case 'browser.get_text':
      return { text: hasField(res.data, 'text') ? (res.data as any).text : res.stdout };
    case 'browser.screenshot':
      return { data: (res.data as any)?.data ?? (res.data as any)?.base64 ?? res.stdout.trim() };
    case 'browser.eval':
      if (hasField(res.data, 'result')) return { result: (res.data as any).result };
      return { result: res.data ?? res.stdout.trim() };
    default:
      return { ok: true };
  }
}

/**
 * What went wrong when an agent-browser invocation failed.
 *
 * `spawnFailed` and a non-zero exit are opposite problems and must not be
 * collapsed into one message (see `RunResult.spawnFailed`). A non-zero exit is
 * the CLI reporting on the page — its `stderr` is the useful thing and belongs
 * verbatim in front of the agent. A spawn failure means the process never ran:
 * `stderr` is empty, so echoing it would surface a blank error for what is
 * really a wmux/install fault, and the actionable advice ("re-resolve the
 * binary") is something no page-level message could convey. The thrown error
 * carries `spawnFailed` as a property too, so a caller can react rather than
 * having to pattern-match English.
 */
function agentFailure(method: string, res: RunResult): Error {
  if (res.spawnFailed) {
    return Object.assign(
      new Error(
        `agent-browser could not be launched for ${method} — the binary may have moved or been uninstalled. ` +
        `Reopen the pane in agent mode to re-resolve it.`,
      ),
      { spawnFailed: true },
    );
  }
  return Object.assign(
    new Error(res.stderr.trim() || res.stdout.trim() || `agent-browser ${method} failed`),
    { spawnFailed: false },
  );
}

/**
 * Run one browser verb against an already-resolved target. Shared by the
 * single-command and batch paths so there's one source of truth (and no deeply
 * nested handler maps).
 */
export async function runBrowserCommandForTarget(
  method: string,
  params: any,
  target: BrowserTarget,
  deps: BrowserDeps,
): Promise<any> {
  if (target.kind === 'agent') {
    // Built FIRST, before anything is spawned: an unsupported verb must cost a
    // rejected message, not a Chrome round-trip. `toAgentBrowserArgv` throws
    // the identical -32601 the web switch below does, which is what makes the
    // engines indistinguishable for an unknown verb.
    const argv = toAgentBrowserArgv(method, params, target.session.sessionName);
    const res = await deps.runAgent(argv, agentTimeoutFor(method, params));
    if (!res.ok) throw agentFailure(method, res);
    return agentResultShape(method, res);
  }

  const { wcId } = target;
  const bridge = deps.bridge;
  switch (method) {
    case 'browser.navigate':
      await bridge.navigate(params?.url, params?.timeout, wcId);
      return { ok: true };
    case 'browser.snapshot':
      return bridge.snapshot(wcId);
    case 'browser.click':
      await bridge.click(params?.ref, wcId);
      return { ok: true };
    case 'browser.type':
      await bridge.type(params?.ref, params?.text, wcId);
      return { ok: true };
    case 'browser.fill':
      await bridge.fill(params?.ref, params?.value, wcId);
      return { ok: true };
    case 'browser.screenshot':
      return { data: await bridge.screenshot(params?.fullPage, wcId) };
    case 'browser.get_text':
      return { text: await bridge.getText(params?.ref, wcId) };
    case 'browser.eval':
      return { result: await bridge.evaluate(params?.js, wcId) };
    case 'browser.wait':
      await bridge.wait(params?.ref, params?.timeout, wcId);
      return { ok: true };
    case 'browser.back':
      await bridge.goBack(wcId);
      return { ok: true };
    case 'browser.forward':
      await bridge.goForward(wcId);
      return { ok: true };
    case 'browser.reload':
      await bridge.reload(wcId);
      return { ok: true };
    default:
      throw Object.assign(new Error(`Unknown: ${method}`), { rpcCode: -32601 });
  }
}

/**
 * ── Agent-engine budgets ───────────────────────────────────────────────────
 *
 * How long one agent-browser invocation may run. These are NOT free-floating:
 * the CLI hangs up on its own deadline (`browserDeadline()` in
 * `src/cli/wmux.ts` = BROWSER_READY_MS + verb + BROWSER_SLACK_MS), and a server
 * budget larger than that deadline is not a longer budget — it is an
 * UNREPORTABLE one. The client is already gone, so a command that overruns
 * prints a bare `timed out` and the server's real diagnosis
 * ('agent-browser … failed: …') never reaches the user. That is exactly the
 * regression `tests/unit/browser-timeout.test.ts` was written to prevent, and
 * it now checks these numbers against the CLI's directly.
 *
 * Sizing, against a CLI that allows READY(5000) + verb + SLACK(5000):
 *   navigate — 30000, matching cdp-bridge's own navigate budget; CLI allows 40000.
 *   wait     — the caller's own timeout when given, else 10000, matching
 *              cdp-bridge's wait(); the CLI scales its deadline the same way.
 *   the rest — 4000. The CLI allows 10000 total for them, and readiness can
 *              legitimately eat 5000 of it (`pollSurfaceWcId`), so anything
 *              larger could not be reported.
 */
const AGENT_NAVIGATE_MS = 30000;
const AGENT_WAIT_MS = 10000;
const AGENT_VERB_MS = 4000;

function agentTimeoutFor(method: string, params: any): number {
  if (method === 'browser.navigate') return AGENT_NAVIGATE_MS;
  if (method === 'browser.wait') {
    return typeof params?.timeout === 'number' ? params.timeout : AGENT_WAIT_MS;
  }
  return AGENT_VERB_MS;
}

/** The real machine behind `BrowserDeps`. Every production call uses this. */
const defaultDeps: BrowserDeps = {
  bridge: cdpBridge,
  runAgent: async (argv, timeoutMs) => {
    const binary = agentBrowserPath();
    if (!binary) {
      throw new Error('agent-browser is not installed — open a browser tab in agent mode to install it');
    }
    return runAgentBrowser(binary, argv, timeoutMs);
  },
};

async function handleBrowserBatch(params: any, respond: Respond, respondError: RespondError): Promise<void> {
  const target = await resolveBrowserTarget(params?.caller);
  if (target === null) { respondError(-32000, 'Could not open browser panel'); return; }
  const results: any[] = [];
  for (const cmd of params?.commands || []) {
    try {
      results.push({ result: await runBrowserCommandForTarget(cmd.method, cmd.params, target, defaultDeps) });
    } catch (err: any) {
      results.push({ error: { code: err.rpcCode ?? -32000, message: err.message } });
      break;
    }
  }
  respond({ results });
}

/** Entry point: handle any `browser.*` V2 method. */
export function handleBrowserV2(
  method: string,
  params: any,
  respond: Respond,
  respondError: RespondError,
): void {
  (async () => {
    if (method === 'browser.batch') {
      await handleBrowserBatch(params, respond, respondError);
      return;
    }
    const target = await resolveBrowserTarget(params?.caller);
    if (target === null) { respondError(-32000, 'Could not open browser panel'); return; }
    respond(await runBrowserCommandForTarget(method, params, target, defaultDeps));
    // `err.rpcCode ?? -32000`, matching the batch loop. It used to be a flat
    // -32000 here, so an unknown verb reported -32601 inside a batch and -32000
    // as a single command — undoing, one frame up, the engine-indistinguishable
    // -32601 that runBrowserCommandForTarget goes to some trouble to produce.
  })().catch((err: any) => respondError(err?.rpcCode ?? -32000, err?.message));
}
