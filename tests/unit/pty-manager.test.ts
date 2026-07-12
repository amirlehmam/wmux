import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PtyManager, parseShellSpec, resolveSpawnCwd } from '../../src/main/pty-manager';

const TEST_SHELL = 'cmd.exe';
const TEST_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined)
) as Record<string, string>;

describe('PtyManager', () => {
  const managers: PtyManager[] = [];

  function makeManager(): PtyManager {
    const m = new PtyManager();
    managers.push(m);
    return m;
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

  it('resize does not throw', () => {
    const manager = makeManager();
    const { id } = manager.create({
      shell: TEST_SHELL,
      cwd: process.env.USERPROFILE || 'C:\\',
      env: TEST_ENV,
    });
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
