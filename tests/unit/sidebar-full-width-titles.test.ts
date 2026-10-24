// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceInfo, WorkspaceId, PaneId, SurfaceId } from '../../src/shared/types';
import type { HookActivityEntry } from '../../src/renderer/store/claude-session-view';
import { DEFAULT_SIDEBAR_PREFS } from '../../src/renderer/store/settings-slice';
import WorkspaceRow from '../../src/renderer/components/Sidebar/WorkspaceRow';

// The tool-call odometer, the unread badge and the hover-only close button's
// reserved slot sat on the title line, so a narrow sidebar truncated the title
// to make room for them. An opt-in sidebar pref moves the odometer and badge to
// the status line and keeps the close button out of the layout until hover,
// giving the title the row's full width.

const store = create(() => ({
  sidebarPrefs: { ...DEFAULT_SIDEBAR_PREFS },
  appearancePrefs: { uiMode: 'trace' },
  surfaceProgress: {},
  agentMeta: new Map(),
  agentIdentities: {},
  agentDetections: {},
}));
vi.mock('../../src/renderer/store', () => ({ get useStore() { return store; } }));
vi.mock('../../src/renderer/i18n', () => ({ useT: () => (_key: string, fallback: string) => fallback }));

const workspace: WorkspaceInfo = {
  id: 'ws-1' as WorkspaceId, title: 'A long descriptive workspace title', pinned: false, shell: 'pwsh',
  unreadCount: 3, shellState: 'idle',
  splitTree: {
    type: 'leaf', paneId: 'pane-1' as PaneId, activeSurfaceIndex: 0,
    surfaces: [{ id: 'a' as SurfaceId, type: 'terminal' as const, title: 'a' }],
  },
};
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  store.setState({ sidebarPrefs: { ...DEFAULT_SIDEBAR_PREFS }, appearancePrefs: { uiMode: 'trace' } });
});

const busy: Record<string, HookActivityEntry> = { a: { lastTool: 'Read', toolCount: 42, lastSeen: Date.now() } };

function render(unreadCount = workspace.unreadCount, hookActivity = busy) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(React.createElement(WorkspaceRow, {
    workspace: { ...workspace, unreadCount }, isActive: true,
    onSelect: () => {}, onClose: () => {},
    hookActivity, claudeActivity: {}, agentStates: {},
  })));
}

const CSS = readFileSync(join(__dirname, '..', '..', 'src/renderer/styles/sidebar.css'), 'utf8');
const row = () => container.querySelector('.workspace-row')!;
const header = () => container.querySelector('.workspace-row__header')!;
const statusLine = () => container.querySelector('.workspace-row__status-line');

describe('full-width workspace titles', () => {
  it('is off by default, so the shipped title line is unchanged', () => {
    expect(DEFAULT_SIDEBAR_PREFS.fullWidthTitles).toBe(false);
    render();
    expect(header().querySelector('.workspace-row__odometer')?.textContent).toBe('42');
    expect(header().querySelector('.unread-badge')?.textContent).toBe('3');
    expect(statusLine()).toBeNull();
    expect(row().classList.contains('workspace-row--full-width-title')).toBe(false);
  });

  it('moves the odometer and the unread badge after the status text when on', () => {
    store.setState({ sidebarPrefs: { ...DEFAULT_SIDEBAR_PREFS, fullWidthTitles: true } });
    render();
    expect(header().querySelector('.workspace-row__odometer')).toBeNull();
    expect(header().querySelector('.unread-badge')).toBeNull();
    // The title and the close button are all that is left on the title line.
    expect(header().querySelector('.workspace-row__title')?.textContent).toBe(workspace.title);
    expect(header().querySelector('.workspace-row__close')).not.toBeNull();

    const line = statusLine()!;
    expect([...line.children].map((el) => el.className.split(' ')[0]))
      .toEqual(['workspace-row__status', 'workspace-row__odometer', 'unread-badge']);
    expect(line.querySelector('.workspace-row__odometer')?.textContent).toBe('42');
    expect(line.querySelector('.unread-badge')?.textContent).toBe('3');
    expect(row().classList.contains('workspace-row--full-width-title')).toBe(true);
  });

  it('keeps the close button out of the title line until the row is hovered', () => {
    expect(CSS).toMatch(/\.workspace-row--full-width-title:not\(:hover\) \.workspace-row__close \{\s*display: none;/);
    // The 16px button set the title line's height, so the line keeps it.
    expect(CSS).toMatch(/\.workspace-row--full-width-title \.workspace-row__header \{\s*min-height: 16px;/);
  });

  it('leaves the status line as the bare status element when nothing is counted', () => {
    store.setState({
      sidebarPrefs: { ...DEFAULT_SIDEBAR_PREFS, fullWidthTitles: true },
      appearancePrefs: { uiMode: 'classic' },
    });
    render(0, {});
    expect([...statusLine()!.children].map((el) => el.className.split(' ')[0]))
      .toEqual(['workspace-row__status']);
  });
});
