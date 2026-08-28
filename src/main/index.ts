import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { registerIpcHandlers, agentManager, ptyManager, setupAgentPtyForwarding, reapOrphanedPtys, sshDetector, agentIdentity } from './ipc-handlers';
import { sequenceFrom, splitSequencedReport } from './ssh-detect';
import { handleDetectionV2 } from './detection-rpc';
import { isPtyCrashGuardInstalled } from './pty-manager';
import { logDiagnostic } from './crash-diagnostics';
import { handleBrowserV2 } from './v2-browser';
import { pickBrowserSurface } from './browser-engine-surface';
import {
  agentBrowserNeedsTeardown,
  agentBrowserTeardownDeps,
  QUIT_TEARDOWN_BUDGET_MS,
  reconcileOrphanSessions,
  teardownAgentBrowser,
} from './agent-browser-runtime';
import { handleBridgeV2 } from './v2-bridge';
import { distributeAgents } from './agent-manager';
import { PipeServer } from './pipe-server';
import { PortScanner } from './port-scanner';
import { CDPProxy } from './cdp-proxy';
import { IPC_CHANNELS, SurfaceId, BrowserEngine } from '../shared/types';
import { getPipePath, getAppDataDir, ensurePipeToken } from '../shared/instance';
import { loadSession, saveSession, handleVersionChange, SessionData } from './session-persistence';
import { getAgentState, reportAgentSession } from './agent-state';
import {
  stampClaudeSessionIds,
  pruneDeadClaudeSessions,
  listKnownTranscriptIds,
} from './claude-resume';
import { sessionWindows, MAX_RESTORED_WINDOWS } from './session-windows';
import { WindowManager } from './window-manager';
import { initAutoUpdater, requestUpdateNow, getUpdateState } from './updater';
import { initUpdateChecker, getLatestUpdate } from './update-checker';
import { initAgentIntegration } from './agent-integration';
import { applyExternalActivity, markSubagentStop, markAllAgentsDone } from './claude-observer';
import { handleAgentStateV2, setAnswerWriter } from './agent-state-rpc';
import { applyHookToAgentState, hookEventName } from './agent-hook-bridge';
import { startOrchestrationWatcher } from './orchestration-watcher';
import { readMarkdownFile } from './markdown-file';
import { grantMarkdownPath, clearMarkdownGrants } from './markdown-grants';
import { directoryFromArgv } from './shell-context-menu';
import { reportExplorerCwd } from './explorer-roots';
import { ensurePowerShellShim } from './powershell-shim';
import { loadSettings } from './settings-store';
import fs from 'fs';
import path from 'path';

// ─── browser.get_engine / browser.set_engine ────────────────────────────────
//
// These are handled here rather than in v2-browser.ts's `handleBrowserV2`
// (out of scope for this change) even though their names start with
// `browser.` — `routeSpecialV2` below checks for them BEFORE the generic
// `browser.*` delegation, or they would fall into `runBrowserCommandForTarget`'s
// verb switch and be rejected as `Unknown: browser.get_engine`.

/** What resolving a terminal `caller` to ITS bound browser surface found. */
type CallerBrowserResolution =
  | { kind: 'found'; surfaceId: string }
  // No browser surface exists yet in the caller's workspace. Carries the
  // window + workspaceId so a `set` can create one there; a `get` just
  // answers 'web' without creating anything (see handleBrowserEngineV2).
  | { kind: 'none'; win: BrowserWindow; workspaceId: string }
  | { kind: 'ambiguous' }
  | { kind: 'unresolved' };

/**
 * Resolve which browser surface a terminal `caller` (e.g. $WMUX_SURFACE_ID) is
 * effectively bound to, for `browser.get_engine` / `browser.set_engine`.
 *
 * `wmux browser <verb>` already resolves a caller to ITS OWN browser surface
 * (issue #62) — but that binding (`callerBrowserSurface` in v2-browser.ts) is
 * a private module-level map in a file this change does not touch. So this
 * does NOT read or write that map; it re-derives an answer from the same
 * renderer bridge globals v2-browser.ts's `resolveBrowserWcId` uses
 * (`__wmux_getWorkspaceIdForSurface`, `__wmux_listBrowserSurfaces`,
 * `__wmux_splitPane`) — the ones that actually own the split-tree state.
 *
 * That is safe, not just convenient: a surface this creates is never added to
 * v2-browser.ts's private `boundBrowserSurfaces` set either, so it is still
 * "unowned" and gets adopted normally the first time the same caller runs a
 * REAL browser verb — the two paths agree without sharing state.
 *
 * More than one existing browser surface in the caller's workspace (e.g. two
 * agents that already each own one) is refused rather than guessed at:
 * silently picking one risks flipping the WRONG agent's browser, exactly the
 * cross-talk issue #62 exists to prevent.
 */
async function resolveCallerBrowserSurface(caller: string): Promise<CallerBrowserResolution> {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const workspaceId: string | null = await win.webContents.executeJavaScript(
      `window.__wmux_getWorkspaceIdForSurface?.(${JSON.stringify(caller)}) ?? null`,
    );
    if (!workspaceId) continue;
    const existing: string[] = await win.webContents.executeJavaScript(
      `window.__wmux_listBrowserSurfaces?.(${JSON.stringify(workspaceId)}) ?? []`,
    );
    const picked = pickBrowserSurface(caller, existing);
    if (picked.kind !== 'none') return picked;
    return { kind: 'none', win, workspaceId };
  }
  return { kind: 'unresolved' };
}

/** Ask every window whether `surfaceId` is a browser surface, and its engine. */
async function readBrowserEngine(surfaceId: string): Promise<BrowserEngine> {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const engine = await win.webContents.executeJavaScript(
      `window.__wmux_getBrowserEngine?.(${JSON.stringify(surfaceId)}) ?? 'web'`,
    );
    if (engine === 'agent') return 'agent';
  }
  return 'web';
}

/** Ask every window to flip `surfaceId`'s engine. True the moment one takes it. */
async function writeBrowserEngine(surfaceId: string, engine: BrowserEngine): Promise<boolean> {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const ok = await win.webContents.executeJavaScript(
      `window.__wmux_setBrowserEngine?.(${JSON.stringify(surfaceId)}, ${JSON.stringify(engine)}) ?? false`,
    );
    if (ok) return true;
  }
  return false;
}

/**
 * Failure branches shared by get/set once a `caller` (no explicit
 * `surfaceId`) needs resolving. Split out of the get/set handlers below
 * purely to keep each of THEIR cognitive complexity down — every branch here
 * ends in `respondError` and returns, so the caller only has to check for a
 * truthy return to know whether it already answered.
 */
function respondResolutionFailure(
  method: string,
  caller: string,
  resolution: Extract<CallerBrowserResolution, { kind: 'ambiguous' | 'unresolved' }>,
  respondError: (code: number, message: string) => void,
): void {
  if (resolution.kind === 'ambiguous') {
    respondError(-32000, `${method}: surface ${caller} has more than one browser pane in its workspace — pass --surface <id> to pick one`);
  } else {
    respondError(-32000, `${method}: no workspace found for surface ${caller} — is it a live terminal surface?`);
  }
}

/** `browser.get_engine`. See `handleBrowserEngineV2` for the params contract. */
async function handleGetEngine(
  params: any,
  respond: (result: any) => void,
  respondError: (code: number, message: string) => void,
): Promise<void> {
  let surfaceId: string | undefined = params?.surfaceId;
  if (!surfaceId) {
    const caller: string | undefined = params?.caller;
    if (!caller) {
      respondError(-32602, 'browser.get_engine: surface required — pass --surface <id>, or run from inside a pane so $WMUX_SURFACE_ID is set');
      return;
    }
    const resolution = await resolveCallerBrowserSurface(caller);
    if (resolution.kind === 'found') {
      surfaceId = resolution.surfaceId;
    } else if (resolution.kind === 'none') {
      // Nothing bound yet: the next REAL browser verb from this caller would
      // create a 'web' pane by default, so that is the honest answer — no
      // need to create anything just to answer a query.
      respond({ engine: 'web' });
      return;
    } else {
      respondResolutionFailure('browser.get_engine', caller, resolution, respondError);
      return;
    }
  }
  if (!surfaceId) { respondError(-32000, 'browser.get_engine: could not resolve a browser surface'); return; }
  respond({ engine: await readBrowserEngine(surfaceId) });
}

