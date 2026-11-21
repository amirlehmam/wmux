import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSshTarget,
  getSshTarget,
  handleSetSshTarget,
  normalizeRemotePath,
  parseSshTarget,
  resetSshTargets,
  resolveWorkspaceJs,
  sshLocationForSurface,
  setSshTarget,
  sshTargetForSurface,
  validateSetSshTargetParams,
  workspaceIdForSurface,
} from '../../src/main/ssh-targets';

const ARGV = ['ssh', '-F', '/home/me/cfg', '-J', 'jump', '-p', '2222', '-i', '/k/id', 'dev@box'];

/** A window whose renderer answers `answer` (or throws it, when it is an Error). */
function fakeWindow(answer: unknown, destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      executeJavaScript: vi.fn(async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      }),
    },
  };
}

async function call(params: unknown, windows: ReturnType<typeof fakeWindow>[]) {
  const respond = vi.fn();
  const respondError = vi.fn();
  await handleSetSshTarget(params, windows, respond, respondError);
  return { respond, respondError };
}

beforeEach(() => resetSshTargets());

describe('normalizeRemotePath', () => {
  it.each([
    ['/work/repo', '/work/repo'],
    ['/work//repo/', '/work/repo'],
    ['/work/./repo', '/work/repo'],
    ['/work/my repo', '/work/my repo'],
  ])('%s -> %s', (input, expected) => expect(normalizeRemotePath(input)).toBe(expected));

  it.each([[undefined], [5], [''], ['relative/p'], ['/'], ['//'], ['/a/../b'], ['/a/\nb'], ['/a/\0b'], ['/' + 'x'.repeat(5000)]])(
    'refuses %j',
    (input) => expect(normalizeRemotePath(input)).toBeNull(),
  );
});

describe('parseSshTarget', () => {
  it('parses the connection facts and normalises the path', () => {
    const t = parseSshTarget(ARGV, '/work/repo/');
    expect(t).toMatchObject({ path: '/work/repo', session: { destination: 'dev@box', port: 2222, configFile: '/home/me/cfg', jumpHost: 'jump', identityFiles: ['/k/id'] } });
  });

  it('keeps a space-containing argument whole', () => {
    const t = parseSshTarget(['ssh', '-F', 'C:\\Users\\me\\my cfg\\config', 'box'], '/w');
    expect(t).toMatchObject({ session: { configFile: 'C:\\Users\\me\\my cfg\\config' } });
  });

  it.each([
    ['not an array', 'ssh box'],
    ['a non-string entry', ['ssh', 5]],
    ['a NUL', ['ssh', 'bo\0x']],
    ['too many entries', Array.from({ length: 70 }, () => '-4')],
    ['an overlong entry', ['ssh', 'x'.repeat(3000)]],
    ['a program that is not ssh', ['bash', '-c', 'ls', 'box']],
    ['no destination', ['ssh', '-p', '22']],
    ['a remote command', ['ssh', 'box', 'ls']],
    ['a port forward', ['ssh', '-N', 'box']],
    ['an option-like destination after --', ['ssh', '--', '-oProxyCommand=x']],
    ['whitespace in the destination', ['ssh', 'a b']],
    ['LocalCommand', ['ssh', '-o', 'LocalCommand=touch x', 'box']],
    ['PermitLocalCommand', ['ssh', '-o', 'PermitLocalCommand=yes', 'box']],
    ['LocalCommand spelled -oLocalCommand=', ['ssh', '-oLocalCommand=touch x', 'box']],
    ['LocalCommand in lower case', ['ssh', '-o', 'localcommand=touch x', 'box']],
    ['LocalCommand with a space instead of =', ['ssh', '-o', 'LocalCommand touch x', 'box']],
    ['PermitLocalCommand set to no (the key is refused, not the value)', ['ssh', '-o', 'PermitLocalCommand=no', 'box']],
    ['LocalCommand after another option', ['ssh', '-o', 'BatchMode=yes', '-o', 'LocalCommand=x', 'box']],
  ])('refuses %s', (_name, argv) => {
    expect(parseSshTarget(argv, '/w')).toEqual({ error: expect.any(String) });
  });

  it('accepts ProxyCommand and ProxyJump: the pipe caller is already local and authenticated, and a jump host needs them', () => {
    const viaCommand = parseSshTarget(['ssh', '-o', 'ProxyCommand=ssh -W %h:%p jump', 'box'], '/w');
    expect(viaCommand).toMatchObject({ session: { destination: 'box' } });
    expect(parseSshTarget(['ssh', '-J', 'jump', 'box'], '/w')).toMatchObject({ session: { destination: 'box' } });
    expect(parseSshTarget(['ssh', '-o', 'ProxyJump=jump', 'box'], '/w')).toMatchObject({ session: { destination: 'box' } });
  });

  it('refuses a bad path', () => {
    expect(parseSshTarget(ARGV, 'relative')).toEqual({ error: expect.stringContaining('path') });
    expect(parseSshTarget(ARGV, '/a/../b')).toEqual({ error: expect.stringContaining('path') });
  });
});

