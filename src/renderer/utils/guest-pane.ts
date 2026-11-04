import { paneIdAt } from './wheel-zoom';

interface WebviewLike {
  getWebContentsId?: () => number;
  closest?: (selector: string) => { getAttribute(name: string): string | null } | null;
}

/**
 * The pane whose <webview> is the guest `webContentsId`, or null when this
 * window shows no such guest. A key forwarded from a page (shared/guest-key.ts)
 * names its guest by id, and this is what turns that back into a pane.
 */
export function paneOfGuest(
  webContentsId: number,
  root: { querySelectorAll(selector: string): Iterable<unknown> } = document,
): string | null {
  for (const el of root.querySelectorAll('webview') as Iterable<WebviewLike>) {
    let id: number | undefined;
    // Throws until the guest is attached and has fired dom-ready.
    try { id = el.getWebContentsId?.(); } catch { continue; }
    if (id === webContentsId) return paneIdAt(el as EventTarget);
  }
  return null;
}
