import { BrowserWindow, nativeImage, screen } from 'electron';
import { v4 as uuid } from 'uuid';
import os from 'os';
import path from 'path';
import type { WindowId } from '../shared/types';
import { loadSettings } from './settings-store';

/** The window backdrop when transparency is off — matches --ui-bg-1. */
const OPAQUE_BG = '#1a1a1a';
/**
 * Fully transparent backdrop, in Electron's #AARRGGBB order — alpha leads here,
 * unlike CSS's #RRGGBBAA. All-zero reads the same either way, but the ordering
 * matters the moment anyone edits this to a tint.
 *
 * Required in both translucent modes, for different reasons: a backdrop
 * material is only visible under a zero-alpha background, and `transparent`
 * windows fall back to Electron's default of #FFF without one.
 */
const TRANSPARENT_BG = '#00000000';

/**
 * How the desktop shows through the window.
 *
 * 'clear' is plain per-pixel alpha and the one that matches Windows Terminal's
 * `opacity` with `useAcrylic` off — you can read text in the window behind.
 * 'acrylic' and 'mica' are DWM backdrops, which BLUR what is behind by
 * definition, so they can never produce that.
 */
export type WindowMaterial = 'clear' | 'acrylic' | 'mica';

/**
 * Plain alpha transparency. Any DWM-composited Windows can do it — this is not
 * a Win11 feature, unlike the backdrop materials below.
 */
export function supportsTransparency(): boolean {
  return process.platform === 'win32';
}

/**
 * Whether the DWM backdrop APIs behind `setBackgroundMaterial` actually exist.
 *
 * They landed in Windows 11 (build 22000). On Windows 10 the call is accepted
 * and silently does nothing, which would leave a user with a transparent
 * backgroundColor and no backdrop drawn — a BLACK window. So the capability is
 * reported to the renderer and acrylic/mica are hidden where they cannot work.
 */
export function supportsBackdropMaterial(): boolean {
  if (process.platform !== 'win32') return false;
  const build = Number(os.release().split('.')[2]);
  return Number.isFinite(build) && build >= 22000;
}

/**
 * Whether a mode needs the window itself created with `transparent: true`.
 *
 * This is the awkward part of the feature. A backdrop material composites under
 * an ordinary opaque-backed window, so acrylic and mica can be switched on and
 * off at runtime. Plain alpha cannot: `transparent` is fixed when the window is
 * constructed and Electron exposes no setter, so entering or leaving 'clear'
 * needs the window rebuilt — i.e. a restart, which the renderer is told about
 * rather than left to wonder why nothing happened.
 */