describe('registry', () => {
  it('sets, reads and clears per workspace', () => {
    const a = parseSshTarget(ARGV, '/a') as never;
    const b = parseSshTarget(['ssh', 'other'], '/b') as never;
    setSshTarget('ws-1', a);
    setSshTarget('ws-2', b);
    expect(getSshTarget('ws-1')).toBe(a);
    expect(getSshTarget('ws-2')).toBe(b);
    expect(clearSshTarget('ws-1')).toBe(true);
    expect(clearSshTarget('ws-1')).toBe(false);
    expect(getSshTarget('ws-1')).toBeUndefined();
    expect(getSshTarget('ws-2')).toBe(b);
  });
});

describe('validateSetSshTargetParams', () => {
  it('accepts a set and a clear', () => {
    expect(validateSetSshTargetParams({ workspaceId: 'ws-1', argv: ARGV, path: '/w' })).toBeNull();
    expect(validateSetSshTargetParams({ caller: 'surf-1', argv: [] })).toBeNull();
    expect(validateSetSshTargetParams({ caller: 'surf-1' })).toBeNull();
  });

  it.each([
    [null],
    ['nope'],
    [{ workspaceId: 7, argv: [] }],
    [{ workspaceId: 'ws-1', caller: 7, argv: [] }],
    [{ workspaceId: 'ws-1', argv: ARGV }],
    [{ workspaceId: 'ws-1', argv: 'ssh box', path: '/w' }],
  ])('refuses %j', (params) => {
    expect(validateSetSshTargetParams(params)).toEqual(expect.any(String));
  });

  it('refuses a call that names no workspace and comes from no pane', () => {
    expect(validateSetSshTargetParams({ argv: [] })).toMatch(/--workspace/);
  });
});

describe('resolveWorkspaceJs', () => {
  it('encodes every value, so a quote cannot end the expression', () => {
    const js = resolveWorkspaceJs(undefined, `a'"); alert(1); //`);
    expect(js).toContain(JSON.stringify(`a'"); alert(1); //`));
    expect(js.startsWith('window.__wmux_resolveWorkspace?.(')).toBe(true);
  });
});

