import { describe, it, expect } from 'vitest';
import {
  REG_ROOTS,
  verbKeyFor,
  commandFor,
  iconFor,
  directoryFromArgv,
} from '../../src/main/shell-context-menu';

// The registry writes themselves are execFileSync('reg.exe') and are not worth
// mocking; what IS worth pinning is the two things that silently produce a
// context-menu entry that does nothing when they are wrong — the command string
// and the argv parsing on the receiving end.

describe('registry shape', () => {
  it('covers folder, folder-background and drive', () => {
    expect(REG_ROOTS).toContain('Directory');
    expect(REG_ROOTS).toContain('Directory\\Background');
    expect(REG_ROOTS).toContain('Drive');
  });

  it('registers under HKCU so no elevation is needed', () => {
    for (const root of REG_ROOTS) {
      expect(verbKeyFor(root)).toMatch(/^HKCU\\Software\\Classes\\/);
    }
  });
});

describe('command string', () => {
  const EXE = 'C:\\Users\\a\\OneDrive - Pulsa\\Bureau\\wmux\\wmux.exe';

  it('quotes an exe path containing spaces', () => {
    expect(commandFor(EXE)).toBe(`"${EXE}" "%V"`);
  });

  // %1 is EMPTY for Directory\Background — the right-click-empty-space gesture,
  // which is the whole point of the feature. %V resolves for all three roots.
  it('passes %V, not %1', () => {
    expect(commandFor(EXE)).toContain('"%V"');
    expect(commandFor(EXE)).not.toContain('%1');
  });

  it('points the icon at the exe resources', () => {
    expect(iconFor(EXE)).toBe(`"${EXE}",0`);
  });
});

describe('directoryFromArgv', () => {
  const isDir = (p: string) => p === 'C:\\work\\proj' || p === 'C:\\Program Files\\x';

  it('finds the folder Explorer passed', () => {
    expect(directoryFromArgv(['wmux.exe', 'C:\\work\\proj'], isDir)).toBe('C:\\work\\proj');
  });

  it('handles a path with spaces', () => {
    expect(directoryFromArgv(['wmux.exe', 'C:\\Program Files\\x'], isDir)).toBe('C:\\Program Files\\x');
  });

  it('ignores Chromium/Electron switches', () => {
    expect(
      directoryFromArgv(['wmux.exe', '--no-sandbox', '--user-data-dir=C:\\x'], isDir),
    ).toBeNull();
  });

  it('ignores a path that is not a directory', () => {
    expect(directoryFromArgv(['wmux.exe', 'C:\\work\\file.txt'], isDir)).toBeNull();
  });

  it('ignores the dev entry script and the packed app', () => {
    expect(directoryFromArgv(['electron.exe', '.', 'C:\\work\\proj'], isDir)).toBe('C:\\work\\proj');
    expect(directoryFromArgv(['wmux.exe', 'C:\\app\\resources\\app.asar'], isDir)).toBeNull();
  });

  it('never returns the exe itself', () => {
    // argv[0] is skipped outright — otherwise launching from a directory-like
    // path would open a workspace on the install dir on every plain launch.
    expect(directoryFromArgv(['C:\\work\\proj'], isDir)).toBeNull();
  });

  it('ignores relative paths', () => {
    expect(directoryFromArgv(['wmux.exe', 'proj'], () => true)).toBeNull();
  });

  it('survives a throwing stat', () => {
    expect(directoryFromArgv(['wmux.exe', 'C:\\denied'], () => { throw new Error('EACCES'); }))
      .toBeNull();
  });
});
