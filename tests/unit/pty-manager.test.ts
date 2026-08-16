import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PtyManager, parseShellSpec, resolveSpawnCwd, resolveShellForCwd, resolveExistingShellPath, comparePackageVersion, shellEnv } from '../../src/main/pty-manager';
import type { SurfaceId } from '../../src/shared/types';

const TEST_SHELL = 'cmd.exe';
const TEST_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined)
) as Record<string, string>;

/**
 * These spawn REAL ConPTY processes, which is the point — the bugs this suite
 * exists for (#150's crash guard, the double-spawn guard, orphan reaping) all
 * live in node-pty's actual behaviour rather than in anything mockable.
 *
 * The cost is that `pty.spawn()` competes for a shared CI runner, and it is a
 * synchronous call: when the runner is loaded it can stall well past the 15s
 * global timeout, failing a test that does nothing but check an id prefix.
 * That happened to the v1.0.1 tag — with `src/main/pty-manager.ts` byte-identical
 * to the v1.0.0 that had passed — so the flake blocked a release rather than
 * catching anything.
 *
 * A generous per-suite timeout is the right lever, not a longer global one. It
 * only ever costs wall-clock on a spawn that was going to fail anyway, and the
 * global 15s stays tight for the ~1000 tests that touch no processes. The
 * readiness barrier below still resolves rather than rejects, so a slow runner
 * degrades into a slower test rather than a hang either way.
 */
describe('PtyManager', { timeout: 60_000 }, () => {
  const managers: PtyManager[] = [];

  function makeManager(): PtyManager {
    const m = new PtyManager();
    managers.push(m);
    return m;
  }

  /**
   * Resolves once the pty has emitted anything, which on Windows is the signal
   * that node-pty's socket is connected and no longer deferring calls.
   *
   * Resolves rather than rejects on timeout: this is a readiness barrier, not
   * an assertion, and a slow CI runner should not turn into a hang.
   */
  function firstData(manager: PtyManager, id: SurfaceId, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsub();
        resolve();
      }, timeoutMs);
      const unsub = manager.onData(id, () => {
        clearTimeout(timer);
        unsub();
        resolve();
      });
    });
  }

  afterEach(() => {
    for (const m of managers) {
      m.killAll();
    }
    managers.length = 0;
  });

  it('create returns a surf- prefixed SurfaceId', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    expect(id).toMatch(/^surf-/);
  });

  it('has() returns true after create and false after kill', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    expect(manager.has(id)).toBe(true);
    manager.kill(id);
    expect(manager.has(id)).toBe(false);
  });

  it('write does not throw', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    expect(() => manager.write(id, 'echo hello\r')).not.toThrow();
  });

  it('write of a large payload (>1KB) does not throw and is processed via the chunked queue', async () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    // 8 KiB payload — would have flooded ConPTY's input buffer in one shot
    // before the per-PTY chunked write queue was added.
    const big = 'x'.repeat(8 * 1024);
    expect(() => manager.write(id, big)).not.toThrow();
    // Yield long enough for setImmediate-driven chunks to drain.
    await new Promise((r) => setTimeout(r, 50));
  });

  it('resize does not throw', async () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    // Wait for the pty to actually connect before resizing.
    //
    // On Windows, node-pty DEFERS any call made before its socket is up and
    // replays it on connect. Resizing a just-created pty therefore queued a
    // resize that afterEach's killAll() outran: the socket connected after the
    // pty was dead, the replayed resize threw "Cannot resize a pty that has
    // already exited" from inside node-pty's socket callback, and because that
    // throw is asynchronous no try/catch here or in PtyManager could ever see
    // it. Vitest reported it as an unhandled error and failed the whole run —
    // on CI only, since locally the connect usually won the race.
    //
    // Resizing a connected pty is also the thing this test claims to cover;
    // the old form was accidentally exercising node-pty's deferral queue.
    await firstData(manager, id);
    expect(() => manager.resize(id, 120, 40)).not.toThrow();
  });

  it('receives data from PTY after writing', async () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
      cols: 80,
      rows: 24,
    });

    const received = await new Promise<string>((resolve) => {
      const unsub = manager.onData(id, (data) => {
        unsub();
        resolve(data);
      });
      // Write something to trigger output; initial prompt should arrive shortly
    });

    expect(typeof received).toBe('string');
    expect(received.length).toBeGreaterThan(0);
  });

  it('kill removes the PTY from the manager', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    expect(manager.has(id)).toBe(true);
    manager.kill(id);
    expect(manager.has(id)).toBe(false);
  });

  it('getPid returns a numeric PID', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    const pid = manager.getPid(id);
    expect(typeof pid).toBe('number');
    expect(pid).toBeGreaterThan(0);
  });

  it('killAll removes all PTYs', () => {
    const manager = makeManager();
    const { id: id1 } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    const { id: id2 } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
    manager.killAll();
    expect(manager.has(id1)).toBe(false);
    expect(manager.has(id2)).toBe(false);
  });
});

