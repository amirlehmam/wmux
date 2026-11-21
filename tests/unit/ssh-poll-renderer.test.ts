// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DiffPane from '../../src/renderer/components/Diff/DiffPane';
import { GitQueryContext, useGitQuery, type GitQueryScope } from '../../src/renderer/components/Git/git-api';
import type { GitViewRequest } from '../../src/shared/git-view';

/** Which renderer requests say they are polls: the timer's, never a click's. */

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  // jsdom has no element scrolling; the pane scrolls to the top when a file is picked.
  (Element.prototype as any).scrollTo = () => undefined;
  (globalThis as any).CSS = { escape: (s: string) => s };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  document.body.innerHTML = '';
  delete (window as any).wmux;
  vi.useRealTimers();
});

describe('useGitQuery', () => {
  function Probe({ file, refresh, own }: Readonly<{ file: string; refresh: number; own?: GitQueryScope }>): null {
    useGitQuery<string>({ op: 'workingDiff', cwd: '/r', worktree: '/r', file, section: 'unstaged' }, refresh, own);
    return null;
  }

  it('sends poll only for a refresh the pane marked as its timer\'s, never for a new request', async () => {
    const view = vi.fn().mockResolvedValue({ ok: true, data: 'd' });
    (window as any).wmux = { git: { view } };
    const polled = { current: false };
    const render = (file: string, refresh: number) => act(async () => {
      root!.render(
        h(GitQueryContext.Provider, { value: { surfaceId: 'surf-1', polled } }, h(Probe, { file, refresh })),
      );
    });
    const lastRequest = (): GitViewRequest => view.mock.calls.at(-1)![0] as GitViewRequest;

    await render('a.txt', 0);                       // mounted: a person opened it
    expect(lastRequest()).not.toHaveProperty('poll');
    polled.current = true;
    await render('a.txt', 1);                       // the timer's tick
    expect(lastRequest()).toMatchObject({ file: 'a.txt', surfaceId: 'surf-1', poll: true });
    await render('b.txt', 2);                       // a click on another file, even in the same tick
    expect(lastRequest()).toMatchObject({ file: 'b.txt' });
    expect(lastRequest()).not.toHaveProperty('poll');
    polled.current = false;
    await render('b.txt', 3);                       // a Refresh or an agent's edit
    expect(lastRequest()).not.toHaveProperty('poll');
    expect(view).toHaveBeenCalledTimes(4);
  });

  it('takes the flag from its own argument when the pane asks above its provider', async () => {
    const view = vi.fn().mockResolvedValue({ ok: true, data: 'd' });
    (window as any).wmux = { git: { view } };
    const own = { surfaceId: 'surf-own', polled: { current: true } };
    await act(async () => { root!.render(h(Probe, { file: 'a', refresh: 0, own })); });
    await act(async () => { root!.render(h(Probe, { file: 'a', refresh: 1, own })); });
    expect(view.mock.calls[0][0]).not.toHaveProperty('poll');
    expect(view.mock.calls[1][0]).toMatchObject({ surfaceId: 'surf-own', poll: true });
  });

  it('adds the pane\'s surface to a request that names none, keeps one it names, and adds nothing without a scope', async () => {
    const view = vi.fn().mockResolvedValue({ ok: true, data: 'd' });
    (window as any).wmux = { git: { view } };
    function Named(): null {
      useGitQuery<string>({ op: 'repo', cwd: '/x', surfaceId: 'surf-2' });
      useGitQuery<string>({ op: 'repo', cwd: '/y' });
      return null;
    }
    await act(async () => { root!.render(h(GitQueryContext.Provider, { value: { surfaceId: 'surf-1' } }, h(Named))); });
    expect(view.mock.calls.map(([r]) => r)).toEqual([
      { op: 'repo', cwd: '/x', surfaceId: 'surf-2' },
      { op: 'repo', cwd: '/y', surfaceId: 'surf-1' },
    ]);
    view.mockClear();
    await act(async () => { root!.render(h(Named)); });
    expect(view.mock.calls.map(([r]) => r)).toEqual([
      { op: 'repo', cwd: '/x', surfaceId: 'surf-2' },
      { op: 'repo', cwd: '/y' },
    ]);
  });

  it('never sends poll without a provider', async () => {
    const view = vi.fn().mockResolvedValue({ ok: true, data: 'd' });
    (window as any).wmux = { git: { view } };
    await act(async () => { root!.render(h(Probe, { file: 'a', refresh: 0 })); });
    await act(async () => { root!.render(h(Probe, { file: 'a', refresh: 1 })); });
    expect(view).toHaveBeenCalledTimes(2);
    for (const [request] of view.mock.calls) expect(request).not.toHaveProperty('poll');
  });
});

describe('DiffPane', () => {
  it('asks as a person on its first pass and as a poll on every timer pass after it', async () => {
    vi.useFakeTimers();
    const getFiles = vi.fn().mockResolvedValue({ files: [{ path: 'a.txt', status: 'modified', additions: 1, deletions: 0 }] });
    const getFileDiff = vi.fn().mockResolvedValue({ diff: '' });
    (window as any).wmux = { diff: { getFiles, getFileDiff, onUpdate: vi.fn().mockReturnValue(() => {}) } };
    await act(async () => { root!.render(h(DiffPane, { surfaceId: 'surf-1', cwd: '/r' })); });
    expect(getFiles).toHaveBeenLastCalledWith('/r', undefined, 'surf-1');
    expect(getFileDiff).toHaveBeenCalled();
    expect(getFileDiff.mock.calls.every((c) => c.length === 4)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(getFiles).toHaveBeenLastCalledWith('/r', undefined, 'surf-1', true);
    expect(getFileDiff).toHaveBeenLastCalledWith('/r', 'a.txt', undefined, 'surf-1', true);
  });

  it('asks as a person again after the tab was hidden and shown', async () => {
    vi.useFakeTimers();
    const getFiles = vi.fn().mockResolvedValue({ files: [] });
    (window as any).wmux = { diff: { getFiles, getFileDiff: vi.fn().mockResolvedValue({ diff: '' }), onUpdate: vi.fn().mockReturnValue(() => {}) } };
    await act(async () => { root!.render(h(DiffPane, { surfaceId: 'surf-2', cwd: '/r' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(getFiles).toHaveBeenLastCalledWith('/r', undefined, 'surf-2', true);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    const callsWhileHidden = getFiles.mock.calls.length;
    hidden.mockReturnValue(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(getFiles.mock.calls.length).toBe(callsWhileHidden + 1);
    expect(getFiles).toHaveBeenLastCalledWith('/r', undefined, 'surf-2');
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(getFiles).toHaveBeenLastCalledWith('/r', undefined, 'surf-2', true);
    hidden.mockRestore();
  });
});
