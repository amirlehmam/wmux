import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  remoteListDir,
  remoteReadCodeFile,
  remoteWriteCodeFile,
  type RemoteDeps,
} from '../../src/main/ssh-explorer';
import { remoteCommandArgs, remoteInvocation } from '../../src/main/ssh-command';
import { GIT_SCRIPT, isSshUnreachable, sshGitCommand, type SshGitContext } from '../../src/main/ssh-git';
import { handleGitView } from '../../src/main/git-view';
import {
  isSpawnErrorCode,
  isWslRouteUnreachable,
  runSsh,
  wslRemoteCommand,
  wslSshArgs,
  type RunResult,
  type SshRunner,
} from '../../src/main/ssh-exec';
import { parseSshTarget, resetSshTargets, type SshTarget } from '../../src/main/ssh-targets';
import { wslExecutable } from '../../src/main/system32';
import { hasPosixTools } from '../helpers/posix-tools';

/**
 * ssh inside WSL (`wmux set-ssh-target --wsl-distro`). No test here starts a
 * real ssh or wsl.exe: a fake runner records what would have been spawned, and
 * the one quoting-sensitive step is executed with a local `sh`.
 */

const WSL_ARGV = [
  'ssh', '-o', 'UserKnownHostsFile=/home/u/.ssh/known_hosts', '-o', 'StrictHostKeyChecking=yes', 'dev@h',
];
const DISTRO = 'Ubuntu-24.04';

