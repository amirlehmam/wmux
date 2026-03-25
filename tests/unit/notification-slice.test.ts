import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { createNotificationSlice, NotificationSlice } from '../../src/renderer/store/notification-slice';
import { WorkspaceId, SurfaceId } from '../../src/shared/types';

type TestStore = WorkspaceSlice & NotificationSlice;

function makeStore() {
  return create<TestStore>()((...args) => ({
    ...createWorkspaceSlice(...args),
    ...createNotificationSlice(...args),
  }));
}

describe('notification-slice', () => {
  let useStore: ReturnType<typeof makeStore>;
  let workspaceId: WorkspaceId;
  const surfaceId = 'surf-test-1' as SurfaceId;

  beforeEach(() => {
    useStore = makeStore();
    workspaceId = useStore.getState().createWorkspace({ title: 'Test WS' });
  });

  it('starts with empty notifications', () => {
    expect(useStore.getState().notifications).toEqual([]);
  });

  it('addNotification generates id, timestamp and read=false', () => {
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'hello' });
    const notifs = useStore.getState().notifications;
    expect(notifs.length).toBe(1);
    expect(notifs[0].id).toMatch(/^notif-/);
    expect(notifs[0].read).toBe(false);
    expect(typeof notifs[0].timestamp).toBe('number');
    expect(notifs[0].text).toBe('hello');
  });

  it('addNotification increments workspace unreadCount', () => {
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'ping' });
    const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId);
    expect(ws?.unreadCount).toBe(1);
  });

  it('markRead marks notifications for a surface as read and decrements unreadCount', () => {
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'msg1' });
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'msg2' });
    useStore.getState().markRead(surfaceId);

    const notifs = useStore.getState().notifications;
    expect(notifs.every((n) => n.read)).toBe(true);

    const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId);
    expect(ws?.unreadCount).toBe(0);
  });

  it('markAllRead without workspaceId marks everything read', () => {
    const ws2Id = useStore.getState().createWorkspace({ title: 'WS2' });
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'a' });
    useStore.getState().addNotification({
      surfaceId: 'surf-test-2' as SurfaceId,
      workspaceId: ws2Id,
      text: 'b',
    });

    useStore.getState().markAllRead();
    expect(useStore.getState().notifications.every((n) => n.read)).toBe(true);
  });

  it('clearNotification removes a notification by id', () => {
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'x' });
    const id = useStore.getState().notifications[0].id;
    useStore.getState().clearNotification(id);
    expect(useStore.getState().notifications).toEqual([]);
  });

  it('clearAll empties notifications', () => {
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'x' });
    useStore.getState().clearAll();
    expect(useStore.getState().notifications).toEqual([]);
  });

  it('jumpToUnread returns the last unread notification', () => {
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'first' });
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'second' });
    const result = useStore.getState().jumpToUnread();
    expect(result?.text).toBe('second');
  });

  it('jumpToUnread returns null when all notifications are read', () => {
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'x' });
    useStore.getState().markRead(surfaceId);
    expect(useStore.getState().jumpToUnread()).toBeNull();
  });
});
