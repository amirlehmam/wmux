import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { create } from 'zustand';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { createNotificationSlice, MAX_NOTIFICATIONS, NotificationSlice } from '../../src/renderer/store/notification-slice';
import { WorkspaceId, SurfaceId } from '../../src/shared/types';
import { fireNotification } from '../../src/renderer/utils/notifications';

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

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('records focused-terminal notifications as read without transient unread state or external alerts', () => {
    vi.stubGlobal('document', { hasFocus: () => true });
    const fire = vi.fn();
    vi.stubGlobal('window', { wmux: { notification: { fire } } });
    useStore.getState().setNotificationFocusedSurface(surfaceId);
    const seenUnread: boolean[] = [];
    const unsubscribe = useStore.subscribe(state => {
      seenUnread.push(state.notifications.some(notification => !notification.read));
    });

    fireNotification(surfaceId, workspaceId, 'Finished', useStore.getState().addNotification);
    unsubscribe();

    expect(useStore.getState().notifications).toEqual([
      expect.objectContaining({ surfaceId, text: 'Finished', read: true }),
    ]);
    expect(seenUnread).toEqual([false]);
    expect(useStore.getState().workspaces.find(w => w.id === workspaceId)?.unreadCount).toBe(0);
    expect(fire).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'another pane', focused: 'surf-other', windowFocused: true, target: surfaceId },
    { name: 'a hidden tab', focused: surfaceId, windowFocused: true, target: 'surf-hidden' },
    { name: 'an inactive window', focused: surfaceId, windowFocused: false, target: surfaceId },
    { name: 'a non-terminal selection', focused: null, windowFocused: true, target: surfaceId },
    { name: 'an untargeted notification', focused: surfaceId, windowFocused: true, target: '' },
  ])('preserves unread history and external alerts for $name', ({ focused, windowFocused, target }) => {
    vi.stubGlobal('document', { hasFocus: () => windowFocused });
    const fire = vi.fn();
    vi.stubGlobal('window', { wmux: { notification: { fire } } });
    useStore.getState().setNotificationFocusedSurface(focused as SurfaceId | null);

    fireNotification(target, workspaceId, 'Needs you', useStore.getState().addNotification, 'Agent');

    expect(useStore.getState().notifications[0].read).toBe(false);
    expect(useStore.getState().workspaces.find(w => w.id === workspaceId)?.unreadCount).toBe(1);
    expect(fire).toHaveBeenCalledExactlyOnceWith({ surfaceId: target, text: 'Needs you', title: 'Agent' });
  });

  it('ignores a targeted broadcast in a window that does not own the surface', () => {
    const fire = vi.fn();
    vi.stubGlobal('window', { wmux: { notification: { fire } } });

    fireNotification(surfaceId, null, 'Finished elsewhere', useStore.getState().addNotification);

    expect(useStore.getState().notifications).toEqual([]);
    expect(fire).not.toHaveBeenCalled();
  });

  it('still delivers untargeted notices without a workspace', () => {
    const fire = vi.fn();
    vi.stubGlobal('window', { wmux: { notification: { fire } } });

    fireNotification('', null, 'Application notice', useStore.getState().addNotification);

    expect(fire).toHaveBeenCalledExactlyOnceWith({ surfaceId: '', text: 'Application notice', title: 'wmux' });
  });

  it('does not suppress another workspace during a focus hand-off', () => {
    vi.stubGlobal('document', { hasFocus: () => true });
    useStore.getState().setNotificationFocusedSurface(surfaceId);
    const otherWorkspaceId = useStore.getState().createWorkspace({ title: 'Other' });
    useStore.getState().selectWorkspace(otherWorkspaceId);

    const notification = useStore.getState().addNotification({ surfaceId, workspaceId, text: 'Finished' });

    expect(notification.read).toBe(false);
  });

  it('applies focus changes only to new notifications', () => {
    vi.stubGlobal('document', { hasFocus: () => true });
    const add = useStore.getState().addNotification;
    add({ surfaceId, workspaceId, text: 'Before focus' });
    useStore.getState().setNotificationFocusedSurface(surfaceId);
    add({ surfaceId, workspaceId, text: 'While focused' });
    useStore.getState().setNotificationFocusedSurface(null);
    add({ surfaceId, workspaceId, text: 'After focus' });

    expect(useStore.getState().notifications.map(n => n.read)).toEqual([false, true, false]);
    expect(useStore.getState().workspaces.find(w => w.id === workspaceId)?.unreadCount).toBe(2);
  });

  it('keeps unread counters intact when a focused notification arrives at the retention cap', () => {
    for (let i = 0; i < MAX_NOTIFICATIONS; i++) {
      useStore.getState().addNotification({ surfaceId, workspaceId, text: `unread ${i}` });
    }
    vi.stubGlobal('document', { hasFocus: () => true });
    useStore.getState().setNotificationFocusedSurface(surfaceId);
    useStore.getState().addNotification({ surfaceId, workspaceId, text: 'Focused' });

    expect(useStore.getState().notifications).toHaveLength(MAX_NOTIFICATIONS);
    expect(useStore.getState().notifications.every(n => !n.read)).toBe(true);
    expect(useStore.getState().workspaces.find(w => w.id === workspaceId)?.unreadCount).toBe(MAX_NOTIFICATIONS);
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
  // Issue #385: the cap only ever evicted READ notifications, so unread ones —
  // the normal state for agent panes in workspaces nobody is looking at, and
  // the only state for a closed workspace's — accumulated without limit.
  describe('retention (#385)', () => {
    it('stays bounded when nothing is ever read', () => {
      for (let i = 0; i < MAX_NOTIFICATIONS * 5; i++) {
        useStore.getState().addNotification({ surfaceId, workspaceId, text: `turn ${i}` });
      }
      const notifs = useStore.getState().notifications;
      expect(notifs.length).toBe(MAX_NOTIFICATIONS);
      // The newest are the ones kept.
      expect(notifs[notifs.length - 1].text).toBe(`turn ${MAX_NOTIFICATIONS * 5 - 1}`);
      expect(notifs[0].text).toBe(`turn ${MAX_NOTIFICATIONS * 4}`);
    });

    it('keeps the unread counter equal to the unread notifications that still exist', () => {
      for (let i = 0; i < MAX_NOTIFICATIONS + 50; i++) {
        useStore.getState().addNotification({ surfaceId, workspaceId, text: `n${i}` });
      }
      const ws = useStore.getState().workspaces.find((w) => w.id === workspaceId);
      const unread = useStore.getState().notifications.filter((n) => !n.read).length;
      expect(ws?.unreadCount).toBe(unread);
    });

    it('evicts read notifications before unread ones', () => {
      const other = 'surf-other' as SurfaceId;
      useStore.getState().addNotification({ surfaceId: other, workspaceId, text: 'unread-old' });
      for (let i = 0; i < MAX_NOTIFICATIONS - 1; i++) {
        useStore.getState().addNotification({ surfaceId, workspaceId, text: `read ${i}` });
      }
      useStore.getState().markRead(surfaceId);
      useStore.getState().addNotification({ surfaceId, workspaceId, text: 'newest' });
      const texts = useStore.getState().notifications.map((n) => n.text);
      expect(texts.length).toBe(MAX_NOTIFICATIONS);
      expect(texts).toContain('unread-old');
      expect(texts).not.toContain('read 0');
    });

    it('drops the notifications of a workspace that is closed', () => {
      const keep = useStore.getState().createWorkspace({ title: 'Keep' });
      useStore.getState().addNotification({ surfaceId, workspaceId, text: 'gone' });
      useStore.getState().addNotification({ surfaceId, workspaceId: keep, text: 'stays' });
      useStore.getState().closeWorkspace(workspaceId);
      expect(useStore.getState().notifications.map((n) => n.text)).toEqual(['stays']);
    });
  });
});
