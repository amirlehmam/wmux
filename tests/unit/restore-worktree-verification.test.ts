import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyRestoredWorktrees } from '../../src/main/git-worktree';
import type { WorktreeMetadata } from '../../src/shared/types';

const MAIN_DIR = join(__dirname, '../../src/main');
const INDEX = readFileSync(join(MAIN_DIR, 'index.ts'), 'utf8');

describe('verifyRestoredWorktrees', () => {
  const sampleWorktree: WorktreeMetadata = {
    repoRoot: 'C:\\projects\\main-repo',
    branch: 'feat-test',
    baseBranch: 'main',
    baseSha: 'a1b2c3d4e5',
    worktreePath: 'C:\\Users\\User\\.wmux\\worktrees\\main-repo\\feat-test',
  };

  it('keeps worktree and does not dispatch notice when worktreePath exists', () => {
    const existsSync = vi.fn().mockReturnValue(true);
    const showNotice = vi.fn();

    const windows = [
      {
        workspaces: [
          {
            id: 'ws-1',
            worktree: { ...sampleWorktree },
            splitTree: {
              type: 'leaf',
              paneId: 'p-1',
              surfaces: [{ id: 'surf-1', type: 'terminal' }],
              activeSurfaceIndex: 0,
            },
          },
        ],
      },
    ];

    const result = verifyRestoredWorktrees(windows, { existsSync, showNotice });

    expect(result).toEqual({ verified: 1, cleared: 0 });
    expect(windows[0].workspaces[0].worktree).toEqual(sampleWorktree);
    expect(existsSync).toHaveBeenCalledWith(sampleWorktree.worktreePath);
    expect(showNotice).not.toHaveBeenCalled();
  });

  it('clears worktree and dispatches notice when worktreePath is missing', () => {
    const existsSync = vi.fn().mockReturnValue(false);
    const showNotice = vi.fn();

    const windows = [
      {
        workspaces: [
          {
            id: 'ws-1',
            worktree: { ...sampleWorktree },
            splitTree: {
              type: 'leaf',
              paneId: 'p-1',
              surfaces: [{ id: 'surf-term-1', type: 'terminal' }],
              activeSurfaceIndex: 0,
            },
          },
        ],
      },
    ];

    const result = verifyRestoredWorktrees(windows, { existsSync, showNotice });

    expect(result).toEqual({ verified: 0, cleared: 1 });
    expect(windows[0].workspaces[0].worktree).toBeUndefined();
    expect(showNotice).toHaveBeenCalledTimes(1);
    expect(showNotice).toHaveBeenCalledWith(
      'surf-term-1',
      'worktree.restoreMissing',
    );
  });

  it('handles nested split trees (leaves and branches) to find surfaceId', () => {
    const existsSync = vi.fn().mockReturnValue(false);
    const showNotice = vi.fn();

    const windows = [
      {
        workspaces: [
          {
            id: 'ws-nested',
            worktree: { ...sampleWorktree },
            splitTree: {
              type: 'branch',
              direction: 'horizontal',
              ratio: 0.5,
              children: [
                {
                  type: 'branch',
                  direction: 'vertical',
                  ratio: 0.5,
                  children: [
                    {
                      type: 'leaf',
                      paneId: 'p-left-top',
                      surfaces: [{ id: 'surf-nested-1', type: 'terminal' }],
                      activeSurfaceIndex: 0,
                    },
                    {
                      type: 'leaf',
                      paneId: 'p-left-bottom',
                      surfaces: [{ id: 'surf-nested-2', type: 'terminal' }],
                      activeSurfaceIndex: 0,
                    },
                  ],
                },
                {
                  type: 'leaf',
                  paneId: 'p-right',
                  surfaces: [{ id: 'surf-nested-3', type: 'terminal' }],
                  activeSurfaceIndex: 0,
                },
              ],
            },
          },
        ],
      },
    ];

    const result = verifyRestoredWorktrees(windows, { existsSync, showNotice });

    expect(result).toEqual({ verified: 0, cleared: 1 });
    expect(showNotice).toHaveBeenCalledWith(
      'surf-nested-1',
      'worktree.restoreMissing',
    );
  });

  it('selects first terminal surface when active surface in first leaf is non-terminal', () => {
    const existsSync = vi.fn().mockReturnValue(false);
    const showNotice = vi.fn();

    const windows = [
      {
        workspaces: [
          {
            id: 'ws-browser-active',
            worktree: { ...sampleWorktree },
            splitTree: {
              type: 'leaf',
              paneId: 'p-1',
              surfaces: [
                { id: 'surf-browser', type: 'browser' },
                { id: 'surf-terminal-2', type: 'terminal' },
              ],
              activeSurfaceIndex: 0,
            },
          },
        ],
      },
    ];

    const result = verifyRestoredWorktrees(windows, { existsSync, showNotice });

    expect(result).toEqual({ verified: 0, cleared: 1 });
    expect(showNotice).toHaveBeenCalledWith(
      'surf-terminal-2',
      'worktree.restoreMissing',
    );
  });

  it('handles missing workspaces or missing worktree gracefully', () => {
    const existsSync = vi.fn().mockReturnValue(false);
    const showNotice = vi.fn();

    const windows: any[] = [
      {},
      { workspaces: [] },
      {
        workspaces: [
          { id: 'ws-no-worktree' },
          { id: 'ws-empty-worktree', worktree: {} },
          { id: 'ws-empty-path', worktree: { worktreePath: '' } },
        ],
      },
    ];

    const result = verifyRestoredWorktrees(windows, { existsSync, showNotice });

    expect(result).toEqual({ verified: 0, cleared: 0 });
    expect(showNotice).not.toHaveBeenCalled();
    expect(existsSync).not.toHaveBeenCalled();
  });
});

describe('index.ts worktree restore verification wiring', () => {
  it('imports verifyRestoredWorktrees from ./git-worktree', () => {
    expect(INDEX).toMatch(/import\s*\{[^}]*verifyRestoredWorktrees[^}]*\}\s*from\s*['"]\.\/git-worktree['"]/);
  });

  it('calls verifyRestoredWorktrees on savedWindows with deliverPaneNotice', () => {
    expect(INDEX).toMatch(/verifyRestoredWorktrees\(\s*savedWindows\s*,\s*\{\s*showNotice:\s*deliverPaneNotice\s*\}\s*\)/);
  });

  it('places verifyRestoredWorktrees after pruneRestoredOmpSessions and before the windows are primed', () => {
    const ompIndex = INDEX.indexOf('pruneRestoredOmpSessions(savedWindows)');
    const verifyIndex = INDEX.indexOf('verifyRestoredWorktrees(savedWindows');
    // openStartupWindows primes every restored window; startup calls it last.
    const opener = INDEX.slice(INDEX.indexOf('function openStartupWindows('));
    expect(opener.slice(0, opener.search(/\r?\n\}\r?\n/))).toContain('sessionWindows.prime(');
    const primeIndex = INDEX.indexOf('openStartupWindows(savedWindows)');

    expect(ompIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(primeIndex).toBeGreaterThan(-1);

    expect(verifyIndex).toBeGreaterThan(ompIndex);
    expect(verifyIndex).toBeLessThan(primeIndex);
  });
});
