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

  openInWmuxBrowser(uri, {
    forceExternal: !!event?.ctrlKey || !!event?.metaKey,
  });
}

/** xterm's OSC 8 link provider reads this from Terminal.options.linkHandler. */
export const terminalLinkHandler: ILinkHandler = {
  activate: activateTerminalLink,
};
