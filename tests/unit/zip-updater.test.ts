import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock };
});

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0',
    getPath: (name: string) => (name === 'exe' ? 'C:\\wmux\\wmux.exe' : ''),
    isPackaged: true,
    quit: vi.fn(),
  },
  net: { request: vi.fn() },
}));

import {
  isPortableZipInstall,
  pickZipAsset,
  findPayloadRoot,
  buildApplyUpdateCmd,
  updateStampName,
  updateZipName,
  updateHelperName,
  classifyUpdateLeftover,
  isPidAlive,
  sweepUpdateLeftovers,
  applyStagedPortableUpdate,
  buildHelperArgs,
} from '../../src/main/zip-updater';
import { app } from 'electron';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-zip-'));
}

describe('isPortableZipInstall', () => {
  it('is true for a folder that has wmux.exe and no NSIS uninstaller', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'wmux.exe'), '');
    expect(isPortableZipInstall(root)).toBe(true);
  });

  it('is false when the NSIS uninstaller sits next to the exe', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'wmux.exe'), '');
    fs.writeFileSync(path.join(root, 'Uninstall wmux.exe'), '');
    expect(isPortableZipInstall(root)).toBe(false);
  });

  it('is false when wmux.exe is missing', () => {
    const root = tempDir();
    expect(isPortableZipInstall(root)).toBe(false);
  });

  it('is false for an empty path, a missing path, or a file', () => {
    expect(isPortableZipInstall('')).toBe(false);
    expect(isPortableZipInstall(path.join(os.tmpdir(), 'wmux-does-not-exist-' + process.pid))).toBe(false);
    const root = tempDir();
    const file = path.join(root, 'not-a-dir');
    fs.writeFileSync(file, '');
    expect(isPortableZipInstall(file)).toBe(false);
  });
});

describe('pickZipAsset', () => {
  const asset = (name: string) => ({
    name,
    browser_download_url: `https://example.test/${name}`,
    size: 12,
  });

  it('prefers the win-x64 zip', () => {
    const picked = pickZipAsset([
      asset('wmux-1.6.0-linux-x64.zip'),
      asset('wmux-1.6.0-win-x64.zip'),
      asset('wmux-1.6.0-setup.exe'),
    ]);
    expect(picked?.name).toBe('wmux-1.6.0-win-x64.zip');
  });

  it('ignores a zip with no Windows marker (source archives)', () => {
    expect(pickZipAsset([asset('v1.6.0.zip'), asset('source.zip')])).toBeNull();
  });

  it('returns null when there are no assets', () => {
    expect(pickZipAsset(undefined)).toBeNull();
    expect(pickZipAsset([])).toBeNull();
  });
});

describe('findPayloadRoot', () => {
  it('uses the extract dir when wmux.exe is at the zip root', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'wmux.exe'), '');
    expect(findPayloadRoot(root)).toBe(root);
  });

  it('walks one directory down when the zip wrapped a folder', () => {
    const root = tempDir();
    const inner = path.join(root, 'wmux-1.6.0-win-x64');
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, 'wmux.exe'), '');
    expect(findPayloadRoot(root)).toBe(inner);
  });

  it('throws when the zip is not a wmux payload', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'README.txt'), 'nope');
    expect(() => findPayloadRoot(root)).toThrow(/wmux\.exe/);
  });
});

