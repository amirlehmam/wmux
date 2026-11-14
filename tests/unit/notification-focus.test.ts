import { beforeAll, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { IPC_CHANNELS } from '../../src/shared/types';

const { handlers, showToast, fromWebContents } = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  showToast: vi.fn(),
  fromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: (channel: string, handler: Function) => handlers.set(channel, handler),
  },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: (...args: unknown[]) => fromWebContents(...args),
    getFocusedWindow: () => null,
  },
  clipboard: {},
  shell: {},
  dialog: {},
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0', on: vi.fn() },
  nativeTheme: { on: vi.fn() },
}));

vi.mock('../../src/shared/instance', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAppDataDir: () => path.join(os.tmpdir(), 'wmux-notification-focus-test'),
}));
vi.mock('../../src/main/settings-store', () => ({ loadSettings: () => ({}), saveSetting: vi.fn() }));
vi.mock('../../src/main/notification-manager', () => ({
  NotificationManager: class {
    showToast = showToast;
    flashTaskbar = vi.fn();
  },
}));

import { registerIpcHandlers } from '../../src/main/ipc-handlers';

beforeAll(() => registerIpcHandlers({} as any));

it.each([
  { name: 'visible', minimized: false, visible: true, expected: ['raise', 'focus'] },
  { name: 'minimized', minimized: true, visible: true, expected: ['restore', 'raise', 'focus'] },
  { name: 'tray-hidden', minimized: false, visible: false, expected: ['show', 'raise', 'focus'] },
])('raises the $name window when its notification is clicked', ({ minimized, visible, expected }) => {
  const calls: string[] = [];
  const send = vi.fn();
  fromWebContents.mockReturnValue({
    isDestroyed: () => false,
    isMinimized: () => minimized,
    isVisible: () => visible,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    moveTop: () => calls.push('raise'),
    focus: () => calls.push('focus'),
    webContents: { send },
  });
  showToast.mockClear();
  handlers.get(IPC_CHANNELS.NOTIFICATION_FIRE)!({ sender: {} }, { surfaceId: 'surf-test', text: 'Done' });
  expect(calls).toEqual([]);
  showToast.mock.calls[0][2]();
  expect(calls).toEqual(expected);
  expect(send).toHaveBeenCalledWith('notification:focus-surface', 'surf-test');
});
