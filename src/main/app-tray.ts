/**
 * The system tray icon for Close to tray (issue #442).
 *
 * Lifecycle: the icon exists ONLY while a wmux window is hidden to the tray.
 * `ensure()` is called by the close guard just before it hides the last visible
 * window, and `destroy()` once no window is hidden any more (restored from the
 * tray, a second launch, a toast click) or the app is quitting. So turning the
 * pref on adds nothing to the notification area, and turning it off needs no
 * IPC: the pref is read at close time, and an icon that exists always stands
 * for a window you cannot otherwise see.
 *
 * If no icon can be loaded (`ensure()` returns false), the close guard does not
 * hide: a window hidden with no tray icon would be reachable only by launching
 * wmux again, which is not something anyone would guess.
 *
 * "Quit wmux" is `app.quit()`. That runs `before-quit`, which sets the quit flag
 * the close guard reads as `bypass`, so the hidden windows close for real
 * through the same path an update or a relaunch takes (#227).
 */
import { Menu, Tray, type NativeImage } from 'electron';

export interface AppTrayDeps {
  /** The app icon, or undefined when none could be loaded (never an empty image). */
  icon: () => NativeImage | undefined;
  /** Show and focus every window hidden to the tray. */
  onShow: () => void;
  /** Quit for real. */
  onQuit: () => void;
}

export class AppTray {
  private tray: Tray | null = null;

  constructor(private readonly deps: AppTrayDeps) {}

  /** Create the icon if it is not up yet. False when it cannot be shown. */
  ensure(): boolean {
    if (this.tray && !this.tray.isDestroyed()) return true;
    try {
      const icon = this.deps.icon();
      if (!icon || icon.isEmpty()) return false;
      const tray = new Tray(icon);
      tray.setToolTip('wmux');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Show wmux', click: () => this.deps.onShow() },
        { type: 'separator' },
        { label: 'Quit wmux', click: () => this.deps.onQuit() },
      ]));
      // Single click restores, as the issue asks; a double click is two of
      // them and showing is idempotent, so it needs no handler of its own
      // beyond the same one.
      tray.on('click', () => this.deps.onShow());
      tray.on('double-click', () => this.deps.onShow());
      this.tray = tray;
      return true;
    } catch {
      this.tray = null;
      return false;
    }
  }

  /**
   * Remove the icon. Deferred a tick: it is usually called from inside one of
   * the tray's own click handlers (via `onShow`), and a Tray is not torn down
   * from under its own event dispatch.
   */
  destroy(): void {
    const tray = this.tray;
    if (!tray) return;
    this.tray = null;
    setImmediate(() => {
      if (!tray.isDestroyed()) tray.destroy();
    });
  }

  isActive(): boolean {
    return this.tray !== null && !this.tray.isDestroyed();
  }
}
