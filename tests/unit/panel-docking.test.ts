import { describe, expect, it } from 'vitest';
import type { SurfaceRef } from '../../src/shared/types';
import { dockPanelInWorkspace } from '../../src/renderer/components/SplitPane/panel-docking';
import { createLeaf, findLeaf, instantiateLayout } from '../../src/renderer/store/split-utils';
import { moveSurfaceToWorkspaceEdge } from '../../src/renderer/store/split-preview-utils';
import { useStore } from '../../src/renderer/store';

describe('panels promoted to workspace tiles (#405)', () => {
  it('preserves terminal identity and browser history while enabling edge moves', () => {
    const original = createLeaf('pane-terminal');
    const panel: SurfaceRef = { id: 'surf-browser', type: 'browser', url: 'https://example.org/two',
      browserHistory: { index: 1, entries: [{ url: 'https://example.org/one', title: 'one' }, { url: 'https://example.org/two', title: 'two' }] } };
    const docked = dockPanelInWorkspace(original, panel, 'pane-browser');
    expect(findLeaf(docked, 'pane-terminal')).toBe(original);
    const moved = moveSurfaceToWorkspaceEdge(docked, 'pane-browser', panel.id, 'down', 'pane-bottom')!;
    expect(findLeaf(moved.tree, 'pane-terminal')).toBe(original);
    expect(findLeaf(moved.tree, 'pane-bottom')?.surfaces[0]).toBe(panel);
  });

  it('restores a docked explorer and remaps its jailed terminal reference for saved layouts', () => {
    const terminal = createLeaf('pane-terminal');
    const panel: SurfaceRef = { id: 'surf-explorer', type: 'explorer', explorerRootSurfaceId: terminal.surfaces[0].id };
    const docked = dockPanelInWorkspace(terminal, panel, 'pane-explorer');
    useStore.getState().replaceAllWorkspaces([{ id: 'ws-dock', title: 'dock', splitTree: docked, browserPanelDocked: true }]);
    expect(useStore.getState().workspaces[0].browserPanelDocked).toBe(true);
    const restored = useStore.getState().workspaces[0].splitTree;
    expect(findLeaf(restored, 'pane-explorer')?.surfaces[0]).toEqual(panel);
    const fresh = instantiateLayout(restored);
    if (fresh.type !== 'branch' || fresh.children[0].type !== 'leaf' || fresh.children[1].type !== 'leaf') throw new Error('expected two leaves');
    expect(fresh.children[1].surfaces[0].explorerRootSurfaceId).toBe(fresh.children[0].surfaces[0].id);
    expect(fresh.children[1].surfaces[0].explorerRootSurfaceId).not.toBe(panel.explorerRootSurfaceId);
  });
});
