// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { PaneId, SurfaceId, WorkspaceId, WorkspaceInfo } from '../../src/shared/types';
import { useStore } from '../../src/renderer/store';
import { useWorkspaceLabels } from '../../src/renderer/components/SplitPane/use-osc-title';

// ─────────────────────────────────────────────────────────────────────────────
// useWorkspaceLabels runs in App, the Hub, the palette and the agent roster. A
// spinner frame in an agent's title must not hand any of them a new map, or the
// App root re-renders with it about five times a second while an agent works.
// ─────────────────────────────────────────────────────────────────────────────

const surfaceId = 'surf-spin' as SurfaceId;
const workspaces: readonly WorkspaceInfo[] = [{
  id: 'ws-spin' as WorkspaceId, title: 'Workspace 1', titleIsDefault: true, pinned: false, shell: 'pwsh', unreadCount: 0,
  splitTree: { type: 'leaf', paneId: 'pane-spin' as PaneId, activeSurfaceIndex: 0, surfaces: [{ id: surfaceId, type: 'terminal' }] },
}];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const seen: ReadonlyMap<WorkspaceId, string>[] = [];
function Probe(): null {
  seen.push(useWorkspaceLabels(workspaces));
  return null;
}

function announce(title: string): void {
  act(() => useStore.setState((state) => ({
    terminalPrefs: { ...state.terminalPrefs, oscTitleWorkspaces: true },
    oscTitles: { [surfaceId]: { title, at: 0 } },
  })));
}

let root: ReturnType<typeof createRoot> | undefined;
const before = useStore.getState();
afterEach(() => {
  act(() => root?.unmount());
  seen.length = 0;
  useStore.setState({ terminalPrefs: before.terminalPrefs, oscTitles: before.oscTitles });
});

describe('useWorkspaceLabels across spinner frames', () => {
  it('keeps the same map, and does not re-render, while only the glyph moves', () => {
    announce('◐ Hello greeting reply');
    root = createRoot(document.createElement('div'));
    act(() => root!.render(React.createElement(Probe)));
    const first = seen.at(-1);
    expect(first?.get(workspaces[0].id)).toBe('Hello greeting reply');
    const renders = seen.length;

    for (const glyph of ['◑', '◒', '◓', '⠋', '✳']) announce(`${glyph} Hello greeting reply`);

    expect(seen.length).toBe(renders);
    expect(seen.at(-1)).toBe(first);
  });

  it('hands out a new map when the name itself changes', () => {
    announce('✳ Hello greeting reply');
    root = createRoot(document.createElement('div'));
    act(() => root!.render(React.createElement(Probe)));
    const first = seen.at(-1);

    announce('✳ Fix login bug');

    expect(seen.at(-1)).not.toBe(first);
    expect(seen.at(-1)?.get(workspaces[0].id)).toBe('Fix login bug');
  });
});
