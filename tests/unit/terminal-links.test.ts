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

  it('opens ordinary HTTP(S) clicks in the wmux browser', () => {
    activateTerminalLink(mouseEvent(), 'https://example.com/path');

    expect(openInWmuxBrowser).toHaveBeenCalledWith('https://example.com/path', {
      forceExternal: false,
    });
  });

  it.each([
    { ctrlKey: true },
    { metaKey: true },
  ])('opens modified clicks externally: %o', modifiers => {
    activateTerminalLink(mouseEvent(modifiers), 'https://example.com');

    expect(openInWmuxBrowser).toHaveBeenCalledWith('https://example.com', {
      forceExternal: true,
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
