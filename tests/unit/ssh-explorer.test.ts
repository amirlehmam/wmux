import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isValidEntryName,
  mtimeMsOf,
  remoteCreateEntry,
  remoteDeleteEntry,
  remoteGrantKey,
  remoteListDir,
  remoteReadCodeFile,
  remoteRelSegments,
  remoteRenameEntry,
  remoteWriteCodeFile,
  type RemoteDeps,
} from '../../src/main/ssh-explorer';
import { remoteCommandArgs, remoteFilePath } from '../../src/main/ssh-command';
import { parseSshTarget, type SshTarget } from '../../src/main/ssh-targets';
import type { RunResult, SshRunner } from '../../src/main/ssh-exec';
import { MAX_ENTRIES } from '../../src/main/explorer-fs';
import { hasPosixTools } from '../helpers/posix-tools';
import { remoteCommandText } from '../helpers/remote-command-text';

/**
 * The remote scripts are run FOR REAL here: the fake ssh takes the one command
 * string ssh would have sent and hands it to a local `sh -c`, exactly as the
 * remote host's login shell would. So quoting, the jail walk and the GNU find/stat
 * calls are exercised, with no network. (Needs a POSIX sh and GNU find, as the
 * remote host does; the suite is skipped where the host has neither.)
 */
function localRunner(calls: string[][] = []): SshRunner {
  return (_exe, args, _timeout, options) => new Promise<RunResult>((resolve) => {
    calls.push(args);
    const command = args[args.length - 1];
    const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
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

function depsWith(run: SshRunner): RemoteDeps {
  return { run, tool: () => 'ssh' };
}

function targetAt(root: string): SshTarget {
  const parsed = parseSshTarget(['ssh', '-p', '2222', 'dev@box'], root);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

const unreachable: SshRunner = async () => ({ status: 255, stdout: '', stderr: 'ssh: connect to host box port 22: Connection refused', stdoutBuffer: Buffer.alloc(0) });

describe('pure helpers', () => {
  it('remoteRelSegments folds empty and dot segments and refuses the rest', () => {
    expect(remoteRelSegments('')).toEqual([]);
    expect(remoteRelSegments('a//b/./c/')).toEqual(['a', 'b', 'c']);
    expect(remoteRelSegments('a\\b')).toEqual(['a\\b']);
    expect(remoteRelSegments('a/../b')).toEqual({ error: expect.any(String), code: 'outside_root' });
    expect(remoteRelSegments('/etc')).toEqual({ error: expect.any(String), code: 'invalid_path' });
    expect(remoteRelSegments('a\0b')).toEqual({ error: expect.any(String), code: 'invalid_path' });
    expect(remoteRelSegments(5)).toEqual({ error: expect.any(String), code: 'invalid_path' });
  });

  it('isValidEntryName', () => {
    expect(isValidEntryName('a b.txt')).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\0', 7, 'x'.repeat(256)]) expect(isValidEntryName(bad)).toBe(false);
  });

  it('mtimeMsOf truncates seconds to integer milliseconds', () => {
    expect(mtimeMsOf('1700000000.1239999')).toBe(1700000000123);
    expect(mtimeMsOf('1700000000')).toBe(1700000000000);
    expect(mtimeMsOf('nope')).toBe(0);
  });

  it('remoteFilePath is an ssh:// identity, not a local path', () => {
    const t = targetAt('/work/repo');
    expect(remoteFilePath(t, ['src', 'a.ts'])).toBe('ssh://dev@box:2222/work/repo/src/a.ts');
    expect(remoteFilePath(parseSshTarget(['ssh', 'box'], '/w') as SshTarget, [])).toBe('ssh://box/w');
    expect(remoteGrantKey('ssh://box/w/x')).toBe('ssh-code:ssh://box/w/x');
  });

  it('remoteCommandArgs: options, destination, then ONE quoted command with values as arguments', () => {
    const t = targetAt('/work/repo');
    const hostile = `x'; touch pwned; '`;
    const args = remoteCommandArgs(t, 'echo "$1"', ['/work/repo', hostile]);
    expect(args[0]).toBe('-T');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ConnectTimeout=6');
    expect(args[args.length - 2]).toBe('dev@box');
    expect(args[args.indexOf('-p') + 1]).toBe('2222');
    // The login shell sees only base64 inside single quotes; the command `sh` runs is the quoted one.
    expect(args[args.length - 1]).toMatch(/^sh -c 'eval "\$\(echo [A-Za-z0-9+/=]+\|base64 -d\)"'$/);
    const command = remoteCommandText(args);
    expect(command.startsWith(`sh -c 'echo "$1"' sh `)).toBe(true);
    // The hostile value only ever appears inside quotes, never in the script.
    expect(command).toContain(`'x'"'"'; touch pwned; '"'"''`);
    expect(command.split(' sh ')[0]).not.toContain('pwned');
  });
});

describe('no local fallback when ssh fails', () => {
  // The remote side is a POSIX path literal: it is parsed as a remote path, so a Windows temp dir is not one.
  const REMOTE_ROOT = '/srv/app';
  const code = 'ssh-unreachable';

  // Needs a real local directory spelled like a POSIX path, which Windows does not have.
  it.skipIf(process.platform === 'win32')('every operation reports ssh-unreachable even though the same path exists locally', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ssh-local-'));
    try {
      fs.writeFileSync(path.join(root, 'secret.txt'), 'LOCAL FILE');
      const t = targetAt(root);
      const d = depsWith(unreachable);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await remoteListDir(t, '', {}, d)).toMatchObject({ code });
      expect(await remoteReadCodeFile(t, 'secret.txt', d)).toMatchObject({ code });
      expect(await remoteWriteCodeFile(t, 'secret.txt', 'x', undefined, d)).toMatchObject({ code });
      expect(await remoteCreateEntry(t, '', 'new.txt', 'file', d)).toMatchObject({ code });
      expect(await remoteRenameEntry(t, 'secret.txt', 'b.txt', d)).toMatchObject({ code });
      expect(await remoteDeleteEntry(t, 'secret.txt', d)).toMatchObject({ code });
      expect(fs.readFileSync(path.join(root, 'secret.txt'), 'utf8')).toBe('LOCAL FILE');
      expect(fs.readdirSync(root)).toEqual(['secret.txt']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a missing ssh executable is also ssh-unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const d: RemoteDeps = { run: unreachable, tool: () => { throw new Error('matching ssh executable not found'); } };
    expect(await remoteListDir(targetAt(REMOTE_ROOT), '', {}, d)).toMatchObject({ code });
  });

  it('an unknown remote failure is read_failed for reads and write_failed for writes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const odd: SshRunner = async () => ({ status: 3, stdout: '', stderr: 'boom', stdoutBuffer: Buffer.alloc(0) });
    const t = targetAt(REMOTE_ROOT);
    expect(await remoteListDir(t, '', {}, depsWith(odd))).toMatchObject({ code: 'read_failed' });
    expect(await remoteReadCodeFile(t, 'a.txt', depsWith(odd))).toMatchObject({ code: 'read_failed' });
    expect(await remoteCreateEntry(t, '', 'n', 'dir', depsWith(odd))).toMatchObject({ code: 'write_failed' });
  });

  it('a read whose answer has no header is read_failed, not content', async () => {
    const garbled: SshRunner = async () => ({ status: 0, stdout: 'hi', stderr: '', stdoutBuffer: Buffer.from('no newline') });
    expect(await remoteReadCodeFile(targetAt(REMOTE_ROOT), 'a.txt', depsWith(garbled))).toMatchObject({ code: 'read_failed' });
  });

  it('a write whose answer is not an mtime is write_failed', async () => {
    const odd: SshRunner = async (_e, args) => {
      if (remoteCommandText(args).includes('meta=$(find')) {
        return { status: 0, stdout: '', stderr: '', stdoutBuffer: Buffer.from('3 1700000000.0\nabc') };
      }
      return { status: 0, stdout: 'garbage', stderr: '', stdoutBuffer: Buffer.from('garbage') };
    };
    expect(await remoteWriteCodeFile(targetAt(REMOTE_ROOT), 'a.txt', 'x', undefined, depsWith(odd))).toMatchObject({ code: 'write_failed' });
  });
});

// Root reads and writes everything, so the "denied" cases cannot happen as root.
const isRoot = process.getuid?.() === 0;

describe.skipIf(!hasPosixTools(['gnu-find', 'stat-c', 'mktemp']))('remote scripts, executed by a local sh', () => {
  let tmp: string;
  let root: string;
  let calls: string[][];
  let d: RemoteDeps;
  let t: SshTarget;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ssh-explorer-'));
    root = path.join(tmp, 'repo');
    fs.mkdirSync(root);
    calls = [];
    d = depsWith(localRunner(calls));
    t = targetAt(root);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    return () => {
      vi.restoreAllMocks();
      fs.rmSync(tmp, { recursive: true, force: true });
    };
  });

  describe('listDir', () => {
    it('lists kinds, sizes and mtimes, hiding dotfiles and the filtered names', async () => {
      fs.mkdirSync(path.join(root, 'src'));
      fs.mkdirSync(path.join(root, 'node_modules'));
      fs.mkdirSync(path.join(root, '.git'));
      fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
      fs.writeFileSync(path.join(root, '.env'), 'x');
      fs.writeFileSync(path.join(root, 'logo.png'), 'png');
      fs.symlinkSync('a.txt', path.join(root, 'link'));
      const result = await remoteListDir(t, '', {}, d);
      if ('error' in result) throw new Error(result.error);
      expect(result.root).toBe(root);
      expect(result.relPath).toBe('');
      expect(result.truncated).toBe(false);
      // Marks the listing as remote, so the explorer hides the actions that act on local paths.
      expect(result.remote).toBe(true);
      const byName = Object.fromEntries(result.entries.map((e) => [e.name, e]));
      expect(Object.keys(byName).sort()).toEqual(['a.txt', 'link', 'logo.png', 'src']);
      expect(byName['a.txt']).toMatchObject({ kind: 'file', size: 5, viewable: true });
      expect(byName['src']).toMatchObject({ kind: 'dir', viewable: false });
      expect(byName['link']).toMatchObject({ kind: 'symlink', viewable: false });
      expect(byName['logo.png']).toMatchObject({ kind: 'file', viewable: false });
      expect(Math.abs(byName['a.txt'].mtimeMs - fs.statSync(path.join(root, 'a.txt')).mtimeMs)).toBeLessThan(2);
    });

    it('shows hidden entries on request, but still not the filtered names it would show locally', async () => {
      fs.writeFileSync(path.join(root, '.env'), 'x');
      fs.mkdirSync(path.join(root, 'node_modules'));
      const result = await remoteListDir(t, '', { showHidden: true }, d);
      if ('error' in result) throw new Error(result.error);
      expect(result.entries.map((e) => e.name).sort()).toEqual(['.env', 'node_modules']);
    });

    it('lists a subdirectory and answers its relative path', async () => {
      fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'deep', 'x.ts'), '');
      const result = await remoteListDir(t, 'src//deep/', {}, d);
      expect(result).toMatchObject({ relPath: 'src/deep', entries: [{ name: 'x.ts', kind: 'file' }] });
    });

    it('keeps odd names whole: spaces, quotes, newlines, a leading dash, globs', async () => {
      const names = ['a b', `it's`, 'new\nline', '-dash', '*', '$(touch pwned)'];
      for (const name of names) fs.writeFileSync(path.join(root, name), '');
      const result = await remoteListDir(t, '', {}, d);
      if ('error' in result) throw new Error(result.error);
      expect(result.entries.map((e) => e.name).sort()).toEqual([...names].sort());
      expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);
    });

    it('caps the listing and says so', async () => {
      for (let i = 0; i < MAX_ENTRIES + 5; i++) fs.writeFileSync(path.join(root, `f${i}`), '');
      const result = await remoteListDir(t, '', {}, d);
      if ('error' in result) throw new Error(result.error);
      expect(result.entries).toHaveLength(MAX_ENTRIES);
      expect(result.truncated).toBe(true);
    });

    it('works when the checkout path itself is reached through a symlink', async () => {
      const alias = path.join(tmp, 'alias');
      fs.symlinkSync(root, alias);
      fs.writeFileSync(path.join(root, 'a.txt'), '');
      const result = await remoteListDir(targetAt(alias), '', {}, d);
      expect(result).toMatchObject({ entries: [{ name: 'a.txt' }] });
    });

    it.each([
      ['a file as the directory', 'a.txt', 'not_a_directory'],
      ['a missing directory', 'nope', 'not_found'],
      ['.. in the path', 'src/../..', 'outside_root'],
      ['an absolute path', '/etc', 'invalid_path'],
      ['a symlinked directory', 'outlink', 'outside_root'],
      ['below a symlinked directory', 'outlink/sub', 'outside_root'],
    ])('refuses %s', async (_name, rel, code) => {
      fs.writeFileSync(path.join(root, 'a.txt'), '');
      fs.mkdirSync(path.join(root, 'src'));
      fs.mkdirSync(path.join(tmp, 'outside'));
      fs.mkdirSync(path.join(tmp, 'outside', 'sub'));
      fs.symlinkSync(path.join(tmp, 'outside'), path.join(root, 'outlink'));
      expect(await remoteListDir(t, rel, {}, d)).toMatchObject({ code });
    });

    it('answers not_found for a checkout path that does not exist', async () => {
      expect(await remoteListDir(targetAt(path.join(tmp, 'gone')), '', {}, d)).toMatchObject({ code: 'not_found' });
    });

    it.skipIf(isRoot)('answers denied for a directory the login cannot read', async () => {
      fs.mkdirSync(path.join(root, 'locked'));
      fs.chmodSync(path.join(root, 'locked'), 0o000);
      try {
        expect(await remoteListDir(t, 'locked', {}, d)).toMatchObject({ code: 'denied' });
      } finally {
        fs.chmodSync(path.join(root, 'locked'), 0o755);
      }
    });
  });

  describe('readCodeFile', () => {
    it('reads text with its mtime, under an ssh:// identity', async () => {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'const a = 1;\n');
      const result = await remoteReadCodeFile(t, 'src/a.ts', d);
      if ('error' in result) throw new Error(result.error);
      expect(result.content).toBe('const a = 1;\n');
      expect(result.filePath).toBe(`ssh://dev@box:2222${root}/src/a.ts`);
      expect(Math.abs(result.mtimeMs - fs.statSync(path.join(root, 'src', 'a.ts')).mtimeMs)).toBeLessThan(2);
    });

    it('decodes a UTF-8 BOM and UTF-16LE like the local reader', async () => {
      fs.writeFileSync(path.join(root, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo')]));
      fs.writeFileSync(path.join(root, 'wide.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]));
      expect(await remoteReadCodeFile(t, 'bom.txt', d)).toMatchObject({ content: 'héllo' });
      expect(await remoteReadCodeFile(t, 'wide.txt', d)).toMatchObject({ content: 'hi' });
    });

    it('reads an empty file', async () => {
      fs.writeFileSync(path.join(root, 'empty.txt'), '');
      expect(await remoteReadCodeFile(t, 'empty.txt', d)).toMatchObject({ content: '' });
    });

    it('refuses binary by name and by content, and too large', async () => {
      fs.writeFileSync(path.join(root, 'a.png'), 'x');
      fs.writeFileSync(path.join(root, 'blob.txt'), Buffer.from([0x41, 0x00, 0x42]));
      fs.writeFileSync(path.join(root, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
      expect(await remoteReadCodeFile(t, 'a.png', d)).toMatchObject({ code: 'binary' });
      expect(await remoteReadCodeFile(t, 'blob.txt', d)).toMatchObject({ code: 'binary' });
      expect(await remoteReadCodeFile(t, 'big.txt', d)).toMatchObject({ code: 'too_large' });
    });

    it.each([
      ['the root itself', '', 'invalid_path'],
      ['a directory', 'src', 'invalid_path'],
      ['a missing file', 'nope.txt', 'not_found'],
      ['..', '../repo/a.txt', 'outside_root'],
      ['a symlinked file', 'link.txt', 'outside_root'],
      ['a file below a symlinked directory', 'outlink/secret.txt', 'outside_root'],
    ])('refuses %s', async (_name, rel, code) => {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(tmp, 'secret.txt'), 'SECRET');
      fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(root, 'link.txt'));
      fs.symlinkSync(tmp, path.join(root, 'outlink'));
      expect(await remoteReadCodeFile(t, rel, d)).toMatchObject({ code });
    });

    it.skipIf(isRoot)('answers denied for an unreadable file', async () => {
      fs.writeFileSync(path.join(root, 'locked.txt'), 'x');
      fs.chmodSync(path.join(root, 'locked.txt'), 0o000);
      expect(await remoteReadCodeFile(t, 'locked.txt', d)).toMatchObject({ code: 'denied' });
    });

    it('never passes the relative path through the script text', async () => {
      const rel = `'; touch pwned; '`;
      fs.writeFileSync(path.join(root, rel), 'ok');
      expect(await remoteReadCodeFile(t, rel, d)).toMatchObject({ content: 'ok' });
      expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);
      expect(calls[0][calls[0].length - 1].split(' sh ')[0]).not.toContain('pwned');
    });
  });

  describe('writeCodeFile', () => {
    it('writes through a temp file and rename, returning the new mtime, with no stray files', async () => {
      fs.writeFileSync(path.join(root, 'a.txt'), 'old');
      const read = await remoteReadCodeFile(t, 'a.txt', d);
      if ('error' in read) throw new Error(read.error);
      const written = await remoteWriteCodeFile(t, 'a.txt', 'new content', read.mtimeMs, d);
      if ('error' in written) throw new Error(written.error);
      expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('new content');
      expect(fs.readdirSync(root)).toEqual(['a.txt']);
      const reread = await remoteReadCodeFile(t, 'a.txt', d);
      expect(reread).toMatchObject({ mtimeMs: written.mtimeMs, content: 'new content' });
      expect(written.filePath).toBe(read.filePath);
    });

    it('refuses with a conflict, changing nothing, when the file changed since it was opened', async () => {
      fs.writeFileSync(path.join(root, 'a.txt'), 'old');
      const read = await remoteReadCodeFile(t, 'a.txt', d);
      if ('error' in read) throw new Error(read.error);
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(root, 'a.txt'), later, later);
      expect(await remoteWriteCodeFile(t, 'a.txt', 'mine', read.mtimeMs, d)).toMatchObject({ code: 'conflict' });
      expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('old');
      expect(fs.readdirSync(root)).toEqual(['a.txt']);
    });

    it('the script itself refuses a stale mtime, so a change after the read is a conflict too', async () => {
      fs.writeFileSync(path.join(root, 'a.txt'), 'old');
      const inner = localRunner();
      let sawRead = false;
      // Another writer touches the file between the read and the write call.
      const racing: SshRunner = async (exe, args, timeout, options) => {
        const result = await inner(exe, args, timeout, options);
        if (!sawRead && remoteCommandText(args).includes('meta=$(find')) {
          sawRead = true;
          const later = new Date(Date.now() + 9000);
          fs.utimesSync(path.join(root, 'a.txt'), later, later);
        }
        return result;
      };
      const read = await remoteReadCodeFile(t, 'a.txt', d);
      if ('error' in read) throw new Error(read.error);
      expect(await remoteWriteCodeFile(t, 'a.txt', 'mine', read.mtimeMs, depsWith(racing))).toMatchObject({ code: 'conflict' });
      expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('old');
      expect(fs.readdirSync(root)).toEqual(['a.txt']);
    });

    it('skips the check when no expected mtime is given', async () => {
      fs.writeFileSync(path.join(root, 'a.txt'), 'old');
      expect(await remoteWriteCodeFile(t, 'a.txt', 'forced', undefined, d)).toMatchObject({ filePath: expect.any(String) });
      expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('forced');
    });

    it('keeps CRLF, a UTF-8 BOM and the file mode', async () => {
      fs.writeFileSync(path.join(root, 'crlf.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')]));
      fs.chmodSync(path.join(root, 'crlf.txt'), 0o750);
      expect(await remoteWriteCodeFile(t, 'crlf.txt', 'x\ny\n', undefined, d)).toMatchObject({ mtimeMs: expect.any(Number) });
      const bytes = fs.readFileSync(path.join(root, 'crlf.txt'));
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(bytes.subarray(3).toString()).toBe('x\r\ny\r\n');
      expect(fs.statSync(path.join(root, 'crlf.txt')).mode & 0o777).toBe(0o750);
    });

    it('keeps UTF-16LE', async () => {
      fs.writeFileSync(path.join(root, 'w.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]));
      await remoteWriteCodeFile(t, 'w.txt', 'yo', undefined, d);
      expect(fs.readFileSync(path.join(root, 'w.txt'))).toEqual(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('yo', 'utf16le')]));
    });

    it('writes content with quotes and $ verbatim (stdin, never the script)', async () => {
      fs.writeFileSync(path.join(root, 'a.txt'), '');
      const content = `echo "$(touch pwned)" 'x' \`id\`\n`;
      await remoteWriteCodeFile(t, 'a.txt', content, undefined, d);
      expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe(content);
      expect(fs.existsSync(path.join(root, 'pwned'))).toBe(false);
    });

    it.each([
      ['a binary name', 'a.png', 'binary'],
      ['a missing file', 'nope.txt', 'not_found'],
      ['the root', '', 'invalid_path'],
      ['..', '../x.txt', 'outside_root'],
      ['a symlink', 'link.txt', 'outside_root'],
      ['a directory', 'dir', 'invalid_path'],
    ])('refuses %s', async (_name, rel, code) => {
      fs.mkdirSync(path.join(root, 'dir'));
      fs.writeFileSync(path.join(tmp, 'target.txt'), 'untouched');
      fs.symlinkSync(path.join(tmp, 'target.txt'), path.join(root, 'link.txt'));
      expect(await remoteWriteCodeFile(t, rel, 'x', undefined, d)).toMatchObject({ code });
      expect(fs.readFileSync(path.join(tmp, 'target.txt'), 'utf8')).toBe('untouched');
    });

    it('refuses non-string content and too large content', async () => {
      fs.writeFileSync(path.join(root, 'a.txt'), '');
      expect(await remoteWriteCodeFile(t, 'a.txt', 5, undefined, d)).toMatchObject({ code: 'invalid_path' });
      expect(await remoteWriteCodeFile(t, 'a.txt', 'x'.repeat(2 * 1024 * 1024 + 1), undefined, d)).toMatchObject({ code: 'too_large' });
    });

    it.skipIf(isRoot)('refuses a read-only file as denied', async () => {
      fs.writeFileSync(path.join(root, 'ro.txt'), 'x');
      fs.chmodSync(path.join(root, 'ro.txt'), 0o444);
      expect(await remoteWriteCodeFile(t, 'ro.txt', 'y', undefined, d)).toMatchObject({ code: 'denied' });
    });
  });

  describe('create, rename, delete', () => {
    it('creates a file and a folder, never overwriting', async () => {
      fs.mkdirSync(path.join(root, 'src'));
      expect(await remoteCreateEntry(t, 'src', 'new file.ts', 'file', d)).toEqual({ ok: true });
      expect(await remoteCreateEntry(t, '', 'docs', 'dir', d)).toEqual({ ok: true });
      expect(fs.statSync(path.join(root, 'src', 'new file.ts')).isFile()).toBe(true);
      expect(fs.statSync(path.join(root, 'docs')).isDirectory()).toBe(true);
      fs.writeFileSync(path.join(root, 'src', 'keep.ts'), 'keep');
      expect(await remoteCreateEntry(t, 'src', 'keep.ts', 'file', d)).toMatchObject({ code: 'invalid_path' });
      expect(fs.readFileSync(path.join(root, 'src', 'keep.ts'), 'utf8')).toBe('keep');
    });

    it('refuses bad names and parents', async () => {
      fs.writeFileSync(path.join(root, 'a.txt'), '');
      for (const name of ['', '.', '..', 'a/b', 'x\0']) {
        expect(await remoteCreateEntry(t, '', name, 'file', d)).toMatchObject({ code: 'invalid_path' });
      }
      expect(await remoteCreateEntry(t, 'a.txt', 'x', 'file', d)).toMatchObject({ code: 'not_a_directory' });
      expect(await remoteCreateEntry(t, '..', 'x', 'file', d)).toMatchObject({ code: 'outside_root' });
      expect(fs.existsSync(path.join(tmp, 'x'))).toBe(false);
    });

    it('renames within the same directory only', async () => {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'A');
      fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'B');
      expect(await remoteRenameEntry(t, 'src/a.ts', 'c d.ts', d)).toEqual({ ok: true });
      expect(fs.readFileSync(path.join(root, 'src', 'c d.ts'), 'utf8')).toBe('A');
      expect(fs.existsSync(path.join(root, 'src', 'a.ts'))).toBe(false);
      expect(await remoteRenameEntry(t, 'src/c d.ts', 'b.ts', d)).toMatchObject({ code: 'invalid_path' });
      expect(await remoteRenameEntry(t, 'src/c d.ts', '../escape.ts', d)).toMatchObject({ code: 'invalid_path' });
      expect(await remoteRenameEntry(t, '', 'x', d)).toMatchObject({ code: 'invalid_path' });
      expect(await remoteRenameEntry(t, 'src/missing', 'x', d)).toMatchObject({ code: 'not_found' });
      expect(fs.readFileSync(path.join(root, 'src', 'b.ts'), 'utf8')).toBe('B');
    });

    it('does not rename a symlink', async () => {
      fs.writeFileSync(path.join(tmp, 't.txt'), '');
      fs.symlinkSync(path.join(tmp, 't.txt'), path.join(root, 'link'));
      expect(await remoteRenameEntry(t, 'link', 'other', d)).toMatchObject({ code: 'outside_root' });
      expect(fs.lstatSync(path.join(root, 'link')).isSymbolicLink()).toBe(true);
    });

    it('deletes a file and an empty folder, but never a folder with content', async () => {
      fs.writeFileSync(path.join(root, 'a.txt'), '');
      fs.mkdirSync(path.join(root, 'empty'));
      fs.mkdirSync(path.join(root, 'full'));
      fs.writeFileSync(path.join(root, 'full', 'x'), '');
      expect(await remoteDeleteEntry(t, 'a.txt', d)).toEqual({ ok: true });
      expect(await remoteDeleteEntry(t, 'empty', d)).toEqual({ ok: true });
      expect(await remoteDeleteEntry(t, 'full', d)).toMatchObject({ code: 'write_failed' });
      expect(fs.readdirSync(root)).toEqual(['full']);
      expect(fs.existsSync(path.join(root, 'full', 'x'))).toBe(true);
    });

    it('never deletes the root, a symlink target, or anything outside', async () => {
      fs.writeFileSync(path.join(tmp, 'outside.txt'), 'keep');
      fs.symlinkSync(path.join(tmp, 'outside.txt'), path.join(root, 'link'));
      expect(await remoteDeleteEntry(t, '', d)).toMatchObject({ code: 'invalid_path' });
      expect(await remoteDeleteEntry(t, '../outside.txt', d)).toMatchObject({ code: 'outside_root' });
      expect(await remoteDeleteEntry(t, 'link', d)).toMatchObject({ code: 'outside_root' });
      expect(await remoteDeleteEntry(t, 'missing', d)).toMatchObject({ code: 'not_found' });
      expect(fs.readFileSync(path.join(tmp, 'outside.txt'), 'utf8')).toBe('keep');
      expect(fs.existsSync(root)).toBe(true);
    });
  });
});