describe('parseShellSpec (issue #78 — shell command lines with args)', () => {
  it('treats a bare executable as command with no args', () => {
    expect(parseShellSpec('pwsh.exe')).toEqual({ command: 'pwsh.exe', args: [] });
  });

  it('returns empty command for undefined/empty specs', () => {
    expect(parseShellSpec(undefined)).toEqual({ command: '', args: [] });
    expect(parseShellSpec('   ')).toEqual({ command: '', args: [] });
  });

  it('splits an ssh command line into command + args', () => {
    expect(parseShellSpec('ssh user@host')).toEqual({ command: 'ssh', args: ['user@host'] });
    expect(parseShellSpec('ssh -p 2222 user@host')).toEqual({
      command: 'ssh',
      args: ['-p', '2222', 'user@host'],
    });
  });

  it('never splits an existing absolute path containing spaces', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux spec '));
    const exe = path.join(dir, 'my shell.exe');
    fs.writeFileSync(exe, '');
    try {
      expect(parseShellSpec(exe)).toEqual({ command: exe, args: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors double quotes around an executable path with spaces', () => {
    expect(parseShellSpec('"C:\\some path\\tool.exe" --flag')).toEqual({
      command: 'C:\\some path\\tool.exe',
      args: ['--flag'],
    });
  });
});

describe('resolveExistingShellPath', () => {
  it('returns undefined for empty input', () => {
    expect(resolveExistingShellPath('')).toBeUndefined();
  });

  it('returns an existing absolute path unchanged', () => {
    const exe = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
      : '/bin/sh';
    expect(resolveExistingShellPath(exe)).toBe(exe);
  });

  it('skips WindowsApps aliases and finds a real file for pwsh', () => {
    if (process.platform !== 'win32') return;
    const resolved = resolveExistingShellPath('pwsh.exe');
    expect(resolved).toBeTruthy();
    expect(fs.existsSync(resolved!)).toBe(true);
    expect(resolved!.includes('WindowsApps')).toBe(false);
  });

  it('resolves pwsh-preview to a real Store pwsh.exe, not the alias', () => {
    if (process.platform !== 'win32') return;
    const resolved = resolveExistingShellPath('pwsh-preview');
    if (!resolved) return; // preview not installed
    expect(fs.existsSync(resolved)).toBe(true);
    expect(resolved.toLowerCase()).not.toContain('\\windowsapps\\pwsh-preview');
    expect(path.basename(resolved).toLowerCase()).toBe('pwsh.exe');
  });
});

describe('comparePackageVersion (WindowsApps package ordering)', () => {
  const STABLE = 'Microsoft.PowerShell_';
  const PREVIEW = 'Microsoft.PowerShellPreview_';
  /** A real WindowsApps directory name, version assembled from its components. */
  const pkg = (prefix: string, version: number[]) => `${prefix}${version.join('.')}_x64__8wekyb3d8bbwe`;

  it('orders newest first', () => {
    const older = pkg(STABLE, [7, 4, 6, 0]);
    const newer = pkg(STABLE, [7, 5, 2, 0]);
    expect([older, newer].sort(comparePackageVersion)[0]).toBe(newer);
  });

  it('compares numerically, so a two-digit minor beats a one-digit one', () => {
    // The reason this exists. `.sort().reverse()` is a string sort, and "7.7"
    // sorts above "7.10" — which would silently pick the older PowerShell the
    // first time a minor version reaches two digits.
    const newer = pkg(STABLE, [7, 10, 0, 0]);
    const older = pkg(STABLE, [7, 7, 1, 0]);
    expect([newer, older].sort(comparePackageVersion)[0]).toBe(newer);
    expect([newer, older].sort().reverse()[0]).toBe(older); // what it used to do
  });

  it('treats a missing or unparseable component as zero rather than NaN', () => {
    // A NaN anywhere in the comparator makes the sort order undefined, so a
    // package dir that does not match the expected shape must not poison the
    // ordering of the ones that do.
    const full = pkg(STABLE, [7, 5, 0, 0]);
    const dirs = [full, STABLE, pkg(STABLE, [7, 5])];
    expect(dirs.sort(comparePackageVersion)[0]).toBe(full);
  });

  it('keeps the stable and preview package prefixes disjoint', () => {
    // findStorePwsh filters by prefix, and the two only stay separable because
    // stable carries the underscore. Dropping it would make every preview
    // package a candidate for a plain `pwsh` request.
    expect(pkg(PREVIEW, [7, 7, 0, 1]).startsWith(STABLE)).toBe(false);
    expect(pkg(STABLE, [7, 5, 2, 0]).startsWith(STABLE)).toBe(true);
  });
});


/**
 * CreateProcess fails with error 267 (ERROR_DIRECTORY) when handed a working
 * dir that isn't a real directory, and node-pty surfaces it as an opaque
 * "Failed to create terminal: Cannot create process, error code: 267" — the
 * pane just dies. The cwd comes from session state / CLI args (e.g. an agent
 * spawned into a git worktree that was deleted after its wave, or ordered
 * before `git worktree add` finished), so it cannot be trusted to still exist.
 */
describe('resolveSpawnCwd', () => {
  const home = process.env.USERPROFILE || 'C:\\';

  it('keeps a cwd that exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cwd-'));
    try {
      expect(resolveSpawnCwd(dir)).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back when the cwd was deleted (the worktree case → error 267)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cwd-'));
    fs.rmSync(dir, { recursive: true, force: true });
    expect(resolveSpawnCwd(dir)).toBe(home);
  });

  it('falls back when the cwd never existed', () => {
    expect(resolveSpawnCwd('C:\\definitely\\not\\here\\wmux-test')).toBe(home);
  });

  it('falls back when the cwd is a file, not a directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cwd-'));
    const file = path.join(dir, 'not-a-dir.txt');
    fs.writeFileSync(file, 'x');
    try {
      expect(resolveSpawnCwd(file)).toBe(home);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back for a POSIX/WSL cwd (issue #60)', () => {
    expect(resolveSpawnCwd('/home/user/project')).toBe(home);
  });

  it('passes undefined through (node-pty default)', () => {
    expect(resolveSpawnCwd(undefined)).toBeUndefined();
  });
});
/**
 * resolveSpawnCwd above is the honest Win32 answer — %USERPROFILE% — but it is
 * also why a new tab in a WSL/devcontainer workspace silently opened in the
 * Windows home folder instead of the project. A UNC working directory is not an
 * option (CreateProcess rejects it), so the fix is to pick the one shell that
 * can actually reach the path.
 */
