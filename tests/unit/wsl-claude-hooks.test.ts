import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { applyWmuxHooks } from '../../src/main/claude-context';
import {
  applyWslClaudeHooks,
  decodeWslOutput,
  isInsideDistro,
  isSkippedDistro,
  noteWslPaneOpened,
  PANE_SYNC_DELAYS_MS,
  parseWslDistroList,
  reconcileWslSettingsFile,
  removeWslClaudeHooks,
  resetWslClaudeHooksForTests,
  setWslClaudeHooksWanted,
  syncWslClaudeHooks,
  WSL_HOOK_HELPER,
  wslClaudeHooksIdle,
  wslHookCommand,
  type WslBoundary,
  type WslSettingsLocation,
} from '../../src/main/wsl-claude-hooks';

/**
 * Issue #428, last part: Claude Code inside a WSL pane reads the distro's own
 * ~/.claude/settings.json, so wmux's hooks have to be there too, under the same
 * consent, with the same inverse, and without waking a distro that is stopped.
 *
 * Real files in a temp dir throughout; the only stand-in is the wsl.exe
 * boundary (which distros are running, where their settings file is).
 */

const ROOT = path.join(__dirname, '..', '..');
const ALL_EVENTS = [
  'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'SubagentStart',
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SessionEnd',
];
const commandsOf = (settings: any): string[] =>
  Object.values(settings.hooks ?? {}).flatMap((entries: any) =>
    entries.flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command as string)));

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsl-hooks-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** A distro home with a ~/.claude/settings.json holding `content`. */
function distroSettings(name: string, content: string | null): string {
  const dir = path.join(tmp, name, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  if (content !== null) fs.writeFileSync(file, content);
  return file;
}

/** The wsl.exe boundary: a set of running distros and where their files are. */
function fakeWsl(running: string[], files: Record<string, WslSettingsLocation>) {
  const probed: string[] = [];
  const boundary: WslBoundary = {
    runningDistros: async () => [...running],
    claudeSettingsPath: async (distro) => {
      probed.push(distro);
      return files[distro] ?? null;
    },
  };
  return { boundary, probed, running };
}

describe('the hook commands written into a distro', () => {
  it('cover every event the Windows hooks cover, with the same entries', () => {
    const wsl = applyWslClaudeHooks({});
    const win = applyWmuxHooks({}, '/res/cli/wmux-hook.js');
    expect(Object.keys(wsl.hooks).sort()).toEqual(ALL_EVENTS.sort());
    for (const event of ALL_EVENTS) {
      // Same matchers and async flags; only the command spelling differs.
      const shape = (entries: any[]) => entries.map((e) => ({ matcher: e.matcher, async: e.hooks[0].async }));
      expect(shape(wsl.hooks[event]), event).toEqual(shape(win.hooks[event]));
    }
  });

  it('start the helper only inside a wmux WSL pane, and name no install path', () => {
    expect(wslHookCommand('--event Stop')).toBe(
      '[ ! -f "${WMUX_BASH_SCRIPT%/*}/wmux-hook-wsl.sh" ] || sh "${WMUX_BASH_SCRIPT%/*}/wmux-hook-wsl.sh" --event Stop',
    );
    for (const cmd of commandsOf(applyWslClaudeHooks({}))) {
      expect(cmd).toContain('wmux-hook'); // the marker removal matches
      expect(cmd).not.toMatch(/[A-Za-z]:[\\/]|\/mnt\//);
    }
  });

  it('are idempotent and keep the user\'s own hooks and keys', () => {
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'audit.sh' }] };
    const settings = { model: 'opus', hooks: { PostToolUse: [mine] } };
    const once = applyWslClaudeHooks(settings);
    expect(applyWslClaudeHooks(once)).toEqual(once);
    expect(once.model).toBe('opus');
    expect(once.hooks.PostToolUse[0]).toEqual(mine);
    expect(removeWslClaudeHooks(once)).toEqual(settings);
  });

  it('removal leaves nothing behind in a file that had no hooks', () => {
    expect(removeWslClaudeHooks(applyWslClaudeHooks({ theme: 'dark' }))).toEqual({ theme: 'dark' });
  });
});

