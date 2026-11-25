// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DiffPane from '../../src/renderer/components/Diff/DiffPane';

/**
 * An agent's edit hook names the file it wrote by an absolute path in the agent's own file system, which for a
 * devbox session (a container on the ssh target's host) is not even under the checkout path wmux knows. The Diff
 * tab must ask for the changed file that path ends with, spelled as the list spells it, and never for the raw path
 * (an ssh workspace answers that with "Invalid path").
 */
describe('DiffPane after an agent edit', () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;
  let mockGetFiles: ReturnType<typeof vi.fn>;
  let mockGetFileDiff: ReturnType<typeof vi.fn>;
  let fireUpdate: (data: { file?: string }) => void;

  const changed = (path: string) => ({ path, status: 'modified', additions: 1, deletions: 0 });
  const settle = (ms = 450) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

  beforeEach(() => {
    (globalThis as any).CSS = { escape: (s: string) => s };
    // jsdom has no element scrolling; the pane scrolls to the top when a file is selected.
    (Element.prototype as any).scrollTo = () => undefined;
    mockGetFiles = vi.fn().mockResolvedValue({ files: [changed('README.md'), changed('AGENTS.md')] });
    mockGetFileDiff = vi.fn().mockResolvedValue({ diff: '' });
    (window as any).wmux = {
      diff: {
        getFiles: mockGetFiles,
        getFileDiff: mockGetFileDiff,
        onUpdate: vi.fn((cb: (data: { file?: string }) => void) => { fireUpdate = cb; return () => {}; }),
      },
    };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    delete (window as any).wmux;
  });

  const mount = () => act(async () => {
    root.render(React.createElement(DiffPane, { surfaceId: 'surf-hook', cwd: '/anywhere' }));
  });

  it('asks for the listed file the hook path ends with, and never for the hook path', async () => {
    await mount();
    mockGetFileDiff.mockClear();
    act(() => fireUpdate({ file: '/workspaces/ms-container-feature-agent2/AGENTS.md' }));
    await settle();
    const asked = mockGetFileDiff.mock.calls.map((c) => c[1]);
    expect(asked).toContain('AGENTS.md');
    expect(asked.every((file) => !String(file).startsWith('/'))).toBe(true);
    expect(container.textContent).not.toContain('Invalid path');
  });

  it('leaves the selection alone for a file the change list does not have', async () => {
    await mount();
    await settle(50);
    mockGetFileDiff.mockClear();
    act(() => fireUpdate({ file: '/workspaces/repo/untouched.ts' }));
    await settle();
    const asked = mockGetFileDiff.mock.calls.map((c) => c[1]);
    expect(asked).not.toContain('/workspaces/repo/untouched.ts');
    expect(asked.every((file) => file === 'README.md')).toBe(true); // the first file, selected by default
  });

  it('takes a hook event without a file as a plain refresh', async () => {
    await mount();
    mockGetFiles.mockClear();
    act(() => fireUpdate({}));
    await settle();
    expect(mockGetFiles).toHaveBeenCalled();
  });
});