function wslTarget(argv: string[] = WSL_ARGV, root = '/w/repo', distro: string | null = DISTRO): SshTarget {
  const parsed = parseSshTarget(argv, root, distro ?? undefined);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

function ok(stdout = ''): RunResult {
  const stdoutBuffer = Buffer.from(stdout);
  return { status: 0, stdout, stderr: '', stdoutBuffer };
}

function failed(status: number, extra: Partial<RunResult> = {}): RunResult {
  return { status, stdout: '', stderr: 'C:\\Users\\me\\secret: boom', stdoutBuffer: Buffer.alloc(0), ...extra };
}

const toolNeverAsked = vi.fn((): string => { throw new Error('Windows OpenSSH must not be consulted on the WSL route'); });

function depsWith(run: SshRunner): RemoteDeps {
  return { run, tool: toolNeverAsked };
}

beforeEach(() => {
  resetSshTargets();
  toolNeverAsked.mockClear();
  vi.stubEnv('SystemRoot', 'C:\\Windows');
});

afterEach(() => vi.unstubAllEnvs());

describe('the WSL route argv', () => {
  const script = `printf '%s\n' "$1" "$2"; echo "$0" 100%\n`;
  const hostile = `it's a "x" $HOME %PATH% ../../etc;'rm -rf /'`;

  it('is wsl.exe -d <distro> --exec ssh <options> <destination> <command>, with no shell', () => {
    const inv = remoteInvocation(wslTarget(), script, [hostile, 'a b'], toolNeverAsked);
    expect(inv.file).toBe('C:\\Windows\\System32\\wsl.exe');
    expect(inv.viaWsl).toBe(true);
    expect(inv.cwd).toBe('C:\\Windows');
    expect(inv.args).toEqual([
      '-d', DISTRO, '--exec', 'ssh', '-T', '-q',
      '-o', 'ConnectTimeout=6',
      '-o', 'ServerAliveInterval=20',
      '-o', 'ServerAliveCountMax=2',
      '-o', 'BatchMode=yes',
      '-o', 'ClearAllForwardings=yes',
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPath=/tmp/wmux-%C',
      '-o', 'ControlPersist=300',
      '-o', 'UserKnownHostsFile=/home/u/.ssh/known_hosts',
      '-o', 'StrictHostKeyChecking=yes',
      'dev@h',
      'set -f;IFS=;eval $(echo c2ggLWMgJ3ByaW50ZiAnIiciJyVzCiciJyInICIkMSIgIiQyIjsgZWNobyAiJDAiIDEwMCUKJyBzaCAnaXQnIiciJ3MgYSAieCIgJEhPTUUgJVBBVEglIC4uLy4uL2V0YzsnIiciJ3JtIC1yZiAvJyInIicnICdhIGIn|base64 -d)',
    ]);
    expect(toolNeverAsked).not.toHaveBeenCalled();
  });

  it('hands nothing but safe characters to wsl.exe in the remote command, whatever the script and paths hold', () => {
    const inv = remoteInvocation(wslTarget(), script, [hostile, 'a b', '..\\..\\x'], toolNeverAsked);
    const command = inv.args[inv.args.length - 1];
    expect(command).toMatch(/^set -f;IFS=;eval \$\(echo [A-Za-z0-9+/=]+\|base64 -d\)$/);
    expect(command).not.toMatch(/['"\\%\n]/);
  });

  it('decodes to exactly the command the direct route sends', () => {
    const target = wslTarget();
    const inv = remoteInvocation(target, script, [hostile, 'a b'], toolNeverAsked);
    const command = inv.args[inv.args.length - 1];
    const encoded = /echo ([A-Za-z0-9+/=]+)\|/.exec(command)?.[1] ?? '';
    const direct = remoteCommandArgs(target, script, [hostile, 'a b']);
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(direct[direct.length - 1]);
  });

  it('is built from the pushed words: -F -J -i -p and the WSL known_hosts, nothing translated or added', () => {
    const target = wslTarget(
      ['ssh', '-F', '/home/u/.ssh/cfg', '-J', 'jump', '-p', '2222', '-i', '/home/u/.ssh/id', '-4', '-A', '-C',
        '-o', 'UserKnownHostsFile=/home/u/.ssh/known_hosts', 'dev@h'],
    );
    const args = wslSshArgs(target.session, DISTRO, 'CMD');
    expect(args.slice(args.indexOf('-4'))).toEqual([
      '-4', '-A', '-C', '-F', '/home/u/.ssh/cfg', '-J', 'jump', '-p', '2222', '-i', '/home/u/.ssh/id',
      '-o', 'UserKnownHostsFile=/home/u/.ssh/known_hosts', 'dev@h', 'CMD',
    ]);
    expect(args.join(' ')).not.toMatch(/[A-Za-z]:\\|wsl\.localhost|ssh\.exe/);
  });

  it('puts the ControlMaster options in exactly once, and drops the pushed ones and the pushed ControlPath', () => {
    const target = wslTarget([
      'ssh', '-o', 'ControlMaster=yes', '-o', 'ControlPath=/run/user/pane-%C', '-o', 'ControlPersist=yes',
      '-o', 'BatchMode=no', '-o', 'ClearAllForwardings=no', 'dev@h',
    ]);
    target.session.sshOptions.push('RemoteCommand=bash');
    const options = wslSshArgs(target.session, DISTRO, 'CMD').filter((_, i, all) => all[i - 1] === '-o');
    const count = (prefix: string) => options.filter((o) => o.toLowerCase().startsWith(prefix)).length;
    for (const key of ['controlmaster=', 'controlpath=', 'controlpersist=', 'batchmode=', 'clearallforwardings=']) {
      expect(count(key)).toBe(1);
    }
    expect(options).toEqual(expect.arrayContaining(['ControlMaster=auto', 'ControlPath=/tmp/wmux-%C', 'ControlPersist=300', 'BatchMode=yes', 'ClearAllForwardings=yes']));
    expect(options.some((o) => /^RemoteCommand/i.test(o))).toBe(false);
  });

  it('keeps a pushed ConnectTimeout and ServerAlive values instead of adding its own', () => {
    const target = wslTarget(['ssh', '-o', 'ConnectTimeout=30', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=9', 'dev@h']);
    const options = wslSshArgs(target.session, DISTRO, 'CMD').filter((_, i, all) => all[i - 1] === '-o');
    expect(options.filter((o) => o.startsWith('ConnectTimeout='))).toEqual(['ConnectTimeout=30']);
    expect(options.filter((o) => o.startsWith('ServerAliveInterval='))).toEqual(['ServerAliveInterval=5']);
    expect(options.filter((o) => o.startsWith('ServerAliveCountMax='))).toEqual(['ServerAliveCountMax=9']);
  });

  it('uses the SystemRoot the environment names', () => {
    expect(wslExecutable({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\wsl.exe');
    expect(wslExecutable({ windir: 'E:\\W' })).toBe('E:\\W\\System32\\wsl.exe');
    expect(wslExecutable({})).toBe('C:\\Windows\\System32\\wsl.exe');
  });

  it('does not touch the direct route: the host ssh, ControlMaster=no, the one-string command, no wsl', () => {
    const direct = wslTarget(WSL_ARGV, '/w/repo', null);
    const inv = remoteInvocation(direct, 'echo "$1"\n', ['a b'], () => 'C:\\ssh.exe');
    expect(inv.viaWsl).toBe(false);
    expect(inv.file).toBe('C:\\ssh.exe');
    expect(inv.cwd).toBeUndefined();
    expect(inv.args).toEqual(remoteCommandArgs(direct, 'echo "$1"\n', ['a b']));
    expect(inv.args).toEqual([
      '-T', '-q',
      '-o', 'ConnectTimeout=6', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=2',
      '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'UserKnownHostsFile=/home/u/.ssh/known_hosts', '-o', 'StrictHostKeyChecking=yes',
      'dev@h',
      `sh -c 'echo "$1"\n' sh 'a b'`,
    ]);
  });
});

describe.skipIf(!hasPosixTools(['base64']))('the remote command, executed by a local sh', () => {
  /** What the remote host's login shell does with the one string ssh hands it. */
  function runRemote(command: string, input?: string): Promise<{ status: number; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'] });
      const out: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => out.push(c));
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
      child.on('close', (code) => resolve({ status: code ?? 1, stdout: Buffer.concat(out).toString() }));
    });
  }

  const script = `printf '[%s]' "$@"; echo; echo "$0"; cat\n`;
  const args = [`it's`, `a "b"`, '$HOME `id` $(id)', '%PATH% %C', '..\\..\\x', '*', 'new\nline', '--', '-n'];

  it('gives the script exactly the arguments the direct route gives it, and passes stdin through', async () => {
    const target = wslTarget();
    const wsl = remoteInvocation(target, script, args, toolNeverAsked);
    const direct = remoteCommandArgs(target, script, args);
    const viaWsl = await runRemote(wsl.args[wsl.args.length - 1], 'body from stdin');
    const plain = await runRemote(direct[direct.length - 1], 'body from stdin');
    expect(viaWsl).toEqual(plain);
    expect(viaWsl.status).toBe(0);
    expect(viaWsl.stdout).toContain(`[it's][a "b"][$HOME \`id\` $(id)][%PATH% %C][..\\..\\x][*][new\nline][--][-n]`);
    expect(viaWsl.stdout.endsWith('body from stdin')).toBe(true);
  });

  it('does not glob or split the decoded text, and keeps the exit status', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.txt'), '');
      const inv = remoteInvocation(wslTarget(), 'echo "$1"; exit 23\n', ['*.txt  spaced'], toolNeverAsked);
      const result = await new Promise<{ status: number; stdout: string }>((resolve) => {
        const child = spawn('sh', ['-c', inv.args[inv.args.length - 1]], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
        let stdout = '';
        child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
        child.on('close', (code) => resolve({ status: code ?? 1, stdout }));
      });
      expect(result).toEqual({ status: 23, stdout: '*.txt  spaced\n' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the explorer scripts run through it: list, read and write with stdin content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-root-'));
    try {
      fs.writeFileSync(path.join(root, 'a b.txt'), 'hello');
      const calls: Array<{ file: string; args: string[] }> = [];
      const run: SshRunner = (file, args, _t, options) => new Promise<RunResult>((resolve) => {
        calls.push({ file, args });
        const child = spawn('sh', ['-c', args[args.length - 1]], { stdio: ['pipe', 'pipe', 'pipe'] });
        const out: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => out.push(c));
        child.stdin.on('error', () => undefined);
        child.stdin.end(options?.input);
        child.on('close', (code) => {
          const stdoutBuffer = Buffer.concat(out);
          resolve({ status: code ?? 1, stdout: stdoutBuffer.toString(), stderr: '', stdoutBuffer });
        });
      });
      const target = wslTarget(WSL_ARGV, root);
      const deps = depsWith(run);
      const listing = await remoteListDir(target, '', {}, deps);
      expect(listing).toMatchObject({ entries: [expect.objectContaining({ name: 'a b.txt' })] });
      expect(await remoteReadCodeFile(target, 'a b.txt', deps)).toMatchObject({ content: 'hello' });
      const wrote = await remoteWriteCodeFile(target, 'a b.txt', 'changed', undefined, deps);
      expect(wrote).not.toHaveProperty('error');
      expect(fs.readFileSync(path.join(root, 'a b.txt'), 'utf8')).toBe('changed');
      expect(calls.every((c) => c.file === 'C:\\Windows\\System32\\wsl.exe' && c.args[0] === '-d')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('explorer over the WSL route', () => {
  it('runs wsl.exe from the Windows directory, never the session cwd or Windows OpenSSH', async () => {
    const run = vi.fn<SshRunner>(async () => ok(''));
    const target = wslTarget();
    target.session.workingDirectory = 'C:\\Users\\me\\work';
    await remoteListDir(target, '', {}, depsWith(run));
    const [file, args, , options] = run.mock.calls[0];
    expect(file).toBe('C:\\Windows\\System32\\wsl.exe');
    expect(args.slice(0, 4)).toEqual(['-d', DISTRO, '--exec', 'ssh']);
    expect(options?.cwd).toBe('C:\\Windows');
    expect(toolNeverAsked).not.toHaveBeenCalled();
  });

  it.each([
    ['ssh could not connect (255)', failed(255)],
    ['wsl.exe has no such distro (-1, unsigned)', failed(4294967295)],
    ['wsl.exe has no such distro (-1)', failed(-1)],
    ['wsl.exe did not start', failed(1, { spawnFailed: true })],
  ])('reports %s as ssh-unreachable, with no raw stderr', async (_name, result) => {
    const run: SshRunner = async () => result;
    const target = wslTarget();
    for (const answer of [
      await remoteListDir(target, '', {}, depsWith(run)),
      await remoteReadCodeFile(target, 'a.txt', depsWith(run)),
      await remoteWriteCodeFile(target, 'a.txt', 'x', undefined, depsWith(run)),
    ]) {
      expect(answer).toEqual({ error: 'Could not reach the remote host over ssh', code: 'ssh-unreachable' });
      expect(JSON.stringify(answer)).not.toContain('secret');
    }
  });

  it('a plain exit 1 from the remote is still a read failure, not "unreachable"', async () => {
    const run: SshRunner = async () => failed(1);
    expect(await remoteListDir(wslTarget(), '', {}, depsWith(run))).toMatchObject({ code: 'read_failed' });
  });

  it('keeps the direct route\'s own mapping: -1 and a spawn failure are not "unreachable" there', async () => {
    const direct = wslTarget(WSL_ARGV, '/w', null);
    const deps: RemoteDeps = { run: async () => failed(4294967295), tool: () => 'ssh' };
    expect(await remoteListDir(direct, '', {}, deps)).toMatchObject({ code: 'read_failed' });
    expect(await remoteListDir(direct, '', {}, { ...deps, run: async () => failed(255) })).toMatchObject({ code: 'ssh-unreachable' });
  });
});

describe('git over the WSL route', () => {
  it('sshGitCommand goes through the same invocation, with the git args as quoted arguments', () => {
    const ctx: SshGitContext = { target: wslTarget(), tool: toolNeverAsked };
    const cmd = sshGitCommand(ctx, '/w/repo', ['status', '--', `x'; touch pwned; '`]);
    expect(cmd).toMatchObject({ file: 'C:\\Windows\\System32\\wsl.exe', ssh: true, wsl: true, cwd: 'C:\\Windows' });
    expect(cmd.args.slice(0, 4)).toEqual(['-d', DISTRO, '--exec', 'ssh']);
    expect(cmd.args).toContain('ControlPersist=300');
    const same = remoteInvocation(ctx.target, GIT_SCRIPT, ['/w/repo', 'status', '--', `x'; touch pwned; '`], toolNeverAsked);
    expect(cmd.args).toEqual(same.args);
    expect(toolNeverAsked).not.toHaveBeenCalled();
  });

  it('is the host ssh, and not wsl, without a distro', () => {
    const ctx: SshGitContext = { target: wslTarget(WSL_ARGV, '/w/repo', null), tool: () => 'ssh' };
    expect(sshGitCommand(ctx, '/w/repo', ['status'])).toMatchObject({ file: 'ssh', wsl: false });
  });

  it('isSshUnreachable adds wsl.exe\'s failures on the WSL route only', () => {
    expect(isSshUnreachable({ code: 255 })).toBe(true);
    expect(isSshUnreachable({ code: 255 }, true)).toBe(true);
    for (const code of [4294967295, -1, 'ENOENT', 'EACCES']) {
      expect(isSshUnreachable({ code }, true)).toBe(true);
      expect(isSshUnreachable({ code })).toBe(false);
    }
    for (const code of [1, 128, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', undefined]) {
      expect(isSshUnreachable({ code }, true)).toBe(false);
    }
    expect(isSshUnreachable(null, true)).toBe(false);
    expect(isSshUnreachable('x')).toBe(false);
  });

  it('the Git view answers unreachable when wsl.exe cannot start, and reads nothing local', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-git-'));
    // No System32\wsl.exe here (nor on Linux at all): the spawn itself fails.
    vi.stubEnv('SystemRoot', dir);
    try {
      const res = await handleGitView({ op: 'repo', cwd: dir }, { target: wslTarget() });
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining('Could not reach the remote host over ssh') });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ssh-exec helpers', () => {
  it('wslRemoteCommand is the base64 of the command, evaluated without globbing or splitting', () => {
    expect(wslRemoteCommand('echo hi')).toBe('set -f;IFS=;eval $(echo ZWNobyBoaQ==|base64 -d)');
  });

  it('isWslRouteUnreachable', () => {
    expect(isWslRouteUnreachable(255, false)).toBe(true);
    expect(isWslRouteUnreachable(4294967295, undefined)).toBe(true);
    expect(isWslRouteUnreachable(-1, undefined)).toBe(true);
    expect(isWslRouteUnreachable(1, true)).toBe(true);
    expect(isWslRouteUnreachable(1, false)).toBe(false);
    expect(isWslRouteUnreachable(23, undefined)).toBe(false);
  });

  it('isSpawnErrorCode: the OS refusing to start, not a child that ran', () => {
    expect(isSpawnErrorCode('ENOENT')).toBe(true);
    expect(isSpawnErrorCode('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')).toBe(false);
    expect(isSpawnErrorCode(255)).toBe(false);
  });

  it('runSsh marks an executable that cannot start, and only that', async () => {
    const missing = await runSsh(path.join(os.tmpdir(), 'wmux-no-such-wsl-exe'), [], 5000);
    expect(missing).toMatchObject({ status: 1, spawnFailed: true });
    if (process.platform !== 'win32') {
      const exit3 = await runSsh('sh', ['-c', 'exit 3'], 5000);
      expect(exit3.status).toBe(3);
      expect(exit3.spawnFailed).toBeUndefined();
      const exit255 = await runSsh('sh', ['-c', 'exit 255'], 5000);
      expect(exit255.status).toBe(255);
      const big = await runSsh('sh', ['-c', 'head -c 4000 /dev/zero'], 5000, { maxBuffer: 10 });
      expect(big.spawnFailed).toBeUndefined();
    }
  });
});
