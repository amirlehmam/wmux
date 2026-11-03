import { describe, it, expect } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { gitBashIntegrationArgs, GIT_BASH_LOGIN_ARGS } from '../../src/main/git-bash';
import { buildShellArgs, gitBashArgs } from '../../src/main/pty-manager';
import { WSL_ENV_PASSTHROUGH } from '../../src/main/pane-browser-env';

/**
 * Issues #427 and #428: the bash integration reported nothing from Git Bash or
 * WSL. Nothing loaded it in Git Bash, its native transport appended to a temp
 * file no part of wmux reads, Git Bash's cwd came out as `/c/...` (POSIX to
 * wmux, so never restored), WSL's bash could not source the CRLF copy the
 * release shipped, and WSLENV's /u kept the pipe and token away from the
 * Windows helpers a WSL pane starts.
 */

const ROOT = path.join(__dirname, '..', '..');
const SH = path.join(ROOT, 'src', 'shell-integration', 'wmux-bash-integration.sh');
const INTEGRATION_DIR = path.dirname(SH);
const CLI = path.join(ROOT, 'resources', 'cli', 'wmux.js');
const GIT_BASH = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
const hasGitBash = process.platform === 'win32' && fs.existsSync(GIT_BASH);

describe('shell scripts ship with LF (#428)', () => {
  it('.gitattributes checks every .sh out LF whatever core.autocrlf says', () => {
    // The attribute, not the bytes on disk: a checkout made before the
    // attribute existed keeps its CRLF copy until it is checked out again, but
    // the release runner always checks out fresh.
    const rules = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith('#'));
    expect(rules).toContain('*.sh text eol=lf');
    // No later line may take the integration back to CRLF.
    expect(rules.filter((l) => /wmux-bash-integration|\.sh\b/.test(l) && /eol=crlf/.test(l))).toEqual([]);
  });
});

describe('Git Bash loads the integration (#427)', () => {
  const script = 'C:\\wmux\\resources\\shell-integration\\wmux-bash-integration.sh';

  it('a login "Git Bash" pane trades --login for --init-file and asks the script for the login files', () => {
    expect(gitBashIntegrationArgs(GIT_BASH, GIT_BASH_LOGIN_ARGS, script)).toEqual({
      args: ['--init-file', 'C:/wmux/resources/shell-integration/wmux-bash-integration.sh', '-i'],
      login: true,
    });
  });

  it('a launcher path with no args stays a non-login shell', () => {
    expect(gitBashIntegrationArgs(GIT_BASH, [], script)?.login).toBe(false);
  });

  it('leaves the user\'s own args, a raw usr\\bin bash and the WSL launcher alone', () => {
    expect(gitBashIntegrationArgs(GIT_BASH, ['--norc'], script)).toBeNull();
    expect(gitBashIntegrationArgs(GIT_BASH, ['-c', 'make'], script)).toBeNull();
    expect(gitBashIntegrationArgs('C:\\Program Files\\Git\\usr\\bin\\bash.exe', [], script)).toBeNull();
    expect(gitBashIntegrationArgs('C:\\Windows\\System32\\bash.exe', [], script)).toBeNull();
    expect(gitBashIntegrationArgs('C:\\Windows\\System32\\cmd.exe', [], script)).toBeNull();
  });

  it('sets the prologue\'s variables only when it injects', () => {
    const env: Record<string, string> = {};
    expect(gitBashArgs(GIT_BASH, GIT_BASH_LOGIN_ARGS, INTEGRATION_DIR, env)?.[0]).toBe('--init-file');
    expect(env).toEqual({ WMUX_BASH_INIT: '1', WMUX_BASH_LOGIN: '1' });

    const plain: Record<string, string> = {};
    gitBashArgs(GIT_BASH, [], INTEGRATION_DIR, plain);
    expect(plain).toEqual({ WMUX_BASH_INIT: '1' });
  });

  it('starts bash as asked when the script is missing, rather than skipping ~/.bashrc', () => {
    const env: Record<string, string> = {};
    expect(gitBashArgs(GIT_BASH, GIT_BASH_LOGIN_ARGS, path.join(os.tmpdir(), 'wmux-no-such-dir-427'), env)).toBeNull();
    expect(env).toEqual({});
  });
});

describe('WSLENV lets a Windows helper started in the pane reach wmux (#428)', () => {
  const flags = new Map(WSL_ENV_PASSTHROUGH.split(':').map((entry) => {
    const [name, flag = ''] = entry.split('/');
    return [name, flag] as const;
  }));

  it('carries the surface, the pipe and the token both ways', () => {
    for (const name of ['WMUX', 'WMUX_SURFACE_ID', 'WMUX_PIPE', 'WMUX_PIPE_TOKEN']) {
      expect(flags.get(name), name).toBe('');
    }
    // Translated both ways: /mnt/c/... inside, C:\... for node.exe.
    expect(flags.get('WMUX_CLI')).toBe('p');
  });

  it('keeps one-way what Windows must not get back', () => {
    expect(flags.get('BROWSER')).toBe('u');
    expect(flags.get('WMUX_REMOTE')).toBe('u');
    expect(flags.get('WMUX_REMOTE_TOKEN')).toBe('u');
    expect(flags.get('WMUX_WSL_NODE')).toBe('up');
  });

  it('never hands WMUX_NODE in: the cli-bin shim would run node.exe on a /mnt script path', () => {
    expect(flags.has('WMUX_NODE')).toBe(false);
  });

  it('a WSL pane gets the runtime and the script the integration needs', () => {
    const env: Record<string, string> = { WMUX_NODE: 'C:\\Program Files\\nodejs\\node.exe' };
    buildShellArgs('wsl', env, INTEGRATION_DIR, undefined);
    expect(env.WMUX_WSL_NODE).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(env.WMUX_BASH_SCRIPT).toBe(SH);
    expect(env.WSLENV).toContain('WMUX_BASH_SCRIPT/up');
  });
});

