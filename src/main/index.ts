import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { registerIpcHandlers, agentManager, ptyManager, setupAgentPtyForwarding, reapOrphanedPtys } from './ipc-handlers';
import { handleBrowserV2 } from './v2-browser';
import { handleBridgeV2 } from './v2-bridge';
import { distributeAgents } from './agent-manager';
import { PipeServer } from './pipe-server';
import { PortScanner } from './port-scanner';
import { CDPProxy } from './cdp-proxy';
import { IPC_CHANNELS, SurfaceId } from '../shared/types';
import { getPipePath, getAppDataDir, ensurePipeToken } from '../shared/instance';
import { loadSession, saveSession, handleVersionChange, SessionData } from './session-persistence';
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
import { ensurePowerShellShim } from './powershell-shim';
import fs from 'fs';
import path from 'path';

// Route the V2 methods that live in their own modules: browser.* (per-caller
// isolated routing, issue #62) and the uniform renderer-bridge methods. Returns
// true when the method was handled here so the main switch can be skipped.
function routeSpecialV2(
  request: { method: string; params?: any },
  respond: (result: any) => void,
  respondError: (code: number, message: string) => void,
): boolean {
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

  // Always refresh the diff for Edit/Write, even without a file path — but only
  // once the write has happened. PreToolUse carries the same tool name and fires
  // BEFORE it, so refreshing on that would render the diff as it was (issue #151).
  const isPost = !params?.event || params.event === 'PostToolUse';
  if (isPost && (params?.tool === 'Edit' || params?.tool === 'Write')) pushDiffUpdate(params.file || '');
}

app.whenReady().then(() => {
  // A losing second instance is already quitting; don't run startup side effects.
  if (!gotInstanceLock) return;
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

  pipeServer.on('v1', (cmd) => {
    // Trigger port scan when requested from shell integration
    if (cmd.command === 'ports_kick') {
      portScanner.kick();
    }
    // Forward metadata updates to all windows
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
            const { loadUserConfig } = await import('./user-config');
            const { loadUserLocales } = await import('./user-locales');
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

app.on('will-quit', () => {
  // Kill all PTYs before anything else tears down. Without this, node-pty's
  // libuv async handles (batons) are still pending when the process exits,
  // triggering the "Assertion failed: remove_pty_baton" MSVC runtime error.
  ptyManager.killAll();
  pipeServer.stop();
  cdpProxy.stop();
  portScanner.stop();
});

app.on('window-all-closed', () => {
  app.quit();
});
