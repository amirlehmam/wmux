import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ownedRemoteTarget,
  readRemoteFile,
  saveGrantedRemoteFile,
  senderLocationFor,
  serveRemoteFirst,
  sshRunners,
  type RemoteFileDeps,
} from '../../src/main/ssh-access';
import { remoteGrantKey } from '../../src/main/ssh-explorer';
import { remoteFilePath } from '../../src/main/ssh-command';
import { grantFilePath, isFilePathGranted, resetFileGrants } from '../../src/main/file-grants';
import { parseSshTarget, resetSshTargets, setSshTarget, type SshTarget } from '../../src/main/ssh-targets';

/**
 * The decisions behind the remote explorer, code and markdown handlers, with every
 * collaborator a fake: who owns a surface, which window holds a grant, what the
 * remote host answers. Nothing here starts a process.
 */
const target = (() => {
  const parsed = parseSshTarget(['ssh', 'dev@box'], '/work/repo');
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
})();
const keyOf = (...segments: string[]) => remoteGrantKey(remoteFilePath(target, segments));

beforeEach(() => {
  resetFileGrants();
  resetSshTargets();
});

describe('ownedRemoteTarget', () => {
  const make = (owned: boolean, found: SshTarget | undefined, calls: string[] = []) => ({
    ownsLiveSurface: vi.fn((id: unknown) => { calls.push('owns'); return owned && id === 's1'; }),
    targetForSurface: vi.fn(async () => { calls.push('registry'); return found; }),
  });

  it('answers a surface the sender owns with the target of its workspace', async () => {
    expect(await ownedRemoteTarget('s1', make(true, target))).toBe(target);
  });

  it('answers undefined, without asking the registry, for a surface the sender does not own', async () => {
    const gate = make(false, target);
    expect(await ownedRemoteTarget('s1', gate)).toBeUndefined();
    expect(gate.targetForSurface).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 42, '', {}])('answers undefined, without asking anyone, for %j', async (bad) => {
    const gate = make(true, target);
    expect(await ownedRemoteTarget(bad, gate)).toBeUndefined();
    expect(gate.targetForSurface).not.toHaveBeenCalled();
  });

  it('answers undefined for an owned surface whose workspace has no target (a local one)', async () => {
    expect(await ownedRemoteTarget('s1', make(true, undefined))).toBeUndefined();
  });

  it('asks about ownership BEFORE it reads the registry', async () => {
    const calls: string[] = [];
    await ownedRemoteTarget('s1', make(true, target, calls));
    expect(calls).toEqual(['owns', 'registry']);
  });
});

describe('serveRemoteFirst', () => {
  it('asks for the target first, answers from the remote host, and never runs the local gate', async () => {
    const calls: string[] = [];
    const result = await serveRemoteFirst(
      async () => { calls.push('find'); return target; },
      (t) => { calls.push('remote'); return `remote:${t.path}`; },
      () => { calls.push('local'); return 'local'; },
    );
    expect(result).toBe('remote:/work/repo');
    expect(calls).toEqual(['find', 'remote']);
  });

  it('runs the local gate only when there is no target, after asking', async () => {
    const calls: string[] = [];
    const result = await serveRemoteFirst(
      async () => { calls.push('find'); return undefined; },
      () => { calls.push('remote'); return 'remote'; },
      async () => { calls.push('local'); return 'local'; },
    );
    expect(result).toBe('local');
    expect(calls).toEqual(['find', 'local']);
  });

  it('does not fall back to the local gate when the remote host fails', async () => {
    const local = vi.fn(() => 'local');
    await expect(serveRemoteFirst(
      async () => target,
      async () => { throw new Error('unreachable'); },
      local,
    )).rejects.toThrow('unreachable');
    expect(local).not.toHaveBeenCalled();
  });
});

