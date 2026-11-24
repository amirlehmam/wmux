import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitCommand, wslFastRouteEnabled, wslGitContextFor } from '../../src/main/git-view';
import { resetExecWarmForTests, warmWorkspace } from '../../src/main/exec-warm';

/**
 * The fast route of a folder on a WSL share is opt-in. vitest.config.ts switches it on for
 * every other suite; this one covers what a person gets without asking for anything.
 */
describe('WMUX_WSL_FAST, the one switch of the WSL-folder fast route', () => {
  const REPO = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\repo';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.WMUX_WSL_FAST;
    resetExecWarmForTests();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.WMUX_WSL_FAST;
    else process.env.WMUX_WSL_FAST = saved;
  });

  it('is off unless the value is exactly 1', () => {
    delete process.env.WMUX_WSL_FAST;
    expect(wslFastRouteEnabled()).toBe(false);
    for (const value of ['', '0', 'true', 'yes', ' 1']) {
      process.env.WMUX_WSL_FAST = value;
      expect(wslFastRouteEnabled()).toBe(false);
    }
    process.env.WMUX_WSL_FAST = '1';
    expect(wslFastRouteEnabled()).toBe(true);
  });

  it('off: a WSL folder has no context, so nothing batches, gates, caches or warms for it', async () => {
    delete process.env.WMUX_WSL_FAST;
    expect(wslGitContextFor(REPO)).toBeNull();
    // The warm-up asks whether the workspace is on screen only once it has something to warm.
    const visible = vi.fn(() => true);
    await warmWorkspace('ws-1', REPO, visible);
    expect(visible).not.toHaveBeenCalled();
  });

  it('off: git for a WSL folder is still the per-call wsl.exe it was before', () => {
    delete process.env.WMUX_WSL_FAST;
    const cmd = gitCommand(REPO, ['status']);
    expect(cmd.args.slice(0, 6)).toEqual(['-d', 'Ubuntu-24.04', '--cd', '/home/me/repo', '--exec', 'git']);
  });

  it('on: the folder names its distro and directory', () => {
    process.env.WMUX_WSL_FAST = '1';
    expect(wslGitContextFor(REPO)).toEqual({ wsl: { distro: 'Ubuntu-24.04', posix: '/home/me/repo' } });
    expect(wslGitContextFor('C:\\repo')).toBeNull();
  });
});
