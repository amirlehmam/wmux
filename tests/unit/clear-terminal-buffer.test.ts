// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneId } from '../../src/shared/types';
import { useTerminal } from '../../src/renderer/hooks/useTerminal';
import { useKeyboardShortcuts } from '../../src/renderer/hooks/useKeyboardShortcuts';
import { useStore } from '../../src/renderer/store';
import { createLeaf } from '../../src/renderer/store/split-utils';
import { DEFAULT_SHORTCUTS } from '../../src/renderer/store/settings-slice';
import CommandPalette from '../../src/renderer/components/CommandPalette/CommandPalette';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let terminal: Terminal;
let otherTerminal: Terminal;
let surfaceId: string;
let paneId: PaneId;
const refs = new Map<string, React.RefObject<Terminal | null>>();

function Probe({ id }: { id: string }) {
  /** Attach a headless emulator after mount so the real event effect runs without a PTY or canvas. */
  const { xtermRef } = useTerminal({ surfaceId: id });
  refs.set(id, xtermRef);
  return null;
}

function ShortcutProbe() {
  useKeyboardShortcuts(paneId);
  return null;
}

function clear(id = surfaceId) {
  act(() => {
    document.dispatchEvent(new CustomEvent('wmux:clear-terminal-buffer', { detail: { surfaceId: id } }));
  });
}

function write(term: Terminal, text: string) {
  return new Promise<void>((resolve) => term.write(text, resolve));
}

function bufferText(term: Terminal) {
  return Array.from({ length: term.buffer.active.length }, (_, line) =>
    term.buffer.active.getLine(line)?.translateToString(true)).join('\n').trimEnd();
}

beforeEach(async () => {
  useStore.setState({ language: 'en', workspaces: [], activeWorkspaceId: null, shortcuts: { ...DEFAULT_SHORTCUTS } });
  const leaf = createLeaf();
  paneId = leaf.paneId;
  surfaceId = leaf.surfaces[0].id;
  useStore.getState().createWorkspace({ title: 'ws', shell: 'pwsh', splitTree: leaf });
  terminal = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  otherTerminal = new Terminal({ cols: 40, rows: 4 });
  await write(terminal, 'old output\r\n'.repeat(12) + 'PS> typed command');
  await write(otherTerminal, 'other output\r\nother prompt');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement('div', null,
    createElement(Probe, { id: surfaceId }),
    createElement(Probe, { id: 'surf-other' }),
    createElement(ShortcutProbe),
  )));
  refs.get(surfaceId)!.current = terminal;
  refs.get('surf-other')!.current = otherTerminal;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  refs.clear();
  terminal.dispose();
  otherTerminal.dispose();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

describe('Clear terminal buffer', () => {
  it('clears only the targeted buffer, preserves the cursor line and accepts further output', async () => {
    const sent = vi.fn();
    terminal.onData(sent);
    const marker = terminal.registerMarker(0)!;
    const cursorX = terminal.buffer.active.cursorX;
    expect(terminal.buffer.active.baseY).toBeGreaterThan(0);

    clear();

    expect(bufferText(terminal)).toBe('PS> typed command');
    expect(terminal.buffer.active.baseY).toBe(0);
    expect(terminal.buffer.active.cursorY).toBe(0);
    expect(terminal.buffer.active.cursorX).toBe(cursorX);
    expect(marker.isDisposed).toBe(true);
    expect(bufferText(otherTerminal)).toBe('other output\nother prompt');
    expect(sent).not.toHaveBeenCalled();
    await write(terminal, '\r\nnew output');
    expect(bufferText(terminal)).toBe('PS> typed command\nnew output');
  });

  it('has no default binding and works after assigning one', () => {
    expect(DEFAULT_SHORTCUTS.clearTerminalBuffer).toEqual({ key: '' });
    act(() => useStore.setState({ shortcuts: {
      ...DEFAULT_SHORTCUTS, clearTerminalBuffer: { key: 'k', ctrl: true, alt: true },
    } }));
    const event = new KeyboardEvent('keydown', {
      key: 'k', code: 'KeyK', ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
    });
    act(() => { document.body.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(bufferText(terminal)).toBe('PS> typed command');
  });

  it('ignores the shortcut when a non-terminal surface is active', () => {
    act(() => {
      const state = useStore.getState();
      state.addSurface(state.activeWorkspaceId!, paneId, 'browser');
      useStore.setState({ shortcuts: {
        ...DEFAULT_SHORTCUTS, clearTerminalBuffer: { key: 'k', ctrl: true, alt: true },
      } });
    });
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k', ctrlKey: true, altKey: true, bubbles: true,
    })); });
    expect(bufferText(terminal)).toContain('old output');
  });

  it('removes its event listener on unmount', () => {
    act(() => root.render(null));
    clear();
    expect(bufferText(terminal)).toContain('old output');
  });

  it('exposes the unbound action in the command palette', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const onAction = vi.fn();
    act(() => root.render(createElement(CommandPalette, { onClose: vi.fn(), onAction })));
    const input = host.querySelector('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Clear terminal buffer');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const item = Array.from(host.querySelectorAll('.command-palette__item')).find(
      (element) => element.textContent?.includes('Clear terminal buffer'),
    );
    expect(item).toBeDefined();
    act(() => { item!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(onAction).toHaveBeenCalledWith('clearTerminalBuffer');
  });
});
