import { StateCreator } from 'zustand';
import { v4 as uuid } from 'uuid';
import { WorkspaceId, WorkspaceInfo, SplitNode } from '../../shared/types';
import { createLeaf } from './split-utils';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkspaceSlice {
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: WorkspaceId | null;

  createWorkspace(options?: Partial<WorkspaceInfo>): WorkspaceId;
  closeWorkspace(id: WorkspaceId): void;
  selectWorkspace(id: WorkspaceId): void;
  renameWorkspace(id: WorkspaceId, title: string): void;
  reorderWorkspaces(ids: WorkspaceId[]): void;
  updateWorkspaceMetadata(id: WorkspaceId, partial: Partial<WorkspaceInfo>): void;
  updateSplitTree(id: WorkspaceId, tree: SplitNode): void;
}

// ─── Slice creator ───────────────────────────────────────────────────────────

export const createWorkspaceSlice: StateCreator<WorkspaceSlice> = (set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,

  createWorkspace(options = {}): WorkspaceId {
    const id: WorkspaceId = `ws-${uuid()}`;
    const splitTree = options.splitTree ?? createLeaf();
    const workspace: WorkspaceInfo = {
      id,
      title: options.title ?? `Workspace ${get().workspaces.length + 1}`,
      pinned: options.pinned ?? false,
      shell: options.shell ?? 'pwsh.exe',
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
});
