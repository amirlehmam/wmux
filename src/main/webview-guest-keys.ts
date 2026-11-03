import { IPC_CHANNELS } from '../shared/types';
import { guestKeyFromInput } from '../shared/guest-key';

/**
 * Hand a browser guest's shortcut-shaped keys to the window that hosts it, so
 * Ctrl+W in a page closes the browser tab. See shared/guest-key.ts.
 *
 * Never preventDefault here. Main cannot know the user's bindings, and the
 * page keeps the key either way: the desktop acts only on the few tab-level
 * actions a browser reserves from pages, so a web app's own Ctrl+B or Ctrl+F
 * still works.
 */
export function forwardGuestKeys(contents: Electron.WebContents): void {
  if (contents.getType() !== 'webview') return;
  contents.on('before-input-event', (_event, input) => {
    const key = guestKeyFromInput(input);
    if (!key) return;
    const host = contents.hostWebContents;
    if (!host || host.isDestroyed()) return;
    host.send(IPC_CHANNELS.BROWSER_GUEST_KEY, contents.id, key);
  });
}
