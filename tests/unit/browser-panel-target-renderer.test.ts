import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { WorkspaceId } from '../../src/shared/types';

vi.mock('../../src/renderer/hooks/useTerminal', () => ({ surfaceTerminalRegistry: new Map(), showPaneNotice: () => {} }));
import { useStore } from '../../src/renderer/store';
import { createLeaf } from '../../src/renderer/store/split-utils';
import { initPipeBridge } from '../../src/renderer/pipe-bridge';

let active: WorkspaceId, other: WorkspaceId;
const panel = (id?: string, reveal = false, caller?: string) => (window as any).__wmux_browserPanelTarget(id, reveal, caller);
const read = (id: WorkspaceId) => useStore.getState().workspaces.find((ws) => ws.id === id)!;

beforeEach(() => {
  vi.stubGlobal('window', {});
  useStore.setState({ workspaces: [], activeWorkspaceId: null });
  active = useStore.getState().createWorkspace({ browserOpen: true, splitTree: createLeaf() });
  other = useStore.getState().createWorkspace({ browserOpen: false, splitTree: createLeaf() });
  initPipeBridge();
});
afterEach(() => vi.unstubAllGlobals());

it('targets the active panel without a caller; only reveal opens a closed background panel', () => {
  expect(panel()).toEqual({ surfaceId: `browser-${active}` });
  expect(panel(other).error).toMatch(/closed/i);
  expect(read(other).browserOpen).toBe(false);
  const tree = read(other).splitTree;
  if (tree.type !== 'leaf') throw new Error('expected terminal pane');
  expect(panel(other, true, tree.surfaces[0].id)).toEqual({ surfaceId: `browser-${other}` });
  expect(useStore.getState().activeWorkspaceId).toBe(active);
  expect(read(other).splitTree).toBe(tree);
  expect(read(other)).toMatchObject({ browserOpen: true, browserPanelStartBlank: true });
  // A query against an already-open panel must not reset its browsing context.
  expect(read(active).browserPanelStartBlank).toBeUndefined();
});

it('refuses moved or closed callers; never undocks or falls back to a different workspace', () => {
  const source = read(active).splitTree;
  if (source.type !== 'leaf') throw new Error('expected terminal pane');
  expect(panel(other, true, source.surfaces[0].id).error).toMatch(/caller/i);
  expect(panel(other, true, 'removed').error).toMatch(/caller/i);
  expect(panel('removed', true).error).toMatch(/workspace/i);
  useStore.getState().updateWorkspaceMetadata(other, { browserPanelDocked: true });
  expect(panel(other, true).error).toMatch(/docked/i);
  expect(read(other)).toMatchObject({ browserOpen: false, browserPanelDocked: true });
});