/** `browser.set_engine`. See `handleBrowserEngineV2` for the params contract. */
async function handleSetEngine(
  params: any,
  respond: (result: any) => void,
  respondError: (code: number, message: string) => void,
): Promise<void> {
  const engine: BrowserEngine | undefined = params?.engine;
  if (engine !== 'web' && engine !== 'agent') {
    respondError(-32602, `browser.set_engine: engine must be "web" or "agent" (got ${JSON.stringify(params?.engine)})`);
    return;
  }

  let surfaceId: string | undefined = params?.surfaceId;
  if (!surfaceId) {
    const caller: string | undefined = params?.caller;
    if (!caller) {
      respondError(-32602, 'browser.set_engine: surface required — pass --surface <id>, or run from inside a pane so $WMUX_SURFACE_ID is set');
      return;
    }
    const resolution = await resolveCallerBrowserSurface(caller);
    if (resolution.kind === 'found') {
      surfaceId = resolution.surfaceId;
    } else if (resolution.kind === 'none') {
      const created = await resolution.win.webContents.executeJavaScript(
        `window.__wmux_splitPane?.({ direction: 'horizontal', type: 'browser', workspaceId: ${JSON.stringify(resolution.workspaceId)} }) ?? null`,
      );
      if (!created?.surfaceId) {
        respondError(-32000, `browser.set_engine: could not create a browser pane for surface ${caller}`);
        return;
      }
      surfaceId = created.surfaceId;
    } else {
      respondResolutionFailure('browser.set_engine', caller, resolution, respondError);
      return;
    }
  }
  if (!surfaceId) { respondError(-32000, 'browser.set_engine: could not resolve a browser surface'); return; }

  const ok = await writeBrowserEngine(surfaceId, engine);
  if (!ok) {
    respondError(-32000, `browser.set_engine: surface ${surfaceId} does not exist or is not a browser surface`);
    return;
  }
  respond({ engine });
}

/**
 * `browser.get_engine` / `browser.set_engine`.
 *
 * Params carry either an explicit `surfaceId` (a known browser surface —
 * always used as-is) or a `caller` (a terminal surface, the shape every other
 * `browser.*` verb already accepts, forwarded here by `cmdBrowser`'s existing
 * `--surface`/`$WMUX_SURFACE_ID` handling with no CLI-side special-casing).
 * Neither present is the one case Part 2 asks for directly: -32602, since
 * there is nothing to resolve.
 */
function handleBrowserEngineV2(
  method: string,
  params: any,
  respond: (result: any) => void,
  respondError: (code: number, message: string) => void,
): void {
  const task = method === 'browser.set_engine'
    ? handleSetEngine(params, respond, respondError)
    : handleGetEngine(params, respond, respondError);
  task.catch((err: any) => respondError(-32000, err?.message ?? String(err)));
}

// Route the V2 methods that live in their own modules: browser.* (per-caller
// isolated routing, issue #62) and the uniform renderer-bridge methods. Returns
// true when the method was handled here so the main switch can be skipped.
function routeSpecialV2(
  request: { method: string; params?: any },
  respond: (result: any) => void,
  respondError: (code: number, message: string) => void,
): boolean {
  // get_engine/set_engine must be caught BEFORE the generic browser.*
  // delegation just below, or they fall into handleBrowserV2's verb switch
  // and are rejected as `Unknown: browser.get_engine` (-32601).
  if (request.method === 'browser.get_engine' || request.method === 'browser.set_engine') {
    handleBrowserEngineV2(request.method, request.params, respond, respondError);
    return true;
  }
  if (request.method.startsWith('browser.')) {
    handleBrowserV2(request.method, request.params, respond, respondError);
    return true;
  }
  if (request.method.startsWith('window.')) {
    return handleWindowV2(request.method, request.params, respond, respondError);
  }
  // Declared agent state (issue #128) — pane.report_agent and friends.
  if (handleAgentStateV2(request.method, request.params, respond, respondError)) return true;
  return handleBridgeV2(request.method, request.params, respond, respondError);
}

// Pick which pane each agent in a batch lands in, per distribution strategy.
function resolveAgentAssignments(strategy: string, count: number, paneLoads: any[]): string[] {
  if (strategy === 'stack') {
    const sorted = [...paneLoads].sort((a, b) => a.tabCount - b.tabCount);
    return Array.from({ length: count }, () => sorted[0].paneId);
  }
  if (strategy !== 'distribute') {
    console.warn('[wmux] split strategy not yet implemented, falling back to distribute');
  }
  return distributeAgents(count, paneLoads);
}

// Spawn each agent in a batch into its assigned pane, broadcasting updates.
// Per-agent failures are captured as { error } so one bad agent can't fail the batch.
function spawnAgentBatch(
  agentParams: any[],
  assignments: string[],
  workspaceId: any,
  win: BrowserWindow | undefined,
): any[] {
  const results: any[] = [];
  agentParams.forEach((p, i) => {
    try {
      const agentCmd = p.cmd || p.prompt; // accept both 'cmd' and 'prompt'
      if (!agentCmd) { results.push({ error: `Agent ${i}: missing required field 'cmd'` }); return; }
      const result = agentManager.spawn({ ...p, cmd: agentCmd, paneId: assignments[i] as any, workspaceId });
      if (win && !win.isDestroyed()) setupAgentPtyForwarding(result.surfaceId, win);
      BrowserWindow.getAllWindows().forEach((w) => {
        if (!w.isDestroyed()) {
          w.webContents.send(IPC_CHANNELS.AGENT_UPDATE, {
            type: 'spawned', ...result, paneId: assignments[i], workspaceId, label: p.label,
          });
        }
      });
      results.push(result);
    } catch (err: any) { results.push({ error: err.message }); }
  });
  return results;
}

const windowManager = new WindowManager();

// Closing a window should forget its saved workspaces — otherwise the merged
// session file keeps them and they reappear as a ghost window next launch
// (issue #118). Two cases deliberately do NOT prune: shutdown, and closing the
// *last* window, which is how most people quit wmux and must still persist
// everything for the next launch.
windowManager.onWindowClosed = (id, webContentsId) => {
  clearMarkdownGrants(webContentsId);
  if (isQuitting || windowManager.getCount() === 0) return;
  sessionWindows.forget(id);
  saveSession({ version: 1, windows: sessionWindows.toArray() });
};

// Agent exit → renderer. Without this broadcast, sidebar agent lines would
// pulse "running" forever: agentMeta is only written at spawn, and the old
// 3s agent.list poll that used to sync statuses is gone. Mirrors the
// 'spawned' AGENT_UPDATE emissions above.
agentManager.setOnAgentExit((info) => {
  BrowserWindow.getAllWindows().forEach((w) => {
    if (!w.isDestroyed()) {
      w.webContents.send(IPC_CHANNELS.AGENT_UPDATE, {
        type: 'exited', surfaceId: info.surfaceId, exitCode: info.exitCode,
      });
    }
  });
});

// window.* V2 methods (issue #78) run entirely in the main process against
// windowManager — no renderer bridge involved. Returns true when handled so
// the main dispatch switch can be skipped.
function handleWindowV2(
  method: string,
  params: any,
  respond: (result: any) => void,
  respondError: (code: number, message: string) => void,
): boolean {
  switch (method) {
    case 'window.create':
      // Second OS window — lets users spread workspaces across monitors
      // without a second wmux instance. Same code path as the Ctrl+Shift+N
      // shortcut, just reachable from the CLI/agents.
      respond({ windowId: windowManager.createWindow() });
      return true;
    case 'window.list':
      respond({ windows: windowManager.listWindows() });
      return true;
    case 'window.focus': {
      const id = params?.id || params?.windowId;
      if (!id) { respondError(-32602, 'Missing window id'); return true; }
      windowManager.focusWindow(id);
      respond({ ok: true });
      return true;
    }
    default:
      return false;
  }
}
// Per-instance secret that authenticates privileged (V2) pipe requests.
// Generated/persisted once per APPDATA dir and injected into spawned shells
// as WMUX_PIPE_TOKEN so the CLI and hooks can authenticate.
const pipeToken = ensurePipeToken();
process.env.WMUX_PIPE_TOKEN = pipeToken;
const pipeServer = new PipeServer(getPipePath(), pipeToken);
const portScanner = new PortScanner();
const cdpProxy = new CDPProxy();

// Strip MOTW (Mark of the Web) Zone.Identifier ADS from app directory.
// Windows blocks taskbar pinning and shows security warnings for downloaded files.
// Removing the :Zone.Identifier alternate data stream fixes this transparently.
function stripMotw(): void {
  if (process.platform !== 'win32') return;
  const appDir = path.dirname(process.execPath);
  const stripDir = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stripDir(full);
      } else if (/\.(exe|dll|node|lnk)$/i.test(entry.name)) {
        fs.unlink(full + ':Zone.Identifier', () => {});
      }
    }
  };
  stripDir(appDir);
}

// Auto-save debounce handle
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
// Set on before-quit so the final round of session:save replies is merged
// instead of pruned — during shutdown every window is being destroyed, and
// "forget windows that no longer exist" would erase the whole file (issue #118).
let isQuitting = false;
const AUTO_SAVE_INTERVAL_MS = 30_000;