describe('buildApplyUpdateCmd', () => {
  const cmd = buildApplyUpdateCmd();

  it('waits for the old process, copies, relaunches, and removes the payload', () => {
    expect(cmd).toContain('robocopy.exe');
    expect(cmd).toMatch(/start "" "%EXE%"/);
    expect(cmd).toContain('tasklist.exe');
    expect(cmd).toContain('rmdir /s /q "%SRC%"');
    expect(cmd).toContain('%SystemRoot%\\System32');
  });

  // Issue #3: a hidden PowerShell recursively running Unblock-File is a MOTW
  // bypass pattern (T1553.005) and stripped nothing — the payload never had a
  // :Zone.Identifier stream, and executables are unblocked in-process on launch.
  it('does not run PowerShell or strip Mark of the Web', () => {
    expect(cmd).not.toMatch(/powershell/i);
    expect(cmd).not.toMatch(/Unblock-File/i);
  });

  // wmux has already quit by the time the helper runs, so a robocopy failure
  // that exits without relaunching leaves the user with no wmux at all. The
  // failure branch has to fall through to the same relaunch as the happy path.
  it('still relaunches when robocopy fails', () => {
    expect(cmd).toContain('if %ERRORLEVEL% GEQ 8 goto relaunch');
    expect(cmd).toContain(':relaunch');
    expect(cmd).not.toMatch(/GEQ 8 exit/);
    // The relaunch must come after the label, not only on the success path.
    expect(cmd.indexOf(':relaunch')).toBeLessThan(cmd.indexOf('start "" "%EXE%"'));
  });

  // Self-deleting scripts are a classic dropper/malware signature; not
  // self-deleting removes one plausible trigger for AV behavioral scans
  // (e.g. Norton SONAR) hanging the system on update.
  it('does not self-delete', () => {
    expect(cmd).not.toMatch(/del\s+"%~f0"/i);
  });

  // The console cannot be hidden (DETACHED_PROCESS makes Windows ignore
  // CREATE_NO_WINDOW), so it has to say what it is: a user reported an empty
  // window titled "findstr.exe" and could not tell whether it wanted input.
  it('names itself and says the window closes on its own', () => {
    expect(cmd).toContain('title wmux update');
    expect(cmd).toMatch(/echo\s+Installing the wmux update\./);
    expect(cmd).toMatch(/This window closes by itself/);
    // Windows renames a console after the child running in it, so the title is
    // re-set inside the wait loop and not only once at the top.
    expect(cmd.match(/title wmux update/g)?.length).toBeGreaterThan(1);
    expect(cmd.indexOf('title wmux update')).toBeLessThan(cmd.indexOf(':wait'));
  });

  // timeout.exe refuses a redirected stdin, and the helper is spawned with
  // stdio 'ignore' — so it exited at once and the wait became a tasklist spin.
  // waitfor honours /t with NUL stdin. `ping -n` is the dropper batch-sleep
  // idiom and is deliberately not the replacement.
  it('pauses the wait loop with waitfor, not timeout or ping', () => {
    expect(cmd).not.toMatch(/timeout\.exe/i);
    expect(cmd).not.toMatch(/ping(\.exe)?\s+-n/i);
    expect(cmd).toContain('"%SYS%\\waitfor.exe" /t 1 wmuxUpdateWait >nul 2>nul');
    // The pause runs before the liveness probe, so its own exit code can never
    // stand in for tasklist's.
    expect(cmd.indexOf('waitfor.exe')).toBeLessThan(cmd.indexOf('tasklist.exe'));
  });

  it('does not embed caller paths — those arrive as arguments', () => {
    expect(cmd).not.toMatch(/C:\\/);
    expect(cmd).toContain('set "PID=%~1"');
    expect(cmd).toContain('set "SRC=%~2"');
    expect(cmd).toContain('set "DST=%~3"');
    expect(cmd).toContain('set "EXE=%~4"');
  });
});

describe('update leftover names (#3)', () => {
  it('classifies every name the update flow creates', () => {
    expect(classifyUpdateLeftover(updateHelperName(4242))).toEqual({ kind: 'helper', pid: 4242 });
    expect(classifyUpdateLeftover(updateZipName('2.12.0', 17))).toEqual({ kind: 'zip', pid: 17 });
    expect(classifyUpdateLeftover(updateStampName('2.12.0', 17))).toEqual({ kind: 'extract-dir', pid: 17 });
    expect(classifyUpdateLeftover(updateStampName('2.13.0-beta.1+build-7', 9))).toEqual({ kind: 'extract-dir', pid: 9 });
  });

  it('rejects near misses', () => {
    for (const name of [
      'wmux-apply-update-12.cmd.txt',
      'wmux-apply-update-.cmd',
      'wmux-apply-update-12.CMD',
      'WMUX-apply-update-12.cmd',
      'wmux-update-2.12.0.zip',
      'wmux-update-2.12.0-',
      'wmux-update-2.12.0-12.zip.part',
      'wmux-update-2.12.0-12-old',
      'wmux-update-2 12 0-12',
      'xwmux-update-2.12.0-12',
      'wmux-zip-abc',
    ]) {
      expect(classifyUpdateLeftover(name), name).toBeNull();
    }
  });

  it('rejects a PID that is not a real one', () => {
    expect(classifyUpdateLeftover('wmux-apply-update-0.cmd')).toBeNull();
    expect(classifyUpdateLeftover('wmux-apply-update-4294967296.cmd')).toBeNull();
    expect(classifyUpdateLeftover('wmux-apply-update-12345678901234567890.cmd')).toBeNull();
    expect(classifyUpdateLeftover('wmux-apply-update-0123.cmd')).toBeNull();
    expect(classifyUpdateLeftover('wmux-apply-update-4294967295.cmd')).toEqual({ kind: 'helper', pid: 4294967295 });
  });
});