describe('saveGrantedRemoteFile', () => {
  const written = { filePath: remoteFilePath(target, ['a.txt']), mtimeMs: 7 };
  const make = (granted: (key: string) => boolean): RemoteFileDeps & { write: ReturnType<typeof vi.fn> } => ({
    isGranted: granted,
    grant: () => undefined,
    write: vi.fn(async () => written),
    read: vi.fn(),
  });

  it('writes, with the expected mtime, a file this window was granted', async () => {
    const deps = make((key) => key === keyOf('a.txt'));
    expect(await saveGrantedRemoteFile(deps, target, 'a.txt', 'new', 5)).toBe(written);
    expect(deps.write).toHaveBeenCalledWith(target, 'a.txt', 'new', 5);
  });

  it('refuses with not_granted, and writes nothing, without a grant', async () => {
    const deps = make(() => false);
    expect(await saveGrantedRemoteFile(deps, target, 'a.txt', 'x', undefined)).toMatchObject({ code: 'not_granted' });
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('a grant for a different file does not cover this one', async () => {
    const deps = make((key) => key === keyOf('other.txt'));
    expect(await saveGrantedRemoteFile(deps, target, 'a.txt', 'x', undefined)).toMatchObject({ code: 'not_granted' });
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('a grant for another spelling of the same file is read as the same file, and one for a sibling is not', async () => {
    const deps = make((key) => key === keyOf('sub', 'a.txt'));
    expect(await saveGrantedRemoteFile(deps, target, './sub//a.txt', 'x', undefined)).toBe(written);
    deps.write.mockClear();
    expect(await saveGrantedRemoteFile(deps, target, 'sub/b.txt', 'x', undefined)).toMatchObject({ code: 'not_granted' });
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('refuses a path that climbs out before it looks at any grant', async () => {
    const isGranted = vi.fn(() => true);
    const deps = { ...make(isGranted), isGranted };
    expect(await saveGrantedRemoteFile(deps, target, '../x', 'x', undefined)).toMatchObject({ code: 'outside_root' });
    expect(isGranted).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('with the real grant set: a grant held by another window does not open this window', async () => {
    const write = vi.fn(async () => written);
    const forWindow = (id: number): RemoteFileDeps => ({
      ...sshRunners((key) => isFilePathGranted(id, key), (key) => grantFilePath(id, key)),
      write,
    });
    grantFilePath(1, keyOf('a.txt'));
    expect(await saveGrantedRemoteFile(forWindow(2), target, 'a.txt', 'x', undefined)).toMatchObject({ code: 'not_granted' });
    expect(write).not.toHaveBeenCalled();
    expect(await saveGrantedRemoteFile(forWindow(1), target, 'a.txt', 'x', undefined)).toBe(written);
  });

  it('a local path with the same spelling is not a grant for the remote file', async () => {
    grantFilePath(1, '/work/repo/a.txt');
    const deps = sshRunners((key) => isFilePathGranted(1, key), () => undefined);
    const write = vi.fn(async () => written);
    expect(await saveGrantedRemoteFile({ ...deps, write }, target, 'a.txt', 'x', undefined)).toMatchObject({ code: 'not_granted' });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('readRemoteFile', () => {
  const ok = (rel: string) => ({ filePath: remoteFilePath(target, [rel]), content: 'c', mtimeMs: 1 });
  const make = (read: RemoteFileDeps['read']) => {
    const granted: string[] = [];
    const deps: RemoteFileDeps = { isGranted: () => false, grant: (key) => granted.push(key), write: vi.fn(), read };
    return { deps, granted };
  };

  it('mints the save grant, under the remote key of the file read, on success', async () => {
    const { deps, granted } = make(async (_t, rel) => ok(String(rel)));
    expect(await readRemoteFile(deps, target, 'a.txt', false)).toEqual(ok('a.txt'));
    expect(granted).toEqual([keyOf('a.txt')]);
  });

  it('mints nothing from an error reply', async () => {
    const { deps, granted } = make(async () => ({ error: 'File not found', code: 'not_found' as const }));
    expect(await readRemoteFile(deps, target, 'a.txt', false)).toMatchObject({ code: 'not_found' });
    expect(granted).toEqual([]);
  });

  it('a markdown read refuses another extension before reading, and mints nothing', async () => {
    const read = vi.fn(async () => ok('x.ps1'));
    const { deps, granted } = make(read);
    expect(await readRemoteFile(deps, target, 'x.ps1', true)).toMatchObject({ code: 'unsupported_type' });
    expect(await readRemoteFile(deps, target, undefined, true)).toMatchObject({ code: 'unsupported_type' });
    expect(read).not.toHaveBeenCalled();
    expect(granted).toEqual([]);
  });

  it('a markdown read of a markdown file reads it and mints the grant', async () => {
    const { deps, granted } = make(async (_t, rel) => ok(String(rel)));
    await readRemoteFile(deps, target, 'docs/a.md', true);
    expect(granted).toEqual([keyOf('docs/a.md')]);
  });

  it('a code read has no extension whitelist (the editor has its own deny-list)', async () => {
    const { deps, granted } = make(async (_t, rel) => ok(String(rel)));
    await readRemoteFile(deps, target, 'run.ps1', false);
    expect(granted).toEqual([keyOf('run.ps1')]);
  });
});

describe('senderLocationFor', () => {
  const windowAnswering = (workspace: string | null) => ({
    isDestroyed: () => false,
    webContents: { executeJavaScript: vi.fn(async () => workspace) },
  });

  it('asks only the window it is given, and answers with its workspace and target', async () => {
    setSshTarget('ws-1', target);
    const mine = windowAnswering('ws-1');
    expect(await senderLocationFor('surf', mine)).toEqual({ workspaceId: 'ws-1', target });
    expect(mine.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
  });

  it('does not see a surface that only another window holds: that window is never asked', async () => {
    setSshTarget('ws-1', target);
    const sender = windowAnswering(null);
    const other = windowAnswering('ws-1');
    expect(await senderLocationFor('surf-of-the-other-window', sender)).toBeUndefined();
    expect(other.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it.each([undefined, null, '', 7, {}])('is undefined for the surface id %j', async (bad) => {
    setSshTarget('ws-1', target);
    expect(await senderLocationFor(bad, windowAnswering('ws-1'))).toBeUndefined();
  });

  it('is undefined with no window, and for a workspace that has no target', async () => {
    setSshTarget('ws-1', target);
    expect(await senderLocationFor('surf', null)).toBeUndefined();
    expect(await senderLocationFor('surf', undefined)).toBeUndefined();
    expect(await senderLocationFor('surf', windowAnswering('ws-2'))).toBeUndefined();
  });
});