function scheduleAutoSave(): void {
  if (autoSaveTimer !== null) {
    clearTimeout(autoSaveTimer);
  }
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('session:request');
      }
    });
  }, AUTO_SAVE_INTERVAL_MS);
}

// ─── PTY surface resolution + named-key translation (V2 send_text / send_key) ──
// When no surfaceId is provided, the active surface from the renderer can point
// at a pane without a PTY (markdown / browser). Writing into that silently drops
// the input. Return a clear error instead so callers can react.
async function resolvePtySurface(
  id: string | undefined
): Promise<{ ok: true; id: `surf-${string}` } | { ok: false; error: string }> {
  let surfaceId = id;
  if (!surfaceId) {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return { ok: false, error: 'No window' };
    try {
      surfaceId = await win.webContents.executeJavaScript(
        `window.__wmux_getActiveSurfaceId?.()`
      );
    } catch (err: any) {
      return { ok: false, error: `Could not resolve active surface: ${err.message}` };
    }
    if (!surfaceId) return { ok: false, error: 'No active surface' };
  }
  const branded = surfaceId as `surf-${string}`;
  if (!ptyManager.has(branded)) {
    return {
      ok: false,
      error: `surface ${surfaceId} has no PTY (pane is markdown/browser, or surface was closed). Pass an explicit surfaceId pointing at a terminal surface.`,
    };
  }
  return { ok: true, id: branded };
}

// ─── Prompt log (issue #207) ─────────────────────────────────────────────────
// The log lives in the renderer's store, so `surface.list_prompts` delegates the
// way `surface.read_text` does — but the multi-window rule is NOT the same one,
// which is why these are two named functions rather than one inline loop.
//
// read_text can tell "this window does not own that terminal" from "the screen
// is blank", so it takes the first window that answers without an error. A
// prompt log cannot: a surface with nothing recorded and a surface owned by
// another window both answer with an empty list, and both are honestly "no
// prompts". So the targeted query takes the first NON-EMPTY answer — the surface
// may well be in window 2 (issue #143), and asking only the focused window is
// how that bug ends up describing panes the caller has never seen.

/**
 * Default cap on the UNTARGETED form, per surface.
 *
 * The targeted form stays unlimited: the caller named one pane, and that pane's
 * log is bounded by the store itself (MAX_PROMPTS_PER_SURFACE = 200). The
 * untargeted form multiplies that by every tracked surface, and 64 surfaces x
 * 200 entries x 4000 characters is ~51 MB that has to be serialised out of
 * `executeJavaScript`, merged in main, pushed down the named pipe and then
 * printed by a CLI that gives each entry a line. `surface.read_text` faced the
 * same question and answered it the same way — 50 lines by default rather than
 * the whole scrollback — so an untargeted list with no cap at all was the
 * outlier, not the convention.
 *
 * 20 rather than read_text's 50 because this budget is PER SURFACE and the
 * untargeted caller is asking "which panes have prompts, and what are they
 * working on" — reading one pane's history back is what the targeted form is
 * for. 20 is comfortably more than an orchestration wave puts into a pane, so
 * the common case is not truncated at all, and the worst case lands near 5 MB
 * and ~1300 printed lines instead of 51 MB and ~12800. `--limit` raises it, and
 * the reply says when it bit, because a silent cap reads as "that is all there
 * is".
 */
const DEFAULT_ALL_PROMPTS_LIMIT = 20;

/**
 * The renderer's prompt-preference key, spelled here because main cannot import
 * it: STORAGE_KEYS lives in src/renderer/store/settings-slice.ts, a zustand
 * module. The FILE is shared though — the renderer persists through main into
 * %APPDATA%\wmux\settings.json — so reading it back here is reading the same
 * bytes the renderer wrote, not a second copy of the state.
 */
const PROMPT_PREFS_KEY = 'wmux-prompt-prefs';

/**
 * Is the prompt log switched on at all? (issue #207)
 *
 * With `promptPrefs.enabled` off nothing subscribes to the log, so every
 * surface answers with an empty list — indistinguishable, from the caller's
 * side, from a pane that simply has not been asked anything yet. That is the
 * difference between "this feature is off, go turn it on" and "wait a moment",
 * and an agent cannot act on either without being told which one it is.
 *
 * Absent means on, matching DEFAULT_PROMPT_PREFS: the block only exists on disk
 * once the user has touched the settings panel, so treating a missing blob as
 * "disabled" would report the feature off for everyone who never opened it.
 * Only an explicit `false` counts.
 *
 * Read off disk per call rather than cached. This is a CLI-driven path that
 * runs at human frequency, and the alternative is a cached copy that goes stale
 * the moment the user flips the toggle — which is precisely when the answer
 * matters.
 */
function promptLogEnabled(): boolean {
  const prefs = loadSettings()[PROMPT_PREFS_KEY];
  return !(prefs && typeof prefs === 'object' && (prefs as Record<string, unknown>).enabled === false);
}

/** Most recent `limit` entries, and whether keeping only those dropped any. */
function tailOf(list: any[], limit: number): { entries: any[]; truncated: boolean } {
  if (limit > 0 && list.length > limit) return { entries: list.slice(-limit), truncated: true };
  return { entries: list, truncated: false };
}

function liveWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
}

/**
 * A surface's prompts, or null when NO window had anything for it.
 *
 * Null is not "empty" — it is "nobody answered", which is the point at which
 * the caller still has three possibilities open and has to go and narrow them
 * down (see the case handler). Returning `[]` here is what collapsed them.
 */
async function promptsForSurface(surfaceId: string, limit: number): Promise<{ prompts: any[]; truncated: boolean } | null> {
  const script = `window.__wmux_listPrompts?.(${JSON.stringify(surfaceId)})`;
  for (const win of liveWindows()) {
    const answer = await win.webContents.executeJavaScript(script);
    if (Array.isArray(answer) && answer.length > 0) {
      const { entries, truncated } = tailOf(answer, limit);
      return { prompts: entries, truncated };
    }
  }
  return null;
}

/**
 * Does this surface exist in any window at all?
 *
 * Asked ONLY after every window has answered the prompt query with nothing, so
 * the happy path still costs one `executeJavaScript` per window and this is
 * paid exclusively by the case that is about to be reported as empty. Ordering
 * it that way also settles a race in the caller's favour: a surface that has
 * prompts is answered from its prompts, even if it is being torn down as we
 * ask, rather than being declared missing.
 *
 * `__wmux_locateSurface` and not the prompt store: a closed surface's log is
 * deleted with it, so "no entry in the log" and "no such surface" have to be
 * distinguished by something that outlives neither — the split tree.
 */
async function surfaceExists(surfaceId: string): Promise<boolean> {
  const script = `!!window.__wmux_locateSurface?.(${JSON.stringify(surfaceId)})`;
  for (const win of liveWindows()) {
    if (await win.webContents.executeJavaScript(script) === true) return true;
  }
  return false;
}

/**
 * Every tracked surface, MERGED across windows rather than read off the first
 * one that replies: with no surfaceId the caller is asking a question about the
 * app ("which panes have prompts?"), and each window keeps its own store.
 *
 * `truncated` is one flag for the whole reply rather than one per surface. The
 * question it answers is "is there more than this?", which the CLI turns into a
 * single footer line; a per-surface breakdown would be more precise about
 * something no caller has to act on differently.
 */
async function promptsForAllSurfaces(limit: number): Promise<{ surfaces: Record<string, any[]>; truncated: boolean }> {
  const surfaces: Record<string, any[]> = {};
  let truncated = false;
  for (const win of liveWindows()) {
    const answer = await win.webContents.executeJavaScript('window.__wmux_listPrompts?.()');
    for (const [id, list] of Object.entries(answer ?? {})) {
      if (!Array.isArray(list) || list.length === 0) continue;
      const tail = tailOf(list, limit);
      surfaces[id] = tail.entries;
      truncated = truncated || tail.truncated;
    }
  }
  return { surfaces, truncated };
}

// Named-key → raw PTY input translation. Fallback rules:
//   - length === 1            → literal character (covers Ctrl+letter flow).
//   - known multi-char name   → translated to real control/escape bytes.
//   - unknown multi-char name → null (caller returns -32602 invalid params).
const PTY_KEY_MAP: Record<string, string> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  esc: '\x1b',
  escape: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  space: ' ',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-u': '\x15',
  'ctrl-l': '\x0c',
  'ctrl-a': '\x01',
  'ctrl-e': '\x05',
  'ctrl-k': '\x0b',
  'ctrl-w': '\x17',
  'ctrl-r': '\x12',
  'ctrl-z': '\x1a',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS',
  f5: '\x1b[15~', f6: '\x1b[17~', f7: '\x1b[18~', f8: '\x1b[19~',
  f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~',
};
function translateKeyName(key: string, shift: boolean): string | null {
  if (key.length === 1) return shift ? key.toUpperCase() : key;
  const normalized = key.toLowerCase();
  if (normalized in PTY_KEY_MAP) return PTY_KEY_MAP[normalized];
  return null;
}

