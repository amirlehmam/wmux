import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/exec-worker', () => ({ releaseExecWorkers: vi.fn() }));

import { releaseExecWorkers } from '../../src/main/exec-worker';
import {
  forgetClosedWorkspace,
  getSshTarget,
  parseSshTarget,
  resetSshTargets,
  setSshTarget,
  type SshTarget,
} from '../../src/main/ssh-targets';

/**
 * A closed workspace must not keep its ssh target, because the target is what keeps a host's
 * persistent worker alive. The renderer announces the close; main forgets the target, and the
 * worker of the host goes with it unless another workspace still uses that host.
 */
const target = (destination: string, wslDistro?: string): SshTarget => {
  const parsed = parseSshTarget(['ssh', destination], '/work/repo', wslDistro);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
};

beforeEach(() => {
  resetSshTargets();
  vi.mocked(releaseExecWorkers).mockClear();
});

describe('forgetClosedWorkspace', () => {
  it('drops the target of the closed workspace and ends the worker of its host', () => {
    setSshTarget('ws-1', target('dev@box', 'Ubuntu'));
    expect(forgetClosedWorkspace('ws-1')).toBe(true);
    expect(getSshTarget('ws-1')).toBeUndefined();
    expect(releaseExecWorkers).toHaveBeenCalledWith('Ubuntu', 'dev@box');
  });

  it('keeps the worker while another workspace still uses the same host', () => {
    setSshTarget('ws-1', target('dev@box', 'Ubuntu'));
    setSshTarget('ws-2', target('dev@box', 'Ubuntu'));
    expect(forgetClosedWorkspace('ws-1')).toBe(true);
    expect(releaseExecWorkers).not.toHaveBeenCalled();
    expect(getSshTarget('ws-2')).toBeDefined();
    expect(forgetClosedWorkspace('ws-2')).toBe(true);
    expect(releaseExecWorkers).toHaveBeenCalledTimes(1);
  });

  it('a host reached through another distro, or another destination, is not "still used"', () => {
    setSshTarget('ws-1', target('dev@box', 'Ubuntu'));
    setSshTarget('ws-2', target('dev@box', 'Debian'));
    setSshTarget('ws-3', target('dev@other', 'Ubuntu'));
    forgetClosedWorkspace('ws-1');
    expect(releaseExecWorkers).toHaveBeenCalledWith('Ubuntu', 'dev@box');
  });

  it('has no worker to end for a target that does not run in WSL', () => {
    setSshTarget('ws-1', target('dev@box'));
    expect(forgetClosedWorkspace('ws-1')).toBe(true);
    expect(releaseExecWorkers).not.toHaveBeenCalled();
  });

  it('does nothing for a workspace without a target, and ignores anything that is not an id', () => {
    setSshTarget('ws-1', target('dev@box', 'Ubuntu'));
    expect(forgetClosedWorkspace('ws-other')).toBe(false);
    for (const bad of [undefined, null, '', 7, {}, ['ws-1']]) expect(forgetClosedWorkspace(bad)).toBe(false);
    expect(getSshTarget('ws-1')).toBeDefined();
    expect(releaseExecWorkers).not.toHaveBeenCalled();
  });
});
