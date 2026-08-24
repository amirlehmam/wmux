import type { ILinkHandler } from '@xterm/xterm';
import { openInWmuxBrowser } from './open-in-browser';

/** Route terminal links through wmux instead of xterm's window.open fallback. */
export function activateTerminalLink(event: MouseEvent, uri: string): void {
  let protocol: string;
  try {
    protocol = new URL(uri).protocol;
  } catch {
    return;
  }

  if (protocol !== 'http:' && protocol !== 'https:') return;

  // Report only whether the modifier was held. Whether that means "panel" or
  // "system browser" depends on browserPrefs.openLinksExternally, and that
  // rule lives in openInWmuxBrowser (issue #201).
  openInWmuxBrowser(uri, {
    invert: !!event?.ctrlKey || !!event?.metaKey,
  });
}

/** xterm's OSC 8 link provider reads this from Terminal.options.linkHandler. */
export const terminalLinkHandler: ILinkHandler = {
  activate: activateTerminalLink,
};
