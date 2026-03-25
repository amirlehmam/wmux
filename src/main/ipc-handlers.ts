import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS, SurfaceId } from '../shared/types';
import { PtyManager } from './pty-manager';
import { NotificationManager } from './notification-manager';
import { detectShells } from './shell-detector';
import { getDefaultTheme, loadBundledThemes } from './theme-loader';
import { parseWindowsTerminalConfig, parseGhosttyConfig } from './config-loader';

const ptyManager = new PtyManager();
const notificationManager = new NotificationManager();

export function registerIpcHandlers(): void {
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
}

export { ptyManager };