describe('the native transport', () => {
  it('no longer writes to the temp file nothing reads', () => {
    const code = fs.readFileSync(SH, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toContain('AppData/Local/Temp');
    expect(code).toContain('raw-v1 "$msg"');
  });
});

/** What the integration resolves as its transport, sourced under a faked platform. */
function resolvedTransport(setup: string[]): string {
  const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const script = [
    ...setup,
    'unset WMUX_SURFACE_ID WMUX_REMOTE',
    `source ${sq(SH.replace(/\\/g, '/'))}`,
    'trap - DEBUG',
    'printf "%s|%s|%s" "$_wmux_windows" "$_wmux_cli_node" "$_wmux_cli_script"',
  ].join('\n');
  return execFileSync(GIT_BASH, ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe.skipIf(!hasGitBash)('transport resolution', () => {
  const node = process.execPath;

  it('Git Bash runs WMUX_CLI with WMUX_NODE', () => {
    const out = resolvedTransport([`export WMUX_NODE='${node}' WMUX_CLI='C:\\wmux\\wmux.js'`]);
    expect(out).toBe(`1|${node}|C:\\wmux\\wmux.js`);
  });

  it('WSL runs the Windows-spelled CLI with WMUX_WSL_NODE', () => {
    const out = resolvedTransport([
      'OSTYPE=linux-gnu',
      `export WSL_DISTRO_NAME=Ubuntu WMUX_WSL_NODE='${node}' WMUX_CLI=/mnt/c/wmux/wmux.js`,
      'wslpath() { [ "$1" = -w ] && printf "C:\\\\wmux\\\\wmux.js\\n"; }',
    ]);
    expect(out).toBe(`|${node}|C:\\wmux\\wmux.js`);
  });

  it('WSL without a Windows runtime stays silent rather than guessing', () => {
    const out = resolvedTransport([
      'OSTYPE=linux-gnu',
      'export WSL_DISTRO_NAME=Ubuntu WMUX_CLI=/mnt/c/wmux/wmux.js',
      'unset WMUX_WSL_NODE',
    ]);
    expect(out).toBe('||');
  });
});

/**
 * End to end: Git's launcher started the way pty-manager starts it, a fake
 * wmux pipe, and the real CLI carrying the reports. What arrives is what main
 * would get.
 */
async function gitBashSession(login: boolean, commands: string[]): Promise<{ output: string; lines: string[] }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-gitbash-home-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-gitbash-cd-'));
  fs.writeFileSync(path.join(home, '.bashrc'), 'echo "RC=bashrc"\n');
  fs.writeFileSync(path.join(home, '.bash_profile'), 'echo "RC=profile"\n');
  const pipe = `\\\\.\\pipe\\wmux-gitbash-${process.pid}-${login ? 'l' : 'n'}`;
  const lines: string[] = [];
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\n')) {
        lines.push(buf.trim().replace(/^auth \S+ /, ''));
        socket.end('ok\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(pipe, resolve));
  try {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      WMUX: '1', WMUX_SURFACE_ID: 'surf-gitbash', WMUX_PIPE: pipe, WMUX_PIPE_TOKEN: 'tok',
      WMUX_CLI: CLI, WMUX_NODE: process.execPath,
    };
    const args = gitBashArgs(GIT_BASH, login ? GIT_BASH_LOGIN_ARGS : [], INTEGRATION_DIR, env);
    expect(args).not.toBeNull();
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(GIT_BASH, args as string[], { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { out += d.toString(); });
      child.on('error', reject);
      child.on('exit', () => resolve(out));
      child.stdin.write(`cd '${target.replace(/\\/g, '/')}'\n`);
      for (const c of commands) child.stdin.write(`${c}\n`);
      child.stdin.end('exit\n');
    });
    // The reports are backgrounded node processes; give the last ones time.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !lines.some((l) => l.startsWith(`report_pwd surf-gitbash ${target}`))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 1500));
    return { output, lines: lines.map((l) => l.replace(target, '<target>')) };
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
}

describe.skipIf(!hasGitBash)('a Git Bash pane reports a cwd wmux can restore (#427)', () => {
  it('reports the cwd after `cd` as a Windows path, through the pipe', async () => {
    const { lines } = await gitBashSession(true, []);
    expect(lines).toContain('report_pwd surf-gitbash <target>');
    // Never the MSYS spelling, which isPosixPath reads as a WSL path.
    expect(lines.filter((l) => /^report_pwd surf-gitbash \//.test(l))).toEqual([]);
  }, 60_000);

  it('reads the login files for a login pane, ~/.bashrc otherwise, and clears its own variables', async () => {
    const probe = 'echo "INIT=${WMUX_BASH_INIT-unset} LOGIN=${WMUX_BASH_LOGIN-unset}"';
    const login = await gitBashSession(true, [probe]);
    expect(login.output).toContain('RC=profile');
    expect(login.output).not.toContain('RC=bashrc');
    expect(login.output).toContain('INIT=unset LOGIN=unset');

    const plain = await gitBashSession(false, [probe]);
    expect(plain.output).toContain('RC=bashrc');
    expect(plain.output).not.toContain('RC=profile');
  }, 120_000);

  it('reports "running" once per command line, not once per simple command', async () => {
    const { lines } = await gitBashSession(false, ['true; true; true']);
    const running = lines.filter((l) => / running$/.test(l)).length;
    const idle = lines.filter((l) => / idle$/.test(l)).length;
    // One per command line typed (cd, the loop, exit), never more than the prompts.
    expect(running).toBeLessThanOrEqual(3);
    expect(idle).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
