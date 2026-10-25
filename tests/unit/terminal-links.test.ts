import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openInWmuxBrowser } = vi.hoisted(() => ({
  openInWmuxBrowser: vi.fn(),
}));

vi.mock('../../src/renderer/utils/open-in-browser', () => ({
  openInWmuxBrowser,
}));

import {
  activateTerminalLink,
  claimsLinkMouseDown,
  createTerminalLinkActivation,
  linkClickTarget,
  type MouseTrackingMode,
} from '../../src/renderer/utils/terminal-links';

function mouseEvent(modifiers: Partial<Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'button'>> = {}): MouseEvent {
  return {
    button: 0,
    ctrlKey: false,
    metaKey: false,
    ...modifiers,
  } as MouseEvent;
}

describe('terminal link handling', () => {
  beforeEach(() => {
    openInWmuxBrowser.mockReset();
  });

  // This module reports only WHETHER to invert. Since issue #201 the meaning
  // of that lives in openInWmuxBrowser, because it depends on
  // browserPrefs.openLinksExternally — so an unmodified click is `invert:
  // false`, not "open in the panel".
  it('reports an unmodified HTTP(S) click as no inversion', () => {
    activateTerminalLink(mouseEvent(), 'https://example.com/path');

    expect(openInWmuxBrowser).toHaveBeenCalledWith('https://example.com/path', {
      invert: false,
    });
  });

  it.each([
    { ctrlKey: true },
    { metaKey: true },
  ])('reports a modified click as an inversion: %o', modifiers => {
    activateTerminalLink(mouseEvent(modifiers), 'https://example.com');

    expect(openInWmuxBrowser).toHaveBeenCalledWith('https://example.com', {
      invert: true,
    });
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'file:///C:/Windows/win.ini',
    'not a URL',
  ])('rejects unsafe or invalid targets: %s', uri => {
    activateTerminalLink(mouseEvent(), uri);

    expect(openInWmuxBrowser).not.toHaveBeenCalled();
  });
});

// #280: OpenCode v2 opens a plainly-clicked link itself, so wmux opening it
// too meant two browsers for one click.
describe('a pane whose app has captured the mouse (#280)', () => {
  beforeEach(() => {
    openInWmuxBrowser.mockReset();
  });

  const TRACKING: MouseTrackingMode[] = ['x10', 'vt200', 'drag', 'any'];

  it.each(TRACKING)('a plain click is the app\'s (%s): wmux opens nothing', mode => {
    activateTerminalLink(mouseEvent(), 'https://example.com', mode);
    expect(openInWmuxBrowser).not.toHaveBeenCalled();
  });

  it.each(TRACKING)('Ctrl+click reaches wmux and opens the DEFAULT destination (%s)', mode => {
    // Not an inversion: with tracking on, the modifier is the only way to
    // reach wmux at all, so inverting would make the default destination —
    // the panel, out of the box — unreachable from every such pane.
    activateTerminalLink(mouseEvent({ ctrlKey: true }), 'https://example.com', mode);
    expect(openInWmuxBrowser).toHaveBeenCalledWith('https://example.com', { invert: false });
  });

  it('Cmd counts as the modifier too', () => {
    activateTerminalLink(mouseEvent({ metaKey: true }), 'https://example.com', 'any');
    expect(openInWmuxBrowser).toHaveBeenCalledWith('https://example.com', { invert: false });
  });

  it('the full decision table', () => {
    expect(linkClickTarget(false, 'none')).toEqual({ invert: false });
    expect(linkClickTarget(true, 'none')).toEqual({ invert: true });
    expect(linkClickTarget(false, 'vt200')).toBeNull();
    expect(linkClickTarget(true, 'vt200')).toEqual({ invert: false });
  });
});

describe('createTerminalLinkActivation', () => {
  beforeEach(() => {
    openInWmuxBrowser.mockReset();
  });

  it('the OSC 8 handler and the WebLinksAddon callback are the same function', () => {
    const links = createTerminalLinkActivation(() => 'none');
    expect(links.linkHandler.activate).toBe(links.activate);
  });

  it('reads the mouse mode at click time, not at creation', () => {
    // The pane outlives the app: tracking goes on when OpenCode starts and off
    // when it exits, and a captured value would be wrong for one of them.
    let mode: MouseTrackingMode = 'none';
    const links = createTerminalLinkActivation(() => mode);

    links.activate(mouseEvent(), 'https://a.example');
    expect(openInWmuxBrowser).toHaveBeenCalledTimes(1);

    mode = 'any';
    links.activate(mouseEvent(), 'https://b.example');
    expect(openInWmuxBrowser).toHaveBeenCalledTimes(1);

    mode = 'none';
    links.activate(mouseEvent(), 'https://c.example');
    expect(openInWmuxBrowser).toHaveBeenCalledTimes(2);
  });

  it('the OSC 8 handler and the WebLinksAddon options share one hover state', () => {
    const links = createTerminalLinkActivation(() => 'any');
    expect(links.linkHandler.hover).toBe(links.webLinkOptions.hover);
    expect(links.linkHandler.leave).toBe(links.webLinkOptions.leave);
  });
});

