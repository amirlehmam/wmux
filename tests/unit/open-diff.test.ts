// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  diffRootKey, findDiffSurface, openDiffView, takeDiffSelection, DIFF_SELECT_EVENT,
  type OpenDiffOps,
} from '../../src/renderer/components/Diff/open-diff';
import { getSurfaceLabel } from '../../src/renderer/components/SplitPane/surface-label';
import type {
  PaneId, SplitNode, SurfaceId, SurfaceRef, WorkspaceId, WorkspaceInfo,
} from '../../src/shared/types';

// Issue #325: the explorer's change indicators open the existing Diff view.

const WS = 'ws-1' as WorkspaceId;
const P1 = 'pane-1' as PaneId;
const P2 = 'pane-2' as PaneId;

function surf(id: string, type: SurfaceRef['type'], cwd?: string): SurfaceRef {
  return { id: id as SurfaceId, type, ...(cwd ? { cwd } : {}) };
}

function leaf(paneId: PaneId, surfaces: SurfaceRef[]): SplitNode {
  return { type: 'leaf', paneId, surfaces, activeSurfaceIndex: 0 };
}

function workspace(tree: SplitNode, cwd = 'C:\\repo'): WorkspaceInfo {
  return { id: WS, title: 'w', cwd, splitTree: tree } as unknown as WorkspaceInfo;
}

function twoPanes(left: SurfaceRef[], right: SurfaceRef[]): SplitNode {
  return { type: 'branch', direction: 'horizontal', ratio: 0.5, children: [leaf(P1, left), leaf(P2, right)] };
}

function ops(ws: WorkspaceInfo): OpenDiffOps & { added: unknown[]; selected: unknown[] } {
  const added: unknown[] = [];
  const selected: unknown[] = [];
  return {
    workspaces: [ws],
    added,
    selected,
    selectSurface: (w, p, i) => { selected.push([w, p, i]); },
    addSurface: (w, p, type, options) => { added.push([w, p, type, options]); return 'surf-new' as SurfaceId; },
  };
}

describe('diffRootKey', () => {
  it('folds separators, trailing separators and case', () => {
    expect(diffRootKey('C:/Repo/')).toBe(diffRootKey('c:\\repo'));
    expect(diffRootKey('C:\\Repo\\\\')).toBe('c:\\repo');
    expect(diffRootKey(undefined)).toBe('');
  });
});

describe('findDiffSurface', () => {
  it('matches a pinned tab by its own cwd', () => {
    const ws = workspace(twoPanes([surf('t', 'terminal')], [surf('d', 'diff', 'C:\\other')]));
    expect(findDiffSurface(ws, 'c:/other')).toEqual({ paneId: P2, index: 0, surfaceId: 'd' });
  });

  it('matches an unpinned tab through the workspace cwd it follows', () => {
    const ws = workspace(leaf(P1, [surf('t', 'terminal'), surf('d', 'diff')]), 'C:\\repo');
    expect(findDiffSurface(ws, 'C:\\repo')?.surfaceId).toBe('d');
  });

  it('does not reuse a tab looking at a different folder', () => {
    const ws = workspace(leaf(P1, [surf('d', 'diff', 'C:\\a')]));
    expect(findDiffSurface(ws, 'C:\\b')).toBeNull();
  });

  it('prefers the pane the user is in', () => {
    const ws = workspace(twoPanes([surf('d1', 'diff', 'C:\\r')], [surf('d2', 'diff', 'C:\\r')]));
    expect(findDiffSurface(ws, 'C:\\r', P2)?.surfaceId).toBe('d2');
  });
});