describe('isPidAlive', () => {
  const failing = (code: string) => () => { throw Object.assign(new Error(code), { code }); };

  it('reads only ESRCH as gone', () => {
    expect(isPidAlive(1, () => undefined)).toBe(true);
    expect(isPidAlive(1, failing('ESRCH'))).toBe(false);
    expect(isPidAlive(1, failing('EPERM'))).toBe(true);
    expect(isPidAlive(1, failing('EINVAL'))).toBe(true);
  });

  it('sends signal 0', () => {
    const kill = vi.fn();
    isPidAlive(77, kill);
    expect(kill).toHaveBeenCalledWith(77, 0);
  });
});

describe('sweepUpdateLeftovers (#3)', () => {
  const HOUR = 60 * 60 * 1000;
  const now = Date.now();
  const dead = () => false;

  function age(p: string, ms: number): void {
    const t = new Date(now - ms);
    fs.utimesSync(p, t, t);
  }

  function file(dir: string, name: string, ageMs: number): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, 'x');
    age(p, ageMs);
    return p;
  }

  function folder(dir: string, name: string, ageMs: number): string {
    const p = path.join(dir, name);
    fs.mkdirSync(p);
    fs.writeFileSync(path.join(p, 'wmux.exe'), '');
    age(p, ageMs);
    return p;
  }

  const sweep = (dir: string, isPidAliveFn: (pid: number) => boolean = dead) =>
    sweepUpdateLeftovers(dir, { now: () => now, isPidAlive: isPidAliveFn });

  it('removes old leftovers of a dead process and nothing else', async () => {
    const dir = tempDir();
    const helper = file(dir, updateHelperName(101), 2 * HOUR);
    const zip = file(dir, updateZipName('2.12.0', 101), 2 * HOUR);
    const extract = folder(dir, updateStampName('2.12.0', 101), 2 * HOUR);
    const unrelated = file(dir, 'something-else.cmd', 2 * HOUR);
    const result = await sweep(dir);
    expect(result.removed.sort()).toEqual(
      [updateHelperName(101), updateStampName('2.12.0', 101), updateZipName('2.12.0', 101)].sort(),
    );
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(helper)).toBe(false);
    expect(fs.existsSync(zip)).toBe(false);
    expect(fs.existsSync(extract)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('keeps leftovers whose PID is still alive', async () => {
    const dir = tempDir();
    const extract = folder(dir, updateStampName('2.12.0', 102), 5 * 24 * HOUR);
    const result = await sweep(dir, (pid) => pid === 102);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(extract)).toBe(true);
  });

  it('keeps fresh leftovers and ones dated in the future', async () => {
    const dir = tempDir();
    const fresh = file(dir, updateHelperName(103), HOUR / 2);
    const future = file(dir, updateHelperName(104), -HOUR);
    const result = await sweep(dir);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(future)).toBe(true);
  });

  it('keeps an entry whose type does not match its name', async () => {
    const dir = tempDir();
    const zipNamedDir = folder(dir, updateZipName('2.12.0', 105), 2 * HOUR);
    const helperNamedDir = folder(dir, updateHelperName(105), 2 * HOUR);
    const extractNamedFile = file(dir, updateStampName('2.12.0', 106), 2 * HOUR);
    const result = await sweep(dir);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(zipNamedDir)).toBe(true);
    expect(fs.existsSync(helperNamedDir)).toBe(true);
    expect(fs.existsSync(extractNamedFile)).toBe(true);
  });

  // "Later", then "Install and restart" days afterwards: the payload is old
  // and its PID is dead while a helper is still copying from it. Only the
  // helper's mtime says the install is in progress.
  it('keeps a payload while a fresh helper with the same PID exists', async () => {
    const dir = tempDir();
    file(dir, updateHelperName(107), 60 * 1000);
    const extract = folder(dir, updateStampName('2.12.0', 107), 3 * 24 * HOUR);
    const zip = file(dir, updateZipName('2.12.0', 107), 3 * 24 * HOUR);
    const result = await sweep(dir);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(extract)).toBe(true);
    expect(fs.existsSync(zip)).toBe(true);
  });

  it('removes a payload and its helper once both are old', async () => {
    const dir = tempDir();
    file(dir, updateHelperName(108), 2 * HOUR);
    folder(dir, updateStampName('2.12.0', 108), 3 * 24 * HOUR);
    const result = await sweep(dir);
    expect(result.removed.sort()).toEqual([updateHelperName(108), updateStampName('2.12.0', 108)].sort());
  });

  it('does not let a fresh helper protect a payload with a different PID', async () => {
    const dir = tempDir();
    file(dir, updateHelperName(109), 60 * 1000);
    const extract = folder(dir, updateStampName('2.12.0', 110), 3 * 24 * HOUR);
    const result = await sweep(dir);
    expect(result.removed).toEqual([updateStampName('2.12.0', 110)]);
    expect(fs.existsSync(extract)).toBe(false);
  });

  it('never follows or removes a junction', async () => {
    const dir = tempDir();
    const target = tempDir();
    const inside = path.join(target, 'precious.txt');
    fs.writeFileSync(inside, 'keep me');
    const link = path.join(dir, updateStampName('2.12.0', 111));
    fs.symlinkSync(target, link, 'junction');
    const t = new Date(now - 2 * HOUR);
    fs.lutimesSync(link, t, t);
    const result = await sweep(dir);
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(link)).toBe(true);
    expect(fs.readFileSync(inside, 'utf8')).toBe('keep me');
  });

  it('records a failed remove and carries on', async () => {
    const dir = tempDir();
    file(dir, updateHelperName(112), 2 * HOUR);
    file(dir, updateHelperName(113), 2 * HOUR);
    const realRm = fs.promises.rm;
    let calls = 0;
    const spy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (p, opts) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return realRm(p, opts);
    });
    try {
      const result = await sweep(dir);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].code).toBe('EBUSY');
      expect(result.removed).toHaveLength(1);
      expect(fs.readdirSync(dir)).toEqual([result.failed[0].name]);
    } finally {
      spy.mockRestore();
    }
  });
});