describe('the helper the hooks run', () => {
  it('ships in both shell-integration copies, LF-only', () => {
    for (const dir of ['src', 'resources']) {
      const file = path.join(ROOT, dir, 'shell-integration', WSL_HOOK_HELPER);
      expect(fs.readFileSync(file, 'utf8')).not.toContain('\r');
    }
  });
});

describe('wsl.exe output', () => {
  it('reads the UTF-16LE list wsl.exe prints, and the UTF-8 one under WSL_UTF8', () => {
    expect(parseWslDistroList(Buffer.from('Ubuntu\r\ndocker-desktop\r\n', 'utf16le'))).toEqual(['Ubuntu', 'docker-desktop']);
    expect(parseWslDistroList(Buffer.from('\uFEFFDebian\n', 'utf8'))).toEqual(['Debian']);
    expect(parseWslDistroList(Buffer.alloc(0))).toEqual([]);
    expect(decodeWslOutput(Buffer.from('/home/me/.claude/settings.json\n'))).toBe('/home/me/.claude/settings.json\n');
  });

  it('skips Docker Desktop\'s own distros only', () => {
    expect(isSkippedDistro('docker-desktop')).toBe(true);
    expect(isSkippedDistro('docker-desktop-data')).toBe(true);
    expect(isSkippedDistro('Ubuntu')).toBe(false);
    expect(isSkippedDistro('my-docker-desktop-clone')).toBe(false);
  });

  it('takes a settings path only inside the distro it came from', () => {
    expect(isInsideDistro('\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\settings.json', 'Ubuntu')).toBe(true);
    expect(isInsideDistro('\\\\wsl$\\ubuntu\\home\\me\\.claude\\settings.json', 'Ubuntu')).toBe(true);
    // A symlink out to the Windows ~/.claude: ensureClaudeHooks owns that file.
    expect(isInsideDistro('C:\\Users\\me\\.claude\\settings.json', 'Ubuntu')).toBe(false);
    expect(isInsideDistro('\\\\wsl.localhost\\Debian\\home\\me\\.claude\\settings.json', 'Ubuntu')).toBe(false);
    expect(isInsideDistro('\\\\wsl.localhost\\Ubuntu-22.04\\x', 'Ubuntu')).toBe(false);
  });
});

describe('reconcileWslSettingsFile', () => {
  it('installs, then leaves the file alone, then takes the hooks back', async () => {
    const original = '{\n    "model": "opus"\n}\n';
    const file = distroSettings('Ubuntu', original);

    expect(await reconcileWslSettingsFile(file, true)).toBe('installed');
    const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(installed.model).toBe('opus');
    expect(commandsOf(installed).every((c) => c.includes(WSL_HOOK_HELPER))).toBe(true);

    const bytes = fs.readFileSync(file);
    expect(await reconcileWslSettingsFile(file, true)).toBe('unchanged');
    expect(fs.readFileSync(file)).toEqual(bytes);

    expect(await reconcileWslSettingsFile(file, false)).toBe('removed');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ model: 'opus' });
  });

  it('never rewrites a file wmux has nothing to change in, whatever its formatting', async () => {
    const original = '{\n\t"model": "opus"\n}';
    const file = distroSettings('Ubuntu', original);
    expect(await reconcileWslSettingsFile(file, false)).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('does not create a missing file, and leaves one that does not parse', async () => {
    const missing = distroSettings('NoClaude', null);
    expect(await reconcileWslSettingsFile(missing, true)).toBe('absent');
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'nowhere'))).toBe(false);
    expect(await reconcileWslSettingsFile(path.join(tmp, 'nowhere', '.claude', 'settings.json'), true)).toBe('absent');

    const broken = distroSettings('Broken', '{ "model": ');
    expect(await reconcileWslSettingsFile(broken, true)).toBe('unreadable');
    expect(fs.readFileSync(broken, 'utf8')).toBe('{ "model": ');
    const list = distroSettings('List', '[]');
    expect(await reconcileWslSettingsFile(list, true)).toBe('unreadable');
  });

  it('replaces the Windows-spelled wmux hooks a user copied in by hand, keeping theirs', async () => {
    const copied = applyWmuxHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } },
      'C:/Program Files/wmux/resources/cli/wmux-hook.js');
    const file = distroSettings('Ubuntu', JSON.stringify(copied, null, 2));
    await reconcileWslSettingsFile(file, true);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(commandsOf(after).filter((c) => c.includes('C:/Program Files'))).toEqual([]);
    expect(commandsOf(after)).toContain('mine.sh');
  });
});

