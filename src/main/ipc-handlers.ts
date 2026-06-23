import { ipcMain, BrowserWindow, clipboard, shell, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IPC_CHANNELS, SurfaceId, WindowId, WorkspaceId, AgentId } from '../shared/types';
import { observePtyData } from './claude-observer';
import { PtyManager } from './pty-manager';
import { NotificationManager } from './notification-manager';
import { detectShells } from './shell-detector';
import { getDefaultTheme, getThemeByName, loadBundledThemes } from './theme-loader';
import { parseWindowsTerminalConfig, parseGhosttyConfig, loadProjectProfiles, importWindowsTerminalProfiles } from './config-loader';
import { loadUserConfig, getConfigPath } from './user-config';
import { WindowManager } from './window-manager';
import { CDPBridge } from './cdp-bridge';
import { CDPProxy } from './cdp-proxy';
import { AgentManager } from './agent-manager';
import { saveNamedSession, loadNamedSession, listNamedSessions, deleteNamedSession, loadSession } from './session-persistence';
import { loadSettings, saveSetting } from './settings-store';
import { getChangedFiles, getFileDiff } from './diff-provider';

const ptyManager = new PtyManager();
const notificationManager = new NotificationManager();
const cdpBridge = new CDPBridge();
const agentManager = new AgentManager(ptyManager);

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
    ptyManager.write(id, data);
  });

  ipcMain.on(IPC_CHANNELS.PTY_RESIZE, (_event, id: SurfaceId, cols: number, rows: number) => {
    ptyManager.resize(id, cols, rows);
  });

  ipcMain.on(IPC_CHANNELS.PTY_KILL, (_event, id: SurfaceId) => {
    ptyManager.kill(id);
  });

  ipcMain.handle(IPC_CHANNELS.PTY_HAS, (_event, id: SurfaceId) => {
    return ptyManager.has(id);
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_SHELLS, async () => {
    return detectShells();
  });

  ipcMain.on(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, (_event, url: string) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url);
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
    const cfg = loadUserConfig();
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

  ipcMain.on(IPC_CHANNELS.CDP_ATTACH, (_event, webContentsId: number) => {
    cdpBridge.attach(webContentsId);
    cdpProxyInstance?.setWebContentsId(webContentsId);
  });
  ipcMain.on(IPC_CHANNELS.CDP_DETACH, (_event, webContentsId?: number) => {
    // Only the pane that owns the current attachment may clear it (issue #27).
    if (webContentsId !== undefined && cdpBridge.attachedWebContentsId !== webContentsId) return;
    cdpBridge.detach(webContentsId);
    cdpProxyInstance?.setWebContentsId(null);
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

  // Clipboard image paste: save clipboard image to temp file, return path
  ipcMain.handle('clipboard:paste-image', async () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    const tmpDir = path.join(os.tmpdir(), 'wmux');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, `screenshot-${Date.now()}.png`);
    fs.writeFileSync(filePath, img.toPNG());
    return filePath;
  });

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
  // Return the most recent auto-saved session in the flattened shape the
  // renderer's restore code already understands. Used on app launch so the
  // workspaces / splits / tabs persisted by the 30s rolling save are actually
  // rehydrated (instead of the renderer falling back to a fresh "Session 1").
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD_AUTO, () => {
    const data = loadSession();
    const win = data?.windows?.[0];
    if (!win) return null;
    const activeIndex = win.activeWorkspaceId
      ? win.workspaces.findIndex(w => w.id === win.activeWorkspaceId)
      : 0;
    return {
      workspaces: win.workspaces,
      sidebarWidth: win.sidebarWidth,
      activeIndex: activeIndex >= 0 ? activeIndex : 0,
    };
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
    const ALLOWED_MD_EXT = new Set(['.md', '.markdown', '.mdx', '.txt', '.text', '.rst']);
    const MAX_MD_BYTES = 5 * 1024 * 1024;
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Open Markdown File',
      properties: ['openFile'],
      filters: [
        { name: 'Markdown / Text', extensions: ['md', 'markdown', 'mdx', 'txt', 'text', 'rst'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).toLowerCase();
    if (!ALLOWED_MD_EXT.has(ext)) {
      return { error: `Unsupported file type: ${ext || '(none)'}` };
    }
    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); } catch { return { error: 'File not found' }; }
    if (!stat.isFile() || stat.size > MAX_MD_BYTES) {
      return { error: 'File is not a regular file or exceeds 5MB limit' };
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { filePath, content };
    } catch (err: any) {
      return { error: err?.message || 'Failed to read file' };
    }
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
