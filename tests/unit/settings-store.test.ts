import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const location = vi.hoisted(() => ({ directory: '' }));
vi.mock('../../src/shared/instance', () => ({ getAppDataDir: () => location.directory }));

const diskError = (code: string) => Object.assign(new Error(code), { code });

describe('settings persistence acknowledgement', () => {
  let root: string;
  let store: typeof import('../../src/main/settings-store');

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-settings-'));
    location.directory = path.join(root, 'wmux');
    vi.resetModules();
    store = await import('../../src/main/settings-store');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports success only after replacement and keeps unrelated settings', () => {
    expect(store.saveSetting('theme', 'dark')).toBe(true);
    expect(store.saveSetting('wmux-terminal-history', { enabled: true, generation: 0 })).toBe(true);
    expect(store.loadSettings()).toEqual({ theme: 'dark', 'wmux-terminal-history': { enabled: true, generation: 0 } });
    expect(fs.existsSync(store.getSettingsPath() + '.tmp')).toBe(false);
  });

  it('reports a failed replacement without unlinking or changing the previous target', () => {
    expect(store.saveSetting('wmux-terminal-history', { enabled: true, generation: 0 })).toBe(true);
    const previous = fs.readFileSync(store.getSettingsPath(), 'utf8');
    const unlink = vi.spyOn(fs, 'unlinkSync');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw diskError('EPERM'); });
    expect(store.saveSetting('wmux-terminal-history', { enabled: false, generation: 1 })).toBe(false);
    expect(unlink).not.toHaveBeenCalled();
    expect(fs.readFileSync(store.getSettingsPath(), 'utf8')).toBe(previous);
    expect(store.loadSettings()['wmux-terminal-history']).toEqual({ enabled: true, generation: 0 });
    rename.mockRestore();
    expect(store.saveSetting('wmux-terminal-history', { enabled: false, generation: 1 })).toBe(true);
    expect(store.loadSettings()['wmux-terminal-history']).toEqual({ enabled: false, generation: 1 });
  });

  it('reports ENOSPC while leaving the last good settings readable', () => {
    expect(store.saveSetting('theme', 'dark')).toBe(true);
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw diskError('ENOSPC'); });
    expect(store.saveSetting('theme', 'light')).toBe(false);
    expect(store.loadSettings()).toEqual({ theme: 'dark' });
    write.mockRestore();
  });

  it('reports failure rather than acknowledging a first-time settings write', () => {
    vi.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => { throw diskError('EACCES'); });
    expect(store.saveSetting('wmux-terminal-history', { enabled: true, generation: 0 })).toBe(false);
    expect(store.loadSettings()).toEqual({});
    expect(fs.existsSync(store.getSettingsPath())).toBe(false);
  });
});
