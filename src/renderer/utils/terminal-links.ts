import type { ILinkHandler } from '@xterm/xterm';
import type { ILinkProviderOptions } from '@xterm/addon-web-links';
import { openInWmuxBrowser } from './open-in-browser';
import { isHttpUrl } from './open-link';

/** xterm's `terminal.modes.mouseTrackingMode` — public API since xterm 5. */
export type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

/**
 * What a click on a terminal link means: ignore it, or open it with or without
 * inverting the configured destination.
 *
 * Who owns a PLAIN click is the whole question (#280). When the program in the
 * pane has turned mouse tracking on, the click is also being reported to it —
 * xterm 6's Linkifier activates on an unmodified mouseup with no regard for
 * that — and a TUI that handles links itself (OpenCode v2 opens them with the
 * `open` package) then opens the same URL a second time, in the system
 * browser, beside the panel wmux just opened. Two openers, neither able to see
 * the other. Every mainstream terminal avoids this the same way: a plain click
 * belongs to an app that has captured the mouse, and the terminal's own link
 * handling waits for a modifier (Windows Terminal and VS Code Ctrl+click,
 * iTerm2 Cmd+click). So with tracking on, an unmodified click is the app's.
 *
 * And in that pane the modifier OPENS rather than inverts. Under #201 Ctrl
 * inverts `openLinksExternally` because a plain click already reaches the
 * default destination; with tracking on, Ctrl is the only way to reach wmux at
 * all, so if it still inverted, the panel (the default) would be unreachable
 * from every mouse-capturing pane — and in OpenCode, whose plain click already
 * opens the system browser, both gestures would land in the same place.
 *
 * Shell output (tracking off) is unchanged: plain click → default destination,
 * Ctrl/Cmd → the other one.
 */
export function linkClickTarget(
  modifier: boolean,
  mouseTracking: MouseTrackingMode,
): { invert: boolean } | null {
  if (mouseTracking === 'none') return { invert: modifier };
  return modifier ? { invert: false } : null;
}

/** Route terminal links through wmux instead of xterm's window.open fallback. */
export function activateTerminalLink(event: MouseEvent, uri: string, mouseTracking: MouseTrackingMode = 'none'): void {
  if (!isHttpUrl(uri)) return;

  // Report only whether to invert. Whether that means "panel" or "system
  // browser" depends on browserPrefs.openLinksExternally, and that rule lives
  // in openInWmuxBrowser (issue #201).
  const target = linkClickTarget(!!event?.ctrlKey || !!event?.metaKey, mouseTracking);
  if (!target) return;
  openInWmuxBrowser(uri, target);
}

/**
 * Whether a mousedown is a link click wmux takes and the app must never see
 * (#353).
 *
 * `linkClickTarget` gives a modified click in a mouse-tracking pane to wmux,
 * but xterm reports that same click to the app anyway: its mousedown reporter
 * holds back only a selection-forcing modifier (Shift, or Alt on macOS), and
 * the report carries the Ctrl bit. An app that opens links on Ctrl+click
 * (reported with Claude Code) then opened the URL itself, in the system
 * browser, beside the panel wmux had just opened — #280 again, on the
 * modified click. So the
 * press is claimed before xterm sees it, but only for exactly the clicks wmux
 * would open: anything not on a link is still the app's.
 */
export function claimsLinkMouseDown(
  event: Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey'>,
  mouseTracking: MouseTrackingMode,
  hoveredUri: string | undefined,
): boolean {
  if (mouseTracking === 'none' || event.button !== 0) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  return isHttpUrl(hoveredUri);
}

type LinkHoverOptions = Required<Pick<ILinkProviderOptions, 'hover' | 'leave'>>;

/**
 * One terminal's link activation, for BOTH of xterm's link sources — the OSC 8
 * provider (reads `Terminal.options.linkHandler`) and the WebLinksAddon — so a
 * URL behaves the same whichever of them found it. The mouse mode is read at
 * click time, never captured: an app turns tracking on and off for its whole
 * life, and the pane outlives the app.
 *
 * `claimMouseDown`/`claimMouseUp` are for capture-phase listeners above
 * xterm's element; `true` means "stop this event here" (#353). The link under
 * the pointer comes from the providers' hover/leave callbacks — public API,
 * where xterm's own current link is private. A claimed press is answered here,
 * on its release, because xterm's Linkifier never saw the press and would not
 * activate the link on its own.
 */
export function createTerminalLinkActivation(getMouseTracking: () => MouseTrackingMode): {
  activate: (event: MouseEvent, uri: string) => void;
  linkHandler: ILinkHandler;
  webLinkOptions: LinkHoverOptions;
  claimMouseDown: (event: MouseEvent) => boolean;
  claimMouseUp: (event: MouseEvent) => boolean;
} {
  const activate = (event: MouseEvent, uri: string) => activateTerminalLink(event, uri, getMouseTracking());

  let hoveredUri: string | undefined;
  let claimedUri: string | undefined;
  const hover = (_event: MouseEvent, uri: string) => { hoveredUri = uri; };
  const leave = (_event: MouseEvent, uri: string) => {
    if (hoveredUri === uri) hoveredUri = undefined;
  };

  const claimMouseDown = (event: MouseEvent): boolean => {
    claimedUri = claimsLinkMouseDown(event, getMouseTracking(), hoveredUri) ? hoveredUri : undefined;
    return claimedUri !== undefined;
  };
  // A claimed release is swallowed even when the pointer has left the link:
  // the app never saw the press, so a lone release would be noise to it.
  const claimMouseUp = (event: MouseEvent): boolean => {
    if (claimedUri === undefined) return false;
    const uri = claimedUri;
    claimedUri = undefined;
    if (hoveredUri === uri) activate(event, uri);
    return true;
  };

  return {
    activate,
    linkHandler: { activate, hover, leave },
    webLinkOptions: { hover, leave },
    claimMouseDown,
    claimMouseUp,
  };
}
