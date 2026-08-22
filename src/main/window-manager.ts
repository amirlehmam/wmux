import { BrowserWindow, nativeImage, screen } from 'electron';
import { v4 as uuid } from 'uuid';
import os from 'os';
import path from 'path';
import type { WindowId } from '../shared/types';
import { loadSettings } from './settings-store';

/** The window backdrop when transparency is off — matches --ui-bg-1. */
const OPAQUE_BG = '#1a1a1a';
/**
 * Fully transparent backdrop. `setBackgroundMaterial` only becomes visible when
 * the window's own background colour has zero alpha — an opaque backgroundColor
 * paints over the DWM material and the window just looks normal.
 */
const TRANSPARENT_BG = '#00000000';

export type WindowMaterial = 'acrylic' | 'mica';

/**
 * Whether the DWM backdrop APIs behind `setBackgroundMaterial` actually exist.
 *
 * They landed in Windows 11 (build 22000). On Windows 10 the call is accepted
 * and silently does nothing, which would leave a user with transparency ON, a
 * transparent backgroundColor and therefore a BLACK window — worse than no
 * feature at all. So the capability is reported to the renderer and the toggle
 * is hidden where it cannot work.
 */
export function supportsBackdropMaterial(): boolean {
  if (process.platform !== 'win32') return false;
  const build = Number(os.release().split('.')[2]);
  return Number.isFinite(build) && build >= 22000;
}

/**
 * The transparency pref, read straight off %APPDATA%\wmux\settings.json.
 *
 * Read here rather than pushed from the renderer so the window can be CREATED
 * with the right backdrop. Applying it after the renderer boots works, but the
 * window paints opaque for those first frames and the transition is a visible
 * flash on every launch.
 */
function storedBackdrop(): { enabled: boolean; material: WindowMaterial } {
  try {
    const prefs = loadSettings()['wmux-appearance-prefs'] as
      | { windowTransparency?: boolean; windowMaterial?: WindowMaterial }
      | undefined;
    return {
      enabled: prefs?.windowTransparency === true,
      material: prefs?.windowMaterial === 'mica' ? 'mica' : 'acrylic',
    };
  } catch {
    return { enabled: false, material: 'acrylic' };
  }
}

/**
 * The window icon, preferring the multi-size .ico over the 512px .png (issue #137).
 *
 * Windows asks for this icon at four different sizes — 16px in the Alt-Tab strip,
 * 24–32px on the taskbar button, 48px in the window list, 256px in Task Manager —
 * and a single 512px representation means the shell downsamples for every one of
 * them. The .ico carries purpose-drawn entries at each size (the tiny variants
 * drop detail that cannot survive the downsample), so handing it over is the
 * difference between a crisp mark and a smudge at exactly the sizes users see
 * most. Falls back to the .png if the .ico is missing from an older install's
 * resources, since an approximate icon beats the default Electron one.
 */
function getAppIcon(): Electron.NativeImage | undefined {
  try {
    const { app } = require('electron') as typeof import('electron');
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'icon.ico'), path.join(process.resourcesPath, 'icon.png')]
      : [
          path.resolve(path.join(__dirname, '../../resources/icons/icon.ico')),
          path.resolve(path.join(__dirname, '../../resources/icon.png')),
        ];
    for (const candidate of candidates) {
      const image = nativeImage.createFromPath(candidate);
      // createFromPath returns an *empty* image rather than throwing when the
      // file is absent or unreadable, and an empty icon silently falls back to
      // the Electron default — so emptiness is the only usable existence check.
      if (!image.isEmpty()) return image;
    }
    return undefined;
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

  /**
   * Notified after a window is gone, so the session registry can forget its
   * slot (issue #118). Without it, a window the user deliberately closed comes
   * back on the next launch, because the merged save still carries its state.
   */
  onWindowClosed: ((id: WindowId, webContentsId: number) => void) | null = null;

  createWindow(
    bounds?: { x: number; y: number; width: number; height: number },
    maximized?: boolean,
  ): WindowId {
    const id = `win-${uuid()}` as WindowId;

    // Validate + clamp saved bounds against the display they best match. On
    // multi-monitor + mixed-DPI setups, DIP bounds captured on one monitor can
    // otherwise be re-applied to the wrong display and collapse the window toward
    // the min-size floor — the "tiny window" in issue #57.
    if (bounds) {
      if (bounds.width < 400 || bounds.height < 300) {
        bounds = undefined;
      } else {
        const target = screen.getDisplayMatching(bounds as Electron.Rectangle);
        const wa = target.workArea;
        const intersects =
          bounds.x < wa.x + wa.width && bounds.x + bounds.width > wa.x &&
          bounds.y < wa.y + wa.height && bounds.y + bounds.height > wa.y;
        if (!intersects) {
          bounds = undefined;
        } else {
          // Clamp size to the target work area and nudge the window fully on it,
          // so a restore can never shrink below what that display can show.
          const width = Math.min(bounds.width, wa.width);
          const height = Math.min(bounds.height, wa.height);
          const x = Math.max(wa.x, Math.min(bounds.x, wa.x + wa.width - width));
          const y = Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - height));
          bounds = { x, y, width, height };
        }
      }
    }

    const backdrop = storedBackdrop();
    const transparent = backdrop.enabled && supportsBackdropMaterial();

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
      backgroundColor: transparent ? TRANSPARENT_BG : OPAQUE_BG,
      // Only ever set on Win11 — passing a material on Win10 leaves the window
      // transparent-but-unblurred, i.e. black.
      ...(transparent ? { backgroundMaterial: backdrop.material } : {}),
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

    // Restore the maximized state on the correct monitor. Bounds above were set
    // to the pre-maximize ("normal") rectangle on the target display, so maximize
    // lands on that display and a later un-maximize returns there (issue #57).
    if (maximized) {
      win.maximize();
    }

    // webContents id is captured up front: by the time 'closed' fires the
    // BrowserWindow is destroyed and reading win.webContents throws.
    const webContentsId = win.webContents.id;
    win.on('closed', () => {
      this.windows.delete(id);
      this.onWindowClosed?.(id, webContentsId);
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

  /**
   * Which window a renderer message came from. Session auto-save is a broadcast
   * and every window answers it, so the reply has to be attributable to a window
   * before it can be merged rather than overwrite everyone else's (issue #118).
   */
  idForWebContents(sender: Electron.WebContents): WindowId | null {
    for (const entry of this.windows.values()) {
      if (!entry.window.isDestroyed() && entry.window.webContents.id === sender.id) return entry.id;
    }
    return null;
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

  /**
   * Toggle the Win11 backdrop on every open window, live.
   *
   * Both halves have to move together: the material is what DWM blurs, the
   * background colour is what lets it show. Setting one without the other gives
   * either no effect at all (opaque colour) or a black window (material 'none'
   * over a transparent colour), so they are applied as a pair.
   *
   * Per-window try/catch: a window destroyed between the isDestroyed() check and
   * the call must not stop the remaining windows from updating.
   */
  setBackdrop(enabled: boolean, material: WindowMaterial): void {
    if (!supportsBackdropMaterial()) return;
    for (const entry of this.getAllWindows()) {
      try {
        entry.window.setBackgroundColor(enabled ? TRANSPARENT_BG : OPAQUE_BG);
        entry.window.setBackgroundMaterial(enabled ? material : 'none');
      } catch {
        // Window went away mid-loop, or the platform rejected the material.
      }
    }
  }
}