// A quit whose helper never runs leaves the user with no wmux and nothing to
// restart it (#3). Every failure wmux can still see must reject BEFORE quit.
describe('applyStagedPortableUpdate', () => {
  const savedTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  let payload: string;
  let scratchTemp: string;

  function fakeChild(): EventEmitter & { unref: ReturnType<typeof vi.fn> } {
    return Object.assign(new EventEmitter(), { unref: vi.fn() });
  }

  function staged() {
    return { version: '9.9.9', extractDir: payload, installDir: 'C:\\wmux', exePath: 'C:\\wmux\\wmux.exe' };
  }

  function pointTempAt(dir: string): void {
    process.env.TEMP = dir;
    process.env.TMP = dir;
    process.env.TMPDIR = dir;
  }

  beforeEach(() => {
    payload = tempDir();
    fs.writeFileSync(path.join(payload, 'wmux.exe'), '');
    // os.tmpdir() reads the environment on every call, so the helper lands in
    // a scratch dir rather than the real %TEMP%.
    scratchTemp = tempDir();
    pointTempAt(scratchTemp);
    spawnMock.mockReset();
    vi.mocked(app.quit).mockReset();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedTemp)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('refuses a payload that is gone, without writing, spawning or quitting', async () => {
    fs.unlinkSync(path.join(payload, 'wmux.exe'));
    await expect(applyStagedPortableUpdate(staged())).rejects.toMatchObject({ code: 'PAYLOAD_MISSING' });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    expect(fs.readdirSync(scratchTemp)).toEqual([]);
  });

  it('does not quit when the helper cannot be written', async () => {
    pointTempAt(path.join(scratchTemp, 'missing', 'dir'));
    await expect(applyStagedPortableUpdate(staged())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('does not quit when a path would be rewritten on the helper command line', async () => {
    const withPercentPair = { ...staged(), installDir: 'C:\\tools\\%OS%\\wmux', exePath: 'C:\\tools\\%OS%\\wmux\\wmux.exe' };
    await expect(applyStagedPortableUpdate(withPercentPair)).rejects.toThrow(/expand/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('does not quit when the helper fails to start', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const pending = applyStagedPortableUpdate(staged());
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })));
    await expect(pending).rejects.toThrow('spawn EPERM');
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('quits once the helper has started, and survives a late child error', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const pending = applyStagedPortableUpdate(staged());
    expect(app.quit).not.toHaveBeenCalled();
    setImmediate(() => child.emit('spawn'));
    await expect(pending).resolves.toBeUndefined();
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(child.unref).toHaveBeenCalledTimes(1);
    // An EventEmitter with no 'error' listener throws; in main that is an
    // uncaught exception after the quit has started.
    expect(() => child.emit('error', new Error('late'))).not.toThrow();
    expect(() => child.emit('error', new Error('later'))).not.toThrow();

    const [, args, opts] = spawnMock.mock.calls[0];
    const helper = path.join(scratchTemp, `wmux-apply-update-${process.pid}.cmd`);
    expect(args).toEqual(buildHelperArgs(helper, [String(process.pid), payload, 'C:\\wmux', 'C:\\wmux\\wmux.exe']));
    expect(opts).toMatchObject({ detached: true, windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true });
  });
});

// `cmd /c` strips the first and last quote of a line that starts with one and
// holds more than two, so a %TEMP% with a space ("C:\Users\First Last\...")
// turned the helper path into `C:\Users\First` and the update did nothing
// after wmux had already quit.
describe('buildHelperArgs', () => {
  it('wraps every piece in quotes inside one outer pair, under /s', () => {
    const args = buildHelperArgs('C:\\Users\\First Last\\AppData\\Local\\Temp\\wmux-apply-update-7.cmd', [
      '7', 'C:\\Users\\First Last\\AppData\\Local\\Temp\\wmux-update-9.9.9-7', 'C:\\Program Files\\wmux', 'C:\\Program Files\\wmux\\wmux.exe',
    ]);
    expect(args).toEqual([
      '/d', '/s', '/c',
      '""C:\\Users\\First Last\\AppData\\Local\\Temp\\wmux-apply-update-7.cmd" "7" ' +
        '"C:\\Users\\First Last\\AppData\\Local\\Temp\\wmux-update-9.9.9-7" "C:\\Program Files\\wmux" ' +
        '"C:\\Program Files\\wmux\\wmux.exe""',
    ]);
  });

  it('refuses a piece that would add a quote of its own', () => {
    expect(() => buildHelperArgs('C:\\t\\h.cmd', ['1', 'C:\\a" & calc & "', 'C:\\w', 'C:\\w\\wmux.exe'])).toThrow(/double quote/);
  });

  // cmd expands a defined %NAME% even inside quotes, so `C:\x\%OS%\y` would
  // reach the helper as `C:\x\Windows_NT\y` and the install would do nothing.
  it('refuses a %…% pair anywhere, including the helper path', () => {
    expect(() => buildHelperArgs('C:\\t\\h.cmd', ['1', 'C:\\x\\%OS%\\y', 'C:\\w', 'C:\\w\\wmux.exe'])).toThrow(/expand/);
    expect(() => buildHelperArgs('C:\\Users\\a%b%c\\Temp\\h.cmd', ['1', 'C:\\p', 'C:\\w', 'C:\\w\\wmux.exe'])).toThrow(/expand/);
  });

  it('allows a lone percent sign, which cmd leaves alone', () => {
    expect(buildHelperArgs('C:\\t\\h.cmd', ['1', 'C:\\100%\\p', 'C:\\w', 'C:\\w\\wmux.exe'])[3]).toContain('"C:\\100%\\p"');
  });
});
