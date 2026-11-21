import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  defaultRemoteMarkdownDeps,
  isRemoteIdentity,
  readRemoteMarkdown,
  resolveRemoteIdentity,
  saveRemoteMarkdown,
  type RemoteMarkdownDeps,
} from '../../src/main/ssh-markdown';
import { remoteGrantKey, remoteReadCodeFile, type RemoteDeps } from '../../src/main/ssh-explorer';
import { remoteFilePath } from '../../src/main/ssh-command';
import { grantFilePath, isFilePathGranted, resetFileGrants } from '../../src/main/file-grants';
import { listSshTargets, parseSshTarget, resetSshTargets, setSshTarget, type SshTarget } from '../../src/main/ssh-targets';
import type { RunResult, SshRunner } from '../../src/main/ssh-exec';
import { hasPosixTools } from '../helpers/posix-tools';
import { makeTmpDir } from '../helpers/git-repo';

/**
 * Saving a markdown file that lives on a remote host. The pure gates run against
 * fakes; the write itself runs the REAL remote scripts through a local `sh`
 * (see ssh-explorer.test.ts), so the jail, the mtime check and the temp-file
 * rename are the ones the remote host would run.
 */
function targetAt(root: string, argv = ['ssh', '-p', '2222', 'dev@box']): SshTarget {
  const parsed = parseSshTarget(argv, root);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

function localRunner(): SshRunner {
  return (_exe, args, _timeout, options) => new Promise<RunResult>((resolve) => {
    const child = spawn('sh', ['-c', args[args.length - 1]], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.stdin.on('error', () => undefined);
    child.stdin.end(options?.input);
    child.on('close', (code) => {
      const stdoutBuffer = Buffer.concat(out);
      resolve({ status: code ?? 1, stdout: stdoutBuffer.toString(), stderr: Buffer.concat(err).toString(), stdoutBuffer });
    });
  });
}

const unreachable: SshRunner = async () => ({ status: 255, stdout: '', stderr: 'Connection refused', stdoutBuffer: Buffer.alloc(0) });

beforeEach(() => {
  resetFileGrants();
  resetSshTargets();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('isRemoteIdentity', () => {
  it('is the ssh:// spelling only', () => {
    expect(isRemoteIdentity('ssh://box/w/a.md')).toBe(true);
    for (const local of ['C:\\w\\a.md', '/w/a.md', 'ssh:/x', '', undefined, 5]) expect(isRemoteIdentity(local)).toBe(false);
  });
});

describe('resolveRemoteIdentity', () => {
  const a = targetAt('/work/repo');

  it('maps an identity under a registered checkout to that target and a relative path', () => {
    expect(resolveRemoteIdentity('ssh://dev@box:2222/work/repo/docs/a.md', [a])).toEqual({ target: a, relPath: 'docs/a.md' });
    expect(resolveRemoteIdentity(remoteFilePath(a, ['x y', 'b.md']), [a])).toEqual({ target: a, relPath: 'x y/b.md' });
  });

  it('prefers the most specific checkout when one is nested in another', () => {
    const outer = targetAt('/work');
    const resolved = resolveRemoteIdentity('ssh://dev@box:2222/work/repo/a.md', [outer, a]);
    expect(resolved).toEqual({ target: a, relPath: 'a.md' });
  });

  it.each([
    ['another host', 'ssh://other@box:2222/work/repo/a.md'],
    ['another port', 'ssh://dev@box/work/repo/a.md'],
    ['outside the checkout', 'ssh://dev@box:2222/work/other/a.md'],
    ['a sibling that merely shares the prefix', 'ssh://dev@box:2222/work/repo-evil/a.md'],
    ['the checkout itself', 'ssh://dev@box:2222/work/repo'],
  ])('refuses %s', (_name, identity) => {
    expect(resolveRemoteIdentity(identity, [a])).toMatchObject({ error: expect.any(String) });
  });

  it('refuses ".." however it is spelled, and any non-canonical spelling of an in-checkout path', () => {
    for (const bad of [
      'ssh://dev@box:2222/work/repo/../secret.md',
      'ssh://dev@box:2222/work/repo/docs/../../x.md',
      'ssh://dev@box:2222/work/repo/docs/..',
    ]) expect(resolveRemoteIdentity(bad, [a])).toMatchObject({ code: 'outside_root' });
    // The grant key is the canonical spelling; a second spelling must not slip past it.
    for (const bad of [
      'ssh://dev@box:2222/work/repo//a.md',
      'ssh://dev@box:2222/work/repo/./a.md',
      'ssh://dev@box:2222/work/repo/docs//a.md',
    ]) expect(resolveRemoteIdentity(bad, [a])).toMatchObject({ code: 'invalid_path' });
  });

  it('refuses a NUL, and has nothing to resolve against with no target registered', () => {
    expect(resolveRemoteIdentity('ssh://dev@box:2222/work/repo/a\0.md', [a])).toMatchObject({ code: 'invalid_path' });
    expect(resolveRemoteIdentity('ssh://dev@box:2222/work/repo/a.md', [])).toMatchObject({ code: 'outside_root' });
  });
});

describe('saveRemoteMarkdown (fakes)', () => {
  const a = targetAt('/work/repo');
  const id = remoteFilePath(a, ['docs', 'a.md']);

  function deps(over: Partial<RemoteMarkdownDeps> = {}): RemoteMarkdownDeps {
    return {
      targets: () => [a],
      isGranted: () => true,
      write: vi.fn(async () => ({ filePath: id, mtimeMs: 42 })),
      read: vi.fn(async () => ({ filePath: id, content: 'x', mtimeMs: 7 })),
      ...over,
    };
  }

  it('asks for the grant under the remote key for THIS identity', async () => {
    const isGranted = vi.fn(() => true);
    await saveRemoteMarkdown(id, 'x', undefined, deps({ isGranted }));
    expect(isGranted).toHaveBeenCalledWith(remoteGrantKey(id));
  });

  it('an absent or non-numeric expected mtime is passed as "no check", never as NaN', async () => {
    const d = deps();
    await saveRemoteMarkdown(id, 'x', undefined, d);
    await saveRemoteMarkdown(id, 'x', Number.NaN, d);
    await saveRemoteMarkdown(id, 'x', '5', d);
    expect((d.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[3])).toEqual([undefined, undefined, undefined]);
  });

  it('refuses before any ssh: a bad extension, bad content, an identity of no registered target', async () => {
    const d = deps();
    expect(await saveRemoteMarkdown(remoteFilePath(a, ['run.ps1']), 'x', 1, d)).toMatchObject({ code: 'unsupported_type' });
    expect(await saveRemoteMarkdown(remoteFilePath(a, ['x.sh']), 'x', 1, d)).toMatchObject({ code: 'unsupported_type' });
    expect(await saveRemoteMarkdown(id, 42, 1, d)).toMatchObject({ code: 'invalid_path' });
    expect(await saveRemoteMarkdown(id, 'x'.repeat(5 * 1024 * 1024 + 1), 1, d)).toMatchObject({ code: 'too_large' });
    expect(await saveRemoteMarkdown('ssh://other@elsewhere/work/repo/a.md', 'x', 1, d)).toMatchObject({ code: 'outside_root' });
    expect(await saveRemoteMarkdown('ssh://dev@box:2222/work/repo/../a.md', 'x', 1, d)).toMatchObject({ code: 'outside_root' });
    expect(d.write).not.toHaveBeenCalled();
  });

  it('passes every other writer failure through, with its code', async () => {
    const d = deps({ write: vi.fn(async () => ({ error: 'Permission denied', code: 'denied' })) });
    expect(await saveRemoteMarkdown(id, 'x', 1, d)).toEqual({ error: 'Permission denied', code: 'denied' });
  });
});

describe('readRemoteMarkdown (fakes)', () => {
  const a = targetAt('/work/repo');
  const id = remoteFilePath(a, ['a.md']);
  const base = (over: Partial<RemoteMarkdownDeps> = {}): RemoteMarkdownDeps => ({
    targets: () => [a],
    isGranted: () => true,
    write: vi.fn(),
    read: vi.fn(async () => ({ filePath: id, content: 'text', mtimeMs: 9 })),
    ...over,
  });

  it('refuses without a grant, a bad extension, or an identity outside every checkout', async () => {
    expect(await readRemoteMarkdown(id, base({ isGranted: () => false }))).toMatchObject({ code: 'not_granted' });
    expect(await readRemoteMarkdown(remoteFilePath(a, ['a.ps1']), base())).toMatchObject({ code: 'unsupported_type' });
    expect(await readRemoteMarkdown('ssh://dev@box:2222/etc/passwd.md', base())).toMatchObject({ code: 'outside_root' });
  });
});

describe('defaultRemoteMarkdownDeps', () => {
  it('wires the registry, the window grants and the ssh runners', async () => {
    const a = targetAt('/work/repo');
    setSshTarget('ws-1', a);
    grantFilePath(7, remoteGrantKey('ssh://dev@box:2222/work/repo/a.md'));
    const d = defaultRemoteMarkdownDeps(listSshTargets, (key) => isFilePathGranted(7, key));
    expect(d.targets()).toEqual([a]);
    expect(d.isGranted(remoteGrantKey('ssh://dev@box:2222/work/repo/a.md'))).toBe(true);
    // Another window never saw the file.
    expect(defaultRemoteMarkdownDeps(listSshTargets, (key) => isFilePathGranted(8, key)).isGranted(remoteGrantKey('ssh://dev@box:2222/work/repo/a.md'))).toBe(false);
  });
});

describe.skipIf(!hasPosixTools(['gnu-find', 'stat-c', 'mktemp']))('remote markdown save, scripts run by a local sh', () => {
  let tmp: string;
  let root: string;
  let t: SshTarget;
  let remote: RemoteDeps;

  const depsFor = (run: SshRunner): RemoteMarkdownDeps => ({
    targets: () => [t],
    isGranted: (key) => isFilePathGranted(1, key),
    write: async (target, rel, content, expected) => {
      const { remoteWriteCodeFile } = await import('../../src/main/ssh-explorer');
      return remoteWriteCodeFile(target, rel, content, expected, { run, tool: () => 'ssh' });
    },
    read: (target, rel) => remoteReadCodeFile(target, rel, { run, tool: () => 'ssh' }),
  });

  beforeEach(() => {
    tmp = makeTmpDir('wmux-ssh-md-');
    root = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    t = targetAt(root);
    remote = { run: localRunner(), tool: () => 'ssh' };
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** What the explorer's markdown read does: read, then mint the grant under the remote key. */
  async function open(rel: string) {
    const read = await remoteReadCodeFile(t, rel, remote);
    if ('error' in read) throw new Error(read.error);
    grantFilePath(1, remoteGrantKey(read.filePath));
    return read;
  }

  it('saves on the remote host with the mtime from the read, leaving no temp files and touching no local path', async () => {
    fs.writeFileSync(path.join(root, 'docs', 'a.md'), '# old\n');
    const read = await open('docs/a.md');
    const res = await saveRemoteMarkdown(read.filePath, '# new\n', read.mtimeMs, depsFor(localRunner()));
    expect(res).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(root, 'docs', 'a.md'), 'utf8')).toBe('# new\n');
    expect(fs.readdirSync(path.join(root, 'docs'))).toEqual(['a.md']);
    // The ssh:// identity was never treated as a local path.
    expect(fs.existsSync(path.join(process.cwd(), 'ssh:'))).toBe(false);
    // The new mtime is the basis of the next save, which therefore does not conflict.
    const again = await saveRemoteMarkdown(read.filePath, '# newer\n', (res as { mtimeMs: number }).mtimeMs, depsFor(localRunner()));
    expect(again).toMatchObject({ ok: true });
  });

  it('answers `conflict` and changes nothing when the file changed since it was opened', async () => {
    fs.writeFileSync(path.join(root, 'docs', 'a.md'), '# old\n');
    const read = await open('docs/a.md');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, 'docs', 'a.md'), later, later);
    const res = await saveRemoteMarkdown(read.filePath, 'mine', read.mtimeMs, depsFor(localRunner()));
    expect(res).toMatchObject({ conflict: true });
    expect(fs.readFileSync(path.join(root, 'docs', 'a.md'), 'utf8')).toBe('# old\n');
  });

  it('is refused without the grant, even for a file inside the checkout', async () => {
    fs.writeFileSync(path.join(root, 'docs', 'a.md'), '# old\n');
    const res = await saveRemoteMarkdown(remoteFilePath(t, ['docs', 'a.md']), 'x', undefined, depsFor(localRunner()));
    expect(res).toMatchObject({ code: 'not_granted' });
    expect(fs.readFileSync(path.join(root, 'docs', 'a.md'), 'utf8')).toBe('# old\n');
  });

  it('a grant for one file does not cover another, nor a sibling spelling', async () => {
    fs.writeFileSync(path.join(root, 'docs', 'a.md'), 'a');
    fs.writeFileSync(path.join(root, 'docs', 'b.md'), 'b');
    await open('docs/a.md');
    expect(await saveRemoteMarkdown(remoteFilePath(t, ['docs', 'b.md']), 'x', undefined, depsFor(localRunner()))).toMatchObject({ code: 'not_granted' });
    expect(fs.readFileSync(path.join(root, 'docs', 'b.md'), 'utf8')).toBe('b');
  });

  it('never writes outside the checkout, with a grant for the escaping spelling or without', async () => {
    fs.writeFileSync(path.join(tmp, 'secret.md'), 'keep');
    const escaping = `${remoteFilePath(t, [])}/../secret.md`;
    grantFilePath(1, remoteGrantKey(escaping));
    expect(await saveRemoteMarkdown(escaping, 'pwned', undefined, depsFor(localRunner()))).toMatchObject({ code: 'outside_root' });
    expect(fs.readFileSync(path.join(tmp, 'secret.md'), 'utf8')).toBe('keep');
  });

  it('refuses a symlinked target, as the code editor does', async () => {
    fs.writeFileSync(path.join(tmp, 'elsewhere.md'), 'keep');
    fs.symlinkSync(path.join(tmp, 'elsewhere.md'), path.join(root, 'docs', 'link.md'));
    const id = remoteFilePath(t, ['docs', 'link.md']);
    grantFilePath(1, remoteGrantKey(id));
    expect(await saveRemoteMarkdown(id, 'pwned', undefined, depsFor(localRunner()))).toMatchObject({ error: expect.any(String) });
    expect(fs.readFileSync(path.join(tmp, 'elsewhere.md'), 'utf8')).toBe('keep');
  });

  it('says the host is unreachable, with the fixed sentence, and never writes locally', async () => {
    fs.writeFileSync(path.join(root, 'docs', 'a.md'), '# old\n');
    const read = await open('docs/a.md');
    const res = await saveRemoteMarkdown(read.filePath, 'x', read.mtimeMs, depsFor(unreachable));
    expect(res).toEqual({ error: 'Could not reach the remote host over ssh', code: 'ssh-unreachable' });
    expect(fs.readFileSync(path.join(root, 'docs', 'a.md'), 'utf8')).toBe('# old\n');
  });

  it('re-reads (reload from disk) a granted file with its current mtime', async () => {
    fs.writeFileSync(path.join(root, 'docs', 'a.md'), 'v1');
    const read = await open('docs/a.md');
    fs.writeFileSync(path.join(root, 'docs', 'a.md'), 'v2');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(root, 'docs', 'a.md'), later, later);
    const res = await readRemoteMarkdown(read.filePath, depsFor(localRunner()));
    expect(res).toMatchObject({ content: 'v2' });
    expect((res as { mtimeMs: number }).mtimeMs).toBeGreaterThan(read.mtimeMs);
  });
});
