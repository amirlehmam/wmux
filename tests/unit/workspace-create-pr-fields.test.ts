import { describe, it, expect } from 'vitest';
import { create } from 'zustand';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { SurfaceId } from '../../src/shared/types';

// Issue #4, small consistency gap flagged by external review: createWorkspace
// copied prNumber/prStatus/prLabel from options but not prSurfaceId. No
// current caller passes PR fields into createWorkspace, so this was latent —
// but a workspace created WITH a PR and no recorded owner would carry a badge
// nothing could ever clear, since `clear_pr` is only honoured from the
// surface named in `ws.prSurfaceId` (see pr-metadata.ts). Keeping all four PR
// fields copied together (or none of them) keeps that invariant true no
// matter how a workspace gets created.

function makeStore() {
  return create<WorkspaceSlice>()((...args) => ({ ...createWorkspaceSlice(...args) }));
}

describe('createWorkspace PR field consistency', () => {
  it('copies prSurfaceId alongside the other PR fields when options provide one', () => {
    const store = makeStore();
    const owner = 'surf-owner-1' as SurfaceId;
    const id = store.getState().createWorkspace({
      prNumber: 99,
      prStatus: 'open',
      prLabel: 'Some PR',
      prSurfaceId: owner,
    });
    const ws = store.getState().workspaces.find((w) => w.id === id)!;
    expect(ws.prNumber).toBe(99);
    expect(ws.prSurfaceId).toBe(owner);
  });

  it('leaves prSurfaceId unset when no PR fields are given at all', () => {
    const store = makeStore();
    const id = store.getState().createWorkspace({ title: 'Plain' });
    const ws = store.getState().workspaces.find((w) => w.id === id)!;
    expect(ws.prNumber).toBeUndefined();
    expect(ws.prSurfaceId).toBeUndefined();
  });
});
