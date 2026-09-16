import { describe, expect, it } from 'vitest';
import type { PaneId, SplitNode, SurfaceId, SurfaceRef } from '../../src/shared/types';
import { deriveWorkspaceTitle } from '../../src/renderer/components/SplitPane/surface-label';

// ─────────────────────────────────────────────────────────────────────────────
// An untitled new workspace is named after the tabs it opens with, so the
// sidebar can tell workspaces apart without renaming each one. A workspace with
// nothing to name it after answers '' and the store numbers it instead.
// ─────────────────────────────────────────────────────────────────────────────

let n = 0;
function s(patch: Partial<SurfaceRef> = {}): SurfaceRef {
  return { id: `surf-${++n}` as SurfaceId, type: 'terminal', ...patch };
}
function leaf(...surfaces: SurfaceRef[]): SplitNode {
  return { type: 'leaf', paneId: `pane-${++n}` as PaneId, surfaces, activeSurfaceIndex: 0 };
}
function branch(direction: 'horizontal' | 'vertical', a: SplitNode, b: SplitNode): SplitNode {
  return { type: 'branch', direction, ratio: 0.5, children: [a, b] };
}
const named = (title: string) => s({ customTitle: title });

describe('deriveWorkspaceTitle — order', () => {
  it('walks the tree depth-first, first child before second', () => {
    const tree = branch('vertical',
      branch('horizontal', leaf(named('a')), leaf(named('b'))),
      leaf(named('c')));
    expect(deriveWorkspaceTitle(tree, undefined, undefined)).toBe('a + b + c');
  });

  it('goes as deep as the nesting does, on either side', () => {
    const tree = branch('horizontal',
      leaf(named('a')),
      branch('vertical', leaf(named('b')), branch('horizontal', leaf(named('c')), leaf(named('d')))));
    expect(deriveWorkspaceTitle(tree, undefined, undefined)).toBe('a + b + c + d');
  });

  it('lists every tab of a pane, in tab order', () => {
    const tree = branch('horizontal', leaf(named('a'), named('b')), leaf(named('c')));
    expect(deriveWorkspaceTitle(tree, undefined, undefined)).toBe('a + b + c');
  });

  it('keeps duplicate labels', () => {
    const tree = branch('horizontal', leaf(s({ cwd: 'C:\\src\\api' })), leaf(s({ cwd: 'C:\\src\\api' })));
    expect(deriveWorkspaceTitle(tree, undefined, undefined)).toBe('api + api');
  });
});

describe('deriveWorkspaceTitle — labels', () => {
  it('ranks a custom title above everything, for every surface type', () => {
    for (const type of ['terminal', 'browser', 'markdown', 'code', 'diff', 'prompts'] as const) {
      const tree = leaf(s({ type, customTitle: 'mine', cwd: 'C:\\x', markdownFileName: 'f.md', codeFileName: 'f.ts' }));
      expect(deriveWorkspaceTitle(tree, 'C:\\ws', 'pwsh.exe')).toBe('mine');
    }
  });

  it('labels a terminal by its own cwd before the workspace cwd', () => {
    expect(deriveWorkspaceTitle(leaf(s({ cwd: 'C:\\src\\api' })), 'C:\\src\\web', undefined)).toBe('api');
    expect(deriveWorkspaceTitle(leaf(s()), 'C:\\src\\web', undefined)).toBe('web');
  });

  it('reads Windows and POSIX paths, with or without a trailing slash', () => {
    expect(deriveWorkspaceTitle(leaf(s({ cwd: 'C:\\src\\api\\' })), undefined, undefined)).toBe('api');
    expect(deriveWorkspaceTitle(leaf(s({ cwd: '/home/me/api/' })), undefined, undefined)).toBe('api');
    expect(deriveWorkspaceTitle(leaf(s({ cwd: '/home/me/api' })), undefined, undefined)).toBe('api');
  });

  it('falls back to the surface shell, then the workspace shell', () => {
    expect(deriveWorkspaceTitle(leaf(s({ shell: 'pwsh.exe' })), undefined, 'cmd.exe')).toBe('PowerShell');
    expect(deriveWorkspaceTitle(leaf(s()), undefined, 'cmd.exe')).toBe('Command Prompt');
  });

  it('labels a shell spec with arguments by its executable', () => {
    // `shell` may be a whole command line, and resolvedShell — what a live tab
    // uses to dodge this — does not exist yet when the title is stored.
    expect(deriveWorkspaceTitle(leaf(s({ shell: 'wsl.exe -d Ubuntu' })), undefined, undefined)).toBe('WSL');
    expect(deriveWorkspaceTitle(leaf(s()), undefined, 'ssh user@host')).toBe('Ssh');
    expect(deriveWorkspaceTitle(leaf(s({ shell: '"C:\\Program Files\\Git\\bin\\bash.exe" --login' })), undefined, undefined)).toBe('Bash');
    expect(deriveWorkspaceTitle(leaf(s({ shell: '   ' })), undefined, undefined)).toBe('');
  });

  it('never uses what only exists once the PTY runs', () => {
    // currentCwd and resolvedShell are live fields: nothing has reported them
    // when a workspace is created, and a stored title must not depend on them.
    const tree = leaf(s({ currentCwd: 'C:\\live', resolvedShell: 'pwsh.exe' }));
    expect(deriveWorkspaceTitle(tree, undefined, undefined)).toBe('');
  });

  it('names markdown and code tabs by file, without the unsaved marker', () => {
    const tree = branch('horizontal',
      leaf(s({ type: 'markdown', markdownFileName: 'notes.md', markdownDirty: true })),
      leaf(s({ type: 'code', codeFileName: 'main.ts', markdownDirty: true })));
    expect(deriveWorkspaceTitle(tree, undefined, undefined)).toBe('notes.md + main.ts');
  });

  it('labels other surfaces by their translated type, among named tabs', () => {
    const tree = leaf(
      named('api'),
      s({ type: 'browser' }),
      s({ type: 'diff' }),
      s({ type: 'prompts' }),
      s({ type: 'markdown' }),
      s({ type: 'code' }),
      s(),
    );
    const t = (key: string, fallback?: string) => `<${fallback ?? key}>`;
    expect(deriveWorkspaceTitle(tree, undefined, undefined, t as never))
      .toBe('api + <Browser> + <Diff> + <Prompts> + <Markdown> + <Code> + <Terminal>');
  });
});

describe('deriveWorkspaceTitle — nothing to name it after', () => {
  it('answers empty when every tab is only its type', () => {
    const tree = branch('vertical',
      branch('horizontal', leaf(s()), leaf(s({ type: 'browser' }))),
      leaf(s({ type: 'prompts' }), s({ type: 'markdown' }), s({ type: 'code' }), s({ type: 'diff' })));
    expect(deriveWorkspaceTitle(tree, undefined, undefined)).toBe('');
  });

  it('keeps the bare labels once one tab has a name of its own', () => {
    const tree = branch('horizontal', leaf(s({ cwd: 'C:\\src\\api' })), leaf(s(), s({ type: 'prompts' })));
    expect(deriveWorkspaceTitle(tree, undefined, undefined)).toBe('api + Terminal + Prompts');
  });

  it('answers empty for a tree with no tabs', () => {
    expect(deriveWorkspaceTitle(leaf(), 'C:\\src\\api', 'pwsh.exe')).toBe('');
  });
});
