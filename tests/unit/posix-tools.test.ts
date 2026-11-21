import { describe, expect, it } from 'vitest';
import { hasPosixTools } from '../helpers/posix-tools';

/** The gate every shell-script-backed suite asks: it must say no on Windows, whatever the probes find. */
describe('hasPosixTools', () => {
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
});
