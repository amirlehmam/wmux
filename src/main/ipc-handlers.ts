import { ipcMain, BrowserWindow, clipboard, shell, dialog, app, nativeTheme } from 'electron';
import * as path from 'path';
import { IPC_CHANNELS, SurfaceId, WindowId, WorkspaceId, AgentId, type InsertionResult } from '../shared/types';
import { observePtyData, clearActivity } from './claude-observer';
import { clearAgentState, noteHumanInput } from './agent-state';
import { PtyManager } from './pty-manager';
import { PtyLedger, reapOrphans } from './pty-ledger';
import { SshDetector } from './ssh-detect';
import {
  readClipboardSource,
  resolveInsertion,
  uploadEnabled,
  type PasteSource,
} from './remote-insert';
import { getAppDataDir } from '../shared/instance';
import { NotificationManager } from './notification-manager';
import { detectShells } from './shell-detector';
import { listSystemFonts } from './font-detector';
import { isContextMenuInstalled, installContextMenu, uninstallContextMenu } from './shell-context-menu';
import { getDefaultTheme, getThemeByName, loadBundledThemes } from './theme-loader';
import { parseWindowsTerminalConfig, parseGhosttyConfig, loadProjectProfiles, importWindowsTerminalProfiles } from './config-loader';
import { loadUserConfig, getConfigPath, resetConfigWarnings } from './user-config';
import { loadUserLocales } from './user-locales';
import { WindowManager, supportsBackdropMaterial, supportsTransparency, toWindowMaterial } from './window-manager';
import { CDPBridge } from './cdp-bridge';
import { CDPProxy } from './cdp-proxy';
import { AgentManager } from './agent-manager';
import { saveNamedSession, loadNamedSession, listNamedSessions, deleteNamedSession, loadSession } from './session-persistence';
import { sessionWindows, toRestorePayload, restoreAnswerFor } from './session-windows';
import { loadSettings, saveSetting } from './settings-store';
import { readConsent, updateConsent } from './agent-integration';
import { handleAgentStateV2 } from './agent-state-rpc';
import { getChangedFiles, getFileDiff } from './diff-provider';
import {
  readMarkdownFile,
  isAllowedMarkdownPath,
  statMarkdownFile,
  writeMarkdownFile,
  MD_DIALOG_EXTENSIONS,
} from './markdown-file';
import { grantMarkdownPath, isMarkdownPathGranted } from './markdown-grants';

// Claimed at module load, before anything can spawn a PTY, so the candidate
// list is strictly what a PREVIOUS instance left behind (issue #139). The
// killing half is async and driven from index.ts once the app is up.
const ptyLedger = new PtyLedger(path.join(getAppDataDir(), 'pty-ledger.json'));
const orphanCandidates = ptyLedger.takeOver();

const ptyManager = new PtyManager(ptyLedger);
const notificationManager = new NotificationManager();
const cdpBridge = new CDPBridge();
const agentManager = new AgentManager(ptyManager);

/**
 * Tracks which panes are sitting inside an ssh session, so a pasted image or a
 * dropped file can be scp'd to the host the pane is actually on instead of
 * having a local Windows path typed into a remote shell that cannot open it.
 *
 * Module-scoped alongside ptyManager because the surface -> pid mapping it
 * needs lives there. Exported the same way ptyManager and agentManager are,
 * so index.ts can feed it the shell-integration reports directly.
 */
export const sshDetector = new SshDetector({
  getPid: (surfaceId) => ptyManager.getPid(surfaceId as SurfaceId),
  liveSurfaceIds: () => ptyManager.liveSurfaceIds(),
});



/**
 * Tree-kill the PTY subtrees a previously crashed wmux left running (issue
 * #139). Best-effort and unawaited by design — see reapOrphans().
 */
export function reapOrphanedPtys(): void {
  reapOrphans(orphanCandidates).then(
    () => { /* reaped, or nothing to reap */ },
    (err) => { console.warn('[wmux] orphan reap failed:', err?.message); },
  );
}

