import { nextZoomFactor } from './zoom-factor';

/** Guest Ctrl+wheel comes through zoom-changed, a distinct Electron event
 * from before-input-event (keyboard). The desktop captures its DOM gesture
 * before xterm can forward it, and uses WINDOW_ZOOM instead. */
export function installPageZoom(contents: Electron.WebContents): void {
  contents.on('zoom-changed', (_event, direction) => {
    contents.setZoomFactor(nextZoomFactor(contents.getZoomFactor(), direction === 'in' ? -1 : 1));
  });
}
