import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { registerIpcHandlers, agentManager, ptyManager, setupAgentPtyForwarding } from './ipc-handlers';
import { handleBrowserV2 } from './v2-browser';
import { handleBridgeV2 } from './v2-bridge';
import { distributeAgents } from './agent-manager';
import { PipeServer } from './pipe-server';
import { PortScanner } from './port-scanner';
import { GitPoller } from './git-poller';
import { PrPoller } from './pr-poller';
import { CDPProxy } from './cdp-proxy';
import { IPC_CHANNELS, SurfaceId } from '../shared/types';
import { getPipePath, getAppDataDir, ensurePipeToken } from '../shared/instance';
import { loadSession, saveSession, handleVersionChange, SessionData } from './session-persistence';
import { WindowManager } from './window-manager';
import { initAutoUpdater } from './updater';
import { initUpdateChecker, getLatestUpdate } from './update-checker';
import { ensureClaudeContext, ensureClaudeHooks, ensureChromeDevtoolsConfig, ensureOrchestratorPlugin } from './claude-context';
import { ensureOpencodeContext, ensureOpencodePlugin } from './opencode-context';
import { applyExternalActivity } from './claude-observer';
import { startOrchestrationWatcher } from './orchestration-watcher';
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
const gitPoller = new GitPoller();
const prPoller = new PrPoller();
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
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
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

app.whenReady().then(() => {
  // A losing second instance is already quitting; don't run startup side effects.
  if (!gotInstanceLock) return;
  hardenWebContents();
  // Inject wmux instructions into ~/.claude/CLAUDE.md for Claude Code awareness
  ensureClaudeContext();
  ensureClaudeHooks();
  ensureChromeDevtoolsConfig();
  ensureOrchestratorPlugin();
  ensureOpencodeContext();
  ensureOpencodePlugin();

  // IPC: renderer pushes session state (auto-save response or explicit save)
  ipcMain.on('session:save', (event, data: SessionData) => {
    // Augment with actual window bounds (renderer can't know these)
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed() && data.windows?.[0]) {
      // Persist the maximized flag and the *normal* (pre-maximize) rectangle so a
      // relaunch can re-maximize on the right monitor and un-maximize sanely (issue #57).
      data.windows[0].maximized = win.isMaximized();
      data.windows[0].bounds = win.getNormalBounds();
    }
    saveSession(data);
    scheduleAutoSave();
  });

  registerIpcHandlers(windowManager, cdpProxy);

  // Clear stale session data on version change (clean start for upgrades/fresh installs)
  handleVersionChange(app.getVersion());

  // Attempt to restore last saved window bounds
  const savedSession = loadSession();
  const savedWindow = savedSession?.windows?.[0];
  windowManager.createWindow(savedWindow?.bounds, savedWindow?.maximized);

  // Initialize auto-updater only when packaged (avoids errors in dev)
  if (app.isPackaged) {
    initAutoUpdater();
    initUpdateChecker();
  }

  // Late-mounted windows query the cached latest update info so the badge
  // appears even if the GitHub poll fired before the window's renderer attached.
  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_LATEST, () => getLatestUpdate());
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

  gitPoller.onUpdate((cwd, state) => {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.METADATA_UPDATE, {
          command: state.branch ? 'report_git_branch' : 'clear_git_branch',
          surfaceId: '', // will be mapped via cwd → workspace
          args: state.branch ? [state.branch, state.dirty ? 'dirty' : ''] : [],
        });
      }
    });
  });

  prPoller.onUpdate((cwd, pr) => {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        if (pr) {
          win.webContents.send(IPC_CHANNELS.METADATA_UPDATE, {
            command: 'report_pr',
            surfaceId: '',
            args: [String(pr.number), pr.state, pr.title],
          });
        }
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
        respond({ name: 'wmux', version: '0.5.0', platform: 'win32' });
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
      case 'config.reload': {
        // Re-read ~/.wmux/config.toml and live-apply to every open window.
        (async () => {
          try {
            const { loadUserConfig } = await import('./user-config');
            const cfg = loadUserConfig();
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
            const filePath = request.params?.filePath || request.params?.path || request.params?.file;
            if (!filePath) { respondError(-32000, 'No file path provided'); return; }
            // Defense-in-depth: even with a valid pipe token, only render plain
            // text/markdown files and cap the size, so this can't be used to
            // slurp secrets (e.g. id_rsa, .env) into the markdown viewer.
            const ALLOWED_MD_EXT = new Set(['.md', '.markdown', '.mdx', '.txt', '.text', '.rst']);
            const ext = path.extname(filePath).toLowerCase();
            if (!ALLOWED_MD_EXT.has(ext)) {
              respondError(-32602, `Unsupported file type for markdown.load_file: ${ext || '(none)'}`);
              return;
            }
            let stat: fs.Stats;
            try { stat = fs.statSync(filePath); } catch { respondError(-32000, 'File not found'); return; }
            const MAX_MD_BYTES = 5 * 1024 * 1024;
            if (!stat.isFile() || stat.size > MAX_MD_BYTES) {
              respondError(-32602, 'File is not a regular file or exceeds 5MB limit');
              return;
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            const win = BrowserWindow.getAllWindows()[0];
            if (!win || win.isDestroyed()) { respondError(-32000, 'No window'); return; }
            await win.webContents.executeJavaScript(
              `window.__wmux_setMarkdownContent?.(${JSON.stringify(request.params?.surfaceId || '')}, ${JSON.stringify(content)})`
            );
            respond({ ok: true, length: content.length });
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
              if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.AGENT_UPDATE, { type: 'spawned', ...result, paneId, workspaceId, label: params.label });
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
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.HOOK_EVENT, request.params);
        });
        // Always push diff update for Edit/Write hooks (even without file path).
        // Delay slightly so the renderer has time to mount the DiffPane
        // (HOOK_EVENT triggers diff tab creation; DIFF_UPDATE needs to arrive after mount).
        if (request.params.tool === 'Edit' || request.params.tool === 'Write') {
          // Stagger updates: 500ms for immediate feedback, 2s to catch slower writes
          for (const delay of [500, 2000]) {
            setTimeout(() => {
              BrowserWindow.getAllWindows().forEach(w => {
                if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.DIFF_UPDATE, { file: request.params.file || '' });
              });
            }, delay);
          }
        }
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
  gitPoller.unwatchAll();
  prPoller.stopAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
