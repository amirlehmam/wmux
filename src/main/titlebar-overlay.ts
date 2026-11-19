/**
 * The native caption buttons (`titleBarOverlay`) against the page zoom (#465).
 *
 * The overlay is sized in window pixels and the titlebar in CSS pixels, so
 * they agree only at 100 % zoom. Zoomed out, the overlay stayed 38 px tall
 * over a titlebar that had shrunk: the buttons hung below the bar and covered
 * the settings button beside them. Measured in a bare Electron window: at 70 %
 * a 38 px overlay is 55 CSS px tall, and one of round(38 * 0.7) is 38 again.
 *
 * Height is fixed here. The buttons' WIDTH does not follow the zoom at all, so
 * the renderer reserves it with `env(titlebar-area-width)` (titlebar.css).
 */
import type { BrowserWindow } from 'electron';

/** `.titlebar`'s height in CSS pixels (titlebar.css). */
export const TITLEBAR_CSS_HEIGHT = 38;

/** The overlay height, in window pixels, that covers the titlebar at `zoom`. */
export function overlayHeightForZoom(zoom: number): number {
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.max(1, Math.round(TITLEBAR_CSS_HEIGHT * factor));
}

/** Resize `win`'s caption overlay for its page zoom. `zoom` defaults to the current one. */
export function syncTitleBarOverlay(win: BrowserWindow, zoom?: number): void {
  if (win.isDestroyed()) return;
  try {
    win.setTitleBarOverlay({ height: overlayHeightForZoom(zoom ?? win.webContents.getZoomFactor()) });
  } catch {
    // A frameless (clear transparency) window has no overlay: Electron throws,
    // and the renderer draws its own buttons there, which scale with the page.
  }
}
