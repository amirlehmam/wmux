import { describe, it, expect } from 'vitest';
import {
  ancestorsOf,
  buildDiffStats,
  statFor,
  totalStat,
  isEditingTool,
  relativizeTouched,
  noteTouched,
  isTouched,
  MAX_TOUCHED,
} from '../../src/renderer/components/Explorer/explorer-diff';
import type { ExplorerDiffEntry } from '../../src/shared/types';

function file(path: string, additions = 1, deletions = 0): ExplorerDiffEntry {
  return { path, status: 'modified', additions, deletions };
}

describe('ancestorsOf', () => {
  it('lists every directory above a path, nearest first', () => {
    expect(ancestorsOf('src/main/diff-tree.ts')).toEqual(['src/main', 'src']);
  });

  it('excludes the root and the file itself', () => {
    expect(ancestorsOf('CLAUDE.md')).toEqual([]);
  });

  it('is empty for the root', () => {
    expect(ancestorsOf('')).toEqual([]);
  });

  it('treats a backslash path as the same path', () => {
    expect(ancestorsOf('src\\main\\x.ts')).toEqual(['src/main', 'src']);
  });
});

describe('buildDiffStats', () => {
  it('gives a changed file its own numbers', () => {
    const stats = buildDiffStats([file('CLAUDE.md', 9, 0)]);
    expect(statFor(stats, 'CLAUDE.md')).toEqual({ additions: 9, deletions: 0, files: 1 });
  });

  it('rolls a file up into every ancestor folder', () => {
    const stats = buildDiffStats([file('src/main/code-file.ts', 55, 22)]);
    expect(statFor(stats, 'src/main')).toEqual({ additions: 55, deletions: 22, files: 1 });
    expect(statFor(stats, 'src')).toEqual({ additions: 55, deletions: 22, files: 1 });
  });

  it('sums siblings into their shared parent', () => {
    const stats = buildDiffStats([
      file('src/main/a.ts', 10, 2),
      file('src/main/b.ts', 5, 3),
      file('src/renderer/c.tsx', 1, 1),
    ]);
    expect(statFor(stats, 'src/main')).toEqual({ additions: 15, deletions: 5, files: 2 });
    expect(statFor(stats, 'src')).toEqual({ additions: 16, deletions: 6, files: 3 });
  });

  it('returns null for a path with nothing changed under it', () => {
    const stats = buildDiffStats([file('src/main/a.ts')]);
    expect(statFor(stats, 'tests')).toBeNull();
    expect(statFor(stats, 'src/renderer')).toBeNull();
  });

  // The rollup has to be independent of what the panel has expanded: the
  // explorer lists directories lazily, so most of the tree is not in memory.
  it('rolls up folders the tree has never listed', () => {
    const stats = buildDiffStats([file('a/b/c/d/e.ts', 3, 4)]);
    for (const dir of ['a', 'a/b', 'a/b/c', 'a/b/c/d']) {
      expect(statFor(stats, dir)).toEqual({ additions: 3, deletions: 4, files: 1 });
    }
  });

  it('does not emit an entry for the root itself', () => {
    const stats = buildDiffStats([file('a.ts', 1, 1)]);
    expect(statFor(stats, '')).toBeNull();
  });

  it('matches a row whichever separator the caller spells it with', () => {
    const stats = buildDiffStats([file('src/main/a.ts', 7, 1)]);
    expect(statFor(stats, 'src\\main')).toEqual({ additions: 7, deletions: 1, files: 1 });
  });

  it('ignores leading and trailing separators', () => {
    const stats = buildDiffStats([file('/src/main/a.ts/', 2, 0)]);
    expect(statFor(stats, 'src/main/a.ts')).toEqual({ additions: 2, deletions: 0, files: 1 });
  });

  it('handles an empty change list', () => {
    const stats = buildDiffStats([]);
    expect(statFor(stats, 'src')).toBeNull();
  });

  it('counts deletions of a removed file', () => {
    const stats = buildDiffStats([
      { path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 40 },
    ]);
    expect(statFor(stats, 'src')).toEqual({ additions: 0, deletions: 40, files: 1 });
  });
});

describe('totalStat', () => {
  it('sums the whole change list for the header', () => {
    expect(totalStat([file('a.ts', 5, 1), file('b/c.ts', 2, 3)]))
      .toEqual({ additions: 7, deletions: 4, files: 2 });
  });

  it('is zero for no changes', () => {
    expect(totalStat([])).toEqual({ additions: 0, deletions: 0, files: 0 });
  });
});

