import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
} from '../../src/main/zip-updater';

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

  it('waits for the old process, copies, unblocks, and relaunches', () => {
    expect(cmd).toContain('robocopy');
    expect(cmd).toContain('Unblock-File');
    expect(cmd).toMatch(/start "" "%EXE%"/);
    expect(cmd).toContain('tasklist');
  });

  it('does not embed caller paths — those arrive as arguments', () => {
    expect(cmd).not.toMatch(/C:\\/);
    expect(cmd).toContain('set "PID=%~1"');
    expect(cmd).toContain('set "SRC=%~2"');
    expect(cmd).toContain('set "DST=%~3"');
    expect(cmd).toContain('set "EXE=%~4"');
  });
});
