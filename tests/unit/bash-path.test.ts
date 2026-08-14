import { describe, it, expect } from 'vitest';
import { bashPathCandidates, toBashPath } from '../helpers/bash-path';

/**
 * Which spelling `bashPathCandidates` leads with depends on the bash the suite
 * can actually reach, so it is the one thing here that is platform-conditional.
 * On Windows that bash is Git Bash, which mounts `C:` at `/c`; anywhere else
 * the runner is already inside a Linux bash, where a Windows drive — if it is
 * visible at all — is a WSL2 mount at `/mnt/c`. Every flavour is always
 * offered either way; only the order moves. Asserting the fixed Git Bash order
 * would pass on Windows and fail on every Linux and macOS checkout.
 */
const likeliestMount = process.platform === 'win32' ? '/c' : '/mnt/c';

describe('bashPathCandidates', () => {
  it('offers the Git Bash, WSL and Cygwin spellings of a Windows drive path', () => {
    const candidates = bashPathCandidates('C:\\dev\\wmux\\scripts');
    expect(candidates).toEqual(
      expect.arrayContaining([
        '/c/dev/wmux/scripts',
        '/mnt/c/dev/wmux/scripts',
        '/cygdrive/c/dev/wmux/scripts',
      ]),
    );
    expect(candidates).toHaveLength(3);
  });

  it('leads with the spelling the bash on this platform is likeliest to mount', () => {
    expect(bashPathCandidates('C:\\dev\\wmux\\scripts')[0]).toBe(`${likeliestMount}/dev/wmux/scripts`);
  });

  it('lower-cases the drive letter, the way every bash flavour mounts it', () => {
    expect(bashPathCandidates('D:/Temp/x')).toEqual(
      expect.arrayContaining(['/d/Temp/x', '/mnt/d/Temp/x', '/cygdrive/d/Temp/x']),
    );
  });

  it('leaves a POSIX path alone', () => {
    expect(bashPathCandidates('/home/u/wmux')).toEqual(['/home/u/wmux']);
  });

  it('slash-converts a driveless Windows path without inventing a mount point', () => {
    expect(bashPathCandidates('\\\\server\\share\\x')).toEqual(['//server/share/x']);
  });
});

describe('toBashPath', () => {
  it('picks the spelling the probe says the bash on PATH can see', () => {
    const wslOnly = (p: string) => p.startsWith('/mnt/');
    expect(toBashPath('C:\\dev\\wmux', wslOnly)).toBe('/mnt/c/dev/wmux');
  });

  it('picks the spelling the probe says the bash on PATH can see, Git Bash flavour', () => {
    const gitBashOnly = (p: string) => !p.startsWith('/mnt/') && !p.startsWith('/cygdrive/');
    expect(toBashPath('C:\\dev\\wmux', gitBashOnly)).toBe('/c/dev/wmux');
  });

  it('prefers the platform mount when every spelling resolves', () => {
    expect(toBashPath('C:\\dev\\wmux', () => true)).toBe(`${likeliestMount}/dev/wmux`);
  });

  it('falls back to the first candidate when nothing probes true', () => {
    expect(toBashPath('C:\\dev\\wmux', () => false)).toBe(`${likeliestMount}/dev/wmux`);
  });

  it('never probes a path that has no drive letter to translate', () => {
    const probe = (): boolean => { throw new Error('should not probe'); };
    expect(toBashPath('/home/u/wmux', probe)).toBe('/home/u/wmux');
  });
});
