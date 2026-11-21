// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DiffPane from '../../src/renderer/components/Diff/DiffPane';

describe('DiffPane worktree baseRef', () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let container: HTMLDivElement;
  let mockGetFiles: ReturnType<typeof vi.fn>;
  let mockGetFileDiff: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as any).CSS = {
      escape: (s: string) => s,
    };

    mockGetFiles = vi.fn().mockResolvedValue({ files: [] });
    mockGetFileDiff = vi.fn().mockResolvedValue({ diff: '' });

    (window as any).wmux = {
      diff: {
        getFiles: mockGetFiles,
        getFileDiff: mockGetFileDiff,
        onUpdate: vi.fn().mockReturnValue(() => {}),
      },
    };

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    document.body.innerHTML = '';
    delete (window as any).wmux;
  });

  it('passes baseRef to window.wmux.diff.getFiles when provided', async () => {
    await act(async () => {
      root!.render(
        React.createElement(DiffPane, {
          surfaceId: 'surf-1',
          cwd: '/repo/path',
          baseRef: 'base-sha-12345',
        }),
      );
    });

    expect(mockGetFiles).toHaveBeenCalledWith('/repo/path', 'base-sha-12345', 'surf-1');
  });

  it('omits baseRef when not provided', async () => {
    await act(async () => {
      root!.render(
        React.createElement(DiffPane, {
          surfaceId: 'surf-2',
          cwd: '/repo/path',
        }),
      );
    });

    expect(mockGetFiles).toHaveBeenCalledWith('/repo/path', undefined, 'surf-2');
  });

  // An ssh workspace answers `{ error }` when its host cannot be reached; the
  // pane must say so rather than look like a checkout with no changes.
  it('shows an error from main, not an empty change list', async () => {
    mockGetFiles.mockResolvedValue({ error: 'Could not reach the remote host over ssh', code: 'ssh-unreachable' });
    await act(async () => {
      root!.render(React.createElement(DiffPane, { surfaceId: 'surf-3', cwd: '/anywhere' }));
    });
    expect(container!.textContent).toContain('Could not reach the remote host over ssh');
  });
});
