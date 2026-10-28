// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ShortcutRecorder from '../../src/renderer/components/Settings/ShortcutRecorder';
import KeyboardSettings from '../../src/renderer/components/Settings/KeyboardSettings';
import { useStore } from '../../src/renderer/store';
import { DEFAULT_SHORTCUTS } from '../../src/renderer/store/settings-slice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Recorder() {
  const binding = useStore((s) => s.shortcuts.splitRight);
  return createElement(ShortcutRecorder, { action: 'splitRight', binding });
}

let root: Root;
let host: HTMLDivElement;
let persist: ReturnType<typeof vi.fn>;

beforeEach(() => {
  persist = vi.fn();
  Object.defineProperty(window, 'wmux', { configurable: true, value: { settings: { set: persist } } });
  useStore.setState({ language: 'en', shortcuts: { ...DEFAULT_SHORTCUTS } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(Recorder)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, 'wmux');
  localStorage.clear();
});

function click(selector: string): void {
  act(() => host.querySelector<HTMLButtonElement>(selector)!.click());
}

function press(key: string, modifiers: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
  act(() => document.dispatchEvent(event));
  return event;
}

describe('integrated shortcut unbind control', () => {
  it('clears only this binding and persists an explicit unbound entry', () => {
    click('.shortcut-recorder__action');
    expect(useStore.getState().shortcuts.splitRight).toEqual({ key: '' });
    expect(useStore.getState().shortcuts.splitDown).toEqual(DEFAULT_SHORTCUTS.splitDown);
    expect(persist).toHaveBeenLastCalledWith('wmux-shortcuts', expect.objectContaining({ splitRight: { key: '' } }));
    expect(host.querySelector('.shortcut-recorder__btn')!.textContent).toBe('+ Add shortcut');
    expect(host.querySelector('.shortcut-recorder__action')!.getAttribute('aria-label')).toBe('Restore default: Split right');
    expect(host.querySelector('.shortcut-recorder__control--unbound')).not.toBeNull();
  });

  it('restores the default without entering recording mode', () => {
    click('.shortcut-recorder__action');
    click('.shortcut-recorder__action');
    expect(useStore.getState().shortcuts.splitRight).toEqual(DEFAULT_SHORTCUTS.splitRight);
    expect(host.querySelector('.shortcut-recorder__btn')!.textContent).toBe('Ctrl+D');
    expect(host.querySelector('.shortcut-recorder__action')!.getAttribute('title')).toBe('Unbind shortcut');
    expect(host.querySelector('.shortcut-recorder__btn--recording')).toBeNull();
    expect(persist).toHaveBeenLastCalledWith('wmux-shortcuts', expect.objectContaining({ splitRight: DEFAULT_SHORTCUTS.splitRight }));
  });

  it('can cancel or record a new combination from the unbound state', () => {
    click('.shortcut-recorder__action');
    click('.shortcut-recorder__btn');
    press('Escape');
    expect(useStore.getState().shortcuts.splitRight).toEqual({ key: '' });
    click('.shortcut-recorder__btn');
    expect(press('Y', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(useStore.getState().shortcuts.splitRight).toEqual({ key: 'Y', ctrl: true, shift: true, alt: undefined });
    expect(host.querySelector('.shortcut-recorder__btn')!.textContent).toBe('Ctrl+Shift+Y');
  });

  it('stops capturing when cleared or when focus leaves the recorder', () => {
    click('.shortcut-recorder__btn');
    click('.shortcut-recorder__action');
    expect(press('F6').defaultPrevented).toBe(false);
    expect(useStore.getState().shortcuts.splitRight).toEqual({ key: '' });
    const recorder = host.querySelector<HTMLButtonElement>('.shortcut-recorder__btn')!;
    act(() => recorder.focus());
    click('.shortcut-recorder__btn');
    act(() => recorder.blur());
    expect(press('F7').defaultPrevented).toBe(false);
    expect(useStore.getState().shortcuts.splitRight).toEqual({ key: '' });
  });

  it('reports conflicts when restoring a default taken by another action', () => {
    click('.shortcut-recorder__action');
    act(() => useStore.getState().setShortcut('splitDown', DEFAULT_SHORTCUTS.splitRight));
    click('.shortcut-recorder__action');
    expect(host.querySelector('.shortcut-recorder__conflict')!.textContent).toBe('Conflicts with Split down');
    click('.shortcut-recorder__action');
    expect(host.querySelector('.shortcut-recorder__conflict')).toBeNull();
  });

  it('keeps an unbound action visible in the settings list', () => {
    click('.shortcut-recorder__action');
    act(() => root.render(createElement(KeyboardSettings)));
    const row = [...host.querySelectorAll('.shortcut-row')].find((r) => r.querySelector('.shortcut-action-label')!.textContent === 'Split right')!;
    expect(row.querySelector('.shortcut-recorder__btn')!.textContent).toBe('+ Add shortcut');
    expect(row.querySelector('.shortcut-recorder__action')!.getAttribute('title')).toBe('Restore default');
  });
});
