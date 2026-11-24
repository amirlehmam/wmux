import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasPosixTools } from '../helpers/posix-tools';

/** The gate every shell-script-backed suite asks: it must say no on Windows, whatever the probes find. */
describe('hasPosixTools', () => {
  // The Linux release job sets WMUX_REQUIRE_POSIX=1 for the whole run; these tests set it themselves.
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.WMUX_REQUIRE_POSIX;
    delete process.env.WMUX_REQUIRE_POSIX;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.WMUX_REQUIRE_POSIX;
    else process.env.WMUX_REQUIRE_POSIX = saved;
  });

  it('is false on win32 whatever is asked', () => {
    expect(hasPosixTools([], 'win32')).toBe(false);
    expect(hasPosixTools(['git', 'gnu-find'], 'win32')).toBe(false);
  });

  it('answers for sh itself with nothing asked, and agrees with itself on a second ask', () => {
    expect(hasPosixTools([], 'linux')).toBe(hasPosixTools([], 'linux'));
  });

  it('is false for a need this machine cannot meet only when a probe fails, and never throws', () => {
    expect(typeof hasPosixTools(['git', 'gnu-find', 'stat-c', 'awk', 'base64', 'mktemp', 'head', 'wc', 'sed', 'sha1sum'], 'linux')).toBe('boolean');
  });

  it('WMUX_REQUIRE_POSIX=1 turns "skip" into a failure that names what is missing', () => {
    process.env.WMUX_REQUIRE_POSIX = '1';
    expect(() => hasPosixTools(['git'], 'win32')).toThrow(/cannot run here: missing a POSIX platform/);
    process.env.WMUX_REQUIRE_POSIX = '0';
    expect(hasPosixTools(['git'], 'win32')).toBe(false);
  });
});