describe('openDiffView', () => {
  it('focuses the existing tab instead of stacking a second one', () => {
    const o = ops(workspace(twoPanes([surf('t', 'terminal')], [surf('x', 'terminal'), surf('d', 'diff', 'C:\\r')])));
    expect(openDiffView(o, WS, P1, 'C:\\r')).toBe('d');
    expect(o.selected).toEqual([[WS, P2, 1]]);
    expect(o.added).toEqual([]);
  });

  it('opens a tab pinned to the root in the focused pane', () => {
    const o = ops(workspace(twoPanes([surf('t', 'terminal')], [surf('u', 'terminal')])));
    expect(openDiffView(o, WS, P2, 'C:\\r')).toBe('surf-new');
    expect(o.added).toEqual([[WS, P2, 'diff', { cwd: 'C:\\r' }]]);
  });

  it('falls back to the first pane when the focused one is gone', () => {
    const o = ops(workspace(leaf(P1, [surf('t', 'terminal')])));
    openDiffView(o, WS, 'pane-gone' as PaneId, 'C:\\r');
    expect(o.added).toEqual([[WS, P1, 'diff', { cwd: 'C:\\r' }]]);
  });

  it('hands the file to the tab, which may not have mounted yet', () => {
    const listener = vi.fn();
    window.addEventListener(DIFF_SELECT_EVENT, listener);
    const o = ops(workspace(leaf(P1, [surf('d', 'diff', 'C:\\r')])));
    openDiffView(o, WS, P1, 'C:\\r', 'src/a.ts');
    window.removeEventListener(DIFF_SELECT_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(takeDiffSelection('d')).toBe('src/a.ts');
    // One-shot: a remount must not jump back to it.
    expect(takeDiffSelection('d')).toBeNull();
  });

  it('does nothing without a root', () => {
    const o = ops(workspace(leaf(P1, [surf('t', 'terminal')])));
    expect(openDiffView(o, WS, P1, '')).toBeNull();
    expect(o.added).toEqual([]);
  });
});

describe('a remote (ssh) workspace', () => {
  const remoteWs = (surfaces: SurfaceRef[]) => workspace(leaf(P1, surfaces), 'C:\\Users\\me\\somewhere');

  it('opens a Diff tab WITHOUT pinning the remote root as if it were a local folder', () => {
    const o = ops(remoteWs([surf('t', 'terminal')]));
    expect(openDiffView(o, WS, P1, '/home/dev/proj', 'src/a.ts', { remote: true })).toBe('surf-new');
    expect(o.added).toEqual([[WS, P1, 'diff', undefined]]);
  });

  it('needs no root at all, since main takes the checkout from the ssh target', () => {
    const o = ops(remoteWs([surf('t', 'terminal')]));
    expect(openDiffView(o, WS, P1, '', null, { remote: true })).toBe('surf-new');
  });

  it('reuses any Diff tab of the workspace, whatever cwd it carries (they all show the one checkout)', () => {
    const o = ops(remoteWs([surf('t', 'terminal'), surf('d', 'diff', 'C:\\stale\\pin')]));
    expect(openDiffView(o, WS, P1, '/home/dev/proj', null, { remote: true })).toBe('d');
    expect(o.added).toEqual([]);
    expect(o.selected).toEqual([[WS, P1, 1]]);
    expect(findDiffSurface(remoteWs([surf('d', 'diff')]), '', null, true)?.surfaceId).toBe('d');
  });

  it('still hands the chosen file to the tab', () => {
    const o = ops(remoteWs([surf('d', 'diff')]));
    openDiffView(o, WS, P1, '/home/dev/proj', 'docs/x.md', { remote: true });
    expect(takeDiffSelection('d')).toBe('docs/x.md');
  });

  it('a local request is pinned to its root and matched by it', () => {
    const o = ops(workspace(leaf(P1, [surf('t', 'terminal')])));
    openDiffView(o, WS, P1, 'C:\\repo');
    expect(o.added).toEqual([[WS, P1, 'diff', { cwd: 'C:\\repo' }]]);
    expect(findDiffSurface(workspace(leaf(P1, [surf('d', 'diff', 'C:\\a')])), 'C:\\b')).toBeNull();
    expect(openDiffView(o, WS, P1, '')).toBeNull();
  });
});

describe('diff tab label', () => {
  it('names the folder a pinned tab looks at', () => {
    expect(getSurfaceLabel(surf('d', 'diff', 'C:\\work\\repo'))).toBe('Diff · repo');
  });

  it('keeps the bare label for a tab following the workspace', () => {
    expect(getSurfaceLabel(surf('d', 'diff'))).toBe('Diff');
  });
});
