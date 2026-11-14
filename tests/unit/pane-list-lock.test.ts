import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneId, SplitNode, SurfaceId, WorkspaceId, WorkspaceInfo } from '../../src/shared/types';

vi.mock('../../src/renderer/hooks/useTerminal', () => ({
  surfaceTerminalRegistry: new Map(),
  showPaneNotice: () => {},
}));

import { useStore } from '../../src/renderer/store';
import { initPipeBridge } from '../../src/renderer/pipe-bridge';
import { getAllPaneIds } from '../../src/renderer/store/split-utils';

const WS = 'ws-lock' as WorkspaceId;
const leaf = (id: string, locked = false): SplitNode => ({
  type: 'leaf',
  paneId: id as PaneId,
  activeSurfaceIndex: 0,
  surfaces: [{ id: `surf-${id}` as SurfaceId, type: 'terminal' }],
  ...(locked ? { locked: true } : {}),
});
const split = (a: SplitNode, b: SplitNode): SplitNode => ({
  type: 'split', direction: 'horizontal', ratio: 0.5, children: [a, b],
} as SplitNode);

const workspace = (splitTree: SplitNode): WorkspaceInfo => ({
  id: WS, title: 'W', titleIsDefault: true, pinned: false, shell: 'pwsh', unreadCount: 0, cwd: 'C:\\repo', splitTree,
});

interface Bridge {
  __wmux_listPanes: (workspaceId?: string) => Array<Record<string, unknown>>;
  __wmux_layoutGrid: (params: { count: number }) => Record<string, unknown> | null;
  __wmux_layoutAgents: (params: { count: number; anchorPaneId?: string }) => Record<string, unknown> | null;
  __wmux_createSurface: (params?: { type?: string; paneId?: string; workspaceId?: string }) => Record<string, unknown> | null;
}
const bridge = () => globalThis.window as unknown as Bridge;
const tree = () => useStore.getState().workspaces[0].splitTree;

function load(splitTree: SplitNode): void {
  useStore.setState({ workspaces: [workspace(splitTree)], activeWorkspaceId: WS });
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).window = {};
  (globalThis as Record<string, unknown>).document = { querySelector: () => null };
  initPipeBridge();
});

describe('pane list lock flag (AC20)', () => {
  it('marks a locked pane and leaves the key off an unlocked one', () => {
    load(split(leaf('pane-a', true), leaf('pane-b')));
    const [a, b] = bridge().__wmux_listPanes();
    expect(a.locked).toBe(true);
    expect('locked' in b).toBe(false);
  });
});

describe('layout grid on locked panes (AC18)', () => {
  it('refuses and leaves the tree untouched when any pane is locked', () => {
    load(split(leaf('pane-a'), leaf('pane-b', true)));
    const before = tree();
    const result = bridge().__wmux_layoutGrid({ count: 4 });
    expect(result).toEqual({ error: 'Workspace has locked panes; unlock them or use layout agents' });
    expect(tree()).toBe(before);
  });

  it('still builds the grid when nothing is locked', () => {
    load(split(leaf('pane-a'), leaf('pane-b')));
    const result = bridge().__wmux_layoutGrid({ count: 4 });
    expect(result).not.toHaveProperty('error');
    expect(getAllPaneIds(tree()).length).toBeGreaterThan(2);
  });
});

const surfaceCount = (paneId: string) =>
  (bridge().__wmux_listPanes().find((p) => p.paneId === paneId)?.tabCount as number);

describe('new-surface placement (AC25, AC26)', () => {
  it('skips a locked first pane and opens in the first unlocked one', () => {
    load(split(leaf('pane-a', true), split(leaf('pane-b'), leaf('pane-c'))));
    const result = bridge().__wmux_createSurface();
    expect(result?.paneId).toBe('pane-b');
    expect(surfaceCount('pane-a')).toBe(1);
    expect(surfaceCount('pane-b')).toBe(2);
    expect(surfaceCount('pane-c')).toBe(1);
  });

  it('opens in the first pane when nothing is locked, as before', () => {
    load(split(leaf('pane-a'), leaf('pane-b')));
    expect(bridge().__wmux_createSurface()?.paneId).toBe('pane-a');
  });

  it('answers an error and creates nothing when every pane is locked', () => {
    load(split(leaf('pane-a', true), leaf('pane-b', true)));
    const before = tree();
    const result = bridge().__wmux_createSurface();
    expect(result).toEqual({ error: `No unlocked panes in workspace ${WS}` });
    expect(tree()).toBe(before);
  });

  it('still opens in a locked pane that is named explicitly', () => {
    load(split(leaf('pane-a', true), leaf('pane-b')));
    const result = bridge().__wmux_createSurface({ paneId: 'pane-a' });
    expect(result?.paneId).toBe('pane-a');
    expect(surfaceCount('pane-a')).toBe(2);
  });
});

describe('layout agents with a locked anchor (AC19)', () => {
  it('succeeds and keeps the anchor locked', () => {
    load(leaf('pane-a', true));
    const result = bridge().__wmux_layoutAgents({ count: 2, anchorPaneId: 'pane-a' });
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('error');
    const paneIds = getAllPaneIds(tree());
    expect(paneIds.length).toBeGreaterThan(1);
    const locked = bridge().__wmux_listPanes().filter((p) => p.locked === true);
    expect(locked.map((p) => p.paneId)).toEqual(['pane-a']);
  });
});
