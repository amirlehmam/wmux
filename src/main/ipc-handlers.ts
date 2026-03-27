import { ipcMain, BrowserWindow, clipboard } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IPC_CHANNELS, SurfaceId, WindowId } from '../shared/types';
import { observePtyData } from './claude-observer';
import { PtyManager } from './pty-manager';
import { NotificationManager } from './notification-manager';
import { detectShells } from './shell-detector';
import { getDefaultTheme, loadBundledThemes } from './theme-loader';
import { parseWindowsTerminalConfig, parseGhosttyConfig } from './config-loader';
import { WindowManager } from './window-manager';
import { CDPBridge } from './cdp-bridge';
import { CDPProxy } from './cdp-proxy';
import { AgentManager } from './agent-manager';
import { saveNamedSession, loadNamedSession, listNamedSessions, deleteNamedSession } from './session-persistence';

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
    const resolvedOptions = {
      ...options,
      cwd: options.cwd || process.env.USERPROFILE || 'C:\\',
    };
    const id = await ptyManager.create(resolvedOptions);
    const window = BrowserWindow.fromWebContents(_event.sender);
    ptyManager.onData(id, (data) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.PTY_DATA, id, data);
      }
      // Feed Claude Code observer for sidebar activity display
      observePtyData(id, data);
    });
    ptyManager.onExit(id, (code) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.PTY_EXIT, id, code);
      }
    });
    return id;
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

  // Config / Theme handlers
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET_THEME, async () => {
    return getDefaultTheme();
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_GET_THEME_LIST, async () => {
    const bundled = loadBundledThemes();
    const names = ['Monokai', ...Array.from(bundled.keys())];
    // Deduplicate in case a bundled theme is also named Monokai
    return Array.from(new Set(names));
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_IMPORT_WT, async () => {
    return parseWindowsTerminalConfig();
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_IMPORT_GHOSTTY, async () => {
    return parseGhosttyConfig();
  });

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
  ipcMain.on(IPC_CHANNELS.CDP_DETACH, () => {
    cdpBridge.detach();
    cdpProxyInstance?.setWebContentsId(null);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_LIST, async (_event, workspaceId?: string) => {
    return agentManager.list(workspaceId as any);
  });
  ipcMain.handle(IPC_CHANNELS.AGENT_STATUS, async (_event, agentId: string) => {
    return agentManager.getStatus(agentId as any);
  });

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
  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE_NAMED, (_event, name: string) => {
    return deleteNamedSession(name);
  });
}

export function setupAgentPtyForwarding(surfaceId: string, window: BrowserWindow): void {
  ptyManager.onData(surfaceId as any, (data) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.PTY_DATA, surfaceId, data);
    }
  });
  ptyManager.onExit(surfaceId as any, (code) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.PTY_EXIT, surfaceId, code);
    }
  });
}

export { ptyManager, cdpBridge, agentManager };
