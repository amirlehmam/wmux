// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaneId } from '../../src/shared/types';
import { useKeyboardShortcuts } from '../../src/renderer/hooks/useKeyboardShortcuts';
import { useStore } from '../../src/renderer/store';
import { createLeaf, findLeaf, getAllPaneIds } from '../../src/renderer/store/split-utils';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * PR #383: a split from the keyboard focuses the pane it created, so the first
 * keystroke after Ctrl+D goes to the new shell. And only when a split really
 * happened: splitNode returns the same tree for a pane it cannot find, and
 * focusing the minted id then would leave focus on a pane that does not exist.
 */
function Probe({ paneId, onFocusPane }: { paneId: PaneId; onFocusPane: (id: PaneId) => void }) {
  useKeyboardShortcuts(paneId, undefined, undefined, undefined, onFocusPane);
  return null;
}

let root: Root;
let host: HTMLDivElement;
let focused: PaneId[];

function pressSplitRight(): void {
  const event = new KeyboardEvent('keydown', {
    key: 'd', code: 'KeyD', ctrlKey: true, bubbles: true, cancelable: true,
  });
  act(() => { document.body.dispatchEvent(event); });
}

function mount(paneId: PaneId): void {
  act(() => root.render(createElement(Probe, { paneId, onFocusPane: (id) => { focused.push(id); } })));
}

beforeEach(() => {
  focused = [];
  useStore.setState({ language: 'en', workspaces: [], activeWorkspaceId: null });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe.each([
  { action: 'split right', key: 'd', shiftKey: false },
  { action: 'split down', key: 'd', shiftKey: true },
  { action: 'new tab', key: 't', shiftKey: false },
])('$action shell inheritance', ({ key, shiftKey }) => {
  it('inherits the active terminal launch spec', () => {
    const leaf = createLeaf();
    leaf.surfaces[0].shell = 'cmd.exe';
    leaf.surfaces.push({
      id: 'surf-active' as any,
      type: 'terminal',
      launchShell: 'wsl.exe -d Ubuntu',
      resolvedShell: 'C:\\Windows\\System32\\wsl.exe',
    });
    leaf.activeSurfaceIndex = 1;
    useStore.getState().createWorkspace({ title: 'ws', shell: 'powershell.exe', splitTree: leaf });
    mount(leaf.paneId);

    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', {
        key, ctrlKey: true, shiftKey, bubbles: true, cancelable: true,
      }));
    });

    const tree = useStore.getState().workspaces[0].splitTree;
    const targetPane = key === 't' ? leaf.paneId : focused[0];
    const target = findLeaf(tree, targetPane)!;
    const created = target.surfaces[target.activeSurfaceIndex];
    expect(created.id).not.toBe('surf-active');
    expect(created.shell).toBe('wsl.exe -d Ubuntu');
  });
});

describe('split focus (PR #383)', () => {
  it('Ctrl+D focuses the pane the split created', () => {
    const leaf = createLeaf();
    useStore.getState().createWorkspace({ title: 'ws', shell: 'pwsh', splitTree: leaf });
    mount(leaf.paneId);
    pressSplitRight();
    const panes = getAllPaneIds(useStore.getState().workspaces[0].splitTree);
    expect(panes).toHaveLength(2);
    const created = panes.find((p) => p !== leaf.paneId);
    expect(focused).toEqual([created]);
  });

  it('a split that does not happen moves no focus', () => {
    const leaf = createLeaf();
    useStore.getState().createWorkspace({ title: 'ws', shell: 'pwsh', splitTree: leaf });
    mount('pane-not-in-tree' as PaneId);
    pressSplitRight();
    expect(getAllPaneIds(useStore.getState().workspaces[0].splitTree)).toEqual([leaf.paneId]);
    expect(focused).toEqual([]);
  });
});
