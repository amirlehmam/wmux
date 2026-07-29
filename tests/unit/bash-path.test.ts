import { describe, it, expect } from 'vitest';
import { bashPathCandidates, toBashPath } from '../helpers/bash-path';

describe('bashPathCandidates', () => {
  it('offers the Git Bash, WSL and Cygwin spellings of a Windows drive path', () => {
    expect(bashPathCandidates('C:\\dev\\wmux\\scripts')).toEqual([
      '/c/dev/wmux/scripts',
      '/mnt/c/dev/wmux/scripts',
      '/cygdrive/c/dev/wmux/scripts',
    ]);
  });

  it('lower-cases the drive letter, the way every bash flavour mounts it', () => {
    expect(bashPathCandidates('D:/Temp/x')[0]).toBe('/d/Temp/x');
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

  it('prefers Git Bash when both spellings resolve — it inherits the Windows env', () => {
    expect(toBashPath('C:\\dev\\wmux', () => true)).toBe('/c/dev/wmux');
  });

  it('falls back to the first candidate when nothing probes true', () => {
    expect(toBashPath('C:\\dev\\wmux', () => false)).toBe('/c/dev/wmux');
  });

  it('never probes a path that has no drive letter to translate', () => {
    const probe = (): boolean => { throw new Error('should not probe'); };
    expect(toBashPath('/home/u/wmux', probe)).toBe('/home/u/wmux');
  });
});
