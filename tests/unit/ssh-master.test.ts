import { describe, expect, it, vi } from 'vitest';
import { closeSshMasters, masterExits, MASTER_EXIT_TIMEOUT_MS, MAX_MASTERS_CLOSED } from '../../src/main/ssh-master';
import { wslSshOptionArgs } from '../../src/main/ssh-exec';
import { parseSshTarget, type SshTarget } from '../../src/main/ssh-targets';

const target = (argv: string[], path = '/w/repo', wslDistro?: string): SshTarget => {
  const parsed = parseSshTarget(argv, path, wslDistro);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
};

describe('masterExits', () => {
  it('runs ssh -O exit in the distro, with the options that name the ControlPath and the destination last', () => {
    const t = target(['ssh', '-F', '/home/u/cfg', '-J', 'jump', '-p', '2222', 'dev@box'], '/w', 'Ubuntu');
    const [exit] = masterExits([t]);
    expect(exit.args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--exec', 'ssh', '-T']);
    expect(exit.args.slice(-3)).toEqual(['-O', 'exit', 'dev@box']);
    expect(exit.args).toEqual(expect.arrayContaining(['ControlPath=/tmp/wmux-%C', '-F', '/home/u/cfg', '-J', 'jump', '-p', '2222']));
    // The very options a view's call carries, so ssh derives the same socket.
    expect(exit.args.slice(0, -3)).toEqual(wslSshOptionArgs(t.session, 'Ubuntu'));
    expect(exit.args).not.toContain('sh');
  });

  it('has nothing for a target that is not on the WSL route', () => {
    expect(masterExits([target(['ssh', 'dev@box'])])).toEqual([]);
    expect(masterExits([])).toEqual([]);
  });

  it('asks once for targets that share a connection, and once for each that does not', () => {
    const exits = masterExits([
      target(['ssh', 'dev@box'], '/w/one', 'Ubuntu'),
      target(['ssh', 'dev@box'], '/w/two', 'Ubuntu'),
      target(['ssh', 'dev@box'], '/w/one', 'Debian'),
      target(['ssh', '-p', '2200', 'dev@box'], '/w/one', 'Ubuntu'),
      target(['ssh', 'dev@other'], '/w/one', 'Ubuntu'),
    ]);
    expect(exits).toHaveLength(4);
  });
});

describe('closeSshMasters', () => {
  const many = (n: number): SshTarget[] => Array.from({ length: n }, (_, i) => target(['ssh', `dev@box${i}`], '/w', 'Ubuntu'));

  it('runs each exit once, bounded, without a window or a stdio to wait on', () => {
    const run = vi.fn(() => ({ status: 0 }));
    expect(closeSshMasters(many(2), run)).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][2]).toMatchObject({ timeout: MASTER_EXIT_TIMEOUT_MS, windowsHide: true, stdio: 'ignore' });
  });

  it('closes at most MAX_MASTERS_CLOSED, so a quit cannot wait long', () => {
    const run = vi.fn(() => ({ status: 0 }));
    expect(closeSshMasters(many(MAX_MASTERS_CLOSED + 5), run)).toBe(MAX_MASTERS_CLOSED);
    expect(run).toHaveBeenCalledTimes(MAX_MASTERS_CLOSED);
  });

  it('goes on after an ssh that fails or cannot start, and never throws', () => {
    const run = vi.fn()
      .mockReturnValueOnce({ status: 255 })
      .mockImplementationOnce(() => { throw new Error('spawn wsl.exe ENOENT'); })
      .mockReturnValueOnce({ status: 0 });
    expect(closeSshMasters(many(3), run)).toBe(3);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('does nothing without a WSL-route target', () => {
    const run = vi.fn();
    expect(closeSshMasters([], run)).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
});
