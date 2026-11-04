import { expect, it } from 'vitest';
import { paneOfGuest } from '../../src/renderer/utils/guest-pane';

function webview(id: number | 'unattached', paneId: string | null) {
  return {
    getWebContentsId: () => { if (id === 'unattached') throw new Error('not attached'); return id; },
    closest: (sel: string) => (sel === '[data-pane-id]' && paneId ? { getAttribute: () => paneId } : null),
  };
}

const root = (els: unknown[]) => ({ querySelectorAll: () => els });

it('finds the pane hosting a guest by its webContents id', () => {
  expect(paneOfGuest(5, root([webview(4, 'pane-a'), webview(5, 'pane-b')]))).toBe('pane-b');
});

it('skips a webview that is not attached yet', () => {
  expect(paneOfGuest(5, root([webview('unattached', 'pane-a'), webview(5, 'pane-b')]))).toBe('pane-b');
});

it('answers null for a guest this window does not show', () => {
  expect(paneOfGuest(9, root([webview(4, 'pane-a')]))).toBeNull();
});
