// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryResult, TerminalHistoryBridge, TerminalHistoryState } from '../../src/shared/terminal-history';
import { DEFAULT_TERMINAL_PREFS } from '../../src/renderer/store/settings-slice';
import TerminalSettings from '../../src/renderer/components/Settings/TerminalSettings';
import * as historyFeedback from '../../src/renderer/utils/terminal-history-feedback';

vi.mock('../../src/renderer/i18n', () => ({ useT: () => (_key: string, fallback?: string) => fallback ?? _key }));
vi.mock('../../src/renderer/store', () => ({
  useStore: Object.assign((selector?: (value: typeof settings) => unknown) => selector ? selector(settings) : settings,
    { getState: () => settings }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const settings = {
  terminalPrefs: DEFAULT_TERMINAL_PREFS,
  appearancePrefs: { terminalBgOpacity: 100, windowTransparency: false, windowMaterial: 'clear' },
  setTerminalPrefs: vi.fn(), setAppearancePrefs: vi.fn(),
  importStatus: null, importUndo: null, setImportStatus: vi.fn(), setImportUndo: vi.fn(),
};
const state = (enabled = false, error: TerminalHistoryState['error'] = null): TerminalHistoryState => ({ enabled, generation: 1, error });
const ok = (value: TerminalHistoryState): HistoryResult<TerminalHistoryState> => ({ ok: true, value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
let host: HTMLDivElement;
let root: Root;
let bridge: TerminalHistoryBridge;
let current: TerminalHistoryState;
let listeners: Set<(value: TerminalHistoryState) => void>;
function emit(value: TerminalHistoryState) {
  current = value;
  for (const listener of listeners) listener(value);
}
function toggle(): HTMLInputElement { return host.querySelector('#terminal-history-enabled')!; }
function status() { return host.querySelector('#terminal-history-status')!.textContent!; }
async function mount() { await act(async () => { root.render(React.createElement(TerminalSettings)); }); }

beforeEach(() => {
  vi.clearAllMocks();
  current = state();
  listeners = new Set();
  bridge = {
    getState: vi.fn(async () => ok(current)),
    onState: vi.fn((listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
    setEnabled: vi.fn(async (enabled) => { emit(state(enabled)); return ok(current); }),
    getBinding: vi.fn(), read: vi.fn(), checkpoint: vi.fn(),
  };
  window.wmux = { terminalHistory: bridge };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as any).wmux;
  vi.restoreAllMocks();
});

describe('main-owned terminal output setting', () => {
  it('defaults off, subscribes before seeding and associates the warning with the control', async () => {
    const seed = deferred<HistoryResult<TerminalHistoryState>>();
    vi.mocked(bridge.getState).mockReturnValue(seed.promise);
    await mount();
    expect(vi.mocked(bridge.onState).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(bridge.getState).mock.invocationCallOrder[0]);
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(true);
    await act(async () => { seed.resolve(ok(state())); });
    expect(toggle().disabled).toBe(false);
    const label = host.querySelector('label[for="terminal-history-enabled"]')!;
    expect(label.textContent).toBe('Save terminal output across restarts');
    expect(toggle().labels?.[0]).toBe(label);
    const hint = host.querySelector('#terminal-history-hint')!;
    expect(toggle().getAttribute('aria-describedby')).toContain(hint.id);
    for (const disclosure of ['plaintext', 'not encrypted', 'sensitive', 'leaves open terminals intact', 'Secure erasure is not guaranteed', 'save output still visible']) {
      expect(hint.textContent).toContain(disclosure);
    }
    expect(settings.setTerminalPrefs).not.toHaveBeenCalled();
  });

  it('does not let a late initial seed overwrite a newer main event', async () => {
    const seed = deferred<HistoryResult<TerminalHistoryState>>();
    vi.mocked(bridge.getState).mockReturnValue(seed.promise);
    await mount();
    act(() => emit(state(true)));
    await act(async () => { seed.resolve(ok(state(false))); });
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(false);
  });

  it('waits for main, showing temporary pause and pending without optimistic success', async () => {
    await mount();
    const change = deferred<HistoryResult<TerminalHistoryState>>();
    vi.mocked(bridge.setEnabled).mockReturnValue(change.promise);
    act(() => toggle().click());
    expect(bridge.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(true);
    expect(status()).toContain('Updating');
    act(() => emit(state(false)));
    expect(toggle().checked).toBe(false);
    await act(async () => { emit(state(true)); change.resolve(ok(current)); });
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(false);
    expect(status()).toBe('');
    expect(settings.setTerminalPrefs).not.toHaveBeenCalled();
  });

  it('never overwrites a newer broadcast with a delayed successful setter reply', async () => {
    await mount();
    const change = deferred<HistoryResult<TerminalHistoryState>>();
    vi.mocked(bridge.setEnabled).mockReturnValue(change.promise);
    act(() => toggle().click());
    act(() => emit(state(false, 'cleanup')));
    await act(async () => { change.resolve(ok(state(true))); });
    expect(toggle().checked).toBe(false);
    expect(status()).toContain('cleanup did not finish');
  });

  it('explains failed preference persistence without claiming the next restart is disabled', async () => {
    current = state(true);
    await mount();
    vi.mocked(bridge.setEnabled).mockImplementation(async () => {
      emit(state(false, 'settings'));
      return { ok: false, error: 'settings' };
    });
    await act(async () => toggle().click());
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(false);
    expect(status()).toContain('off for this run');
    expect(status()).toContain('previous preference may apply after restart');
    expect(status()).toContain('then restart wmux and try again');
  });

  it.each([false, true])('keeps actual main consent after incomplete cleanup (enabled=%s)', async (enabled) => {
    current = state(!enabled);
    await mount();
    vi.mocked(bridge.setEnabled).mockImplementation(async () => {
      emit(state(enabled, 'cleanup'));
      return { ok: false, error: 'cleanup' };
    });
    await act(async () => toggle().click());
    expect(toggle().checked).toBe(enabled);
    expect(status()).toContain('cleanup did not finish');
    expect(toggle().disabled).toBe(false);
  });

  it.each([true, false])('clears historical failure status after authoritative healthy refresh (broadcast=%s)', async (broadcast) => {
    await mount();
    const report = vi.spyOn(historyFeedback, 'reportTerminalHistoryFailure');
    const change = deferred<HistoryResult<TerminalHistoryState>>();
    const refresh = deferred<HistoryResult<TerminalHistoryState>>();
    vi.mocked(bridge.setEnabled).mockReturnValue(change.promise);
    vi.mocked(bridge.getState).mockReturnValue(refresh.promise);
    act(() => toggle().click());
    if (broadcast) act(() => emit(state(true)));
    await act(async () => { change.resolve({ ok: false, error: 'cleanup' }); });
    expect(report).toHaveBeenCalledExactlyOnceWith('cleanup');
    if (broadcast) expect(status()).not.toContain('cleanup did not finish');
    else expect(status()).toContain('cleanup did not finish');
    await act(async () => { refresh.resolve(ok(state(true))); });
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(false);
    expect(status()).toBe('');
  });

  it.each(['healthy', 'failed', 'rejected'] as const)('guards a %s refresh against a newer main error event', async (outcome) => {
    await mount();
    const refresh = deferred<HistoryResult<TerminalHistoryState>>();
    vi.mocked(bridge.getState).mockReturnValue(refresh.promise);
    vi.mocked(bridge.setEnabled).mockResolvedValue({ ok: false, error: 'cleanup' });
    await act(async () => toggle().click());
    expect(toggle().disabled).toBe(true);
    expect(status()).toContain('cleanup did not finish');
    act(() => emit(state(true, 'cleanup')));
    await act(async () => {
      if (outcome === 'healthy') refresh.resolve(ok(state(false)));
      else if (outcome === 'failed') refresh.resolve({ ok: false, error: 'unauthorized' });
      else refresh.reject(new Error('old refresh failed'));
    });
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(false);
    expect(status()).toContain('cleanup did not finish');
    expect(status()).not.toContain('unavailable');
  });

  it('keeps the current main error readable even while another toggle is pending', async () => {
    current = state(false, 'cleanup');
    await mount();
    vi.mocked(bridge.setEnabled).mockReturnValue(new Promise(() => {}));
    act(() => toggle().click());
    expect(status()).toContain('Updating');
    expect(status()).toContain('cleanup did not finish');
  });

  it('shows main broadcasts in both mounted consumers and unsubscribes on unmount', async () => {
    await mount();
    const secondHost = document.createElement('div');
    const second = createRoot(secondHost);
    await act(async () => second.render(React.createElement(TerminalSettings)));
    expect(listeners.size).toBe(2);
    act(() => emit(state(true)));
    expect(toggle().checked).toBe(true);
    expect(secondHost.querySelector<HTMLInputElement>('#terminal-history-enabled')!.checked).toBe(true);
    act(() => second.unmount());
    expect(listeners.size).toBe(1);
    act(() => root.unmount());
    expect(listeners.size).toBe(0);
    root = createRoot(host);
  });

  it.each(['absent', 'rejected', 'failed'] as const)('fails closed with useful feedback when state is %s', async (failure) => {
    if (failure === 'absent') window.wmux = {};
    else if (failure === 'rejected') vi.mocked(bridge.getState).mockRejectedValue(new Error('secret-path'));
    else vi.mocked(bridge.getState).mockResolvedValue({ ok: false, error: 'unauthorized' });
    await mount();
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(true);
    expect(status()).toContain('unavailable');
    expect(status()).not.toContain('secret-path');
    act(() => toggle().click());
    expect(bridge.setEnabled).not.toHaveBeenCalled();
  });

  it.each(['failed', 'rejected'] as const)('keeps incomplete cleanup visible when refresh is %s', async (failure) => {
    await mount();
    vi.mocked(bridge.setEnabled).mockResolvedValue({ ok: false, error: 'cleanup' });
    if (failure === 'failed') vi.mocked(bridge.getState).mockResolvedValue({ ok: false, error: 'unauthorized' });
    else vi.mocked(bridge.getState).mockRejectedValue(new Error('secret-path'));
    await act(async () => toggle().click());
    expect(toggle().disabled).toBe(true);
    expect(status()).toContain('cleanup did not finish');
    expect(status()).toContain('unavailable');
    expect(status()).not.toContain('secret-path');
  });

  it('keeps terminal imports working with partial preload fixtures without changing consent', async () => {
    window.wmux.config = { importWindowsTerminal: vi.fn(async () => ({ name: 'Imported fixture',
      background: '#000000', foreground: '#ffffff', cursor: '#ffffff' })) };
    await mount();
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'From Windows Terminal')!;
    await act(async () => button.click());
    expect(settings.setTerminalPrefs).toHaveBeenCalledWith(expect.objectContaining({ theme: 'Imported fixture' }));
    expect(bridge.setEnabled).not.toHaveBeenCalled();
    expect(toggle().checked).toBe(false);
  });

  it('handles rejected setters without unhandled promises', async () => {
    await mount();
    vi.mocked(bridge.setEnabled).mockRejectedValue(new Error('secret-output'));
    await act(async () => toggle().click());
    expect(toggle().disabled).toBe(true);
    expect(status()).toContain('unavailable');
    expect(status()).not.toContain('secret-output');
  });

  it('ignores seeds and toggle completions after unmount', async () => {
    await mount();
    const change = deferred<HistoryResult<TerminalHistoryState>>();
    vi.mocked(bridge.setEnabled).mockReturnValue(change.promise);
    act(() => toggle().click());
    act(() => root.unmount());
    expect(listeners.size).toBe(0);
    await act(async () => { change.resolve({ ok: false, error: 'cleanup' }); });
    expect(bridge.getState).toHaveBeenCalledTimes(1);
    root = createRoot(host);
    const seed = deferred<HistoryResult<TerminalHistoryState>>();
    vi.mocked(bridge.getState).mockReturnValue(seed.promise);
    await mount();
    act(() => root.unmount());
    await act(async () => { seed.resolve(ok(state(true))); });
    expect(host.textContent).toBe('');
    root = createRoot(host);
  });
});
