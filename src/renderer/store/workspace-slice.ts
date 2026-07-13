import { StateCreator } from 'zustand';
import { v4 as uuid } from 'uuid';
import { WorkspaceId, WorkspaceInfo, SplitNode } from '../../shared/types';
import { createLeaf } from './split-utils';
import { killTreeTerminalPtys } from './pty-teardown';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkspaceSlice {
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: WorkspaceId | null;
  /**
   * Sessions queued behind the close-confirmation dialog (issue #90). Non-empty
   * only while the dialog is up; "Close others" funnels every victim in here so
   * the user confirms the batch once instead of racing N dialogs. Runtime-only.
   */
  pendingCloseWorkspaceIds: WorkspaceId[];

  createWorkspace(options?: Partial<WorkspaceInfo>): WorkspaceId;
  closeWorkspace(id: WorkspaceId): void;
  /**
   * Close a workspace on behalf of a USER gesture (sidebar ×, context menu,
   * Ctrl+Shift+W). Honours the opt-in `confirmWorkspaceClose` pref by parking
   * the id in `pendingCloseWorkspaceIds` for the dialog instead of closing.
   * Programmatic closes (CLI/agents via pipe-bridge) call closeWorkspace()
   * directly and never prompt.
   */
  requestCloseWorkspace(id: WorkspaceId): void;
  /** Dialog "Close" button: close everything queued and dismiss. */
  confirmPendingClose(): void;
  /** Dialog "Cancel" / Escape: drop the queue, close nothing. */
  cancelPendingClose(): void;
  selectWorkspace(id: WorkspaceId): void;
  renameWorkspace(id: WorkspaceId, title: string): void;
  reorderWorkspaces(ids: WorkspaceId[]): void;
  updateWorkspaceMetadata(id: WorkspaceId, partial: Partial<WorkspaceInfo>): void;
  updateSplitTree(id: WorkspaceId, tree: SplitNode): void;
  replaceAllWorkspaces(workspaces: Array<Partial<WorkspaceInfo>>, activeIndex?: number): void;
}

// ─── Slice creator ───────────────────────────────────────────────────────────

export const createWorkspaceSlice: StateCreator<WorkspaceSlice> = (set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  pendingCloseWorkspaceIds: [],

  createWorkspace(options = {}): WorkspaceId {
    const id: WorkspaceId = `ws-${uuid()}`;
    const splitTree = options.splitTree ?? createLeaf();
    const workspace: WorkspaceInfo = {
      id,
      title: options.title ?? `Workspace ${get().workspaces.length + 1}`,
      pinned: options.pinned ?? false,
      shell: options.shell || '',
      splitTree,
      unreadCount: options.unreadCount ?? 0,
      customColor: options.customColor,
      gitBranch: options.gitBranch,
      gitDirty: options.gitDirty,
      cwd: options.cwd,
      prNumber: options.prNumber,
      prStatus: options.prStatus,
      prLabel: options.prLabel,
      ports: options.ports,
      notificationText: options.notificationText,
      shellState: options.shellState,
    };

    set((state) => {
      const isFirst = state.workspaces.length === 0;
      return {
        workspaces: [...state.workspaces, workspace],
        activeWorkspaceId: isFirst ? id : state.activeWorkspaceId,
      };
    });

    return id;
  },

  closeWorkspace(id: WorkspaceId): void {
    // Reap every shell in the workspace before dropping its subtree (issue #65).
    // Closing a workspace (Ctrl+Shift+W, sidebar ×, `wmux close-workspace`) used
    // to discard the entire split tree WITHOUT killing any of its PTYs, orphaning
    // every pane's wrapper shell for the life of the app.
    const closing = get().workspaces.find((w) => w.id === id);
    if (closing) killTreeTerminalPtys(closing.splitTree);

    set((state) => {
      const idx = state.workspaces.findIndex((w) => w.id === id);
      if (idx === -1) return state;

      const next = state.workspaces.filter((w) => w.id !== id);

      let nextActiveId = state.activeWorkspaceId;
      if (state.activeWorkspaceId === id) {
        // Pick neighbour: prefer the one after, then before
        if (next.length === 0) {
          nextActiveId = null;
        } else {
          const newIdx = Math.min(idx, next.length - 1);
          nextActiveId = next[newIdx].id;
        }
      }

      return { workspaces: next, activeWorkspaceId: nextActiveId };
    });
  },

  requestCloseWorkspace(id: WorkspaceId): void {
    // The pref lives in the settings slice; the composed store carries both
    // slices at runtime, but this creator is only typed for its own slice.
    const prefs = (get() as unknown as { workspacePrefs?: { confirmWorkspaceClose?: boolean } })
      .workspacePrefs;
    if (!prefs?.confirmWorkspaceClose) {
      get().closeWorkspace(id);
      return;
    }
    set((state) => ({
      pendingCloseWorkspaceIds: state.pendingCloseWorkspaceIds.includes(id)
        ? state.pendingCloseWorkspaceIds
        : [...state.pendingCloseWorkspaceIds, id],
    }));
  },

  confirmPendingClose(): void {
    const ids = get().pendingCloseWorkspaceIds;
    set({ pendingCloseWorkspaceIds: [] });
    ids.forEach((id) => get().closeWorkspace(id));
  },

  cancelPendingClose(): void {
    set({ pendingCloseWorkspaceIds: [] });
  },

  selectWorkspace(id: WorkspaceId): void {
    set({ activeWorkspaceId: id });
  },

  renameWorkspace(id: WorkspaceId, title: string): void {
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, title } : w)),
    }));
  },

  reorderWorkspaces(ids: WorkspaceId[]): void {
    set((state) => {
      const map = new Map(state.workspaces.map((w) => [w.id, w]));
      const reordered = ids.flatMap((id) => {
        const w = map.get(id);
        return w ? [w] : [];
      });
      return { workspaces: reordered };
    });
  },

  updateWorkspaceMetadata(id: WorkspaceId, partial: Partial<WorkspaceInfo>): void {
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, ...partial } : w)),
    }));
  },

  updateSplitTree(id: WorkspaceId, tree: SplitNode): void {
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === id ? { ...w, splitTree: tree } : w)),
    }));
  },

  replaceAllWorkspaces(workspaceConfigs: Array<Partial<WorkspaceInfo>>, activeIndex?: number): void {
    const newWorkspaces: WorkspaceInfo[] = workspaceConfigs.map((config, i) => ({
      id: `ws-${uuid()}` as WorkspaceId,
      title: config.title ?? `Workspace ${i + 1}`,
      pinned: config.pinned ?? false,
      shell: config.shell || '',
      splitTree: config.splitTree ?? createLeaf(),
      unreadCount: 0,
      customColor: config.customColor,
      cwd: config.cwd,
      browserUrl: config.browserUrl,
      browserWidth: config.browserWidth,
    }));

    // IDs are regenerated above, so a saved activeWorkspaceId is meaningless —
    // callers pass the index of the previously-active workspace instead.
    const clampedIndex =
      typeof activeIndex === 'number' && newWorkspaces.length > 0
        ? Math.max(0, Math.min(activeIndex, newWorkspaces.length - 1))
        : 0;

    set({
      workspaces: newWorkspaces,
      activeWorkspaceId: newWorkspaces.length > 0 ? newWorkspaces[clampedIndex].id : null,
    });
  },
});
