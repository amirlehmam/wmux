import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { IPC_CHANNELS } from '../../src/shared/types';

const registeredHandlers = new Map<string, Function>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      registeredHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => null,
    getFocusedWindow: () => null,
  },
  clipboard: { readText: () => '', writeText: () => {} },
  shell: {},
  dialog: {},
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0', on: vi.fn() },
  nativeTheme: { on: () => {} },
}));

vi.mock('../../src/shared/instance', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAppDataDir: () => path.join(os.tmpdir(), 'wmux-worktree-ipc-test'),
}));

const mockCreateWorktree = vi.fn();
const mockRemoveWorktree = vi.fn();
const mockInspectWorktree = vi.fn();
const mockProbeRepo = vi.fn();

vi.mock('../../src/main/git-worktree', () => ({
  createWorktree: (...args: any[]) => mockCreateWorktree(...args),
  removeWorktree: (...args: any[]) => mockRemoveWorktree(...args),
  inspectWorktree: (...args: any[]) => mockInspectWorktree(...args),
  probeRepo: (...args: any[]) => mockProbeRepo(...args),
}));

import { registerIpcHandlers } from '../../src/main/ipc-handlers';

const WT = 'C:\\Users\\user\\AppData\\Local\\wmux\\wt\\repo\\feat-12345678';