export function registerIpcHandlers(windowManager: WindowManager, cdpProxyInstance?: CDPProxy): void {
  // Toggle DevTools for the renderer window
  ipcMain.on('toggle-devtools', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });

  ipcMain.handle(IPC_CHANNELS.PTY_CREATE, async (_event, options) => {
    try {
      const resolvedOptions = {
        ...options,
        cwd: options.cwd || process.env.USERPROFILE || 'C:\\',
      };
      const created = ptyManager.create(resolvedOptions);
      const id = created.id;
      // `wmux ssh user@host` puts the whole ssh command line in the REQUESTED
      // shell spec, which is the one detection source that is authoritative
      // rather than inferred.
      //
      // Deliberately `resolvedOptions.shell` and not `created.shell`: create()
      // returns the resolved executable with the arguments split off into
      // `shellExtraArgs`, so `created.shell` is a bare `…\ssh.exe` with no
      // destination left in it — which parses to nothing at all.
      sshDetector.setSurfaceShell(id, resolvedOptions.shell);
      // Reused PTY (idempotent create — e.g. StrictMode's double create() race):
      // the original create already wired data/exit forwarding. Re-wiring here
      // would forward every chunk twice and double everything in the renderer.
      if (created.reused) {
        return created;
      }
      const window = BrowserWindow.fromWebContents(_event.sender);
      const unsubData = ptyManager.onData(id, (data) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.PTY_DATA, id, data);
        }
        // Feed Claude Code observer for sidebar activity display
        try { observePtyData(id, data); } catch {}
      });
      const unsubExit = ptyManager.onExit(id, (code) => {
        if (window && !window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.PTY_EXIT, id, code);
        }
        // The process that owned this surface is gone, so any state it declared
        // is now a lie. Drop it rather than leave a `working`/`blocked` pane
        // pointing at a dead PID (issue #128); the observer's scraped activity
        // goes with it, since it describes the same dead process.
        clearAgentState(id);
        clearActivity(id);
        // Same reasoning for the remote session: the ssh that made this pane
        // remote has exited (dropped connection, or the user typed `exit`), so
        // a later paste must not still be offered an upload to that host.
        // PTY_KILL covers the pane being closed; this covers it dying on its own.
        sshDetector.forget(id);
        // Clean up listeners when PTY exits
        unsubData();
        unsubExit();
      });
      return created;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create terminal: ${msg}`);
    }
  });

  ipcMain.on(IPC_CHANNELS.PTY_WRITE, (_event, id: SurfaceId, data: string) => {
    // This channel is the HUMAN's keyboard, and only that: it originates in the
    // terminal component. wmux's own relayed answers (pane.answer_agent) go
    // straight to ptyManager.write in main, so they cannot reach here — which is
    // what keeps answerAgent's "answering never clears blocked" rule intact
    // while still letting a human who typed the answer themselves clear it
    // (issue #151).
    noteHumanInput(id, data);
    ptyManager.write(id, data);
  });

  ipcMain.on(IPC_CHANNELS.PTY_RESIZE, (_event, id: SurfaceId, cols: number, rows: number) => {
    ptyManager.resize(id, cols, rows);
  });

  ipcMain.on(IPC_CHANNELS.PTY_KILL, (_event, id: SurfaceId) => {
    ptyManager.kill(id);
    sshDetector.forget(id);
  });

  ipcMain.handle(IPC_CHANNELS.PTY_HAS, (_event, id: SurfaceId) => {
    return ptyManager.has(id);
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_SHELLS, async () => {
    return detectShells();
  });

  // Installed font families for the Settings font picker (issue #89).
  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_FONTS, async () => {
    return listSystemFonts();
  });

  ipcMain.on(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, (_event, url: string) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url);
    }
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_VERSION, () => app.getVersion());

  // App UI theme (issue #67): report the Windows light/dark setting so the
  // renderer can follow it when appearance mode is "system", and push updates
  // when the user flips it in Windows Settings while wmux is running.
  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_SHOULD_USE_DARK_COLORS, () => nativeTheme.shouldUseDarkColors);
  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.SYSTEM_NATIVE_THEME_UPDATED, nativeTheme.shouldUseDarkColors);
      }
    }
  });

  // Config / Theme handlers
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET_THEME, async (_event, name?: string) => {
    // Passing a name resolves a specific bundled theme; no name returns the default.
    return name ? getThemeByName(name) : getDefaultTheme();
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_GET_THEME_LIST, async () => {
    const bundled = loadBundledThemes();
    const names = ['Monokai', ...Array.from(bundled.keys())];
    return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_IMPORT_WT, async () => {
    return parseWindowsTerminalConfig();
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_IMPORT_GHOSTTY, async () => {
    return parseGhosttyConfig();
  });

  // Quick-launch profiles (issue #32): read project `.wmux.json` and import WT profiles.
  ipcMain.handle('config:getProjectProfiles', async (_event, cwd: string) => {
    return loadProjectProfiles(cwd);
  });
  ipcMain.handle('config:importWindowsTerminalProfiles', async () => {
    return importWindowsTerminalProfiles();
  });

  // User config (~/.wmux/config.toml) — read on startup, reloadable at runtime.
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET_USER_CONFIG, async () => {
    return loadUserConfig();
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_RELOAD_USER_CONFIG, async () => {
    // See the config.reload pipe handler in index.ts: a reload re-reports the
    // file's remaining problems instead of staying quiet about pre-edit ones.
    resetConfigWarnings();
    // A reload covers everything under ~/.wmux, so edited community
    // translations (issue #147) apply without a restart too.
    const cfg = { ...loadUserConfig(), locales: loadUserLocales() };
    // Broadcast to every open window so all surfaces live-apply the new prefs.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.CONFIG_USER_CONFIG_UPDATED, cfg);
      }
    }
    return cfg;
  });

  // Exposed so diagnostics (and the CLI) can report which path was read.
  ipcMain.handle('config:getUserConfigPath', async () => getConfigPath());

  ipcMain.on(IPC_CHANNELS.NOTIFICATION_FIRE, (_event, data: { surfaceId: string; text: string; title?: string }) => {
    const window = BrowserWindow.fromWebContents(_event.sender);
    // Show toast
    notificationManager.showToast(data.title || 'wmux', data.text, () => {
      if (window && !window.isDestroyed()) {
        window.focus();
        window.webContents.send('notification:focus-surface', data.surfaceId);
      }
    });
    // Flash taskbar
    if (window && !window.isDestroyed()) {
      notificationManager.flashTaskbar(window);
    }
    // Ask the renderer to play the notification sound. The main process can't
    // play audio (no Web Audio API), and only the renderer knows the user's
    // `notificationPrefs.sound` preference — it decides whether to actually
    // play. Sending here makes this the single chokepoint for every fired
    // notification (OSC 9/99/777 + App.tsx) regardless of call-site (issue #32).
    if (window && !window.isDestroyed()) {
      window.webContents.send('notification:play-sound');
    }
  });

  // Window management handlers
  ipcMain.handle(IPC_CHANNELS.WINDOW_CREATE, () => windowManager.createWindow());
  ipcMain.handle(IPC_CHANNELS.WINDOW_LIST, () => windowManager.listWindows());
  ipcMain.on(IPC_CHANNELS.WINDOW_CLOSE, (_e, id: WindowId) => windowManager.closeWindow(id));
  ipcMain.on(IPC_CHANNELS.WINDOW_FOCUS, (_e, id: WindowId) => windowManager.focusWindow(id));
  ipcMain.on(IPC_CHANNELS.WINDOW_MINIMIZE, (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on(IPC_CHANNELS.WINDOW_MAXIMIZE, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win?.isMaximized()) win.unmaximize(); else win?.maximize();
  });
  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, (e) =>
    BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false
  );
  // Window transparency (Win11 backdrop material). Applied to every window, not
  // just the sender: the pref is global, and a second window left opaque while
  // the first turned translucent reads as a bug.
  // `handle`, not `on`: entering or leaving plain-alpha mode cannot be applied
  // to a live window, and the renderer needs that answer to tell the user.
  ipcMain.handle(IPC_CHANNELS.WINDOW_SET_BACKDROP, (e, enabled: boolean, material?: string) => {
    const safe = toWindowMaterial(material);
    // The enum was validated; the CAPABILITY was not. A blur material on a host
    // that has none leaves a zero-alpha window with nothing drawn behind it —
    // a black window, which is precisely what supportsBackdropMaterial() exists
    // to prevent. Today's only caller pre-gates, but the guard belongs at the
    // boundary rather than in the callers that happen to exist right now.
    const available = safe === 'clear' ? supportsTransparency() : supportsBackdropMaterial();
    // e.sender, so the restart answer describes the window that asked.
    return windowManager.setBackdrop(enabled === true && available, safe, e.sender);
  });
  // Two separate capabilities: plain alpha needs only DWM, the blur materials
  // need Win11. Reporting one flag for both would hide transparency from every
  // Windows 10 user for the sake of a mode they were not asking for.
  // Frameless (clear) windows have no native caption buttons, so the renderer
  // draws its own and needs a way to close the window it is running in.
  ipcMain.on(IPC_CHANNELS.WINDOW_CLOSE_SELF, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
  // Switching into or out of clear mode rebuilds the window, so the pref can
  // only land on a fresh process.
  ipcMain.handle(IPC_CHANNELS.WINDOW_IS_FRAMELESS, (e) =>
    windowManager.isFramelessFor(e.sender),
  );
  ipcMain.on(IPC_CHANNELS.WINDOW_RELAUNCH, () => {
    app.relaunch();
    app.quit();
  });
  ipcMain.handle(IPC_CHANNELS.WINDOW_SUPPORTS_BACKDROP, () => ({
    transparency: supportsTransparency(),
    materials: supportsBackdropMaterial(),
  }));
  // Taskbar progress: renderer sends its OSC 9;4 aggregate for this window.
  ipcMain.on(IPC_CHANNELS.WINDOW_SET_PROGRESS, (e, value: number, mode?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;
    const validModes = ['none', 'normal', 'indeterminate', 'error', 'paused'];
    const safeMode = (validModes.includes(mode ?? '') ? mode : 'normal') as
      'none' | 'normal' | 'indeterminate' | 'error' | 'paused';
    win.setProgressBar(typeof value === 'number' ? value : -1, { mode: safeMode });
  });

  ipcMain.on(
    IPC_CHANNELS.CDP_ATTACH,
    (_event, webContentsId: number, surfaceId?: string | null, workspaceId?: string | null) => {
      // surfaceId/workspaceId let main route per-caller browser commands to the
      // right pane so concurrent agents don't collide (issue #62).
      cdpBridge.attach(webContentsId, surfaceId, workspaceId);
      cdpProxyInstance?.setWebContentsId(webContentsId);
    },
  );
  ipcMain.on(IPC_CHANNELS.CDP_DETACH, (_event, webContentsId?: number) => {
    // Detach only this pane's own target — other open browsers keep their
    // independent connections (issues #27, #62).
    cdpBridge.detach(webContentsId);
    if (webContentsId === undefined || cdpProxyInstance?.currentWebContentsId === webContentsId) {
      cdpProxyInstance?.setWebContentsId(null);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_LIST, async (_event, workspaceId?: string) => {
    return agentManager.list(workspaceId as WorkspaceId | undefined);
  });
  ipcMain.handle(IPC_CHANNELS.AGENT_STATUS, async (_event, agentId: string) => {
    return agentManager.getStatus(agentId as AgentId);
  });

  // Clipboard text write: used by the OSC 52 handler in the renderer.
  // navigator.clipboard.writeText() requires a user-gesture context; PTY data
  // callbacks don't qualify, so we route through Electron's clipboard module.
  ipcMain.handle('clipboard:write-text', (_event, text: string) => {
    clipboard.writeText(text);
  });

  // Use Electron's clipboard for reads too — navigator.clipboard.readText() can
  // return garbled text on Windows when the source app wrote a non-UTF-8 format.
  ipcMain.handle('clipboard:read-text', () => clipboard.readText());

  /**
   * What should a paste or a drop type into this surface?
   *
   * Main owns every input to that question — the clipboard, the detector, the
   * filesystem, scp, the config — so it answers the whole thing rather than
   * handing the renderer several round trips worth of raw material.
   *
   * The session is looked up here rather than accepted from the renderer: a
   * destination arriving over IPC is renderer-supplied data, and this path
   * spawns a process with it. Re-detecting means the only reachable hosts are
   * ones main already determined the pane is connected to.
   */
  const resolveFor = async (
    surfaceId: SurfaceId,
    source: PasteSource,
    mode: 'paste' | 'drop',
    invert = false,
  ): Promise<InsertionResult> => {
    // Only arm the ssh probe when there is something uploadable. It spawns a
    // PowerShell enumeration of every process on the machine (~550ms) and then
    // re-runs on a timer, and `start()` resets its idle counter — so waking it
    // from a plain text paste would keep that sweep alive for as long as the
    // user keeps pasting, to answer a question text can never ask. The sweep is
    // fire-and-forget and cannot affect this call anyway: detect() reads a cache.
    if (source.kind !== 'files') return resolveInsertion(source, null, false);
    sshDetector.start();
    const mayUpload = !invert && uploadEnabled(loadUserConfig().remote, mode);
    return resolveInsertion(source, sshDetector.detect(surfaceId), mayUpload);
  };

  ipcMain.handle(
    IPC_CHANNELS.REMOTE_RESOLVE_PASTE,
    (_event, surfaceId: SurfaceId) => resolveFor(surfaceId, readClipboardSource(), 'paste'),
  );

  /**
   * Files dropped on a pane — the renderer already resolved those to real paths
   * via webUtils, so they arrive here rather than being read from the clipboard.
   */
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_RESOLVE_DROP,
    (_event, surfaceId: SurfaceId, localPaths: string[], invert: boolean) =>
      resolveFor(
        surfaceId,
        {
          kind: 'files',
          localPaths: Array.isArray(localPaths)
            ? localPaths.filter((candidate) => typeof candidate === 'string')
            : [],
        },
        'drop',
        invert,
      ),
  );

  ipcMain.handle(IPC_CHANNELS.SESSION_SAVE_NAMED, (_event, session: any) => {
    saveNamedSession(session);
    return { ok: true };
  });
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD_NAMED, (_event, name: string) => {
    return loadNamedSession(name);
  });
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST_NAMED, () => {
    return listNamedSessions();
  });
  // Return the auto-saved session in the flattened shape the renderer's restore
  // code already understands. Used on app launch so the workspaces / splits /
  // tabs persisted by the 30s rolling save are actually rehydrated (instead of
  // the renderer falling back to a fresh "Session 1").
  //
  // Answered per window (issue #118): main primes each restored window's slot
  // at creation, so a window gets back its own workspaces. Returning windows[0]
  // to every caller — the old behaviour — meant a window opened during the run
  // came up as a clone of the first window's tabs, and multi-window sessions
  // could never restore more than one window's worth of state.
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD_AUTO, (event) => {
    const windowId = windowManager.idForWebContents(event.sender);
    if (windowId) {
      return restoreAnswerFor(sessionWindows.get(windowId), {
        startup: sessionWindows.isStartup(windowId),
      });
    }
    // Unattributable sender: fall back to the file's first window rather than
    // leaving a legitimately-restored window empty.
    return toRestorePayload(loadSession()?.windows?.[0] ?? null);
  });
  // Settings persistence (issue #19) — file-backed in %APPDATA%\wmux so prefs
  // survive portable-zip updates. get-all is synchronous so the renderer's
  // Zustand settings slice can hydrate at module-load time (no async flash).
  ipcMain.on('settings:get-all-sync', (event) => {
    event.returnValue = loadSettings();
  });
  ipcMain.on('settings:set', (_event, key: string, value: unknown) => {
    saveSetting(key, value);
  });

  // Community translations (~/.wmux/locales/*.json, issue #147). Synchronous
  // for the same reason as settings:get-all-sync, plus one of its own: the
  // persisted-language guard rejects any code the registry doesn't know, so a
  // user-defined language has to be merged in *before* the store initializes or
  // it would reset to English on every restart.
  ipcMain.on('locales:get-all-sync', (event) => {
    try {
      event.returnValue = loadUserLocales();
    } catch {
      event.returnValue = { locales: [], errors: [], dir: '' };
    }
  });

  // The #128 back-channel from the sidebar: answer a blocked pane in place.
  // Routed through the same V2 handler the CLI and pipe clients use, so there
  // is exactly one implementation of "what does answering mean" — including the
  // refusals (pane no longer asking, choice already consumed).
  ipcMain.handle(IPC_CHANNELS.AGENT_ANSWER, (_event, surfaceId: string, choiceId: string) =>
    new Promise((resolve) => {
      const handled = handleAgentStateV2(
        'pane.answer_agent',
        { surfaceId, choiceId },
        (result: any) => resolve({ ok: true, ...result }),
        (_code: number, message: string) => resolve({ ok: false, error: message }),
      );
      if (!handled) resolve({ ok: false, error: 'answer_agent not routed' });
    }),
  );

  // Agent-integration consent (issue #132). Deliberately NOT routed through the
  // generic settings:set above: changing this decision has to reconcile the files
  // in the user's home right away — switching a feature off has to remove what it
  // wrote, or the toggle would only stop future writes and leave the current ones
  // in place, which is the original complaint one level down.
  ipcMain.handle('integration:get', () => readConsent());
  ipcMain.handle('integration:set', (_event, partial: Parameters<typeof updateConsent>[0]) =>
    updateConsent(partial ?? {}),
  );

  // OS display-language list for first-launch UI language detection (issue #114).
  // navigator.language follows Chromium's locale resolution, which on Windows can
  // pick up regional-format/Accept-Language settings and disagree with the actual
  // display language — an English Windows reported French. GetUserPreferredUILanguages
  // (what getPreferredSystemLanguages wraps) is the authoritative signal. Synchronous
  // because the Zustand settings slice hydrates at module-load time.
  ipcMain.on('system:get-preferred-languages-sync', (event) => {
    try {
      event.returnValue = app.getPreferredSystemLanguages();
    } catch {
      event.returnValue = [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE_NAMED, (_event, name: string) => {
    return deleteNamedSession(name);
  });

  // Diff viewer handlers
  // Fallback: prefer process.cwd() (often the project dir) over USERPROFILE (never a git repo)
  ipcMain.handle(IPC_CHANNELS.DIFF_GET_FILES, async (_event, cwd: string) => {
    const resolvedCwd = cwd || process.cwd();
    const files = await getChangedFiles(resolvedCwd);
    return { files };
  });

  ipcMain.handle(IPC_CHANNELS.DIFF_GET_DIFF, async (_event, cwd: string, file: string) => {
    const resolvedCwd = cwd || process.cwd();
    const diff = await getFileDiff(resolvedCwd, file);
    return { diff };
  });

  // Markdown viewer (issue #54): manual "open markdown file" entry point.
  // Shows a native file picker filtered to the allowed extensions, then reads
  // the file applying the SAME guards as the markdown.load_file pipe handler
  // (extension whitelist + 5 MB cap) so the manual path can't slurp secrets.
  ipcMain.handle(IPC_CHANNELS.MARKDOWN_OPEN_FILE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Open Markdown File',
      properties: ['openFile'],
      filters: [
        { name: 'Markdown / Text', extensions: MD_DIALOG_EXTENSIONS },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    // The "All Files" filter lets the user pick anything, so the whitelist still
    // has to be enforced after the dialog — the filter is a convenience, not a guard.
    const read = readMarkdownFile(result.filePaths[0]);
    // The user chose this file in a native dialog, so editing and saving it back
    // is what they asked for. That consent is what the grant set records (F3).
    if (!('error' in read)) grantMarkdownPath(event.sender.id, read.filePath);
    return read;
  });

  // Markdown viewer (issue #116): re-read a file the pane already knows about.
  // Backs "Reload from disk" (agents rewrite files under the pane constantly)
  // and drag-and-drop of a file onto a markdown pane. Same guards as every
  // other read — the renderer supplies the path, so it is treated as untrusted.
  ipcMain.handle(IPC_CHANNELS.MARKDOWN_READ_FILE, async (_event, filePath: string) => {
    return readMarkdownFile(filePath);
  });

  // Markdown viewer (issue #116): the two read-only shell actions on the backing
  // file. Both are gated on the extension whitelist — without it, `openPath` on
  // a renderer-supplied path is an arbitrary-program launcher, which is a much
  // bigger capability than "open the doc I'm reading in Typora".
  ipcMain.handle(IPC_CHANNELS.MARKDOWN_REVEAL, async (_event, filePath: string) => {
    if (!isAllowedMarkdownPath(filePath)) return { error: 'Unsupported file type', code: 'unsupported_type' };
    shell.showItemInFolder(filePath);
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.MARKDOWN_OPEN_IN_APP, async (_event, filePath: string) => {
    if (!isAllowedMarkdownPath(filePath)) return { error: 'Unsupported file type', code: 'unsupported_type' };
    const err = await shell.openPath(filePath);
    return err ? { error: err, code: 'action_failed' } : { ok: true };
  });

  // Markdown editing (issue #116, F3). Re-stat only — backs the on-focus
  // "changed on disk?" check, which needs the mtime and not the content.
  ipcMain.handle(IPC_CHANNELS.MARKDOWN_STAT_FILE, async (_event, filePath: string) => {
    return statMarkdownFile(filePath);
  });

  // Save in place. The path comes from the renderer's store, so it is only
  // honoured if it is in this window's grant set — see ./markdown-grants for
  // why a renderer-supplied write path is treated as attacker-controlled.
  ipcMain.handle(
    IPC_CHANNELS.MARKDOWN_SAVE_FILE,
    async (event, filePath: string, content: string, expectedMtimeMs?: number) => {
      if (!isMarkdownPathGranted(event.sender.id, filePath)) {
        return { error: 'This file was not opened in wmux — use Save As', code: 'not_granted' };
      }
      return writeMarkdownFile(filePath, content, expectedMtimeMs);
    },
  );

  // Save As: the native dialog is the user's consent, so a confirmed
  // destination both gets written and becomes a grant for later in-place saves.
  ipcMain.handle(
    IPC_CHANNELS.MARKDOWN_SAVE_AS,
    async (event, content: string, suggestedName?: string, defaultDir?: string) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const result = await dialog.showSaveDialog(win as BrowserWindow, {
        title: 'Save Markdown File',
        defaultPath: suggestedName
          ? path.join(defaultDir || '', suggestedName)
          : path.join(defaultDir || '', 'untitled.md'),
        filters: [{ name: 'Markdown / Text', extensions: MD_DIALOG_EXTENSIONS }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      const written = writeMarkdownFile(result.filePath, content);
      if ('ok' in written) {
        grantMarkdownPath(event.sender.id, result.filePath);
        return { ...written, filePath: result.filePath };
      }
      return written;
    },
  );

  // Folder picker (issue #64): backs the `openFolder` shortcut (Ctrl+O). Shows a
  // native directory dialog and returns the chosen path; the renderer opens a new
  // workspace rooted there. Previously `openFolder` was a bound-but-no-op stub.
  // "Open in wmux" Explorer verb (HKCU shell keys — see shell-context-menu.ts).
  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_CONTEXT_MENU, () => {
    try {
      return isContextMenuInstalled();
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_SET_CONTEXT_MENU, (_event, enabled: boolean, label?: string) => {
    try {
      if (enabled) {
        // app.getPath('exe') is Electron's own binary in dev, which is correct:
        // the verb then launches the dev build, and the user gets what they see.
        installContextMenu(app.getPath('exe'), label || 'Open in wmux');
      } else {
        uninstallContextMenu();
      }
      // Report the state actually achieved, not the state requested — a partial
      // registry write must not leave the toggle claiming success.
      return { ok: true, enabled: isContextMenuInstalled() };
    } catch (err) {
      return { ok: false, enabled: isContextMenuInstalled(), error: (err as Error).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_PICK_FOLDER, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Open Folder as Workspace',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    return { path: result.filePaths[0] };
  });
}

export function setupAgentPtyForwarding(surfaceId: string, window: BrowserWindow): void {
  const unsubData = ptyManager.onData(surfaceId as SurfaceId, (data) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.PTY_DATA, surfaceId, data);
    }
  });
  const unsubExit = ptyManager.onExit(surfaceId as SurfaceId, (code) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.PTY_EXIT, surfaceId, code);
    }
    // Clean up listeners when PTY exits
    unsubData();
    unsubExit();
  });
}

export { ptyManager, cdpBridge, agentManager };