describe('syncWslClaudeHooks', () => {
  it('looks only at running distros, skipping Docker Desktop\'s', async () => {
    const ubuntu = distroSettings('Ubuntu', '{}');
    const debian = distroSettings('Debian', '{}');
    // Debian is installed but stopped: the boundary does not list it, so it is
    // never probed and its file never read.
    const wsl = fakeWsl(['Ubuntu', 'docker-desktop'], { Ubuntu: { file: ubuntu }, Debian: { file: debian } });

    expect(await syncWslClaudeHooks(true, wsl.boundary)).toEqual({ Ubuntu: 'installed' });
    expect(wsl.probed).toEqual(['Ubuntu']);
    expect(fs.readFileSync(debian, 'utf8')).toBe('{}');
  });

  it('settles a distro once per decision, but keeps probing one without Claude', async () => {
    const ubuntu = distroSettings('Ubuntu', '{}');
    const wsl = fakeWsl(['Ubuntu', 'Alpine'], { Ubuntu: { file: ubuntu } });
    const done = new Map<string, boolean>();

    expect(await syncWslClaudeHooks(true, wsl.boundary, done)).toEqual({ Ubuntu: 'installed', Alpine: 'absent' });
    expect(await syncWslClaudeHooks(true, wsl.boundary, done)).toEqual({ Alpine: 'absent' });
    expect(wsl.probed).toEqual(['Ubuntu', 'Alpine', 'Alpine']);

    expect(await syncWslClaudeHooks(false, wsl.boundary, done)).toEqual({ Ubuntu: 'removed', Alpine: 'absent' });
    expect(fs.readFileSync(ubuntu, 'utf8')).toBe('{}');
  });

  it('never writes a settings file that resolves outside its distro', async () => {
    const wsl = fakeWsl(['Ubuntu'], { Ubuntu: { outside: 'C:\\Users\\me\\.claude\\settings.json' } });
    expect(await syncWslClaudeHooks(true, wsl.boundary)).toEqual({ Ubuntu: 'outside' });
  });

  it('carries on past a distro that fails, and retries it next pass', async () => {
    const ubuntu = distroSettings('Ubuntu', '{}');
    let failing = true;
    const done = new Map<string, boolean>();
    const boundary: WslBoundary = {
      runningDistros: async () => ['Flaky', 'Ubuntu'],
      claudeSettingsPath: async (d) => {
        if (d === 'Flaky' && failing) throw new Error('wsl.exe timed out');
        return d === 'Ubuntu' ? { file: ubuntu } : null;
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await syncWslClaudeHooks(true, boundary, done)).toEqual({ Ubuntu: 'installed' });
    warn.mockRestore();
    failing = false;
    expect(await syncWslClaudeHooks(true, boundary, done)).toEqual({ Flaky: 'absent' });
  });
});

describe('when a pass runs', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetWslClaudeHooksForTests();
  });

  it('nothing is read or written before the consent gate decides', async () => {
    const ubuntu = distroSettings('Ubuntu', '{}');
    const wsl = fakeWsl(['Ubuntu'], { Ubuntu: { file: ubuntu } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resetWslClaudeHooksForTests(wsl.boundary);

    noteWslPaneOpened();
    await vi.advanceTimersByTimeAsync(Math.max(...PANE_SYNC_DELAYS_MS) + 1);
    await wslClaudeHooksIdle();
    expect(wsl.probed).toEqual([]);
    expect(fs.readFileSync(ubuntu, 'utf8')).toBe('{}');
  });

  it('the decision reconciles the running distros, and a WSL pane catches the distro it booted', async () => {
    const ubuntu = distroSettings('Ubuntu', '{}');
    const debian = distroSettings('Debian', '{}');
    const wsl = fakeWsl(['Ubuntu'], { Ubuntu: { file: ubuntu }, Debian: { file: debian } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resetWslClaudeHooksForTests(wsl.boundary);

    setWslClaudeHooksWanted(true);
    await wslClaudeHooksIdle();
    expect(commandsOf(JSON.parse(fs.readFileSync(ubuntu, 'utf8'))).length).toBeGreaterThan(0);
    expect(fs.readFileSync(debian, 'utf8')).toBe('{}');

    // A pane opens in Debian, which boots it. Opening only arms a timer.
    noteWslPaneOpened();
    noteWslPaneOpened();
    wsl.running.push('Debian');
    expect(wsl.probed).toEqual(['Ubuntu']);
    await vi.advanceTimersByTimeAsync(PANE_SYNC_DELAYS_MS[0]);
    await wslClaudeHooksIdle();
    expect(commandsOf(JSON.parse(fs.readFileSync(debian, 'utf8'))).length).toBeGreaterThan(0);
    // Both distros settled: later passes do not probe them again.
    await vi.advanceTimersByTimeAsync(PANE_SYNC_DELAYS_MS[1]);
    await wslClaudeHooksIdle();
    expect(wsl.probed).toEqual(['Ubuntu', 'Debian']);
  });

  it('panes opening steadily cannot postpone a pass: it runs within the first delay of the first open', async () => {
    const ubuntu = distroSettings('Ubuntu', '{}');
    const wsl = fakeWsl([], { Ubuntu: { file: ubuntu } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resetWslClaudeHooksForTests(wsl.boundary);
    setWslClaudeHooksWanted(true);
    await wslClaudeHooksIdle();

    // Ubuntu boots with the first pane; another pane opens every second after.
    wsl.running.push('Ubuntu');
    const [first] = PANE_SYNC_DELAYS_MS;
    noteWslPaneOpened();
    for (let elapsed = 0; elapsed < first; elapsed += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      noteWslPaneOpened();
    }
    await wslClaudeHooksIdle();
    expect(wsl.probed).toEqual(['Ubuntu']);
    expect(commandsOf(JSON.parse(fs.readFileSync(ubuntu, 'utf8'))).length).toBeGreaterThan(0);
  });

  it('a burst of pane opens still costs one pass per delay', async () => {
    const wsl = fakeWsl([], {});
    let lists = 0;
    const boundary: WslBoundary = { ...wsl.boundary, runningDistros: async () => { lists++; return []; } };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    resetWslClaudeHooksForTests(boundary);
    setWslClaudeHooksWanted(true);
    await wslClaudeHooksIdle();
    lists = 0;

    for (let i = 0; i < 20; i++) noteWslPaneOpened();
    await vi.advanceTimersByTimeAsync(Math.max(...PANE_SYNC_DELAYS_MS) + 1);
    await wslClaudeHooksIdle();
    expect(lists).toBe(PANE_SYNC_DELAYS_MS.length);
  });

  it('switching hooks off takes them back from every running distro', async () => {
    const ubuntu = distroSettings('Ubuntu', '{"model":"opus"}');
    const wsl = fakeWsl(['Ubuntu'], { Ubuntu: { file: ubuntu } });
    resetWslClaudeHooksForTests(wsl.boundary);

    setWslClaudeHooksWanted(true);
    await wslClaudeHooksIdle();
    setWslClaudeHooksWanted(false);
    await wslClaudeHooksIdle();
    expect(JSON.parse(fs.readFileSync(ubuntu, 'utf8'))).toEqual({ model: 'opus' });
  });
});

/**
 * End to end, minus WSL itself: the exact command written into settings.json,
 * run by a POSIX shell with the environment a wmux WSL pane has, reaches a pipe
 * through the real compiled wmux-hook.js. `wslpath` is the one stand-in.
 */
const GIT_BASH = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
const hasGitBash = process.platform === 'win32' && fs.existsSync(GIT_BASH);
const fwd = (p: string) => p.replace(/\\/g, '/');

function exitCodeOf(err: (Error & { code?: unknown }) | null): number {
  if (!err) return 0;
  return typeof err.code === 'number' ? err.code : 1;
}

function runHookCommand(command: string, env: Record<string, string>, stdin: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(GIT_BASH, ['-c', command], { env, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: exitCodeOf(err), out: `${stdout}${stderr}` });
    });
    child.stdin?.end(stdin);
  });
}