export function needsTransparentWindow(enabled: boolean, material: WindowMaterial): boolean {
  return enabled && material === 'clear';
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
    const raw = prefs?.windowMaterial;
    const material: WindowMaterial =
      raw === 'mica' || raw === 'acrylic' || raw === 'clear' ? raw : 'clear';
    return { enabled: prefs?.windowTransparency === true, material };
  } catch {
    return { enabled: false, material: 'clear' };
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
  /**
   * Whether this window was constructed with `transparent: true`. Fixed for the
   * window's lifetime, so it decides which backdrop changes can be applied live
   * and which need a restart.
   */
  transparent: boolean;
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
    // 'clear' rides on plain alpha and needs no Win11; the blur materials do.
    const modeAvailable = backdrop.material === 'clear'
      ? supportsTransparency()
      : supportsBackdropMaterial();
    const translucent = backdrop.enabled && modeAvailable;
    const transparent = needsTransparentWindow(translucent, backdrop.material);

    const win = new BrowserWindow({
      width: bounds?.width ?? 1400,
      height: bounds?.height ?? 900,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 800,
      minHeight: 500,
      icon: getAppIcon(),
      // Clear mode has to be FRAMELESS. On Windows `transparent` is ignored
      // unless the window is frameless, and an ignored `transparent` does not
      // fall back to the theme — Electron's default backgroundColor is #FFF, so
      // the window comes up solid white. `titleBarStyle: 'hidden'` is not
      // frameless: it keeps the native frame and only hides the caption text,
      // which is exactly why it cannot be used here.
      //
      // The cost is the native caption buttons, since titleBarOverlay needs
      // that frame. The renderer draws its own in clear mode — see
      // WindowControls in the Titlebar.
      ...(transparent
        ? { frame: false }
        : {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: {
              color: '#1a1a1a',
              symbolColor: '#cccccc',
              height: 38,
            },
          }),
      // #AARRGGBB — Electron reads the alpha FIRST here, not last as CSS does.
      backgroundColor: translucent ? TRANSPARENT_BG : OPAQUE_BG,
      // Per-pixel alpha. Creation-time only — Electron has no setter for it.
      ...(transparent ? { transparent: true } : {}),
      // Only ever set on Win11, and never alongside 'clear': a backdrop would
      // blur exactly what 'clear' exists to keep readable.
      ...(translucent && backdrop.material !== 'clear'
        ? { backgroundMaterial: backdrop.material }
        : {}),
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

    this.windows.set(id, { id, window: win, transparent });
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
    return this.entryForWebContents(sender)?.id ?? null;
  }

  /** The live window a renderer message came from, if it still exists. */
  private entryForWebContents(sender: Electron.WebContents): WindowEntry | undefined {
    for (const entry of this.windows.values()) {
      if (!entry.window.isDestroyed() && entry.window.webContents.id === sender.id) return entry;
    }
    return undefined;
  }

  getAllWindows(): WindowEntry[] {
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
   * Whether the window a renderer message came from was built frameless.
   *
   * Fixed for the window's lifetime, and deliberately NOT derived in the
   * renderer from the transparency pref: while a restart is pending the pref
   * says the opposite of what the window is, and a renderer that guessed would
   * hide the caption buttons of a window that still has no native ones.
   */
  isFramelessFor(sender: Electron.WebContents): boolean {
    return this.entryForWebContents(sender)?.transparent ?? false;
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
   *
   * Applied fleet-wide, but `needsRestart` describes the ASKING window alone.
   * The flag makes its renderer keep treating the window as opaque, so a
   * fleet-wide OR would tell a window that was just built correctly to go on
   * painting over its own transparency because some OTHER window has not been
   * rebuilt yet — the exact state the flag exists to prevent. Windows are
   * independent here: each was built one way or the other and answers for
   * itself. With no sender (nobody asked) the fleet answer is the only one
   * available.
   */
  setBackdrop(
    enabled: boolean,
    material: WindowMaterial,
    sender?: Electron.WebContents,
  ): { needsRestart: boolean } {
    const wantsTransparent = needsTransparentWindow(enabled, material);
    let needsRestart = false;

    for (const entry of this.getAllWindows()) {
      // Crossing the plain-alpha boundary in either direction means this window
      // was built the wrong way round and no setter can fix it. Left alone
      // rather than half-applied: setting a transparent background on a window
      // with an opaque backing paints it black, which looks like a crash.
      if (entry.transparent !== wantsTransparent) {
        if (!sender || entry.window.webContents.id === sender.id) needsRestart = true;
        continue;
      }
      // A window built for clear mode is already exactly right, and touching it
      // is how it gets broken: setBackgroundMaterial('none') resets the DWM
      // backdrop type on a window whose transparency depends on it, and
      // setBackgroundColor re-lands an opaque surface. Nothing to apply — the
      // opacity itself is a renderer-side alpha, not a window property.
      if (wantsTransparent) continue;
      try {
        entry.window.setBackgroundColor(enabled ? TRANSPARENT_BG : OPAQUE_BG);
        if (supportsBackdropMaterial()) {
          entry.window.setBackgroundMaterial(
            enabled && material !== 'clear' ? material : 'none',
          );
        }
      } catch {
        // Window went away mid-loop, or the platform rejected the material.
      }
    }
    return { needsRestart };
  }
}
