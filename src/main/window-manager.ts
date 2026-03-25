import { BrowserWindow } from 'electron';
import { v4 as uuid } from 'uuid';
import path from 'path';
import type { WindowId } from '../shared/types';

interface WindowEntry {
  id: WindowId;
  window: BrowserWindow;
}

export class WindowManager {
  private windows = new Map<WindowId, WindowEntry>();

  createWindow(bounds?: { x: number; y: number; width: number; height: number }): WindowId {
    const id = `win-${uuid()}` as WindowId;

    const win = new BrowserWindow({
      width: bounds?.width ?? 1400,
      height: bounds?.height ?? 900,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 800,
      minHeight: 500,
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

    if (process.env.NODE_ENV === 'development') {
      win.loadURL('http://localhost:5173');
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