describe.skipIf(!hasGitBash)('a hook fired by Claude Code in a WSL pane', () => {
  const SESSION = '3f0a9c1e-5b7d-4e2a-9c3f-1a2b3c4d5e6f';
  let bin: string;

  beforeEach(() => {
    bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    // WSL's wslpath -w, played by Git's cygpath.
    fs.writeFileSync(path.join(bin, 'wslpath'), '#!/bin/sh\n[ "$1" = -w ] && cygpath -w "$2"\n');
  });

  function paneEnv(extra: Record<string, string>): Record<string, string> {
    const env = { ...(process.env as Record<string, string>) };
    for (const k of Object.keys(env)) if (k.startsWith('WMUX') || k === 'GROK_HOOK_EVENT') delete env[k];
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ''}`;
    return { ...env, ...extra };
  }

  it('reports to the pipe, with the session id, through the Windows hook script', async () => {
    const pipe = `\\\\.\\pipe\\wmux-wsl-hook-${process.pid}`;
    let deliver: (line: string) => void = () => {};
    const received = new Promise<string>((r) => { deliver = r; });
    const server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('\n')) { deliver(buf.trim()); socket.end(); }
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(pipe, r));
    try {
      const cmd = commandsOf(applyWslClaudeHooks({})).find((c) => c.endsWith('--event SessionStart')) as string;
      const { code } = await runHookCommand(cmd, paneEnv({
        WMUX: '1', WMUX_SURFACE_ID: 'surf-wsl', WMUX_PIPE: pipe, WMUX_PIPE_TOKEN: 'tok',
        WMUX_BASH_SCRIPT: fwd(path.join(ROOT, 'src', 'shell-integration', 'wmux-bash-integration.sh')),
        WMUX_CLI: fwd(path.join(ROOT, 'resources', 'cli', 'wmux.js')),
        WMUX_WSL_NODE: fwd(process.execPath),
      }), JSON.stringify({ session_id: SESSION, hook_event_name: 'SessionStart', source: 'startup' }));
      expect(code).toBe(0);
      const line = await Promise.race([received, new Promise<string>((r) => setTimeout(() => r(''), 15_000))]);
      expect(line).toContain('surf-wsl');
      expect(line).toContain(SESSION);
      expect(line).toContain('SessionStart');
      // Marked as a WSL session, so the startup prune does not judge it by the
      // Windows transcripts (#428).
      expect(JSON.parse(line).params.host).toBe('wsl');
    } finally {
      server.close();
    }
  }, 30_000);

  it('ends at once, successfully, outside a wmux pane', async () => {
    const cmd = wslHookCommand('--event Stop');
    const { code, out } = await runHookCommand(cmd, paneEnv({}), '{}');
    expect(code).toBe(0);
    expect(out).toBe('');
  }, 30_000);

  it('runs wmux\'s own binary as node only with ELECTRON_RUN_AS_NODE carried across interop', async () => {
    // A stand-in runtime that prints what it was given.
    const runtime = path.join(bin, 'runtime');
    fs.writeFileSync(runtime, '#!/bin/sh\nprintf "%s|%s|%s" "$ELECTRON_RUN_AS_NODE" "$WSLENV" "$*"\n');
    fs.chmodSync(runtime, 0o700);
    const base = {
      WMUX_BASH_SCRIPT: fwd(path.join(ROOT, 'src', 'shell-integration', 'wmux-bash-integration.sh')),
      WMUX_CLI: fwd(path.join(ROOT, 'resources', 'cli', 'wmux.js')),
      WMUX_WSL_NODE: fwd(runtime),
      WSLENV: 'WMUX',
    };
    const hookJs = path.join(ROOT, 'resources', 'cli', 'wmux-hook.js');

    const electron = await runHookCommand(wslHookCommand('Bash'), paneEnv({ ...base, WMUX_NODE_ELECTRON: '1' }), '{}');
    expect(electron.out).toBe(`1|WMUX:ELECTRON_RUN_AS_NODE|${hookJs} Bash --host wsl`);

    const node = await runHookCommand(wslHookCommand('Bash'), paneEnv(base), '{}');
    expect(node.out).toBe(`|WMUX|${hookJs} Bash --host wsl`);
  }, 30_000);

  it('succeeds in a pane opened by a wmux without the helper, rather than exiting 2 (block)', async () => {
    const older = path.join(tmp, 'old-wmux', 'shell-integration');
    fs.mkdirSync(older, { recursive: true });
    const { code, out } = await runHookCommand(wslHookCommand('--event PreToolUse'), paneEnv({
      WMUX_BASH_SCRIPT: fwd(path.join(older, 'wmux-bash-integration.sh')),
    }), '{}');
    expect(code).toBe(0);
    expect(out).toBe('');
  }, 30_000);

  it('succeeds whatever the runtime exits with, so a hook never blocks a tool or a stop', async () => {
    // What dash and busybox do with a Windows binary when interop is off: retry
    // it as a script, fail to parse it, exit 2. Any runtime failure stands in.
    const runtime = path.join(bin, 'runtime');
    fs.writeFileSync(runtime, '#!/bin/sh\necho reported\nexit 2\n');
    fs.chmodSync(runtime, 0o700);
    const env = paneEnv({
      WMUX_BASH_SCRIPT: fwd(path.join(ROOT, 'src', 'shell-integration', 'wmux-bash-integration.sh')),
      WMUX_CLI: fwd(path.join(ROOT, 'resources', 'cli', 'wmux.js')),
      WMUX_WSL_NODE: fwd(runtime),
    });
    for (const args of ['--event PreToolUse', '--event Stop', '--event UserPromptSubmit']) {
      const { code, out } = await runHookCommand(wslHookCommand(args), env, '{}');
      expect(code).toBe(0);
      // The runtime still ran, and its output still reaches Claude Code.
      expect(out).toBe('reported\n');
    }
  }, 30_000);

  it('stays silent when the pane has no Windows runtime', async () => {
    const { code, out } = await runHookCommand(wslHookCommand('--event Stop'), paneEnv({
      WMUX_BASH_SCRIPT: fwd(path.join(ROOT, 'src', 'shell-integration', 'wmux-bash-integration.sh')),
      WMUX_CLI: fwd(path.join(ROOT, 'resources', 'cli', 'wmux.js')),
    }), '{}');
    expect(code).toBe(0);
    expect(out).toBe('');
  }, 30_000);
});