describe('handleSetSshTarget', () => {
  it('answers -32602 before asking any window, and stores nothing', async () => {
    const win = fakeWindow({ workspaceId: 'ws-1' });
    const { respond, respondError } = await call({ workspaceId: 'ws-1', argv: ['bash'], path: '/w' }, [win]);
    expect(respondError).toHaveBeenCalledWith(-32602, expect.any(String));
    expect(respond).not.toHaveBeenCalled();
    expect(win.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(getSshTarget('ws-1')).toBeUndefined();
  });

  it('stores the target for the workspace of the first window that holds it, skipping dead and failing ones', async () => {
    const dead = fakeWindow({ workspaceId: 'ws-x' }, true);
    const reloading = fakeWindow(new Error('reloading'));
    const other = fakeWindow(null);
    const malformed = fakeWindow({ workspaceId: 5 });
    const owner = fakeWindow({ workspaceId: 'ws-2' });
    const { respond, respondError } = await call({ workspaceId: 'ws-2', argv: ARGV, path: '/work/repo/' }, [dead, reloading, other, malformed, owner]);
    expect(respond).toHaveBeenCalledWith({ workspaceId: 'ws-2', target: { destination: 'dev@box', port: 2222, path: '/work/repo' } });
    expect(respondError).not.toHaveBeenCalled();
    expect(dead.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(getSshTarget('ws-2')?.path).toBe('/work/repo');
  });

  it('omits the port when none was given', async () => {
    const { respond } = await call({ workspaceId: 'ws-1', argv: ['ssh', 'box'], path: '/w' }, [fakeWindow({ workspaceId: 'ws-1' })]);
    expect(respond).toHaveBeenCalledWith({ workspaceId: 'ws-1', target: { destination: 'box', path: '/w' } });
  });

  it('is idempotent: setting twice replaces', async () => {
    const win = fakeWindow({ workspaceId: 'ws-1' });
    await call({ workspaceId: 'ws-1', argv: ['ssh', 'one'], path: '/a' }, [win]);
    await call({ workspaceId: 'ws-1', argv: ['ssh', 'two'], path: '/b' }, [win]);
    expect(getSshTarget('ws-1')).toMatchObject({ path: '/b', session: { destination: 'two' } });
  });

  it('clears with an empty argv, and reports whether there was one', async () => {
    const win = fakeWindow({ workspaceId: 'ws-1' });
    await call({ workspaceId: 'ws-1', argv: ARGV, path: '/w' }, [win]);
    const first = await call({ workspaceId: 'ws-1', argv: [] }, [win]);
    expect(first.respond).toHaveBeenCalledWith({ workspaceId: 'ws-1', target: null, cleared: true });
    const second = await call({ workspaceId: 'ws-1' }, [win]);
    expect(second.respond).toHaveBeenCalledWith({ workspaceId: 'ws-1', target: null, cleared: false });
    expect(getSshTarget('ws-1')).toBeUndefined();
  });

  it('reports an unknown workspace instead of a silent success, and stores nothing', async () => {
    const { respond, respondError } = await call({ workspaceId: 'ws-gone', argv: ARGV, path: '/w' }, [fakeWindow(null)]);
    expect(respond).not.toHaveBeenCalled();
    expect(respondError).toHaveBeenCalledWith(-32000, 'Workspace not found: ws-gone');
    expect(getSshTarget('ws-gone')).toBeUndefined();
  });

  it('says so when the calling pane is in no workspace', async () => {
    const { respondError } = await call({ caller: 'surf-stale', argv: [] }, [fakeWindow(null)]);
    expect(respondError).toHaveBeenCalledWith(-32000, expect.stringContaining('calling pane'));
  });

  it('reports a miss when there is no window at all', async () => {
    const { respondError } = await call({ workspaceId: 'ws-1', argv: [] }, []);
    expect(respondError).toHaveBeenCalledWith(-32000, 'Workspace not found: ws-1');
  });
});

describe('workspaceIdForSurface / sshTargetForSurface', () => {
  it('asks every window and takes the first answer', async () => {
    const dead = fakeWindow('ws-x', true);
    const reloading = fakeWindow(new Error('x'));
    const none = fakeWindow(null);
    const owner = fakeWindow('ws-1');
    expect(await workspaceIdForSurface('surf-1', [dead, reloading, none, owner])).toBe('ws-1');
    expect(await workspaceIdForSurface('surf-1', [none])).toBeNull();
    expect(await workspaceIdForSurface('', [owner])).toBeNull();
  });

  it('finds the target of the surface\'s workspace, and nothing for a workspace without one', async () => {
    const target = parseSshTarget(ARGV, '/w') as never;
    setSshTarget('ws-1', target);
    expect(await sshTargetForSurface('surf-1', [fakeWindow('ws-1')])).toBe(target);
    expect(await sshTargetForSurface('surf-2', [fakeWindow('ws-2')])).toBeUndefined();
    expect(await sshTargetForSurface(undefined, [fakeWindow('ws-1')])).toBeUndefined();
  });

  it('does not ask a renderer while no target is set at all', async () => {
    const win = fakeWindow('ws-1');
    expect(await sshTargetForSurface('surf-1', [win])).toBeUndefined();
    expect(win.webContents.executeJavaScript).not.toHaveBeenCalled();
  });
});

describe('sshLocationForSurface', () => {
  it('answers the workspace and its target, or nothing for a workspace without one', async () => {
    const target = parseSshTarget(ARGV, '/w') as never;
    setSshTarget('ws-1', target);
    expect(await sshLocationForSurface('surf-1', [fakeWindow('ws-1')])).toEqual({ workspaceId: 'ws-1', target });
    expect(await sshLocationForSurface('surf-2', [fakeWindow('ws-2')])).toBeUndefined();
    expect(await sshLocationForSurface('surf-3', [fakeWindow(null)])).toBeUndefined();
    expect(await sshLocationForSurface(undefined, [fakeWindow('ws-1')])).toBeUndefined();
  });
});

describe('handleSetSshTarget: the follow-up after a target is set', () => {
  const callWith = async (params: unknown, onSet: (id: string, t: unknown) => unknown, windows = [fakeWindow({ workspaceId: 'ws-1' })]) => {
    const respond = vi.fn();
    const respondError = vi.fn();
    await handleSetSshTarget(params, windows, respond, respondError, onSet as never);
    return { respond, respondError };
  };

  it('runs after a set, with the workspace and the stored target, and after the reply', async () => {
    const order: string[] = [];
    const onSet = vi.fn(() => { order.push('onSet'); });
    const respond = vi.fn(() => { order.push('respond'); });
    await handleSetSshTarget({ workspaceId: 'ws-1', argv: ARGV, path: '/w' }, [fakeWindow({ workspaceId: 'ws-1' })], respond, vi.fn(), onSet);
    expect(order).toEqual(['respond', 'onSet']);
    expect(onSet).toHaveBeenCalledWith('ws-1', getSshTarget('ws-1'));
  });

  it('does not run on a clear, an invalid call or an unknown workspace', async () => {
    const onSet = vi.fn();
    await callWith({ workspaceId: 'ws-1', argv: [] }, onSet);
    await callWith({ workspaceId: 'ws-1', argv: ['bash'], path: '/w' }, onSet);
    await callWith({ workspaceId: 'ws-gone', argv: ARGV, path: '/w' }, onSet, [fakeWindow(null)] as never);
    expect(onSet).not.toHaveBeenCalled();
  });

  it('a follow-up that throws or rejects changes neither the target nor the answer', async () => {
    const thrown = await callWith({ workspaceId: 'ws-1', argv: ARGV, path: '/w' }, () => { throw new Error('boom'); });
    expect(thrown.respond).toHaveBeenCalled();
    const rejected = await callWith({ workspaceId: 'ws-1', argv: ARGV, path: '/w' }, () => Promise.reject(new Error('boom')));
    expect(rejected.respond).toHaveBeenCalled();
    expect(getSshTarget('ws-1')).toBeDefined();
  });
});

describe('wslDistro in a target', () => {
  const base = { workspaceId: 'ws-1', argv: ['ssh', 'dev@h'], path: '/w' };
  const set = (params: Record<string, unknown>) => call(params, [fakeWindow({ workspaceId: 'ws-1' })]);

  it('is validated with the rest of the params, before any window is asked', () => {
    expect(validateSetSshTargetParams({ ...base, wslDistro: 'Ubuntu-24.04' })).toBeNull();
    expect(validateSetSshTargetParams(base)).toBeNull();
    expect(validateSetSshTargetParams({ ...base, wslDistro: '--exec' })).toMatch(/wslDistro/);
    expect(validateSetSshTargetParams({ ...base, wslDistro: null })).toMatch(/wslDistro/);
  });

  it('is kept by parseSshTarget only when given', () => {
    expect(parseSshTarget(base.argv, '/w', 'Ubuntu-24.04')).toMatchObject({ wslDistro: 'Ubuntu-24.04' });
    expect(parseSshTarget(base.argv, '/w')).not.toHaveProperty('wslDistro');
    expect(parseSshTarget(base.argv, '/w', 'bad name')).toEqual({ error: expect.stringMatching(/wslDistro/) });
  });

  it('is stored in the registry and echoed in the reply target, and left out when absent', async () => {
    const withDistro = await set({ ...base, argv: ['ssh', '-p', '2222', 'dev@h'], path: '/w/repo/', wslDistro: 'Ubuntu-24.04' });
    expect(withDistro.respond).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      target: { destination: 'dev@h', port: 2222, path: '/w/repo', wslDistro: 'Ubuntu-24.04' },
    });
    expect(getSshTarget('ws-1')?.wslDistro).toBe('Ubuntu-24.04');
    const direct = await set(base);
    expect(direct.respond).toHaveBeenCalledWith({ workspaceId: 'ws-1', target: { destination: 'dev@h', path: '/w' } });
    expect(getSshTarget('ws-1')).not.toHaveProperty('wslDistro');
  });

  it('answers -32602 for a bad distro and stores nothing', async () => {
    resetSshTargets();
    const { respond, respondError } = await set({ ...base, wslDistro: '-d' });
    expect(respondError).toHaveBeenCalledWith(-32602, expect.stringMatching(/wslDistro/));
    expect(respond).not.toHaveBeenCalled();
    expect(getSshTarget('ws-1')).toBeUndefined();
  });
});