// #353: with mouse tracking on, xterm reports a Ctrl+click to the app as well
// as firing the link handler, so an app that opens links on Ctrl+click opened
// the URL a second time, in the system browser, beside the wmux panel.
describe('a Ctrl+click wmux takes is not reported to the app (#353)', () => {
  beforeEach(() => {
    openInWmuxBrowser.mockReset();
  });

  const URL_A = 'https://example.com/a';
  const range = { start: { x: 1, y: 1 }, end: { x: 20, y: 1 } };

  function hoveredLinks(mode: MouseTrackingMode, uri = URL_A) {
    const links = createTerminalLinkActivation(() => mode);
    links.linkHandler.hover?.(mouseEvent(), uri, range);
    return links;
  }

  it('the claim decision table', () => {
    const ctrl = mouseEvent({ ctrlKey: true });
    expect(claimsLinkMouseDown(ctrl, 'vt200', URL_A)).toBe(true);
    expect(claimsLinkMouseDown(mouseEvent({ metaKey: true }), 'any', URL_A)).toBe(true);
    // Tracking off: nothing is reported to the app, so there is nothing to keep away.
    expect(claimsLinkMouseDown(ctrl, 'none', URL_A)).toBe(false);
    // A plain click belongs to the app (#280).
    expect(claimsLinkMouseDown(mouseEvent(), 'vt200', URL_A)).toBe(false);
    // Not on a link: the app owns every click that is not on one.
    expect(claimsLinkMouseDown(ctrl, 'vt200', undefined)).toBe(false);
    // Only the primary button activates a link.
    expect(claimsLinkMouseDown(mouseEvent({ ctrlKey: true, button: 2 }), 'vt200', URL_A)).toBe(false);
    // wmux would refuse to open it, so the app keeps the click.
    expect(claimsLinkMouseDown(ctrl, 'vt200', 'file:///C:/Windows/win.ini')).toBe(false);
  });

  it('claims the press and the release, and opens the link once on release', () => {
    const links = hoveredLinks('vt200');

    expect(links.claimMouseDown(mouseEvent({ ctrlKey: true }))).toBe(true);
    expect(openInWmuxBrowser).not.toHaveBeenCalled();

    expect(links.claimMouseUp(mouseEvent({ ctrlKey: true }))).toBe(true);
    expect(openInWmuxBrowser).toHaveBeenCalledTimes(1);
    expect(openInWmuxBrowser).toHaveBeenCalledWith(URL_A, { invert: false });
  });

  it('claims a release only after a claimed press', () => {
    const links = hoveredLinks('vt200');
    expect(links.claimMouseUp(mouseEvent({ ctrlKey: true }))).toBe(false);

    links.claimMouseDown(mouseEvent({ ctrlKey: true }));
    links.claimMouseUp(mouseEvent({ ctrlKey: true }));
    expect(links.claimMouseUp(mouseEvent({ ctrlKey: true }))).toBe(false);
    expect(openInWmuxBrowser).toHaveBeenCalledTimes(1);
  });

  it('opens nothing when the pointer left the link before the release', () => {
    const links = hoveredLinks('vt200');
    links.claimMouseDown(mouseEvent({ ctrlKey: true }));
    links.linkHandler.leave?.(mouseEvent(), URL_A, range);

    // Still claimed: the app never saw the press, so it must not see a lone release.
    expect(links.claimMouseUp(mouseEvent({ ctrlKey: true }))).toBe(true);
    expect(openInWmuxBrowser).not.toHaveBeenCalled();
  });

  it('leaves a plain click, and any click with tracking off, to xterm', () => {
    expect(hoveredLinks('vt200').claimMouseDown(mouseEvent())).toBe(false);
    expect(hoveredLinks('none').claimMouseDown(mouseEvent({ ctrlKey: true }))).toBe(false);
  });

  it('leaves a Ctrl+click off any link to the app', () => {
    const links = createTerminalLinkActivation(() => 'vt200');
    expect(links.claimMouseDown(mouseEvent({ ctrlKey: true }))).toBe(false);

    links.webLinkOptions.hover?.(mouseEvent(), URL_A, range);
    links.webLinkOptions.leave?.(mouseEvent(), URL_A);
    expect(links.claimMouseDown(mouseEvent({ ctrlKey: true }))).toBe(false);
  });

  it('a stale leave from another link does not clear the hovered one', () => {
    const links = hoveredLinks('vt200');
    links.webLinkOptions.leave?.(mouseEvent(), 'https://example.com/other');
    expect(links.claimMouseDown(mouseEvent({ ctrlKey: true }))).toBe(true);
  });

  it('reads the mouse mode at press time', () => {
    let mode: MouseTrackingMode = 'none';
    const links = createTerminalLinkActivation(() => mode);
    links.linkHandler.hover?.(mouseEvent(), URL_A, range);
    expect(links.claimMouseDown(mouseEvent({ ctrlKey: true }))).toBe(false);

    mode = 'drag';
    expect(links.claimMouseDown(mouseEvent({ ctrlKey: true }))).toBe(true);
  });
});
