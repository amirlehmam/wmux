import { EventEmitter } from 'events';
import { beforeEach, expect, it, vi } from 'vitest';

const { created, show } = vi.hoisted(() => ({
  created: [] as EventEmitter[],
  show: vi.fn(),
}));

vi.mock('electron', () => ({
  Notification: class extends EventEmitter {
    show = show;
    constructor() {
      super();
      created.push(this);
    }
  },
}));

import { NotificationManager } from '../../src/main/notification-manager';

beforeEach(() => {
  created.length = 0;
  vi.clearAllMocks();
});

it('retains successive toasts until their click callbacks run', () => {
  const manager = new NotificationManager();
  const first = vi.fn();
  const second = vi.fn();
  manager.showToast('wmux', 'First', first);
  manager.showToast('wmux', 'Second', second);
  const retained = (manager as any).activeToasts as Set<EventEmitter>;
  expect([...retained]).toEqual(created);
  created[0].emit('click');
  expect(first).toHaveBeenCalledOnce();
  expect([...retained]).toEqual([created[1]]);
  created[1].emit('click');
  expect(second).toHaveBeenCalledOnce();
  expect(retained.size).toBe(0);
});

it.each(['close', 'failed'])('releases a toast on %s without invoking its click callback', (event) => {
  const manager = new NotificationManager();
  const onClick = vi.fn();
  manager.showToast('wmux', 'Done', onClick);
  created[0].emit(event, { reason: 'dismissed' });
  expect((manager as any).activeToasts.size).toBe(0);
  expect(onClick).not.toHaveBeenCalled();
});

it('releases a toast if showing it throws', () => {
  const manager = new NotificationManager();
  const error = new Error('Toast unavailable');
  show.mockImplementationOnce(() => { throw error; });
  expect(() => manager.showToast('wmux', 'Done')).toThrow(error);
  expect((manager as any).activeToasts.size).toBe(0);
});