/**
 * Deliver an answer from `pane.answer_agent` into the pane (issue #128).
 *
 * Wired here rather than in agent-state-rpc.ts because this is where both
 * halves already live: the PTY manager, and the named-key table that
 * `surface.send_key` uses. Sharing that table is the point — a choice declaring
 * `key: "enter"` must reach the terminal as exactly the same bytes it would if
 * the user had asked wmux to send that key by hand, or the back-channel becomes
 * a second, subtly different way to type.
 *
 * An unknown key name throws rather than falling back to writing the name as
 * literal text: silently typing "enter" into a permission prompt would answer
 * the wrong thing.
 */
setAnswerWriter(async (surfaceId, payload) => {
  const resolved = await resolvePtySurface(surfaceId);
  if (!resolved.ok) throw new Error(resolved.error);
  if (payload.key !== undefined) {
    const translated = translateKeyName(payload.key, false);
    if (translated === null) throw new Error(`the agent declared an unknown key name: "${payload.key}"`);
    ptyManager.write(resolved.id, translated);
    return;
  }
  ptyManager.write(resolved.id, payload.text ?? '');
});

// Set Windows AppUserModelId so taskbar pinning uses the correct icon & identity
app.setAppUserModelId('com.wmux.app');

// Auto-strip MOTW on startup so users never see security warnings or pinning failures
stripMotw();

// Single-instance lock (issue #32). Outside a wmux-spawned shell, `wmux` on PATH
// resolves to the GUI exe rather than the CLI, so `wmux browser open <url>` (and
// any stray re-launch) would otherwise spawn a SECOND window and ignore its args.
// Holding the lock makes the second launch hand off to the running instance,
// which just focuses its window. Named instances (WMUX_INSTANCE) point Electron's
// userData at their own dir so the lock is per-instance and dev/prod still coexist.
if (process.env.WMUX_INSTANCE?.trim()) {
  app.setPath('userData', getAppDataDir());
}
const gotInstanceLock = app.requestSingleInstanceLock();

/**
 * Open a folder as a new workspace, for the Explorer context-menu verb
 * ("Open in wmux" — see shell-context-menu.ts, which registers
 * `"wmux.exe" "%V"`).
 *
 * Routed through the same `__wmux_createWorkspace` bridge the CLI's
 * `new-workspace --cwd` uses, so Explorer, the CLI and the UI all land on one
 * store action rather than a fourth way to make a workspace.
 */
async function openDirectoryAsWorkspace(dirPath: string): Promise<void> {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  try {
    await win.webContents.executeJavaScript(
      `window.__wmux_createWorkspace?.(${JSON.stringify({ title: path.basename(dirPath) || dirPath, cwd: dirPath })})`,
    );
  } catch {
    // Renderer not ready or bridge missing — the window is still up, which is
    // better than failing the launch outright.
  }
}

const isDirectory = (p: string): boolean => fs.statSync(p).isDirectory();

if (!gotInstanceLock) {
  app.quit();
} else {
  // Explorer launches `wmux.exe "C:\folder"`. With the single-instance lock held
  // that becomes a second-instance event on the RUNNING window, carrying the new
  // process's argv — so the folder has to be read from the event, not from our
  // own process.argv, which still holds the original launch.
  app.on('second-instance', (_event, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const dir = directoryFromArgv(argv, isDirectory);
    if (dir) void openDirectoryAsWorkspace(dir);
  });
}

// ─── Webview / navigation hardening (issue #9) ────────────────────────────────
// The renderer hosts <webview> tags that load arbitrary web content. Lock down
// the attack surface so a compromised/hostile page can't escalate:
//  - strip Node integration & preload from attached webviews
//  - block window.open popups (route http/https to the OS browser instead)
//  - prevent the top-level app window from navigating away from its own UI
function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    const type = contents.getType();

    if (type === 'webview') {
      // Enforce safe webview preferences regardless of attributes set in the DOM.
      contents.on('will-attach-webview', (_e, webPreferences, params) => {
        delete (webPreferences as any).preload;
        delete (webPreferences as any).preloadURL;
        webPreferences.nodeIntegration = false;
        webPreferences.contextIsolation = true;
        (params as any).nodeintegration = 'false';
      });
    }

    // Open new-window requests externally rather than spawning in-app windows
    // with full privileges. Only http/https go to the OS browser; deny the rest.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    // The main app window (loads localhost in dev, file:// in prod) must never
    // be navigated to remote content. Webviews host their own contents and are
    // exempt — their navigation is the whole point.
    if (type !== 'webview') {
      contents.on('will-navigate', (e, url) => {
        const isDevServer = url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:');
        const isLocalFile = url.startsWith('file://');
        if (!isDevServer && !isLocalFile) {
          e.preventDefault();
          if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
        }
      });
    }
  });
}

// Lifecycle truth for sidebar agent lines: hooks, not output parsing, decide
// when agents are finished (spec 2026-07-22, issue #81 class). SubagentStop
// marks a single parallel subagent done; Stop marks the whole surface done.
function applyHookLifecycle(params: any): void {
  const sid = params?.surfaceId as SurfaceId | undefined;
  if (!sid) return;
  if (params.event === 'SubagentStop') markSubagentStop(sid);
  else if (params.event === 'Stop') markAllAgentsDone(sid);
}

/** Edit/Write hooks refresh the diff view; delays let the DiffPane mount first. */
function pushDiffUpdate(file: string): void {
  // Stagger updates: 500ms for immediate feedback, 2s to catch slower writes.
  for (const delay of [500, 2000]) {
    setTimeout(() => {
      BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.DIFF_UPDATE, { file });
      });
    }, delay);
  }
}

/** One Claude Code hook event, fanned out to every consumer that wants it. */
function handleHookEvent(params: any): void {
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.HOOK_EVENT, params);
  });
  applyHookLifecycle(params);

  // Same events, second consumer: declared agent run state (issue #128). This
  // is what makes "which pane is parked on me?" work for Claude Code with no
  // plugin to install — wmux already registers these hooks.
  // The event is resolved, not read straight off the payload: the per-tool
  // PostToolUse entries invoke the hook helper by bare tool name, so they arrive
  // with a `tool` and no `event` at all — and gating on `params.event` dropped
  // every one of them. See hookEventName for what that costs.
  const hookEvent = hookEventName(params);
  if (params?.surfaceId && hookEvent) {
    applyHookToAgentState(
      params.surfaceId as SurfaceId,
      hookEvent,
      params.message ?? null,
      Number.isFinite(params.at) ? Number(params.at) : undefined,
    );
  }

  // Third consumer: the resumable session handle (issue #186). Every Claude
  // Code hook payload carries session_id, and since wmux registers those hooks
  // this arrives with no plugin to install and no extra process — the same
  // reason the declared-state path above works. reportAgentSession validates.
  //
  // Deliberately NOT gated on a resolved `hookEvent`: a per-tool PostToolUse
  // arrives with a `tool` and no `event`, and those are the majority of hooks a
  // working session fires. Gating on it is the mistake `hookEventName` exists to
  // document, and would have meant only ever learning an id from a Stop.
  //
  // SessionEnd is the one event that must NOT record an id. It carries a
  // session_id like every other hook, but `applyHookToAgentState` above has
  // just called `releaseAgent()` for it — recording here would re-create the
  // record microseconds later and hand the next restore a conversation the user
  // deliberately quit. "Exit Claude, restart wmux, get a plain shell" is the
  // behaviour #186 asked to keep, and this ordering is the only thing enforcing it.
  if (params?.surfaceId && params?.sessionId && hookEvent !== 'SessionEnd') {
    reportAgentSession(params.surfaceId as SurfaceId, { sessionId: String(params.sessionId) });
  }

  // Always refresh the diff for Edit/Write, even without a file path — but only
  // once the write has happened. PreToolUse carries the same tool name and fires
  // BEFORE it, so refreshing on that would render the diff as it was (issue #151).
  const isPost = !params?.event || params.event === 'PostToolUse';
  if (isPost && (params?.tool === 'Edit' || params?.tool === 'Write')) pushDiffUpdate(params.file || '');
}

// ─── Claude session restore (issue #186) ─────────────────────────────────────

type SavedWindow = SessionData['windows'][number];

/**
 * Bake each terminal's live Claude session id into the copy of the tree that is
 * about to be written, the way `freezeSurfaceCwds` bakes cwd (issue #134).
 *
 * Mutates the window state in place because that state is already a
 * renderer-supplied object on its way to `sessionWindows`; a fresh copy here
 * would have to be threaded through both save paths for no benefit.
 */
