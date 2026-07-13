import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { WorkspaceId } from '../../src/shared/types';

/**
 * Close-session guard (issue #90). requestCloseWorkspace is the path behind
 * every USER close gesture (sidebar ×, context menu, Ctrl+Shift+W): with the
 * opt-in pref off it must behave exactly like closeWorkspace (no behaviour
 * change for existing users); with it on, nothing closes until the dialog's
 * confirm action runs. Programmatic closes (pipe-bridge) call closeWorkspace
 * directly and are out of scope here by design.
 */

// The pref lives in the settings slice; the composed production store carries
// both. Tests fake just the field requestCloseWorkspace reads.
type TestStore = WorkspaceSlice & {
  workspacePrefs: { confirmWorkspaceClose: boolean };
};

function makeStore(confirmWorkspaceClose: boolean) {
  return create<TestStore>()((set, get, api) => ({
    ...createWorkspaceSlice(
      set as never,
      get as never,
      api as never,
    ),
    workspacePrefs: { confirmWorkspaceClose },
  }));
}

describe('workspace close guard (issue #90)', () => {
  describe('pref off (default)', () => {
    let useStore: ReturnType<typeof makeStore>;
    let wsId: WorkspaceId;

    beforeEach(() => {
      useStore = makeStore(false);
      wsId = useStore.getState().createWorkspace({ title: 'A' });
    });

    it('requestCloseWorkspace closes immediately, no pending state', () => {
      useStore.getState().requestCloseWorkspace(wsId);
      expect(useStore.getState().workspaces).toHaveLength(0);
      expect(useStore.getState().pendingCloseWorkspaceIds).toEqual([]);
    });
  });

  describe('pref on', () => {
    let useStore: ReturnType<typeof makeStore>;
    let wsId: WorkspaceId;

    beforeEach(() => {
      useStore = makeStore(true);
      wsId = useStore.getState().createWorkspace({ title: 'A' });
    });

    it('parks the id instead of closing', () => {
      useStore.getState().requestCloseWorkspace(wsId);
      expect(useStore.getState().workspaces).toHaveLength(1);
      expect(useStore.getState().pendingCloseWorkspaceIds).toEqual([wsId]);
    });

    it('confirmPendingClose closes everything queued and clears the queue', () => {
      const wsB = useStore.getState().createWorkspace({ title: 'B' });
      useStore.getState().requestCloseWorkspace(wsId);
      useStore.getState().requestCloseWorkspace(wsB);
      useStore.getState().confirmPendingClose();
      expect(useStore.getState().workspaces).toHaveLength(0);
      expect(useStore.getState().pendingCloseWorkspaceIds).toEqual([]);
    });

    it('cancelPendingClose closes nothing', () => {
      useStore.getState().requestCloseWorkspace(wsId);
      useStore.getState().cancelPendingClose();
      expect(useStore.getState().workspaces).toHaveLength(1);
      expect(useStore.getState().pendingCloseWorkspaceIds).toEqual([]);
    });

    it('deduplicates repeat requests for the same workspace', () => {
      useStore.getState().requestCloseWorkspace(wsId);
      useStore.getState().requestCloseWorkspace(wsId);
      expect(useStore.getState().pendingCloseWorkspaceIds).toEqual([wsId]);
    });

    it('"close others" style batch queues every victim for one dialog', () => {
      const wsB = useStore.getState().createWorkspace({ title: 'B' });
      const wsC = useStore.getState().createWorkspace({ title: 'C' });
      [wsB, wsC].forEach((id) => useStore.getState().requestCloseWorkspace(id));
      expect(useStore.getState().pendingCloseWorkspaceIds).toEqual([wsB, wsC]);
      useStore.getState().confirmPendingClose();
      expect(useStore.getState().workspaces.map((w) => w.id)).toEqual([wsId]);
    });
  });

  describe('without a settings slice (CLI-style composition)', () => {
    it('treats a missing pref as guard off', () => {
      const useStore = create<WorkspaceSlice>()((...args) => ({
        ...createWorkspaceSlice(...args),
      }));
      const wsId = useStore.getState().createWorkspace({ title: 'A' });
      useStore.getState().requestCloseWorkspace(wsId);
      expect(useStore.getState().workspaces).toHaveLength(0);
    });
  });
});
