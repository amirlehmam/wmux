import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ win: null as any }));
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => state.win } }));
import { focusBrowserDevTools } from '../../src/main/browser-tools';

beforeEach(() => { state.win = null; });

it('raises and restores an existing detached DevTools window without creating another', () => {
  state.win = { isDestroyed: () => false, isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
  const tools = { isDestroyed: () => false, focus: vi.fn() };
  const guest = { isDevToolsOpened: () => true, openDevTools: vi.fn(), devToolsWebContents: tools };
  focusBrowserDevTools(guest as any);
  expect(guest.openDevTools).not.toHaveBeenCalled();
  expect(state.win.restore).toHaveBeenCalledOnce();
  expect(state.win.show).toHaveBeenCalledOnce();
  expect(state.win.focus).toHaveBeenCalledOnce();
  expect(tools.focus).toHaveBeenCalledOnce();
});

it('opens DevTools with activation when the window does not exist yet', () => {
  const guest = { isDevToolsOpened: () => false, openDevTools: vi.fn(), devToolsWebContents: null };
  focusBrowserDevTools(guest as any);
  expect(guest.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: true });
});