describe('worktree IPC handlers (#366)', () => {
  let createHandler: Function;
  let removeHandler: Function;
  let inspectHandler: Function;
  let probeHandler: Function;

  beforeAll(() => {
    registerIpcHandlers({} as any);
    createHandler = registeredHandlers.get(IPC_CHANNELS.GIT_WORKTREE_CREATE)!;
    removeHandler = registeredHandlers.get(IPC_CHANNELS.GIT_WORKTREE_REMOVE)!;
    inspectHandler = registeredHandlers.get(IPC_CHANNELS.GIT_WORKTREE_INSPECT)!;
    probeHandler = registeredHandlers.get(IPC_CHANNELS.GIT_WORKTREE_PROBE)!;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the worktree handlers', () => {
    expect(createHandler).toBeDefined();
    expect(removeHandler).toBeDefined();
    expect(inspectHandler).toBeDefined();
    expect(probeHandler).toBeDefined();
  });

  it('exposes no channel that deletes a branch the renderer names', () => {
    expect((IPC_CHANNELS as Record<string, string>).WORKTREE_DELETE_BRANCH).toBeUndefined();
    expect([...registeredHandlers.keys()].some((c) => /delete-branch/i.test(c))).toBe(false);
  });

  describe('GIT_WORKTREE_CREATE', () => {
    const INVALID = { ok: false, code: 'invalid_argument', error: 'Invalid argument types' };

    it('rejects non-string repoDir, branch or base without calling createWorktree', async () => {
      for (const repoDir of [123, null, undefined, {}, [], true]) {
        expect(await createHandler({}, repoDir, 'feature', 'main')).toEqual(INVALID);
      }
      for (const branch of [123, null, undefined, {}, [], false]) {
        expect(await createHandler({}, 'C:\\repo', branch, 'main')).toEqual(INVALID);
      }
      for (const base of [123, null, {}, [], false]) {
        expect(await createHandler({}, 'C:\\repo', 'feature', base)).toEqual(INVALID);
      }
      expect(mockCreateWorktree).not.toHaveBeenCalled();
    });

    it('forwards valid arguments to createWorktree', async () => {
      const ok = { ok: true, worktree: { repoRoot: 'C:\\repo', branch: 'feature', baseBranch: 'main', baseSha: 'a'.repeat(40), worktreePath: WT } };
      mockCreateWorktree.mockResolvedValueOnce(ok);
      expect(await createHandler({}, 'C:\\repo', 'feature', 'main')).toEqual(ok);
      expect(mockCreateWorktree).toHaveBeenCalledWith({ repoRoot: 'C:\\repo', branch: 'feature', base: 'main' });
    });

    it('returns classified errors and catches throws', async () => {
      mockCreateWorktree.mockResolvedValueOnce({ ok: false, code: 'invalid_base', error: 'Invalid base ref' });
      expect(await createHandler({}, 'C:\\repo', 'feature', '-rf')).toEqual({ ok: false, code: 'invalid_base', error: 'Invalid base ref' });
      mockCreateWorktree.mockRejectedValueOnce(new Error('git execution crashed'));
      expect(await createHandler({}, 'C:\\repo', 'feature')).toEqual({ ok: false, code: 'git_failed', error: 'git execution crashed' });
    });
  });

  describe('GIT_WORKTREE_REMOVE', () => {
    it('refuses any mode other than keep/discard without calling removeWorktree', async () => {
      for (const mode of [undefined, null, true, 'force', { force: true }, 'KEEP']) {
        expect(await removeHandler({}, WT, mode)).toEqual({ outcome: 'error', message: 'invalid mode' });
      }
      expect(mockRemoveWorktree).not.toHaveBeenCalled();
    });

    it('forwards the path and the explicit mode, nothing else', async () => {
      mockRemoveWorktree.mockResolvedValue({ outcome: 'removed', branchDeleted: true });
      expect(await removeHandler({}, WT, 'discard')).toEqual({ outcome: 'removed', branchDeleted: true });
      expect(mockRemoveWorktree).toHaveBeenCalledWith(WT, { mode: 'discard' });
      await removeHandler({}, WT, 'keep');
      expect(mockRemoveWorktree).toHaveBeenLastCalledWith(WT, { mode: 'keep' });
    });

    it('logs the outcome only, never the path (#174)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const secretPath = 'C:\\Users\\sensitive-username\\AppData\\Local\\wmux\\wt\\proj\\branch-12345678';
      for (const outcome of ['has-work', 'not-ours', 'absent', 'left-behind', 'error']) {
        warnSpy.mockClear();
        mockRemoveWorktree.mockResolvedValueOnce({ outcome });
        expect((await removeHandler({}, secretPath, 'keep')).outcome).toBe(outcome);
        expect(warnSpy).toHaveBeenCalledWith(`[worktree] keep close: ${outcome}`);
        for (const call of warnSpy.mock.calls) {
          for (const arg of call) expect(String(arg)).not.toContain('sensitive-username');
        }
      }
      warnSpy.mockRestore();
    });

    it('turns a throw into an error outcome', async () => {
      mockRemoveWorktree.mockRejectedValueOnce(new Error('unexpected failure'));
      expect(await removeHandler({}, WT, 'keep')).toEqual({ outcome: 'error', message: 'unexpected failure' });
    });
  });

  describe('GIT_WORKTREE_INSPECT', () => {
    it('forwards the path and returns the pre-flight answer', async () => {
      mockInspectWorktree.mockResolvedValueOnce({ outcome: 'has-work', count: 2 });
      expect(await inspectHandler({}, WT)).toEqual({ outcome: 'has-work', count: 2 });
      expect(mockInspectWorktree).toHaveBeenCalledWith(WT);
    });

    it('turns a throw into an error outcome', async () => {
      mockInspectWorktree.mockRejectedValueOnce(new Error('boom'));
      expect(await inspectHandler({}, WT)).toEqual({ outcome: 'error', message: 'boom' });
    });
  });

  describe('GIT_WORKTREE_PROBE', () => {
    it('returns null for a non-string dir without probing', async () => {
      for (const dir of [123, null, undefined, {}, [], false]) {
        expect(await probeHandler({}, dir)).toBeNull();
      }
      expect(mockProbeRepo).not.toHaveBeenCalled();
    });

    it('forwards a valid dir, and turns a throw into null', async () => {
      mockProbeRepo.mockResolvedValueOnce({ repoRoot: 'C:\\code\\wmux', currentBranch: 'main' });
      expect(await probeHandler({}, 'C:\\code\\wmux\\src')).toEqual({ repoRoot: 'C:\\code\\wmux', currentBranch: 'main' });
      mockProbeRepo.mockRejectedValueOnce(new Error('spawn ENOENT'));
      expect(await probeHandler({}, 'C:\\broken')).toBeNull();
    });
  });
});