function stampWindowClaudeSessions(state: SavedWindow | undefined): void {
  if (!state?.workspaces) return;
  for (const ws of state.workspaces) {
    ws.splitTree = stampClaudeSessionIds(ws.splitTree, (id) => getAgentState(id)?.sessionId);
  }
}

/**
 * Drop ids whose transcript Claude no longer has, before restore turns them
 * into `claude --resume` on a command line.
 *
 * The transcript index is read ONCE for the whole restore rather than per
 * surface: `~/.claude/projects` is one directory per project and the scan is
 * cheap, but doing it inside the walk would re-list every project directory for
 * every pane, and `create()` is already on the synchronous startup path that
 * #176 was about.
 */
function pruneRestoredClaudeSessions(windows: SavedWindow[]): void {
  if (windows.length === 0) return;
  const known = listKnownTranscriptIds();
  if (!known) return; // Claude not installed / unreadable — keep everything.
  let dropped = 0;
  for (const state of windows) {
    for (const ws of state.workspaces ?? []) {
      const result = pruneDeadClaudeSessions(ws.splitTree, known);
      ws.splitTree = result.tree;
      dropped += result.dropped;
    }
  }
  if (dropped > 0) {
    console.log(`[claude-resume] dropped ${dropped} session id(s) with no transcript`);
  }
}

