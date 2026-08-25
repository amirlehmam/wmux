import { describe, it, expect, vi } from 'vitest';
import { focusAgentTarget } from '../../src/renderer/store/focus-agent';
import type { AgentFocusOps } from '../../src/renderer/store/focus-agent';
import { SplitNode, PaneId, SurfaceId, WorkspaceId, WorkspaceInfo } from '../../src/shared/types';

const leaf = (paneId: string, surfaceIds: string[], activeSurfaceIndex = 0): SplitNode => ({
  type: 'leaf',
  paneId: paneId as PaneId,
  surfaces: surfaceIds.map((id) => ({ id, type: 'terminal' } as any)),
  activeSurfaceIndex,
} as SplitNode);

const split = (a: SplitNode, b: SplitNode): SplitNode => ({
  type: 'branch', direction: 'horizontal', ratio: 0.5, children: [a, b],
});

const ws = (id: string, splitTree: SplitNode): WorkspaceInfo => ({
  id: id as WorkspaceId, title: id, pinned: false, shell: 'pwsh', splitTree, unreadCount: 0,
} as WorkspaceInfo);

const opsFor = (workspaces: WorkspaceInfo[]): AgentFocusOps & {
  selectWorkspace: ReturnType<typeof vi.fn>;
  selectSurface: ReturnType<typeof vi.fn>;
} => ({
  workspaces,
  selectWorkspace: vi.fn(),
  selectSurface: vi.fn(),
});

const target = (workspaceId: string, paneId: string, surfaceId: string) => ({
  workspaceId: workspaceId as WorkspaceId,
  paneId: paneId as PaneId,
  surfaceId: surfaceId as SurfaceId,
});

describe('focusAgentTarget', () => {
  it('selects the workspace and returns the pane to focus', () => {
    const ops = opsFor([ws('ws-1', leaf('pane-1', ['surf-a']))]);
    const pane = focusAgentTarget(ops, target('ws-1', 'pane-1', 'surf-a'));

    expect(pane).toBe('pane-1');
    expect(ops.selectWorkspace).toHaveBeenCalledWith('ws-1');
    expect(ops.selectSurface).toHaveBeenCalledWith('ws-1', 'pane-1', 0);
  });

  /**
   * The reason this helper exists. Keep-alive tabs keep every surface in a pane
   * mounted, so focusing the pane without raising the tab lands the user beside
   * the blocked prompt with nothing to indicate why they cannot see it.
   */
  it('raises the tab when the agent sits in a background surface', () => {
    const ops = opsFor([ws('ws-1', leaf('pane-1', ['surf-a', 'surf-b', 'surf-c'], 0))]);
    focusAgentTarget(ops, target('ws-1', 'pane-1', 'surf-c'));
    expect(ops.selectSurface).toHaveBeenCalledWith('ws-1', 'pane-1', 2);
  });

  it('finds the surface even when the roster names a stale pane', () => {
    // A tab dragged to another pane between the render and the click.
    const ops = opsFor([ws('ws-1', split(leaf('pane-1', ['surf-a']), leaf('pane-2', ['surf-moved'])))]);
    const pane = focusAgentTarget(ops, target('ws-1', 'pane-1', 'surf-moved'));

    expect(pane).toBe('pane-2');
    expect(ops.selectSurface).toHaveBeenCalledWith('ws-1', 'pane-2', 0);
  });

  it('returns null and touches nothing when the workspace is gone', () => {
    const ops = opsFor([ws('ws-1', leaf('pane-1', ['surf-a']))]);
    expect(focusAgentTarget(ops, target('ws-gone', 'pane-1', 'surf-a'))).toBeNull();
    expect(ops.selectWorkspace).not.toHaveBeenCalled();
    expect(ops.selectSurface).not.toHaveBeenCalled();
  });

  /**
   * Focusing "something nearby" would move the user somewhere they did not ask
   * to go, which is worse than the click appearing to do nothing.
   */
  it('returns null and touches nothing when the surface is gone', () => {
    const ops = opsFor([ws('ws-1', leaf('pane-1', ['surf-a']))]);
    expect(focusAgentTarget(ops, target('ws-1', 'pane-1', 'surf-closed'))).toBeNull();
    expect(ops.selectWorkspace).not.toHaveBeenCalled();
    expect(ops.selectSurface).not.toHaveBeenCalled();
  });
});
