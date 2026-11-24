// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anyWindowShowsWorkspace, windowShowsWorkspace, type WarmWindow } from '../../src/main/exec-warm';
import { useWorkspaceWarm } from '../../src/renderer/hooks/useWorkspaceWarm';
import { useStore } from '../../src/renderer/store';

const fakeWindow = (over: Partial<Record<'destroyed' | 'visible' | 'minimized', boolean>> & { active?: unknown; throws?: boolean } = {}): WarmWindow => ({
  isDestroyed: () => over.destroyed ?? false,
  isVisible: () => over.visible ?? true,
  isMinimized: () => over.minimized ?? false,
  webContents: {
    executeJavaScript: async (code: string) => {
      expect(code).toBe('window.__wmux_getActiveWorkspaceId?.() ?? null');
      if (over.throws) throw new Error('reloading');
      return over.active ?? 'ws-1';
    },
  },
});

describe('which window shows a workspace', () => {
  it('is a window that is shown, not minimised, and has that workspace selected', async () => {
    expect(await windowShowsWorkspace(fakeWindow(), 'ws-1')).toBe(true);
    expect(await windowShowsWorkspace(fakeWindow({ active: 'ws-2' }), 'ws-1')).toBe(false);
    expect(await windowShowsWorkspace(fakeWindow({ visible: false }), 'ws-1')).toBe(false);
    expect(await windowShowsWorkspace(fakeWindow({ minimized: true }), 'ws-1')).toBe(false);
    expect(await windowShowsWorkspace(fakeWindow({ destroyed: true }), 'ws-1')).toBe(false);
    expect(await windowShowsWorkspace(fakeWindow({ throws: true }), 'ws-1')).toBe(false);
  });

  it('is any of the windows', async () => {
    expect(await anyWindowShowsWorkspace([], 'ws-1')).toBe(false);
    expect(await anyWindowShowsWorkspace([fakeWindow({ active: 'ws-2' }), fakeWindow({ throws: true })], 'ws-1')).toBe(false);
    expect(await anyWindowShowsWorkspace([fakeWindow({ active: 'ws-2' }), fakeWindow()], 'ws-1')).toBe(true);
  });
});

describe('useWorkspaceWarm', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const warm = vi.fn();
  const Probe = ({ id }: { id: string | null }): null => { useWorkspaceWarm(id); return null; };
  const visibility = (state: 'visible' | 'hidden'): void => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  };

  beforeEach(() => {
    warm.mockReset();
    (window as any).wmux = { workspace: { warm } };
    visibility('visible');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as any).wmux;
  });

  it('says which workspace is shown when it becomes active, when the window gets focus and when the page is shown again', () => {
    act(() => root.render(React.createElement(Probe, { id: 'ws-1' })));
    expect(warm).toHaveBeenCalledTimes(1);
    expect(warm).toHaveBeenLastCalledWith('ws-1', undefined);
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(warm).toHaveBeenCalledTimes(2);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(warm).toHaveBeenCalledTimes(3);
    act(() => root.render(React.createElement(Probe, { id: 'ws-2' })));
    expect(warm).toHaveBeenLastCalledWith('ws-2', undefined);
    expect(warm).toHaveBeenCalledTimes(4);
  });

  it('sends the folder too when the workspace is on a WSL share, and never any other folder', () => {
    const saved = useStore.getState().workspaces;
    const withCwd = (cwd: string): void => {
      act(() => { useStore.setState({ workspaces: [{ id: 'ws-1', cwd }] as unknown as typeof saved }); });
    };
    try {
      withCwd('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo');
      act(() => root.render(React.createElement(Probe, { id: 'ws-1' })));
      expect(warm).toHaveBeenLastCalledWith('ws-1', '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo');
      withCwd('//wsl$/Ubuntu/home/me');
      expect(warm).toHaveBeenLastCalledWith('ws-1', '//wsl$/Ubuntu/home/me');
      withCwd('C:\\Users\\me\\repo');
      expect(warm).toHaveBeenLastCalledWith('ws-1', undefined);
      const calls = warm.mock.calls.length;
      withCwd('D:\\other'); // another folder that is not a WSL share: nothing new to say
      expect(warm).toHaveBeenCalledTimes(calls);
    } finally {
      act(() => { useStore.setState({ workspaces: saved }); });
    }
  });

  it('says nothing for no workspace, while the page is hidden, after unmounting, or without the bridge', () => {
    act(() => root.render(React.createElement(Probe, { id: null })));
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(warm).not.toHaveBeenCalled();
    visibility('hidden');
    act(() => root.render(React.createElement(Probe, { id: 'ws-1' })));
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(warm).not.toHaveBeenCalled();
    visibility('visible');
    act(() => root.unmount());
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(warm).not.toHaveBeenCalled();
    delete (window as any).wmux;
    root = createRoot(container);
    act(() => root.render(React.createElement(Probe, { id: 'ws-1' })));
    act(() => { window.dispatchEvent(new Event('focus')); }); // no bridge: no error
  });

  it('never lets a failing bridge become a renderer error', () => {
    warm.mockImplementation(() => { throw new Error('ipc gone'); });
    act(() => root.render(React.createElement(Probe, { id: 'ws-1' })));
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(warm).toHaveBeenCalledTimes(2);
  });
});