app.whenReady().then(() => {
  // A losing second instance is already quitting; don't run startup side effects.
  if (!gotInstanceLock) return;

  // First line of the run, so a crash report can state what this process was
  // rather than infer it (#150). `guard` in particular: whether the node-pty
  // exit-callback guard actually attached was a design claim nobody could
  // check against a process that had already died.
  logDiagnostic('start', {
    version: app.getVersion(),
    electron: process.versions.electron,
    guard: isPtyCrashGuardInstalled(),
  });

  hardenWebContents();

  // Find out whether PowerShell will run the .ps1 shim before the renderer asks
  // for its first PTY (issue #154). Unawaited on purpose: the answer only
  // decides one PATH entry, and a pane that wins the race just gets the old
  // wmux.cmd behaviour rather than a slower startup for everyone.
  ensurePowerShellShim().catch(() => {});

  // IPC: renderer pushes session state (auto-save response or explicit save).
  // Every window answers the same broadcast, each with a one-entry `windows`
  // array describing itself. Merging them through the registry is what stops
  // the last responder from overwriting every other window's workspaces —
  // before this, a second window silently cost you the first one's tabs and
  // browser pages on the next 30s tick (issue #118).
  ipcMain.on('session:save', (event, data: SessionData) => {
    const state = data?.windows?.[0];
    if (!state) return;
    // Before anything downstream copies this tree (issue #186).
    stampWindowClaudeSessions(state);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      // Persist the maximized flag and the *normal* (pre-maximize) rectangle so a
      // relaunch can re-maximize on the right monitor and un-maximize sanely (issue #57).
      state.maximized = win.isMaximized();
      state.bounds = win.getNormalBounds();
    }

    const windowId = windowManager.idForWebContents(event.sender);
    if (windowId) {
      sessionWindows.update(windowId, state);
      // Forget windows the user closed — but never while quitting, when every
      // window is being torn down and pruning would erase what we're saving.
      if (!isQuitting) {
        sessionWindows.retainOnly(windowManager.getAllWindows().map((w) => w.id));
      }
      saveSession({ version: 1, windows: sessionWindows.toArray() });
    } else {
      // Unattributable sender (a window created outside WindowManager). Better
      // to persist its state alone than to drop the save entirely.
      saveSession({ version: 1, windows: [state] });
    }
    scheduleAutoSave();
  });

  registerIpcHandlers(windowManager, cdpProxy);

  // Tree-kill whatever a previously CRASHED instance left running (issue #139).
  // `will-quit` — the only thing that calls killAll() — does not run on a crash,
  // and Windows does not tear down a process tree when its root dies, so every
  // pane's shell, its agent and that agent's MCP servers survive. Restoring the
  // session below then spawns a fresh set beside them, so without this a
  // crash-loop multiplies processes instead of replacing them.
  //
  // Runs before the restore for tidiness only: the orphans are unrelated to the
  // PTYs about to be created, and the reap itself is async and unawaited so
  // startup never blocks on it.
  reapOrphanedPtys();

  // The agent-browser half of the same problem. A crashed wmux leaves its
  // sessions' Chromes resident for exactly the reason its PTY subtrees survive
  // above, and the in-memory SessionRegistry starts empty, so those survivors
  // are invisible to this process — ground truth is `agent-browser session
  // list`. Sessions are ephemeral by design, so every `wmux-` session with no
  // live surface is garbage; nothing without that prefix is ever touched.
  //
  // Unawaited, and it exits immediately when agent-browser is not installed, so
  // a machine that has never used the feature pays one function call. Ordered
  // before the restore below for the same tidiness reason the PTY reap is —
  // and `reconcileOrphanSessions` re-checks the registry immediately before
  // each close, so a pane restored into agent mode while the list is in flight
  // cannot be swept up by it.
  reconcileOrphanSessions(agentBrowserTeardownDeps).catch((err: Error) => {
    console.warn('[wmux] agent-browser session reconcile failed:', err?.message);
  });

  // Clear stale session data on version change (clean start for upgrades/fresh installs)
  handleVersionChange(app.getVersion());

  // Reopen every window the last session had, not just the first (issue #118).
  // Each gets its own slot in the registry so its renderer restores its own
  // workspaces — `SESSION_LOAD_AUTO` used to hand windows[0] to whoever asked,
  // which made a second window a clone of the first.
  //
  // These are also the only windows allowed to fall back to the newest *named*
  // session when they have no slot: a window opened later in the run must come
  // up empty instead of cloning one, which would duplicate its surface ids —
  // and PTY id is surface id, so the clone would attach to live PTYs (#143).
  const savedSession = loadSession();
  const savedWindows = (savedSession?.windows ?? []).slice(0, MAX_RESTORED_WINDOWS);
  pruneRestoredClaudeSessions(savedWindows);
  if (savedWindows.length === 0) {
    sessionWindows.markStartup(windowManager.createWindow());
  } else {
    for (const saved of savedWindows) {
      const id = windowManager.createWindow(saved.bounds, saved.maximized);
      sessionWindows.prime(id, saved);
      sessionWindows.markStartup(id);
    }
  }

  // Everything wmux writes into ~/.claude and ~/.config/opencode now runs behind
  // a stored consent decision, and asks for one on first launch (issue #132).
  //
  // Placed AFTER the windows exist, for two reasons. The prompt is a modal
  // dialog, and an ownerless one opens with nothing behind it — a question about
  // an app the user cannot yet see. And it is deliberately not awaited: startup
  // must not block on an answer, so the rest of the launch proceeds and the
  // integration lands whenever the user gets to it.
  void initAgentIntegration(BrowserWindow.getAllWindows()[0]);

  // Cold launch from the Explorer verb: no instance was running, so there is no
  // second-instance event — the folder is in our own argv. Wait for the renderer
  // to finish loading, otherwise the __wmux_* bridge is not defined yet and the
  // folder is silently dropped.
  const launchDir = directoryFromArgv(process.argv, isDirectory);
  if (launchDir) {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.once('did-finish-load', () => {
        void openDirectoryAsWorkspace(launchDir);
      });
    }
  }

  // Initialize auto-updater only when packaged (avoids errors in dev)
  if (app.isPackaged) {
    initAutoUpdater();
    initUpdateChecker();
  }

  // Late-mounted windows query the cached latest update info so the badge
  // appears even if the GitHub poll fired before the window's renderer attached.
  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_LATEST, () => getLatestUpdate());
  // Badge click — download + install in place; the renderer falls back to the
  // release page when this says it can't (issue #125).
  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () => requestUpdateNow());
  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_STATE, () => getUpdateState());
  ipcMain.on(IPC_CHANNELS.UPDATE_OPEN_RELEASE, (_event, url: string) => {
    // Whitelist GitHub release URLs so a hostile renderer can't pivot this
    // channel into an arbitrary openExternal sink.
    if (typeof url === 'string' && /^https:\/\/github\.com\//.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
  });

  // Kick off the first auto-save cycle after the window is ready
  scheduleAutoSave();

  // Start named pipe server
  pipeServer.start();
  cdpProxy.start().catch(() => {}); // CDP proxy is optional — don't crash if ports are busy

  // Watch TMPDIR for wmux-orchestrator runs and push state to the sidebar.
  startOrchestrationWatcher();

  portScanner.onResults((portsByPid) => {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.METADATA_UPDATE, {
          command: 'ports_update',
          surfaceId: '',
          args: [JSON.stringify(Object.fromEntries(portsByPid))],
        });
      }
    });
  });

  /**
   * Tell every window which agent a surface is running.
   *
   * The payload is `{ surfaceId, kind, source }` and nothing else. The command
   * line the kind was derived from stays in this process — see the note on the
   * v1 forwarding guard below.
   */
  function broadcastAgentIdentity(surfaceId: string): void {
    const identity = agentIdentity.identify(surfaceId);
    const payload = { surfaceId, kind: identity?.kind ?? null, source: identity?.source ?? null };
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.AGENT_IDENTITY, payload);
    });
  }

  /**
   * Apply one shell-integration report to the main-process trackers.
   *
   * Split out of the v1 handler because two independent consumers now read the
   * same two reports — ssh-detect and agent-identity, for the same reason:
   * Windows has no tty foreground process group, so "what is this pane running"
   * has to be told to us rather than asked of the OS. `cmd.args` is mutated in
   * place for the shell-state case, which is why this stays a statement
   * sequence rather than becoming a pure function.
   */
  function applySurfaceReport(cmd: { command: string; surfaceId?: string; args: string[] }): void {
    const surfaceId = cmd.surfaceId;
    if (!surfaceId) return;

    // The preexec hook reporting the command the pane just ran. This is what
    // makes a hand-typed `ssh host` — or `claude` — detectable the instant it
    // is submitted, rather than one background process sweep later.
    if (cmd.command === 'report_command') {
      const raw = cmd.args[0] ?? '';
      sshDetector.reportCommand(surfaceId, raw);
      // A pane may have just become remote, so make sure the probe is awake to
      // back the report up (and to notice when that ssh exits).
      sshDetector.start();

      const { sequence, rest } = splitSequencedReport(raw);
      agentIdentity.reportCommand(surfaceId, rest, sequenceFrom(sequence));
      broadcastAgentIdentity(surfaceId);
      return;
    }

    if (cmd.command === 'report_pwd') {
      sshDetector.reportCwd(surfaceId, cmd.args[0] ?? '');
      // Second consumer of the same report: the explorer panel's tree root
      // resolves from the cwd a shell declares, the same one ssh-detect reads.
      // One report, two readers — not two mechanisms that can disagree about
      // where a pane is.
      reportExplorerCwd(surfaceId, cmd.args[0] ?? '');
      return;
    }

    // Back at a prompt: whatever was running has exited, so both the ssh
    // session and the agent the preexec hook reported are over.
    if (cmd.command === 'report_shell_state') {
      const sequenced = /^seq=\d+$/.test(cmd.args[0] ?? '');
      const state = cmd.args[sequenced ? 1 : 0] ?? '';
      const rawSequence = sequenced ? cmd.args[0] : undefined;
      if (state !== 'running') {
        sshDetector.clearReported(surfaceId, rawSequence);
        // `sequenceFrom`, not `splitSequencedReport`: here the marker is the
        // WHOLE argument (`seq=7`), and splitSequencedReport deliberately reads
        // a bare marker with no payload as a payload.
        agentIdentity.clearReported(surfaceId, sequenceFrom(rawSequence));
        broadcastAgentIdentity(surfaceId);
      }
      // The renderer's metadata protocol remains [state]; sequencing is a
      // main-process implementation detail used only by these two detectors.
      if (sequenced) cmd.args = [state];
    }
  }

  pipeServer.on('v1', (cmd) => {
    // Trigger port scan when requested from shell integration
    if (cmd.command === 'ports_kick') {
      portScanner.kick();
    }
    if (cmd.surfaceId) applySurfaceReport(cmd);

    // Forward metadata updates to all windows.
    //
    // `report_command` is deliberately NOT forwarded: its consumers are the ssh
    // detector and the agent-identity tracker, both in THIS process, and its
    // payload is the full command line of everything the user types — which
    // routinely carries secrets (`curl -H 'Authorization: …'`, a psql URL with
    // a password). No renderer code reads it, so broadcasting it would push
    // credentials into a web context for nothing. The agent LABEL derived from
    // it does cross, on its own channel; the command line never does.
    if (cmd.command === 'report_command') return;
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.METADATA_UPDATE, cmd);
      }
    });
  });

  pipeServer.on('v2', (request, respond, respondError) => {
    // Browser commands (per-caller isolated routing, #62) and uniform
    // renderer-bridge methods are handled in their own modules.
    if (routeSpecialV2(request, respond, respondError)) return;

    switch (request.method) {
      case 'system.identify':
        respond({ name: 'wmux', version: app.getVersion(), platform: 'win32' });
        break;
      case 'system.capabilities':
        respond({ protocols: ['v1', 'v2'], features: ['workspaces', 'splits', 'notifications'] });
        break;
      // workspace.* and pane.split/close handled by handleBridgeV2 (./v2-bridge).
      // window.* handled by handleWindowV2 above.
      case 'pane.focus': {
        // Focus the first surface in the specified pane
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) { respondError(-32000, 'No window'); return; }
            // Get pane's first surface and focus it
            const panes = await win.webContents.executeJavaScript(
              `window.__wmux_listPanes?.(${JSON.stringify(request.params?.workspaceId)})`
            );
            const pane = (panes || []).find((p: any) => p.paneId === (request.params?.id || request.params?.paneId));
            if (pane && pane.surfaces.length > 0) {
              await win.webContents.executeJavaScript(
                `window.__wmux_focusSurface?.(${JSON.stringify(pane.surfaces[0].id)})`
              );
            }
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'pane.zoom': {
        // Zoom toggles are UI-only; acknowledge for now
        respond({ ok: true, note: 'Zoom toggle is a renderer-only action' });
        break;
      }
      // pane.list, layout.grid, system.tree, surface.create/close/focus/list
      // handled by handleBridgeV2 (./v2-bridge).
      case 'surface.set_color_scheme': {
        // Per-pane color scheme override (issue #4). Pass `scheme: null` to clear.
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) { respondError(-32000, 'No window'); return; }
            const surfaceId = request.params?.surfaceId || request.params?.id;
            const scheme = request.params?.colorScheme ?? request.params?.scheme ?? null;
            if (!surfaceId) { respondError(-32602, 'surfaceId required'); return; }
            const result = await win.webContents.executeJavaScript(
              `window.__wmux_setSurfaceColorScheme?.(${JSON.stringify(surfaceId)}, ${JSON.stringify(scheme)})`
            );
            respond(result || { ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'theme.list': {
        // Report available color schemes so the CLI / external tools can discover
        // valid `--color-scheme` values without touching the filesystem.
        (async () => {
          try {
            const { loadBundledThemes } = await import('./theme-loader');
            const bundled = loadBundledThemes();
            const names = ['Monokai', ...Array.from(bundled.keys())];
            respond({ themes: Array.from(new Set(names)).sort((a, b) => a.localeCompare(b)) });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'config.get': {
        // Expose the current ~/.wmux/config.toml state (incl. parse errors).
        (async () => {
          try {
            const { loadUserConfig } = await import('./user-config');
            respond(loadUserConfig());
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'locales.get': {
        // What ~/.wmux/locales currently yields, including the reasons any file
        // was rejected — a translator's only feedback loop (issue #147).
        (async () => {
          try {
            const { loadUserLocales } = await import('./user-locales');
            const result = loadUserLocales();
            respond({
              dir: result.dir,
              errors: result.errors,
              locales: result.locales.map((l) => ({
                code: l.code,
                label: l.label,
                strings: Object.keys(l.strings).length,
                path: l.path,
              })),
            });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'config.reload': {
        // Re-read ~/.wmux/config.toml and live-apply to every open window.
        (async () => {
          try {
            const { loadUserConfig, resetConfigWarnings } = await import('./user-config');
            const { loadUserLocales } = await import('./user-locales');
            // A reload is the user saying "I have edited it" — so re-report the
            // problems the file still has rather than staying quiet because the
            // pre-edit version already warned about them.
            resetConfigWarnings();
            // Same contract as the IPC path: one reload covers all of ~/.wmux,
            // including community translations (issue #147).
            const cfg = { ...loadUserConfig(), locales: loadUserLocales() };
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) {
                win.webContents.send('config:userConfigUpdated', cfg);
              }
            }
            respond(cfg);
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      // ─── Terminal I/O V2 handlers ─────────────────────────────────────────
      case 'surface.send_text': {
        (async () => {
          try {
            const surfaceId = await resolvePtySurface(request.params?.surfaceId || request.params?.id);
            if (!surfaceId.ok) { respondError(-32000, surfaceId.error); return; }
            ptyManager.write(surfaceId.id, request.params?.text || '');
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'surface.send_key': {
        (async () => {
          try {
            let key = request.params?.key || '';
            const mods: string[] = request.params?.modifiers || [];
            const hasCtrl = mods.includes('ctrl') || request.params?.ctrl;
            const hasAlt = mods.includes('alt') || request.params?.alt;
            const hasShift = mods.includes('shift') || request.params?.shift;

            // Translate named keys to control bytes / ANSI escape sequences.
            // Fallback: length-1 key is treated as literal (Ctrl+letter stays); unknown multi-char → error.
            const translated = translateKeyName(key, hasShift);
            if (translated === null) {
              respondError(-32602, `unknown key name: "${key}" (use one of: enter, tab, esc, backspace, delete, up, down, left, right, home, end, pageup, pagedown, f1..f12, or a single character)`);
              return;
            }
            key = translated;

            if (hasCtrl && key.length === 1) {
              const upper = key.toUpperCase();
              const code = upper.charCodeAt(0) - 64;
              if (code > 0 && code < 27) key = String.fromCharCode(code);
            }
            if (hasAlt) key = '\x1b' + key;

            const surfaceId = await resolvePtySurface(request.params?.surfaceId || request.params?.id);
            if (!surfaceId.ok) { respondError(-32000, surfaceId.error); return; }
            ptyManager.write(surfaceId.id, key);
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'surface.read_text': {
        // Screen content lives in the renderer (xterm owns the buffer), so
        // delegate to the __wmux_readScreen bridge global. It reads the ACTIVE
        // buffer — alt buffer included — so full-screen TUIs return what is
        // actually visible, as plain text (no ANSI escapes).
        (async () => {
          try {
            const surfaceId = await resolvePtySurface(request.params?.surfaceId || request.params?.id);
            if (!surfaceId.ok) { respondError(-32000, surfaceId.error); return; }
            const rawLines = Number(request.params?.lines);
            const lines = Number.isFinite(rawLines)
              ? Math.min(Math.max(Math.floor(rawLines), 1), 10000)
              : 50;
            // The surface's terminal is mounted in exactly one window; probe
            // each until one has it, keeping the first miss as the error.
            let result: { text?: string; error?: string } | null = null;
            for (const win of BrowserWindow.getAllWindows()) {
              if (win.isDestroyed()) continue;
              const r = await win.webContents.executeJavaScript(
                `window.__wmux_readScreen?.(${JSON.stringify(surfaceId.id)}, ${lines})`
              );
              if (r && !r.error) { result = r; break; }
              if (r && !result) result = r;
            }
            if (!result) { respondError(-32000, 'No window'); return; }
            if (result.error) { respondError(-32000, result.error); return; }
            respond(result);
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'surface.list_prompts': {
        // What has this pane been asked to do? (issue #207) The answer an agent
        // cannot get any other way: `surface.read_text` returns whatever the TUI
        // is painting now, and a repaint destroys the prompt text permanently.
        //
        // No PTY check and no active-surface fallback, unlike read_text: an
        // empty log is a legitimate answer here, so refusing a surface that has
        // no terminal would turn "nothing recorded" into an error, and guessing
        // at the focused surface would answer about a pane the caller never
        // named. Without a surfaceId the caller gets every tracked pane instead.
        //
        // "Empty" used to be three different situations wearing one answer: the
        // prompt log switched off, a surface id that names nothing, and a pane
        // that genuinely has not been asked anything yet. Each wants a different
        // next move from the caller — turn the feature on, fix the id, wait —
        // and each is now reported as its own thing, following what the sibling
        // methods already do rather than inventing a fourth convention. An
        // unknown surface is a -32000 error the way `surface.read_text` and
        // `workspace.current` report one; `enabled: false` rides along with the
        // (still empty, still same-shaped) result, because a disabled log is a
        // successful answer to the question and not a failure.
        (async () => {
          try {
            const surfaceId: string = request.params?.surfaceId || request.params?.id || '';
            const rawLimit = Number(request.params?.limit);
            const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.floor(rawLimit) : 0;
            if (liveWindows().length === 0) { respondError(-32000, 'No window'); return; }
            const enabled = promptLogEnabled();
            if (surfaceId) {
              const hit = await promptsForSurface(surfaceId, limit);
              if (hit) { respond({ surfaceId, prompts: hit.prompts, truncated: hit.truncated, enabled }); return; }
              if (!(await surfaceExists(surfaceId))) {
                respondError(-32000, `surface ${surfaceId} not found (closed, or never existed). Pass an id from \`wmux list-surfaces\`.`);
                return;
              }
              respond({ surfaceId, prompts: [], truncated: false, enabled });
              return;
            }
            // Only the untargeted form gets a default cap — see
            // DEFAULT_ALL_PROMPTS_LIMIT. `limit` is echoed back so the caller
            // knows which number produced the reply without having to know ours.
            const effective = limit || DEFAULT_ALL_PROMPTS_LIMIT;
            const all = await promptsForAllSurfaces(effective);
            respond({ surfaces: all.surfaces, truncated: all.truncated, limit: effective, enabled });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }
      case 'surface.trigger_flash': {
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) {
            w.webContents.send(IPC_CHANNELS.NOTIFICATION_FIRE, {
              surfaceId: request.params?.surfaceId,
              text: 'Flash triggered via CLI',
            });
          }
        });
        respond({ ok: true });
        break;
      }

      // ─── Markdown V2 handlers ─────────────────────────────────────────────
      // markdown.set_content handled by handleBridgeV2 (./v2-bridge).
      case 'markdown.load_file': {
        (async () => {
          try {
            const requested = request.params?.filePath || request.params?.path || request.params?.file;
            if (!requested) { respondError(-32000, 'No file path provided'); return; }
            // Defense-in-depth: even with a valid pipe token, only render plain
            // text/markdown files and cap the size, so this can't be used to
            // slurp secrets (e.g. id_rsa, .env) into the markdown viewer. The
            // guards live in ./markdown-file so every entry point shares them.
            //
            // Normalize to an absolute path before handing it to the renderer:
            // a path-aware surface (issue #116) has to show and reload something
            // unambiguous. The CLI already resolves against the caller's cwd
            // (src/cli/wmux.ts), so this only normalizes; a raw pipe client that
            // sends a relative path gets the same main-cwd resolution fs would
            // have applied anyway, just made explicit and visible in the pane.
            const filePath = path.resolve(requested);
            const read = readMarkdownFile(filePath);
            if ('error' in read) {
              respondError(-32602, `markdown.load_file: ${read.error}`);
              return;
            }
            const win = BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) { respondError(-32000, 'No window'); return; }
            // This method is token-gated, so the caller is an authenticated
            // client that deliberately opened this file — the same standard as
            // a native dialog, and enough to allow editing it back (F3).
            grantMarkdownPath(win.webContents.id, filePath);
            await win.webContents.executeJavaScript(
              `window.__wmux_setMarkdownContent?.(${JSON.stringify(request.params?.surfaceId || '')}, ${JSON.stringify(read.content)}, ${JSON.stringify(path.basename(filePath))}, ${JSON.stringify(filePath)}, ${JSON.stringify(read.mtimeMs)})`
            );
            respond({ ok: true, length: read.content.length, filePath });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      // ─── Notification V2 handlers ─────────────────────────────────────────
      // notification.list handled by handleBridgeV2 (./v2-bridge).
      case 'notification.clear': {
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) { respondError(-32000, 'No window'); return; }
            if (request.params?.all) {
              await win.webContents.executeJavaScript(
                `window.__wmux_clearAllNotifications?.()`
              );
            } else {
              await win.webContents.executeJavaScript(
                `window.__wmux_clearNotification?.(${JSON.stringify(request.params?.id || '')})`
              );
            }
            respond({ ok: true });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      // ─── Workspace status handler ─────────────────────────────────────────
      case 'workspace.set_status': {
        // Set a named workspace's sidebar status by id (e.g. an orchestration
        // coordinator marking a workspace idle when all waves finish). Keyed on
        // workspaceId, not surfaceId, so it works from outside any pane.
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) {
            w.webContents.send(IPC_CHANNELS.METADATA_UPDATE, {
              command: 'set_workspace_status',
              workspaceId: request.params?.workspaceId,
              args: [request.params?.state || '', request.params?.text || ''],
            });
          }
        });
        respond({ ok: true });
        break;
      }

      // ─── Sidebar V2 handlers ──────────────────────────────────────────────
      case 'sidebar.set_status': {
        // Forward as metadata update to renderer
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) {
            w.webContents.send(IPC_CHANNELS.METADATA_UPDATE, {
              command: 'status',
              surfaceId: request.params?.surfaceId,
              args: [request.params?.key || '', request.params?.value || ''],
            });
          }
        });
        respond({ ok: true });
        break;
      }
      case 'sidebar.set_progress': {
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) {
            w.webContents.send(IPC_CHANNELS.METADATA_UPDATE, {
              command: 'progress',
              surfaceId: request.params?.surfaceId,
              args: [String(request.params?.value ?? 0), request.params?.label || ''],
            });
          }
        });
        respond({ ok: true });
        break;
      }
      case 'sidebar.log': {
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) {
            w.webContents.send(IPC_CHANNELS.METADATA_UPDATE, {
              command: 'log',
              surfaceId: request.params?.surfaceId,
              args: [request.params?.level || 'info', request.params?.message || ''],
            });
          }
        });
        respond({ ok: true });
        break;
      }
      case 'sidebar.get_state': {
        // Return current sidebar metadata — this is stored in the renderer
        (async () => {
          try {
            const win = BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) { respond({ state: null }); return; }
            const workspaces = await win.webContents.executeJavaScript(
              `window.__wmux_listWorkspaces?.()`
            );
            respond({ workspaces: workspaces || [] });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      // browser.* handled by handleBrowserV2 (./v2-browser) — per-caller isolation (#62).
      case 'agent.spawn': {
        (async () => {
          try {
            const params = request.params;
            let workspaceId = params.workspaceId;
            if (!workspaceId) {
              const wins = BrowserWindow.getAllWindows();
              if (wins.length > 0) {
                workspaceId = await wins[0].webContents.executeJavaScript('window.__wmux_getActiveWorkspaceId?.()');
              }
            }
            if (!workspaceId) { respondError(-32000, 'No active workspace'); return; }

            let paneId = params.paneId;
            if (!paneId) {
              const paneLoads = await BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript('window.__wmux_getPaneLoads?.()');
              if (paneLoads && paneLoads.length > 0) paneId = distributeAgents(1, paneLoads)[0];
            }
            if (!paneId) { respondError(-32000, 'No panes available'); return; }

            // Accept both 'cmd' and 'prompt' field names (plugins may use either)
            const cmd = params.cmd || params.prompt;
            if (!cmd) { respondError(-32602, 'Missing required field: cmd'); return; }
            const result = agentManager.spawn({ cmd, label: params.label, cwd: params.cwd, env: params.env, paneId, workspaceId });

            const win = BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) setupAgentPtyForwarding(result.surfaceId, win);

            BrowserWindow.getAllWindows().forEach(w => {
              if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.AGENT_UPDATE, { type: 'spawned', ...result, paneId, workspaceId, label: params.label, replaceTab: !!params.replaceTab });
            });
            respond(result);
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      case 'agent.spawn_batch': {
        (async () => {
          try {
            const { agents: agentParams, strategy = 'distribute', workspaceId: wsId } = request.params;
            let workspaceId = wsId;
            if (!workspaceId) {
              const wins = BrowserWindow.getAllWindows();
              if (wins.length > 0) workspaceId = await wins[0].webContents.executeJavaScript('window.__wmux_getActiveWorkspaceId?.()');
            }
            if (!workspaceId) { respondError(-32000, 'No active workspace'); return; }

            const paneLoads = await BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript('window.__wmux_getPaneLoads?.()') || [];
            if (paneLoads.length === 0) { respondError(-32000, 'No panes available'); return; }

            const assignments = resolveAgentAssignments(strategy, agentParams.length, paneLoads);
            const win = BrowserWindow.getAllWindows()[0];
            respond({ agents: spawnAgentBatch(agentParams, assignments, workspaceId, win) });
          } catch (err: any) { respondError(-32000, err.message); }
        })();
        break;
      }

      case 'agent.status': {
        const info = agentManager.getStatus(request.params.agentId);
        if (!info) { respondError(-32000, 'Agent not found'); break; }
        respond(info);
        break;
      }
      case 'agent.list':
        respond({ agents: agentManager.list(request.params.workspaceId) });
        break;
      case 'agent.kill': {
        const killed = agentManager.kill(request.params.agentId);
        if (!killed) { respondError(-32000, 'Agent not found'); break; }
        respond({ ok: true });
        break;
      }

      case 'hook.event': {
        handleHookEvent(request.params);
        respond({ ok: true });
        break;
      }

      case 'agent.activity': {
        const p = request.params || {};
        const surfaceId = p.surfaceId as SurfaceId;
        if (!surfaceId) { respondError(-32602, 'surfaceId required'); break; }
        applyExternalActivity(surfaceId, {
          lastTool: p.tool || undefined,
          activeSkill: p.skill || undefined,
          isDone: typeof p.done === 'boolean' ? p.done : undefined,
        });
        respond({ ok: true });
        break;
      }

      case 'diff.refresh': {
        // CLI can trigger a full diff refresh
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.DIFF_UPDATE, { file: request.params?.file || '' });
        });
        respond({ ok: true });
        break;
      }

      default:
        // Routed families before the not-found: `detect.*` owns its own module,
        // the same way `pane.report_agent` and friends do.
        if (handleDetectionV2(request.method, request.params, respond, respondError)) break;
        respondError(-32601, `Method not found: ${request.method}`);
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  // Cancel pending auto-save timer
  if (autoSaveTimer !== null) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  // Ask all renderers to push their current state synchronously before quit
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send('session:request');
    }
  });
});

// Windows is ending the session — logoff, shutdown, or a Windows Update
// restart (issue #150). This is not cancellable and the OS is already on a
// deadline, so it is the earliest and last honest chance to take the PTYs down
// ourselves.
//
// Why that matters here specifically. Every PTY has a node-pty
// ThreadSafeFunction whose exit callback runs on the main thread and does
// `cb.Call({Napi::Number::New(env, code)})` — two napi calls outside any
// node-addon-api try/catch. When Windows kills the child processes as part of
// tearing the session down, those callbacks all fire at once, against an
// environment that is itself being destroyed. A napi call that fails there
// throws Napi::Error from a frame with no handler above it, which is
// UnhandledExceptionFilter and then __fastfail(7) — the exact signature #150
// has carried since 0.10.
//
// Killing here does not stop the callbacks; it makes them fire while the
// environment is still healthy, instead of racing its teardown. That is a
// narrower window, not a proof, and it is deliberately described that way:
// the throw itself is upstream in node-pty and not something wmux can catch.
// `session-end` is a WINDOW event, not an app one, in current Electron — so it
// is attached centrally here rather than at each creation site, and made
// one-shot: the OS ends the session once, however many windows are open.
let sessionEndHandled = false;
app.on('browser-window-created', (_event, win) => {
  win.on('session-end', () => {
    if (sessionEndHandled) return;
    sessionEndHandled = true;
    logDiagnostic('session-end', { ptys: ptyManager.count(), guard: isPtyCrashGuardInstalled() });
    ptyManager.killAll();
  });
});

/**
 * Whether the agent-browser teardown pass has already been started.
 *
 * `will-quit` is SYNCHRONOUS, and closing an agent-browser session is not: it
 * is a child process per session plus a dashboard stop. The only way to do it
 * at quit is to `preventDefault()` the first pass, run the async teardown, and
 * call `app.quit()` again — so this flag is what keeps the second pass from
 * preventing the quit it was asked to complete. Everything else in the handler
 * is idempotent by inspection (`killAll` on an empty map; every `stop()` here
 * nulls what it closed), so the second pass repeating them is a no-op.
 */
let agentBrowserTornDown = false;

app.on('will-quit', (event) => {
  logDiagnostic('will-quit', { ptys: ptyManager.count(), guard: isPtyCrashGuardInstalled() });
  // Kill all PTYs before anything else tears down. Without this, node-pty's
  // libuv async handles (batons) are still pending when the process exits,
  // triggering the "Assertion failed: remove_pty_baton" MSVC runtime error.
  //
  // Deliberately still FIRST, ahead of the deferral below: #150 is about these
  // callbacks firing while the environment is healthy, so nothing may push
  // them later than they happen today.
  ptyManager.killAll();
  pipeServer.stop();
  cdpProxy.stop();
  portScanner.stop();
  sshDetector.stop();

  // Sessions are ephemeral (agent-browser-session.ts): quit is the moment every
  // one of them stops being legitimate. Not closing them here leaks a Chrome
  // per agent pane — on Windows a dead parent does not take its descendants
  // with it, which is the whole of issue #139.
  if (agentBrowserTornDown || !agentBrowserNeedsTeardown()) return;
  agentBrowserTornDown = true;
  event.preventDefault();

  // Bounded twice over. `teardownAgentBrowser` caps itself, and this timer caps
  // IT — because the one outcome worse than leaking a browser is a wmux the
  // user cannot quit. `app.exit()` rather than `app.quit()` on that path: quit
  // would re-enter this handler and there is nothing left for it to do, since
  // every step above has already run.
  const forceQuit = setTimeout(() => app.exit(0), QUIT_TEARDOWN_BUDGET_MS + 2_000);
  const finish = (): void => {
    clearTimeout(forceQuit);
    app.quit();
  };
  teardownAgentBrowser(agentBrowserTeardownDeps).then(finish, finish);
});

app.on('window-all-closed', () => {
  app.quit();
});
