import type { ILinkHandler } from '@xterm/xterm';
import { openInWmuxBrowser } from './open-in-browser';

/**
 * Decide, for one activation, whether it is a fresh logical click or the echo
 * of one already handled.
 *
 * wmux wires xterm up with TWO link providers that both call
 * `activateTerminalLink`: the built-in OSC 8 provider (via
 * `Terminal.options.linkHandler`) and `WebLinksAddon`'s plain-URL scanner. When
 * an agent — Claude Code among them — prints a URL as an OSC 8 hyperlink whose
 * VISIBLE text is that same URL, both providers match the one span, so a single
 * Ctrl-click fired `activateTerminalLink` twice and the wmux panel navigated (or
 * the system browser launched) twice.
 *
 * xterm hands both activations the SAME physical `MouseEvent` object, so that
 * object identity is the whole signal: a second activation carrying the very
 * same event is the echo and is dropped. Two SEPARATE events each activate,
 * even for the same uri — a genuine re-click of the same link is a new gesture.
 *
 * A factory rather than module state so it is pure and testable — the module
 * holds one instance; a test makes its own.
 */
export interface LinkActivationGuard {
  /** True to activate (a fresh click); false to drop (a duplicate). */
  shouldActivate(event: MouseEvent | undefined): boolean;
}

export function createLinkActivationGuard(): LinkActivationGuard {
  let lastEvent: MouseEvent | undefined;
  return {
    shouldActivate(event) {
      if (event && event === lastEvent) return false;
      lastEvent = event;
      return true;
    },
  };
}

/** The one guard shared by both link providers, so their activations dedupe. */
const activationGuard = createLinkActivationGuard();

/** Route terminal links through wmux instead of xterm's window.open fallback. */
export function activateTerminalLink(event: MouseEvent, uri: string): void {
  let protocol: string;
  try {
    protocol = new URL(uri).protocol;
  } catch {
    return;
  }

  if (protocol !== 'http:' && protocol !== 'https:') return;

  // Collapse the OSC 8 and WebLinksAddon activations one click can produce into
  // one open. Checked AFTER the safety filter above so a rejected uri never
  // occupies the guard's single slot.
  if (!activationGuard.shouldActivate(event)) return;

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
