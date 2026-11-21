import { describe, expect, it } from 'vitest';
import {
  contextLaneKey,
  contextLocationKey,
  contextPath,
  isWslContext,
  locKind,
  type GitContext,
} from '../../src/main/exec-location';
import { parseSshTarget, type SshTarget } from '../../src/main/ssh-targets';
import { sshLaneKey } from '../../src/main/exec-gate';

const sshTarget = (dest: string, path: string, wslDistro?: string): SshTarget => {
  const parsed = parseSshTarget(['ssh', dest], path);
  if ('error' in parsed) throw new Error(parsed.error);
  return wslDistro ? { ...parsed, wslDistro } : parsed;
};
const wsl = (distro: string, posix: string): GitContext => ({ wsl: { distro, posix } });

describe('exec-location: the two places a git call can run', () => {
  it('tells a WSL folder from a remote host, and names each for the trace', () => {
    const remote: GitContext = { target: sshTarget('dev@box', '/srv/app') };
    expect(isWslContext(remote)).toBe(false);
    expect(isWslContext(wsl('Ubuntu', '/home/me/app'))).toBe(true);
    expect(locKind(remote)).toBe('ssh');
    expect(locKind(wsl('Ubuntu', '/home/me/app'))).toBe('wsl');
  });

  it('keeps a remote host on the lane and location it always had', () => {
    const target = sshTarget('dev@box', '/srv/app', 'Ubuntu');
    const remote: GitContext = { target };
    expect(contextLaneKey(remote)).toBe(sshLaneKey(target));
    expect(contextLocationKey(remote)).toBe('ssh://dev@box/srv/app');
    expect(contextPath(remote)).toBe('/srv/app');
  });

  it('puts every folder of a distro on one lane and each folder on its own location', () => {
    const a = wsl('Ubuntu', '/home/me/a');
    const b = wsl('Ubuntu', '/home/me/b');
    expect(contextLaneKey(a)).toBe(contextLaneKey(b));
    expect(contextLaneKey(a)).not.toBe(contextLaneKey(wsl('Debian', '/home/me/a')));
    expect(contextLocationKey(a)).not.toBe(contextLocationKey(b));
    expect(contextLocationKey(a)).not.toBe(contextLocationKey(wsl('Debian', '/home/me/a')));
    expect(contextPath(a)).toBe('/home/me/a');
  });

  it('never mixes a WSL lane or location with an ssh one, even when the names agree', () => {
    // An ssh target whose destination is spelled like a distro, on a host called "Ubuntu".
    const remote: GitContext = { target: sshTarget('Ubuntu', '/home/me/a', 'Ubuntu') };
    const local = wsl('Ubuntu', '/home/me/a');
    expect(contextLaneKey(local)).not.toBe(contextLaneKey(remote));
    expect(contextLocationKey(local)).not.toBe(contextLocationKey(remote));
  });
});
