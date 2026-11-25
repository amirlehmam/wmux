import { describe, expect, it } from 'vitest';
import { pickHookFile } from '../../src/renderer/components/Diff/diff-hook-file';

const files = (...paths: string[]) => paths.map((path) => ({ path }));

describe('pickHookFile', () => {
  it('finds the changed file an absolute path ends with, whatever root the agent sees', () => {
    const list = files('AGENTS.md', 'src/a.ts', 'docs/n.md');
    expect(pickHookFile(list, '/workspaces/repo/AGENTS.md')).toBe('AGENTS.md');
    expect(pickHookFile(list, '/home/me/agent/repo/src/a.ts')).toBe('src/a.ts');
    expect(pickHookFile(list, '/workspaces/repo/docs/n.md')).toBe('docs/n.md');
  });

  it('reads a Windows path and a path that is already relative', () => {
    const list = files('src/a.ts');
    expect(pickHookFile(list, 'C:\\Users\\me\\repo\\src\\a.ts')).toBe('src/a.ts');
    expect(pickHookFile(list, 'src/a.ts')).toBe('src/a.ts');
    expect(pickHookFile(files('src\\a.ts'), '/w/repo/src/a.ts')).toBe('src\\a.ts');
  });

  it('takes the longest match, so docs/README.md is not mistaken for README.md', () => {
    expect(pickHookFile(files('README.md', 'docs/README.md'), '/w/repo/docs/README.md')).toBe('docs/README.md');
    expect(pickHookFile(files('docs/README.md', 'README.md'), '/w/repo/docs/README.md')).toBe('docs/README.md');
    expect(pickHookFile(files('README.md', 'docs/README.md'), '/w/repo/README.md')).toBe('README.md');
  });

  it('matches at a path segment, not inside a name', () => {
    expect(pickHookFile(files('README.md'), '/w/repo/xREADME.md')).toBeNull();
    expect(pickHookFile(files('a.ts'), '/w/repo/data.ts')).toBeNull();
    expect(pickHookFile(files('src/a.ts'), '/w/repo/mysrc/a.ts')).toBeNull();
  });

  it('never picks a folder entry, and answers null for nothing to match', () => {
    expect(pickHookFile(files('docs/'), '/w/repo/docs/n.md')).toBeNull();
    expect(pickHookFile(files('docs/', 'docs/n.md'), '/w/repo/docs/n.md')).toBe('docs/n.md');
    expect(pickHookFile(files('a.ts'), '/w/repo/other.ts')).toBeNull();
    expect(pickHookFile([], '/w/repo/a.ts')).toBeNull();
    expect(pickHookFile(files(''), '/w/repo/a.ts')).toBeNull();
    for (const bad of ['', undefined, null, 5, {}]) expect(pickHookFile(files('a.ts'), bad)).toBeNull();
  });
});
