import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '../../src/renderer/store';
import { tryReplaceTabSpawn } from '../../src/renderer/App';
import { WorkspaceId, PaneId, SurfaceId, WorkspaceInfo } from '../../src/shared/types';

// Issue #4 (continued), blocker 1 from external review: `--replace-tab` agent
// spawn (PR #85) destroys the pane's sole idle terminal directly via
// `pty.kill`, bypassing `closeSurface` entirely — so the ownership-gated PR
// badge clear that `closeSurface` runs never fires. If that terminal happened
// to be the surface that reported the workspace's PR, `prSurfaceId` is left
// naming a surface that no longer exists. Because `clear_pr` is only honoured
// from its recorded owner (pr-metadata.ts), nothing — not even a fresh
// `report_pr`/`clear_pr` pair from another pane — can ever clear it again.

describe('tryReplaceTabSpawn PR badge teardown', () => {
  let kill: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    kill = vi.fn();
    (globalThis as any).window = { wmux: { pty: { kill } } };
    useStore.setState({ workspaces: [], activeWorkspaceId: null, agentMeta: new Map() } as any);
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  function setup() {
    const workspaceId = useStore.getState().createWorkspace({ title: 'Test WS' });
    const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId) as WorkspaceInfo;
    const paneId = (ws.splitTree as Extract<typeof ws.splitTree, { type: 'leaf' }>).paneId as PaneId;
    const soleSurfaceId = (ws.splitTree as Extract<typeof ws.splitTree, { type: 'leaf' }>).surfaces[0].id;
    return { workspaceId, paneId, soleSurfaceId };
  }

  function setAgentMeta(surfaceId: any, meta: any) {
    useStore.setState((state) => {
      const next = new Map(state.agentMeta);
      next.set(surfaceId, meta);
      return { agentMeta: next } as any;
    });
  }

  it('clears the PR badge when the replaced sole terminal was the owner', () => {
    const { workspaceId, paneId, soleSurfaceId } = setup();
    useStore.getState().updateWorkspaceMetadata(workspaceId, {
      prNumber: 7,
      prStatus: 'open',
      prLabel: 'Some PR',
      prSurfaceId: soleSurfaceId,
    });
    const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId) as WorkspaceInfo;

    const event = {
      type: 'spawned',
      replaceTab: true,
      surfaceId: 'surf-agent' as SurfaceId,
      paneId,
      workspaceId,
      agentId: 'agent-1',
      label: 'Agent',
    };

    const handled = tryReplaceTabSpawn(event, ws, setAgentMeta);

    expect(handled).toBe(true);
    expect(kill).toHaveBeenCalledWith(soleSurfaceId);
    const updated = useStore.getState().workspaces.find((w) => w.id === workspaceId) as WorkspaceInfo;
    expect(updated.prNumber).toBeUndefined();
    expect(updated.prSurfaceId).toBeUndefined();
  });

  it('leaves the PR badge alone when a different surface owns it', () => {
    const { workspaceId, paneId, soleSurfaceId } = setup();
    const otherOwner = 'surf-other-owner' as SurfaceId;
    useStore.getState().updateWorkspaceMetadata(workspaceId, {
      prNumber: 7,
      prStatus: 'open',
      prLabel: 'Some PR',
      prSurfaceId: otherOwner,
    });
    const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId) as WorkspaceInfo;

    const event = {
      type: 'spawned',
      replaceTab: true,
      surfaceId: 'surf-agent-2' as SurfaceId,
      paneId,
      workspaceId,
      agentId: 'agent-2',
      label: 'Agent',
    };

    const handled = tryReplaceTabSpawn(event, ws, setAgentMeta);

    expect(handled).toBe(true);
    expect(kill).toHaveBeenCalledWith(soleSurfaceId);
    const updated = useStore.getState().workspaces.find((w) => w.id === workspaceId) as WorkspaceInfo;
    expect(updated.prNumber).toBe(7);
    expect(updated.prSurfaceId).toBe(otherOwner);
  });
});