describe('resolveShellForCwd (POSIX cwd → WSL shell)', () => {
  const POSIX = '/home/user/agent/project';

  beforeEach(() => {
    vi.spyOn(shellEnv, 'isWindows').mockReturnValue(true);
    vi.spyOn(shellEnv, 'hasWsl').mockReturnValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('swaps a Win32 shell for wsl.exe when the cwd is POSIX', () => {
    expect(resolveShellForCwd('pwsh.exe', POSIX)).toBe('wsl.exe');
    expect(resolveShellForCwd('powershell.exe', POSIX)).toBe('wsl.exe');
    expect(resolveShellForCwd('cmd.exe', POSIX)).toBe('wsl.exe');
  });

  it('leaves a Win32 cwd alone', () => {
    expect(resolveShellForCwd('pwsh.exe', 'C:\\work\\project')).toBe('pwsh.exe');
    expect(resolveShellForCwd('pwsh.exe', undefined)).toBe('pwsh.exe');
  });

  it('leaves a shell that is already WSL alone', () => {
    expect(resolveShellForCwd('wsl.exe', POSIX)).toBe('wsl.exe');
  });

  it('does not hijack a deliberate remote command line (issue #78)', () => {
    // `wmux ssh user@host` resolves to a shell wmux cannot classify. Replacing
    // it with wsl.exe would drop the user somewhere else entirely, which is a
    // worse failure than opening in the wrong directory.
    expect(resolveShellForCwd('ssh', POSIX)).toBe('ssh');
  });

  it('keeps today\'s behaviour when WSL is not installed', () => {
    vi.spyOn(shellEnv, 'hasWsl').mockReturnValue(false);
    expect(resolveShellForCwd('pwsh.exe', POSIX)).toBe('pwsh.exe');
  });

  it('is a no-op off Windows', () => {
    vi.spyOn(shellEnv, 'isWindows').mockReturnValue(false);
    expect(resolveShellForCwd('/bin/bash', POSIX)).toBe('/bin/bash');
  });

  it('classifies an absolute shell by its basename, not by its directories', () => {
    // #172 changed resolveShell to return the resolved absolute path rather
    // than the bare name it was handed, which put every parent directory into
    // the substring match. These are real install layouts: Cmder ships bash
    // under a "cmder" directory, and a path can contain "wsl" or "pwsh" for
    // reasons that have nothing to do with the executable at the end of it.
    expect(resolveShellForCwd('C:\\tools\\cmder\\bin\\bash.exe', POSIX)).toBe('C:\\tools\\cmder\\bin\\bash.exe');
    expect(resolveShellForCwd('C:\\Users\\wsl-admin\\bin\\bash.exe', POSIX)).toBe('C:\\Users\\wsl-admin\\bin\\bash.exe');
  });

  it('still classifies a real absolute PowerShell path', () => {
    // The flip side: narrowing to the basename must not stop recognising the
    // absolute pwsh path resolveShell now actually returns.
    expect(resolveShellForCwd('C:\\Program Files\\PowerShell\\7\\pwsh.exe', POSIX)).toBe('wsl.exe');
    expect(resolveShellForCwd('C:\\Windows\\System32\\cmd.exe', POSIX)).toBe('wsl.exe');
  });
});