describe('isEditingTool', () => {
  it('accepts the tools that write files', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(isEditingTool(tool)).toBe(true);
    }
  });

  it('rejects tools that only read or run things', () => {
    for (const tool of ['Read', 'Bash', 'Grep', 'Glob', 'WebFetch']) {
      expect(isEditingTool(tool)).toBe(false);
    }
  });

  it('rejects a non-string', () => {
    expect(isEditingTool(undefined)).toBe(false);
    expect(isEditingTool(null)).toBe(false);
    expect(isEditingTool(42)).toBe(false);
  });
});

describe('relativizeTouched', () => {
  it('strips the root from an absolute path', () => {
    expect(relativizeTouched('C:/proj', 'C:/proj/src/a.ts')).toBe('src/a.ts');
  });

  it('accepts a backslash-spelled hook path against a forward-slash root', () => {
    expect(relativizeTouched('C:/proj', 'C:\\proj\\src\\a.ts')).toBe('src/a.ts');
  });

  // Windows: the agent's spelling of a drive letter need not match the shell's.
  it('compares case-insensitively', () => {
    expect(relativizeTouched('C:/Proj', 'c:/proj/src/a.ts')).toBe('src/a.ts');
  });

  // ...but returns the ORIGINAL spelling, which is what listDir produced.
  it('preserves the original casing of the returned key', () => {
    expect(relativizeTouched('c:/proj', 'C:/proj/src/MyFile.ts')).toBe('src/MyFile.ts');
  });

  it('rejects a path outside the root', () => {
    expect(relativizeTouched('C:/proj', 'C:/other/a.ts')).toBeNull();
  });

  // The sibling-prefix trap: C:/project must not look like a child of C:/proj.
  it('rejects a sibling whose name merely starts with the root', () => {
    expect(relativizeTouched('C:/proj', 'C:/project/a.ts')).toBeNull();
  });

  it('rejects the root itself', () => {
    expect(relativizeTouched('C:/proj', 'C:/proj')).toBeNull();
  });

  it('rejects empty input', () => {
    expect(relativizeTouched('', 'C:/proj/a.ts')).toBeNull();
    expect(relativizeTouched('C:/proj', '')).toBeNull();
  });
});

describe('noteTouched', () => {
  it('records a path', () => {
    expect([...noteTouched(new Set(), 'a.ts')]).toEqual(['a.ts']);
  });

  it('does not mutate the set it was given', () => {
    const before = new Set(['a.ts']);
    noteTouched(before, 'b.ts');
    expect([...before]).toEqual(['a.ts']);
  });

  it('ignores an empty key', () => {
    expect([...noteTouched(new Set(['a.ts']), '')]).toEqual(['a.ts']);
  });

  // A Set keeps INSERTION order, so a re-add would otherwise leave a
  // hot file in its original slot and let it age out ahead of a cold one.
  it('moves a repeated path to the newest position', () => {
    let set = new Set<string>();
    set = noteTouched(set, 'a.ts');
    set = noteTouched(set, 'b.ts');
    set = noteTouched(set, 'a.ts');
    expect([...set]).toEqual(['b.ts', 'a.ts']);
  });

  it('evicts oldest-first past the bound', () => {
    let set = new Set<string>();
    for (let i = 0; i < MAX_TOUCHED + 10; i++) set = noteTouched(set, `f${i}.ts`);
    expect(set.size).toBe(MAX_TOUCHED);
    expect(set.has('f0.ts')).toBe(false);
    expect(set.has(`f${MAX_TOUCHED + 9}.ts`)).toBe(true);
  });
});

describe('isTouched', () => {
  const touched = new Set(['src/main/a.ts']);

  it('marks the file itself', () => {
    expect(isTouched(touched, 'src/main/a.ts')).toBe(true);
  });

  it('marks every folder above it', () => {
    expect(isTouched(touched, 'src/main')).toBe(true);
    expect(isTouched(touched, 'src')).toBe(true);
  });

  it('does not mark an unrelated sibling', () => {
    expect(isTouched(touched, 'src/renderer')).toBe(false);
    expect(isTouched(touched, 'tests')).toBe(false);
  });

  // The same sibling-prefix trap as relativizeTouched, one level down.
  it('does not mark a folder whose name is a prefix of a touched one', () => {
    expect(isTouched(new Set(['srcfoo/a.ts']), 'src')).toBe(false);
  });

  it('is false for the root', () => {
    expect(isTouched(touched, '')).toBe(false);
  });

  it('is false against an empty set', () => {
    expect(isTouched(new Set(), 'src/main/a.ts')).toBe(false);
  });
});
