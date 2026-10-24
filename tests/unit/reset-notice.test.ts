// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ResetNotice from '../../src/renderer/components/Terminal/ResetNotice';
import { useStore } from '../../src/renderer/store';
import { dispatchResetNotice } from '../../src/renderer/utils/alt-screen-owner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Issue #357: the notice a reset that kept the alternate screen shows. It is a
 * live region, and a screen reader announces a live region's CHANGES: a node
 * mounted already holding its text is often not read at all. So the region
 * stays mounted and only its text comes and goes.
 */
const SURFACE = 'surf-notice';
let root: Root;
let host: HTMLDivElement;

const region = () => host.querySelector<HTMLElement>('[role="status"]');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  useStore.setState({ language: 'en' });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(ResetNotice, { surfaceId: SURFACE })));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('ResetNotice (issue #357)', () => {
  it('mounts an empty polite live region before there is anything to say', () => {
    const node = region();
    expect(node).not.toBeNull();
    expect(node?.getAttribute('aria-live')).toBe('polite');
    expect(node?.textContent).toBe('');
  });

  it('fills the SAME region when a reset keeps the screen, naming the shortcut', () => {
    const before = region();
    act(() => dispatchResetNotice({ surfaceId: SURFACE, until: 105_000 }));
    expect(region()).toBe(before);
    expect(region()?.textContent).toContain('Kept the alternate screen');
    expect(region()?.textContent).toContain('Ctrl+Shift+R');
  });

  it('empties it again when told to hide, and when the force window ends', () => {
    act(() => dispatchResetNotice({ surfaceId: SURFACE, until: 105_000 }));
    act(() => dispatchResetNotice({ surfaceId: SURFACE, until: null }));
    expect(region()?.textContent).toBe('');

    act(() => dispatchResetNotice({ surfaceId: SURFACE, until: 105_000 }));
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(region()).not.toBeNull();
    expect(region()?.textContent).toBe('');
  });

  it("ignores another surface's notice", () => {
    act(() => dispatchResetNotice({ surfaceId: 'surf-other', until: 105_000 }));
    expect(region()?.textContent).toBe('');
  });
});
