import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openInWmuxBrowser } = vi.hoisted(() => ({
  openInWmuxBrowser: vi.fn(),
}));

vi.mock('../../src/renderer/utils/open-in-browser', () => ({
  openInWmuxBrowser,
}));

import {
  activateTerminalLink,
  terminalLinkHandler,
} from '../../src/renderer/utils/terminal-links';

function mouseEvent(modifiers: Partial<Pick<MouseEvent, 'ctrlKey' | 'metaKey'>> = {}): MouseEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    ...modifiers,
  } as MouseEvent;
}

describe('terminal link handling', () => {
  beforeEach(() => {
    openInWmuxBrowser.mockReset();
  });

  // This module reports only WHETHER the modifier was held. Since issue #201
  // the meaning of that lives in openInWmuxBrowser, because it depends on
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

  it('uses the same activation function for OSC 8 links', () => {
    expect(terminalLinkHandler.activate).toBe(activateTerminalLink);
  });
});
