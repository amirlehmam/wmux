import { expect, it, vi } from 'vitest';
import { ignoreMenuShortcutsInGuest } from '../../src/main/webview-menu-shortcuts';

function contents(type: string) {
  return { getType: () => type, setIgnoreMenuShortcuts: vi.fn() };
}

it('keeps menu accelerators such as Window → Close (Ctrl+W) away from a browser guest', () => {
  const guest = contents('webview');
  ignoreMenuShortcutsInGuest(guest as any);
  expect(guest.setIgnoreMenuShortcuts).toHaveBeenCalledWith(true);
});

it.each(['window', 'remote', 'backgroundPage'])('leaves the menu alone for %s contents', (type) => {
  const other = contents(type);
  ignoreMenuShortcutsInGuest(other as any);
  expect(other.setIgnoreMenuShortcuts).not.toHaveBeenCalled();
});
