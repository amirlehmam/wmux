import { StateCreator } from 'zustand';
import { v4 as uuid } from 'uuid';
import { NotificationInfo, SurfaceId, WorkspaceId } from '../../shared/types';
import { WorkspaceSlice } from './workspace-slice';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NotificationSlice {
  notifications: NotificationInfo[];
  addNotification: (notification: Omit<NotificationInfo, 'id' | 'timestamp' | 'read'>) => void;
  markRead: (surfaceId: SurfaceId) => void;
  markAllRead: (workspaceId?: WorkspaceId) => void;
  clearNotification: (id: string) => void;
  clearAll: () => void;
  jumpToUnread: () => NotificationInfo | null;
}

// ─── Slice creator ───────────────────────────────────────────────────────────

export const createNotificationSlice: StateCreator<
  NotificationSlice & WorkspaceSlice,
  [],
  [],
  NotificationSlice
> = (set, get) => ({
  notifications: [],

  addNotification(notification: Omit<NotificationInfo, 'id' | 'timestamp' | 'read'>): void {
    const newNotification: NotificationInfo = {
      ...notification,
      id: `notif-${uuid()}`,
      timestamp: Date.now(),
      read: false,
    };

    set((state) => ({
      notifications: [...state.notifications, newNotification],
    }));

    // Increment unreadCount on the workspace
    const { workspaceId } = notification;
    const state = get();
    const workspace = state.workspaces.find((w) => w.id === workspaceId);
    if (workspace) {
      state.updateWorkspaceMetadata(workspaceId, {
        unreadCount: workspace.unreadCount + 1,
      });
    }
  },

  markRead(surfaceId: SurfaceId): void {
    const state = get();
    const toMark = state.notifications.filter(
      (n) => n.surfaceId === surfaceId && !n.read,
    );

    if (toMark.length === 0) return;

    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.surfaceId === surfaceId ? { ...n, read: true } : n,
      ),
    }));

    // Decrement unreadCount per workspace
    const countsByWorkspace = new Map<WorkspaceId, number>();
    for (const n of toMark) {
      countsByWorkspace.set(
        n.workspaceId,
        (countsByWorkspace.get(n.workspaceId) ?? 0) + 1,
      );
    }

    const currentState = get();
    for (const [workspaceId, count] of countsByWorkspace) {
      const workspace = currentState.workspaces.find((w) => w.id === workspaceId);
      if (workspace) {
        currentState.updateWorkspaceMetadata(workspaceId, {
          unreadCount: Math.max(0, workspace.unreadCount - count),
        });
      }
    }
  },

  markAllRead(workspaceId?: WorkspaceId): void {
    const state = get();
    const toMark = state.notifications.filter(
      (n) => !n.read && (workspaceId === undefined || n.workspaceId === workspaceId),
    );

    if (toMark.length === 0) return;

    set((state) => ({
      notifications: state.notifications.map((n) => {
        if (!n.read && (workspaceId === undefined || n.workspaceId === workspaceId)) {
          return { ...n, read: true };
        }
        return n;
      }),
    }));

    // Reset unreadCount on affected workspaces
    const currentState = get();
    if (workspaceId) {
      currentState.updateWorkspaceMetadata(workspaceId, { unreadCount: 0 });
    } else {
      for (const workspace of currentState.workspaces) {
        if (workspace.unreadCount > 0) {
          currentState.updateWorkspaceMetadata(workspace.id, { unreadCount: 0 });
        }
      }
    }
  },

  clearNotification(id: string): void {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },

  clearAll(): void {
    set({ notifications: [] });
  },

  jumpToUnread(): NotificationInfo | null {
    const state = get();
    const unread = state.notifications.filter((n) => !n.read);
    if (unread.length === 0) return null;
    return unread[unread.length - 1];
  },
});
