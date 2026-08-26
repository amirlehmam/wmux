// Default terminal starting path (issue #205).
//
// Two halves, tested here together because neither is useful alone: the pref
// only reaches a PTY through `resolveSpawnCwd`, and `resolveSpawnCwd` only sees
// a user-TYPED path because of the pref. Everything else that feeds it a cwd
// (session.json, `--cwd`, a split inheriting its parent) hands it a path some
// machine produced, already absolute.

import { describe, it, expect } from 'vitest';
import { expandPathVars } from '../../src/shared/paths';
import { resolveSpawnCwd } from '../../src/main/pty-manager';
import { DEFAULT_WORKSPACE_PREFS } from '../../src/renderer/store/settings-slice';

const HOME = 'C:\\Users\\tester';

describe('expandPathVars', () => {
  const env = { USERPROFILE: HOME, DEV: 'D:\\code', EMPTY: '' };

  it('leaves an ordinary absolute path alone', () => {
    expect(expandPathVars('C:\\Users\\tester\\proj', env)).toBe('C:\\Users\\tester\\proj');
  });

  it('expands a bare ~', () => {
    expect(expandPathVars('~', env)).toBe(HOME);
  });

  it('expands ~ with either slash', () => {
    expect(expandPathVars('~\\proj', env)).toBe(`${HOME}\\proj`);
    expect(expandPathVars('~/proj', env)).toBe(`${HOME}/proj`);
  });

  it('only expands ~ in the leading position', () => {
    expect(expandPathVars('C:\\a~b', env)).toBe('C:\\a~b');
    expect(expandPathVars('~b', env)).toBe('~b');
  });

  it('falls back to HOME when USERPROFILE is unset (WSL/POSIX shells)', () => {
    expect(expandPathVars('~/proj', { HOME: '/home/tester' })).toBe('/home/tester/proj');
  });

  it('expands %VAR% anywhere in the path', () => {
    expect(expandPathVars('%DEV%\\wmux', env)).toBe('D:\\code\\wmux');
    expect(expandPathVars('%USERPROFILE%\\OneDrive', env)).toBe(`${HOME}\\OneDrive`);
  });

  // The important one: collapsing an unset %VAR% to nothing turns
  // `%PROJECTS%\wmux` into `\wmux`, which is a REAL directory (the drive root's
  // child) — the pane would open somewhere plausible-looking and wrong. Left
  // literal, it fails the stat below and gets the honest %USERPROFILE% fallback
  // plus a console warning naming the path.
  it('leaves an unset %VAR% literal rather than collapsing it', () => {
    expect(expandPathVars('%PROJECTS%\\wmux', env)).toBe('%PROJECTS%\\wmux');
  });

  it('treats a var set to the empty string as set', () => {
    expect(expandPathVars('%EMPTY%\\x', env)).toBe('\\x');
  });

  it('trims surrounding whitespace (paste artefact from the settings field)', () => {
    expect(expandPathVars('  C:\\proj  ', env)).toBe('C:\\proj');
    expect(expandPathVars('   ', env)).toBe('');
  });

  it('never expands a POSIX path into something else', () => {
    expect(expandPathVars('/home/tester/proj', env)).toBe('/home/tester/proj');
  });
});

describe('resolveSpawnCwd with a user-typed starting path', () => {
  it('spawns in the home directory for ~', () => {
    expect(resolveSpawnCwd('~')).toBe(process.env.USERPROFILE || 'C:\\');
  });

  it('expands %USERPROFILE% to the same directory the literal path gives', () => {
    expect(resolveSpawnCwd('%USERPROFILE%')).toBe(resolveSpawnCwd(process.env.USERPROFILE));
  });

  it('falls back rather than spawning in a drive root for an unset var', () => {
    expect(resolveSpawnCwd('%WMUX_NO_SUCH_VAR%\\projects')).toBe(process.env.USERPROFILE || 'C:\\');
  });

  it('still returns undefined for no cwd at all', () => {
    expect(resolveSpawnCwd('')).toBeUndefined();
    expect(resolveSpawnCwd(undefined)).toBeUndefined();
    // Whitespace-only is "the user cleared the field", not a directory.
    expect(resolveSpawnCwd('   ')).toBeUndefined();
  });
});

describe('workspacePrefs.defaultCwd', () => {
  // Empty means "wherever wmux itself was launched from" — the behaviour every
  // install had before this pref existed. Shipping any other default would move
  // every existing user's panes on upgrade.
  it('defaults to empty, i.e. unchanged behaviour', () => {
    expect(DEFAULT_WORKSPACE_PREFS.defaultCwd).toBe('');
  });
});
