import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  getPathForFile: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    send: vi.fn(),
    sendSync: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  webUtils: { getPathForFile: electron.getPathForFile },
}));

let bridge: any;

beforeAll(async () => {
  await import('../../src/preload/index');
  bridge = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'wmux')?.[1];
});

beforeEach(() => {
  electron.invoke.mockReset();
  electron.invoke.mockResolvedValue({ text: null });
  electron.getPathForFile.mockReset();
});

describe('remote drop preload boundary', () => {
  it('turns genuine dropped Files into paths inside preload', async () => {
    const droppedFile = { name: 'image.png' };
    electron.getPathForFile.mockImplementation((candidate) => {
      if (candidate !== droppedFile) throw new TypeError('not a File');
      return 'C:\\Users\\me\\image.png';
    });

    await bridge.remote.resolveDrop('surf-1', [droppedFile], true);

    expect(electron.invoke).toHaveBeenCalledWith(
      'remote:resolve-drop',
      'surf-1',
      ['C:\\Users\\me\\image.png'],
      true,
    );
  });

  it('does not accept renderer-supplied path strings', async () => {
    electron.getPathForFile.mockImplementation(() => { throw new TypeError('not a File'); });

    await bridge.remote.resolveDrop('surf-1', ['C:\\Users\\me\\secret.txt'], false);

    expect(electron.invoke).toHaveBeenCalledWith('remote:resolve-drop', 'surf-1', [], false);
  });
});
