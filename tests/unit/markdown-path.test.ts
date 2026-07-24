import { describe, it, expect } from 'vitest';
import {
  middleEllipsize,
  toDisplayPath,
  toRelativePath,
} from '../../src/renderer/components/Markdown/markdown-utils';

// Display-path derivation for the markdown pane's path chip (issue #116).
// These rules are Windows-first: paths compare case-insensitively, either
// separator is accepted, and the copied form must keep backslashes so
// cmd.exe consumers accept it.

describe('toRelativePath', () => {
  it('returns the path relative to a containing base directory', () => {
    expect(toRelativePath('C:\\repo\\docs\\PLAN.md', 'C:\\repo')).toBe('docs\\PLAN.md');
  });

  it('ignores case differences in the drive and directory names', () => {
    expect(toRelativePath('C:\\Repo\\Docs\\PLAN.md', 'c:\\repo')).toBe('Docs\\PLAN.md');
  });

  it('accepts either separator on both sides', () => {
    expect(toRelativePath('C:/repo/docs/PLAN.md', 'C:\\repo')).toBe('docs/PLAN.md');
  });

  it('tolerates a trailing separator on the base directory', () => {
    expect(toRelativePath('C:\\repo\\PLAN.md', 'C:\\repo\\')).toBe('PLAN.md');
  });

  it('returns null when the file is outside the base directory', () => {
    expect(toRelativePath('C:\\other\\PLAN.md', 'C:\\repo')).toBeNull();
  });

  // 'C:\repo-backup' must not count as being inside 'C:\repo'.
  it('does not treat a sibling with a shared prefix as being inside', () => {
    expect(toRelativePath('C:\\repo-backup\\PLAN.md', 'C:\\repo')).toBeNull();
  });

  it('returns null when there is no base directory', () => {
    expect(toRelativePath('C:\\repo\\PLAN.md', undefined)).toBeNull();
  });

  it('handles UNC paths without mangling them', () => {
    expect(toRelativePath('\\\\server\\share\\docs\\a.md', '\\\\server\\share'))
      .toBe('docs\\a.md');
  });
});

describe('toDisplayPath', () => {
  it('prefers a path relative to the workspace cwd', () => {
    expect(toDisplayPath('C:\\repo\\docs\\PLAN.md', {
      cwd: 'C:\\repo',
      homeDir: 'C:\\Users\\me',
    })).toBe('docs\\PLAN.md');
  });

  it('falls back to ~-shortening for files under the home directory', () => {
    expect(toDisplayPath('C:\\Users\\me\\notes\\a.md', {
      cwd: 'C:\\repo',
      homeDir: 'C:\\Users\\me',
    })).toBe('~\\notes\\a.md');
  });

  it('keeps the ~ separator style of the original path', () => {
    expect(toDisplayPath('C:/Users/me/notes/a.md', { homeDir: 'C:/Users/me' }))
      .toBe('~/notes/a.md');
  });

  it('leaves paths outside both cwd and home absolute', () => {
    expect(toDisplayPath('D:\\shared\\spec.md', {
      cwd: 'C:\\repo',
      homeDir: 'C:\\Users\\me',
    })).toBe('D:\\shared\\spec.md');
  });

  it('works with no cwd and no home (pathless workspace)', () => {
    expect(toDisplayPath('D:\\shared\\spec.md')).toBe('D:\\shared\\spec.md');
  });

  it('returns an empty string for an empty path', () => {
    expect(toDisplayPath('')).toBe('');
  });
});

describe('middleEllipsize', () => {
  it('leaves a short path untouched', () => {
    expect(middleEllipsize('docs\\PLAN.md', 60)).toBe('docs\\PLAN.md');
  });

  it('eats the middle and never the basename', () => {
    const result = middleEllipsize('C:\\a\\very\\deeply\\nested\\tree\\PLAN.md', 20);
    expect(result).toContain('PLAN.md');
    expect(result).toContain('…');
    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('honours the budget even when the basename alone overflows', () => {
    const result = middleEllipsize('C:\\dir\\an-extremely-long-file-name.md', 12);
    expect(result.length).toBeLessThanOrEqual(12);
    expect(result.startsWith('…')).toBe(true);
  });

  it('handles a path with no separator at all', () => {
    expect(middleEllipsize('PLAN.md', 60)).toBe('PLAN.md');
  });
});
