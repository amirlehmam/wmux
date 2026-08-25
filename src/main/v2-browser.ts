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
import { dashboardDaemon, sessionRegistry } from './agent-browser-runtime';
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
  runAgent: (argv: string[]) => Promise<RunResult>;
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
  return pollSurfaceWcId(browserSurfaceId, 5000);
}

/**
 * Which engine backs this browser surface?
 *
 * Asked of the RENDERER, because the split tree lives in the Zustand store and
 * main has no copy of it. `?.` and `?? 'web'` are load-bearing: this ships
 * before the renderer half exists, and a renderer that has never heard of
 * `__wmux_getBrowserEngine` must degrade to exactly today's behaviour rather
 * than throwing on every browser command. Anything that is not literally
 * 'agent' is 'web', mirroring `engineOf()`'s rule that an unknown value can
 * only ever degrade to the engine that needs no external binary.
 */
async function engineForSurface(surfaceId: string): Promise<BrowserEngine> {
  const win = firstWindow();
  if (!win) return 'web';
  const engine = await win.webContents.executeJavaScript(
    `window.__wmux_getBrowserEngine?.(${JSON.stringify(surfaceId)}) ?? 'web'`,
  );
  return engine === 'agent' ? 'agent' : 'web';
}

/**
 * Surfaces whose dashboard reference this process has already taken.
 *
 * `DashboardDaemon.acquire()` increments a refcount, so acquiring per COMMAND
 * would inflate it without bound and the last surface closing could never
 * bring it back to zero. One acquire per surface is what the daemon's contract
 * ("refcounted by the number of live agent-mode surfaces") actually asks for,
 * and it pairs one-to-one with the per-surface release teardown owns. A
 * surface is recorded only after acquire SUCCEEDS, so a failed start is
 * retried by the next command rather than remembered as done.
 */
const dashboardAcquiredFor = new Set<string>();

/**
 * Ready an agent-mode surface: its session, and the dashboard that displays it.
 *
 * `acquire()` throws when the dashboard cannot be started (having first rolled
 * its own refcount back, so nothing leaks here). That failure is deliberately
 * NOT fatal to the command: the dashboard is observability — agent-browser
 * drives Chrome perfectly well without it — and failing every `browser open`
 * because a viewer process did not start would trade a degraded feature for a
 * broken one. The pane itself shows the missing dashboard, so the user is not
 * left guessing.
 */
async function agentTargetFor(surfaceId: string): Promise<BrowserTarget> {
  const session = sessionRegistry.ensure(surfaceId as SurfaceId);
  if (!dashboardAcquiredFor.has(surfaceId)) {
    try {
      await dashboardDaemon.acquire();
      dashboardAcquiredFor.add(surfaceId);
    } catch {
      // Observability only — see above. Left unrecorded so the next command retries.
    }
  }
  return { kind: 'agent', session };
}

/**
 * Resolve where a command should run: which browser, on which engine.
 *
 * The engine is checked BEFORE `resolveBrowserWcId` for an already-bound
 * caller, and that order is not cosmetic. An agent-mode surface has no
 * webview attached to the CDPBridge, so `wcIdForSurface` returns null for it —
 * running the wcId path first would read that null as "my browser died", drop
 * a perfectly live binding (#62) and split a second pane on top of it.
 */
export async function resolveBrowserTarget(caller?: string): Promise<BrowserTarget | null> {
  const bound = caller ? callerBrowserSurface.get(caller) : undefined;
  if (bound && (await engineForSurface(bound)) === 'agent') return agentTargetFor(bound);

  const wcId = await resolveBrowserWcId(caller);
  if (wcId === null) {
    // resolveBrowserWcId may have just created and bound a browser surface that
    // starts in agent mode — in which case there is no wcId to wait for and its
    // null is the expected answer, not a failure. Re-check before giving up.
    const created = caller ? callerBrowserSurface.get(caller) : undefined;
    if (created && (await engineForSurface(created)) === 'agent') return agentTargetFor(created);
    return null;
  }
  return { kind: 'web', wcId };
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
    const res = await deps.runAgent(argv);
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

/** The real machine behind `BrowserDeps`. Every production call uses this. */
const defaultDeps: BrowserDeps = {
  bridge: cdpBridge,
  runAgent: async (argv) => {
    const binary = agentBrowserPath();
    if (!binary) {
      throw new Error('agent-browser is not installed — open a browser tab in agent mode to install it');
    }
    return runAgentBrowser(binary, argv);
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
  })().catch((err: any) => respondError(-32000, err.message));
}
