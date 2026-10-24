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

// The state dot, the tool-call odometer, the unread badge and the hover-only
// close button's reserved slot sat on the title line, so a narrow sidebar
// truncated the title to make room for them. An opt-in sidebar pref moves all
// four to a line of their own above the title, so the title and the status
// text each get the row's full width.

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
const topLine = () => container.querySelector('.workspace-row__top-line');
const classesOf = (el: Element) => [...el.children].map((child) => child.className.split(' ')[0]);

describe('full-width workspace titles', () => {
  it('is off by default, so the shipped title line is unchanged', () => {
    expect(DEFAULT_SIDEBAR_PREFS.fullWidthTitles).toBe(false);
    render();
    expect(header().querySelector('.workspace-row__odometer')?.textContent).toBe('42');
    expect(header().querySelector('.unread-badge')?.textContent).toBe('3');
    expect(header().querySelector('.workspace-row__state-dot')).not.toBeNull();
    expect(header().querySelector('.workspace-row__close')).not.toBeNull();
    expect(topLine()).toBeNull();
  });

  it('moves the dot, the counts and the close button above the title when on', () => {
    store.setState({ sidebarPrefs: { ...DEFAULT_SIDEBAR_PREFS, fullWidthTitles: true } });
    render();
    expect(classesOf(topLine()!))
      .toEqual(['workspace-row__state-dot', 'workspace-row__via-ping', 'workspace-row__odometer', 'unread-badge', 'workspace-row__close']);
    expect(topLine()!.querySelector('.workspace-row__odometer')?.textContent).toBe('42');
    expect(topLine()!.querySelector('.unread-badge')?.textContent).toBe('3');
    // The title and the status text each have a line to themselves.
    expect(classesOf(header())).toEqual(['workspace-row__title']);
    expect(header().textContent).toBe(workspace.title);
    expect(row().querySelector(':scope > .workspace-row__status')?.textContent).toBe('Reading file...');
    expect(topLine()!.nextElementSibling).toBe(header());
  });

  it('keeps the top line one height whatever it holds', () => {
    // A fixed height, so a badge arriving or the close button showing on hover
    // never changes the row's height; the dot pushes the rest to the right.
    expect(CSS).toMatch(/\.workspace-row__top-line \{[^}]*\sheight: calc\(12px \* var\(--sidebar-text-scale, 1\)\);/);
    expect(CSS).toMatch(/\.workspace-row__top-line > \.workspace-row__state-dot \{\s*margin-right: auto;/);
  });

  it('keeps the dot and the close button on the top line when nothing is counted', () => {
    store.setState({
      sidebarPrefs: { ...DEFAULT_SIDEBAR_PREFS, fullWidthTitles: true },
      appearancePrefs: { uiMode: 'classic' },
    });
    render(0, {});
    expect(classesOf(topLine()!)).toEqual(['workspace-row__state-dot', 'workspace-row__close']);
  });
});
