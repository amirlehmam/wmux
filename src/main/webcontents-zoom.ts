import { nextZoomFactor } from './zoom-factor';

/** Guest Ctrl+wheel comes through zoom-changed, a distinct Electron event
 * from before-input-event (keyboard). The desktop captures its DOM gesture
 * before xterm can forward it, and uses WINDOW_ZOOM instead. */
export function installPageZoom(contents: Electron.WebContents): void {
  // The host also emits this event for a prevented DOM wheel gesture. Its
  // WINDOW_ZOOM handler already owns the step; only guests use this path.
  if (contents.getType() !== 'webview') return;
  contents.on('zoom-changed', (_event, direction) => {
    contents.setZoomFactor(nextZoomFactor(contents.getZoomFactor(), direction === 'in' ? -1 : 1));
  });
}
