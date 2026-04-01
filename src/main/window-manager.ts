import { BrowserWindow, nativeImage, screen } from 'electron';
import { v4 as uuid } from 'uuid';
import path from 'path';
import type { WindowId } from '../shared/types';

function getAppIcon(): Electron.NativeImage | undefined {
  try {
    const { app } = require('electron') as typeof import('electron');
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.resolve(path.join(__dirname, '../../resources/icon.png'));
    return nativeImage.createFromPath(iconPath);
  } catch {
    return undefined;
  }
}

interface WindowEntry {
  id: WindowId;
  window: BrowserWindow;
}

export class WindowManager {
  private windows = new Map<WindowId, WindowEntry>();

  createWindow(bounds?: { x: number; y: number; width: number; height: number }): WindowId {
    const id = `win-${uuid()}` as WindowId;

    // Validate saved bounds: reasonable size + on a visible display
    if (bounds) {
      if (bounds.width < 400 || bounds.height < 300) {
        bounds = undefined;
      } else {
        const b = bounds;
        const displays = screen.getAllDisplays();
        const isOnScreen = displays.some(d => {
          const wa = d.workArea;
          return b.x < wa.x + wa.width && b.x + b.width > wa.x &&
                 b.y < wa.y + wa.height && b.y + b.height > wa.y;
        });
        if (!isOnScreen) bounds = undefined;
      }
    }

    const win = new BrowserWindow({
      width: bounds?.width ?? 1400,
      height: bounds?.height ?? 900,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 800,
      minHeight: 500,
      icon: getAppIcon(),
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#1a1a1a',
        symbolColor: '#cccccc',
        height: 38,
      },
      backgroundColor: '#1a1a1a',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
      },
    });

    // In dev mode, load from Vite dev server; in production, load built files
    const isDev = !require('electron').app.isPackaged;
    if (isDev) {
      const devPort = process.env.VITE_DEV_PORT || '5199';
      win.loadURL(`http://localhost:${devPort}`);
      win.webContents.openDevTools({ mode: 'detach' });
    } else {
      win.loadFile(path.join(__dirname, '../renderer/index.html'));
    }

    win.on('closed', () => {
      this.windows.delete(id);
    });

    this.windows.set(id, { id, window: win });
    return id;
  }

  closeWindow(id: WindowId): void {
    const entry = this.windows.get(id);
    if (entry && !entry.window.isDestroyed()) {
      entry.window.close();
    }
  }

  focusWindow(id: WindowId): void {
    const entry = this.windows.get(id);
    if (entry && !entry.window.isDestroyed()) {
      entry.window.focus();
    }
  }

  getWindow(id: WindowId): BrowserWindow | undefined {
    const entry = this.windows.get(id);
    return entry && !entry.window.isDestroyed() ? entry.window : undefined;
  }

  getAllWindows(): Array<{ id: WindowId; window: BrowserWindow }> {
    return Array.from(this.windows.values()).filter(e => !e.window.isDestroyed());
  }

  listWindows(): Array<{ id: WindowId; bounds: Electron.Rectangle; focused: boolean }> {
    return this.getAllWindows().map(e => ({
      id: e.id,
      bounds: e.window.getBounds(),
      focused: e.window.isFocused(),
    }));
  }

  getCount(): number {
    return this.windows.size;
  }
}
