import { BrowserWindow, dialog, nativeImage, screen } from 'electron';
import { v4 as uuid } from 'uuid';
import os from 'os';
import path from 'path';
import type { WindowId } from '../shared/types';
import { loadSettings } from './settings-store';
import { closeDialogCopy, decideClose } from './close-guard';
import { rendererRecoveryCopy, isRecoverableGone, type RendererTrouble } from './renderer-recovery';
import { logDiagnostic } from './crash-diagnostics';

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
let backdropMaterialSupport: boolean | null = null;
export function supportsBackdropMaterial(): boolean {
  // Memoised: this is a build number, fixed for the life of the process, and
  // setBackdrop asks it once per open window inside its loop. The renderer's
  // backdrop-caps.ts already caches the same answer on its side.
  if (backdropMaterialSupport === null) {
    if (process.platform !== 'win32') {
      backdropMaterialSupport = false;
    } else {
      const build = Number(os.release().split('.')[2]);
      backdropMaterialSupport = Number.isFinite(build) && build >= 22000;
    }
  }
  return backdropMaterialSupport;
}

/** Narrow an untrusted string to a WindowMaterial, defaulting to the safe one. */
export function toWindowMaterial(raw: unknown): WindowMaterial {
  return raw === 'mica' || raw === 'acrylic' || raw === 'clear' ? raw : 'clear';
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
    return {
      enabled: prefs?.windowTransparency === true,
      material: toWindowMaterial(prefs?.windowMaterial),
    };
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
/**
 * Where the shipped icon lives, best first. Exported because the stale-icon
 * notice (`icon-cache.ts`, #226) fingerprints the same file the window is
 * handed — a second list would be a second answer to "which icon is ours".
 */
export function appIconCandidates(): string[] {
  const { app } = require('electron') as typeof import('electron');
  return app.isPackaged
    ? [path.join(process.resourcesPath, 'icon.ico'), path.join(process.resourcesPath, 'icon.png')]
    : [
        path.resolve(path.join(__dirname, '../../resources/icons/icon.ico')),
        path.resolve(path.join(__dirname, '../../resources/icon.png')),
      ];
}

/** Exported for the tray icon (#442), so the window and the tray load the same file. */
export function getAppIcon(): Electron.NativeImage | undefined {
  try {
    for (const candidate of appIconCandidates()) {
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

type SavedBounds = { x: number; y: number; width: number; height: number };

/**
 * Validate + clamp saved bounds against the display they best match. On
 * multi-monitor + mixed-DPI setups, DIP bounds captured on one monitor can
 * otherwise be re-applied to the wrong display and collapse the window toward
 * the min-size floor — the "tiny window" in issue #57. Undefined means "let
 * Electron pick".
 */
function clampSavedBounds(bounds: SavedBounds | undefined): SavedBounds | undefined {
  if (!bounds) return undefined;
  if (bounds.width < 400 || bounds.height < 300) return undefined;
  const wa = screen.getDisplayMatching(bounds as Electron.Rectangle).workArea;
  const intersects =
    bounds.x < wa.x + wa.width && bounds.x + bounds.width > wa.x &&
    bounds.y < wa.y + wa.height && bounds.y + bounds.height > wa.y;
  if (!intersects) return undefined;
  // Clamp size to the target work area and nudge the window fully on it,
  // so a restore can never shrink below what that display can show.
  const width = Math.min(bounds.width, wa.width);
  const height = Math.min(bounds.height, wa.height);
  const x = Math.max(wa.x, Math.min(bounds.x, wa.x + wa.width - width));
  const y = Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - height));
  return { x, y, width, height };
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
  /** Applied backdrop; null if a failed native change may have partly applied. */
  backdrop: { enabled: boolean; material: WindowMaterial } | null;
  /** A close-confirm dialog is on screen for this window (issue #227). */
  closePending: boolean;
  /** The user answered that dialog with "close"; the re-issued close goes through. */
  closeConfirmed: boolean;
  /** The pre-close session flush (#285) ran; the re-issued close goes through. */
  sessionFlushed: boolean;
}

/**
 * What the close guard (#227) needs from the rest of main. Injected rather
 * than imported: the pref lives in settings.json, the bypass flag in index.ts's
 * quit bookkeeping, and the PTY count in the PtyManager — none of which this
 * module should own.
 */
export interface CloseGuardDeps {
  enabled: () => boolean;
  bypass: () => boolean;
  ptyCount: () => number;
  /** The `closeToTray` pref (#442), read at close time. */
  toTray: () => boolean;
  /**
   * Put the tray icon up before a window hides (#442). False means no icon
   * could be shown, and the close is then decided as if the pref were off.
   */
  ensureTray: () => boolean;
}

export class WindowManager {
  private windows = new Map<WindowId, WindowEntry>();

  /** Unset means no guard — every close goes through, as before 2.10.2. */
  closeGuard: CloseGuardDeps | null = null;

  /**
   * Notified after a window is gone, so the session registry can forget its
   * slot (issue #118). Without it, a window the user deliberately closed comes
   * back on the next launch, because the merged save still carries its state.
   */
  onWindowClosed: ((id: WindowId, webContentsId: number) => void) | null = null;

  /**
   * Asked once per close that is going to happen (issue #285): return a promise
   * to hold the close until it settles — index.ts uses it to pull the window's
   * state into session.json before the renderer dies — or null to close now.
   */
  beforeClose: ((win: BrowserWindow, isLastWindow: boolean) => Promise<unknown> | null) | null = null;

  /**
   * Notified when a window is shown or closed (#442), so index.ts can take the
   * tray icon down once no window is hidden to it any more.
   */
  onVisibilityChanged: (() => void) | null = null;

  createWindow(
    bounds?: { x: number; y: number; width: number; height: number },
    maximized?: boolean,
  ): WindowId {
    const id = `win-${uuid()}` as WindowId;
    bounds = clampSavedBounds(bounds);

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
      this.onVisibilityChanged?.();
    });
    win.on('show', () => this.onVisibilityChanged?.());

    const entry: WindowEntry = {
      id, window: win, transparent,
      backdrop: { enabled: translucent, material: backdrop.material },
      closePending: false, closeConfirmed: false, sessionFlushed: false,
    };
    // Every route to a window close lands here — the caption ×, Alt+F4, the
    // renderer's closeWindow shortcut (`window.close()`), the frameless
    // caption's closeSelf — so this is the one place the guard can sit.
    win.on('close', (event) => this.guardClose(entry, event));
    this.watchRendererHealth(entry);

    this.windows.set(id, entry);
    return id;
  }

  /**
   * The close guard's EFFECT (issue #227); the decision is `decideClose`.
   * Native dialog on purpose: by the time a close can be intercepted it is
   * already in main, and the renderer may be exactly the part that is not
   * responding. Cancel is the default button — the dialog exists to absorb a
   * stray click, so a stray Enter right after must not confirm it.
   */
  private guardClose(entry: WindowEntry, event: Electron.Event): void {
    const guard = this.closeGuard;
    const input = {
      enabled: guard?.enabled() ?? false,
      bypass: guard?.bypass() ?? true,
      confirmed: entry.closeConfirmed,
      pending: entry.closePending,
      toTray: guard?.toTray() ?? false,
      lastVisibleWindow: !this.getAllWindows().some(e => e !== entry && e.window.isVisible()),
    };
    let decision = decideClose(input);
    // No tray icon, no hiding: the window would be unreachable (#442).
    if (decision === 'hide' && !(guard?.ensureTray() ?? false)) {
      decision = decideClose({ ...input, toTray: false });
    }
    if (decision === 'allow') {
      this.flushBeforeClose(entry, event);
      return;
    }
    event.preventDefault();
    if (decision === 'swallow') return;
    if (decision === 'hide') {
      // Nothing ends: the renderer keeps running hidden, the PTYs live in main,
      // and the 30 s auto-save goes on asking this window for its state.
      entry.window.hide();
      return;
    }

    entry.closePending = true;
    const copy = closeDialogCopy({
      lastWindow: this.getAllWindows().length <= 1,
      ptyCount: guard?.ptyCount() ?? 0,
    });
    dialog.showMessageBox(entry.window, {
      type: 'warning',
      title: 'wmux',
      message: copy.message,
      detail: copy.detail,
      buttons: [copy.confirmLabel, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      entry.closePending = false;
      if (response !== 0 || entry.window.isDestroyed()) return;
      entry.closeConfirmed = true;
      entry.window.close();
    }, () => {
      entry.closePending = false;
    });
  }

  /**
   * Offer a reload when this window's renderer hangs or dies (#289) — the PTYs
   * live in main, so a reload reconnects every pane. See renderer-recovery.ts.
   */
  private watchRendererHealth(entry: WindowEntry): void {
    const win = entry.window;
    let prompt: AbortController | null = null;
    // Set while WE end the renderer for a reload: that kill fires
    // render-process-gone too, and must not ask the question a second time.
    let reloading = false;
    const offer = (kind: RendererTrouble) => {
      if (prompt || win.isDestroyed()) return;
      const controller = new AbortController();
      prompt = controller;
      const copy = rendererRecoveryCopy(kind);
      dialog.showMessageBox(win, {
        type: 'warning',
        title: 'wmux',
        message: copy.message,
        detail: copy.detail,
        buttons: copy.buttons,
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        signal: controller.signal,
      }).then(({ response }) => {
        if (prompt === controller) prompt = null;
        if (win.isDestroyed()) return;
        if (response === 0) {
          logDiagnostic('renderer-reload', { kind });
          // A hung renderer may never run the navigation it is asked for, so
          // it is ended first; a gone one has nothing left to end.
          reloading = true;
          if (kind === 'unresponsive') win.webContents.forcefullyCrashRenderer();
          win.webContents.reload();
        } else if (kind === 'gone') {
          // The user just answered "close" in a main-process dialog: neither
          // ask again (#227) nor hide a dead renderer to the tray (#442).
          entry.closeConfirmed = true;
          win.close();
        }
      }, () => {
        if (prompt === controller) prompt = null;
      });
    };
    win.on('unresponsive', () => {
      logDiagnostic('renderer-unresponsive');
      offer('unresponsive');
    });
    win.on('responsive', () => {
      if (!prompt) return;
      logDiagnostic('renderer-responsive');
      const pending = prompt;
      prompt = null;
      pending.abort();
    });
    win.webContents.on('did-finish-load', () => { reloading = false; });
    win.webContents.on('render-process-gone', (_event, details) => {
      if (reloading || !isRecoverableGone(details.reason)) return;
      logDiagnostic('renderer-gone', { reason: details.reason, code: details.exitCode });
      // A dialog still asking about the hang is answered by the death.
      prompt?.abort();
      prompt = null;
      offer('gone');
    });
  }

  /**
   * The close is going ahead — but the renderer is about to die with whatever
   * changed since the last auto-save tick (#285). Hold it once, let
   * `beforeClose` collect the state, then re-issue. `sessionFlushed` is what
   * lets the second pass through, and is set before the wait so a second ×
   * click during it cannot start another round.
   */
  private flushBeforeClose(entry: WindowEntry, event: Electron.Event): void {
    if (entry.sessionFlushed || !this.beforeClose) return;
    const pending = this.beforeClose(entry.window, this.getAllWindows().length <= 1);
    if (!pending) return;
    event.preventDefault();
    entry.sessionFlushed = true;
    const proceed = () => {
      if (!entry.window.isDestroyed()) entry.window.close();
    };
    pending.then(proceed, proceed);
  }

  /**
   * Programmatic close (the pipe's `close-window`, the IPC from another
   * window). Never prompts — the same contract the workspace guard (#90)
   * states for CLI and agent closes.
   */
  closeWindow(id: WindowId): void {
    const entry = this.windows.get(id);
    if (entry && !entry.window.isDestroyed()) {
      entry.closeConfirmed = true;
      entry.window.close();
    }
  }

  focusWindow(id: WindowId): void {
    const entry = this.windows.get(id);
    if (entry && !entry.window.isDestroyed()) {
      entry.window.focus();
    }
  }

  /**
   * Bring back every window hidden to the tray (#442) and focus one of them.
   * False when none was hidden, so a caller can fall back to its own focus.
   */
  showHiddenWindows(): boolean {
    const hidden = this.getAllWindows().filter(e => !e.window.isVisible());
    for (const e of hidden) e.window.show();
    const target = hidden.at(-1)?.window;
    if (!target) return false;
    if (target.isMinimized()) target.restore();
    target.focus();
    return true;
  }

  /** Any wmux window currently hidden to the tray (#442). */
  hasHiddenWindows(): boolean {
    return this.getAllWindows().some(e => !e.window.isVisible());
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
    return this.getAllWindows().find(e => e.window.webContents.id === sender.id);
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
      // The renderer reasserts its prefs on mount. On Win11 even setting an
      // already-disabled material to 'none' rebuilds native transparency and
      // can flash the whole window white, despite ready-to-show and dark CSS.
      // Skip unchanged native state; a disabled backdrop ignores its material.
      if (entry.backdrop && entry.backdrop.enabled === enabled &&
          (!enabled || entry.backdrop.material === material)) continue;
      entry.backdrop = applyOpaqueBackdrop(entry.window, enabled, material)
        ? { enabled, material }
        : null;
    }
    return { needsRestart };
  }
}

/** The live half of setBackdrop, for a window built with an opaque backing. */
function applyOpaqueBackdrop(win: BrowserWindow, enabled: boolean, material: WindowMaterial): boolean {
  try {
    win.setBackgroundColor(enabled ? TRANSPARENT_BG : OPAQUE_BG);
    if (supportsBackdropMaterial()) {
      win.setBackgroundMaterial(enabled && material !== 'clear' ? material : 'none');
    }
    return true;
  } catch {
    // Window went away mid-loop, or the platform rejected the material. The
    // caller invalidates its cache: even returning to the old state must retry.
    return false;
  }
}
