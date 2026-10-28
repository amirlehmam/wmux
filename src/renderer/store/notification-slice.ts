import { StateCreator } from 'zustand';
import { v4 as uuid } from 'uuid';
import { NotificationInfo, SurfaceId, WorkspaceId } from '../../shared/types';
import { WorkspaceSlice } from './workspace-slice';

export const MAX_NOTIFICATIONS = 200;

/**
 * Bound the list at MAX_NOTIFICATIONS (issue #385).
 *
 * Read notifications go first, oldest first. The cap used to stop there, so a
 * list with more than 200 UNREAD entries grew without limit — and unread is the
 * normal state for an agent pane nobody has focused yet: every turn's Stop
 * posts one, and a notification for a pane or workspace that has since been
 * closed can never be read by focusing it. Hours of agents in background
 * workspaces piled them up for the life of the window, each addition copying
 * the whole array. Past the read ones, the oldest unread go too.
 */
export function capNotifications(list: NotificationInfo[]): {
  kept: NotificationInfo[];
  evictedUnread: NotificationInfo[];
} {
  let excess = list.length - MAX_NOTIFICATIONS;
  if (excess <= 0) return { kept: list, evictedUnread: [] };
  const evict = new Set<string>();
  for (const n of list) {
    if (excess === 0) break;
    if (n.read) { evict.add(n.id); excess--; }
  }
  const evictedUnread: NotificationInfo[] = [];
  for (const n of list) {
    if (excess === 0) break;
    if (!n.read) { evict.add(n.id); evictedUnread.push(n); excess--; }
  }
  return { kept: list.filter((n) => !evict.has(n.id)), evictedUnread };
}

/** Take dropped unread notifications back off their workspaces' counters. */
function decrementUnread(state: NotificationSlice & WorkspaceSlice, dropped: readonly NotificationInfo[]): void {
  if (dropped.length === 0) return;
  const counts = new Map<WorkspaceId, number>();
  for (const n of dropped) counts.set(n.workspaceId, (counts.get(n.workspaceId) ?? 0) + 1);
  for (const [workspaceId, count] of counts) {
    const workspace = state.workspaces.find((w) => w.id === workspaceId);
    if (workspace) {
      state.updateWorkspaceMetadata(workspaceId, { unreadCount: Math.max(0, workspace.unreadCount - count) });
    }
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NotificationSlice {
  notifications: NotificationInfo[];
  notificationFocusedSurface: SurfaceId | null;
  setNotificationFocusedSurface: (surfaceId: SurfaceId | null) => void;
  addNotification: (notification: Omit<NotificationInfo, 'id' | 'timestamp' | 'read'>) => NotificationInfo;
  markRead: (surfaceId: SurfaceId) => void;
  markAllRead: (workspaceId?: WorkspaceId) => void;
  clearNotification: (id: string) => void;
  clearAll: () => void;
  /** Drop every notification of a workspace that has been closed (#385). */
  clearWorkspaceNotifications: (workspaceId: WorkspaceId) => void;
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
  notificationFocusedSurface: null,

  setNotificationFocusedSurface(surfaceId): void {
    if (get().notificationFocusedSurface !== surfaceId) set({ notificationFocusedSurface: surfaceId });
  },

  addNotification(notification: Omit<NotificationInfo, 'id' | 'timestamp' | 'read'>): NotificationInfo {
    const { notificationFocusedSurface, activeWorkspaceId } = get();
    const read = !!notification.surfaceId
      && notification.surfaceId === notificationFocusedSurface
      && notification.workspaceId === activeWorkspaceId
      && typeof document !== 'undefined' && document.hasFocus();
    const newNotification: NotificationInfo = {
      ...notification,
      id: `notif-${uuid()}`,
      timestamp: Date.now(),
      read,
    };

    let evictedUnread: NotificationInfo[] = [];
    set((state) => {
      const { kept, evictedUnread: dropped } = capNotifications([...state.notifications, newNotification]);
      evictedUnread = dropped;
      return { notifications: kept };
    });

    // Focused notifications enter history as read, without briefly flashing a ring.
    const { workspaceId } = notification;
    const state = get();
    const workspace = state.workspaces.find((w) => w.id === workspaceId);
    if (!read && workspace) {
      state.updateWorkspaceMetadata(workspaceId, {
        unreadCount: workspace.unreadCount + 1,
      });
    }
    // An unread notification pushed out by the cap no longer exists to be
    // read, so its workspace must stop counting it.
    decrementUnread(get(), evictedUnread);
    return newNotification;
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

  clearWorkspaceNotifications(workspaceId: WorkspaceId): void {
    // Nothing can read these any more: focusing a pane is what marks one read,
    // and the panes of that workspace are gone. No counter to fix either — the
    // workspace that held it is the thing being removed.
    if (!get().notifications.some((n) => n.workspaceId === workspaceId)) return;
    set((state) => ({
      notifications: state.notifications.filter((n) => n.workspaceId !== workspaceId),
    }));
  },

  jumpToUnread(): NotificationInfo | null {
    const state = get();
    const unread = state.notifications.filter((n) => !n.read);
    if (unread.length === 0) return null;
    return unread[unread.length - 1];
  },
});
