// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceInfo, WorkspaceId, PaneId, SurfaceId } from '../../src/shared/types';
import WorkspaceRow from '../../src/renderer/components/Sidebar/WorkspaceRow';

const store = create(() => ({
  sidebarPrefs: { activeTabIndicator: 'leftRail', fullWidthTitles: false, wrapTitles: false },
  appearancePrefs: { uiMode: 'classic' },
  surfaceProgress: {},
  agentMeta: new Map(),
  agentIdentities: {},
  agentDetections: {},
}));

vi.mock('../../src/renderer/store', () => ({ get useStore() { return store; } }));
vi.mock('../../src/renderer/i18n', () => ({ useT: () => (_key: string, fallback: string) => fallback }));

const baseWorkspace: WorkspaceInfo = {
  id: 'ws-1' as WorkspaceId,
  title: 'My Project',
  pinned: false,
  shell: 'pwsh',
  unreadCount: 0,
  splitTree: {
    type: 'leaf',
    paneId: 'pane-1' as PaneId,
    activeSurfaceIndex: 0,
    surfaces: [{ id: 's-1' as SurfaceId, type: 'terminal', title: 'term' }],
  },
};

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = '';
});

function render(workspace: WorkspaceInfo): void {
  act(() => {
    root!.render(
      React.createElement(WorkspaceRow, { workspace, isActive: false, onSelect: () => {}, onClose: () => {} }),
    );
  });
}

const pill = () => container.querySelector<HTMLElement>('.workspace-row__badge--indicator');

describe('WorkspaceRow indicator pill', () => {
  it('shows the text, with the colour as a custom property', () => {
    render({ ...baseWorkspace, indicator: { text: 'SSH', color: '#f59e0b' } });
    expect(pill()?.textContent).toBe('SSH');
    expect(pill()?.getAttribute('title')).toBe('SSH');
    expect(pill()?.style.getPropertyValue('--indicator-color')).toBe('#f59e0b');
  });

  it('leaves the colour to the stylesheet (theme accent) when none was given', () => {
    render({ ...baseWorkspace, indicator: { text: 'SSH' } });
    expect(pill()).not.toBeNull();
    expect(pill()?.style.getPropertyValue('--indicator-color')).toBe('');
  });

  it('renders nothing without an indicator', () => {
    render(baseWorkspace);
    expect(pill()).toBeNull();
  });

  it('never changes the workspace title', () => {
    render({ ...baseWorkspace, indicator: { text: 'SSH' } });
    expect(container.textContent).toContain('My Project');
    expect(container.textContent).not.toContain('[SSH]');
  });

  it('renders in fullWidthTitles mode too', () => {
    store.setState({ sidebarPrefs: { activeTabIndicator: 'leftRail', fullWidthTitles: true, wrapTitles: false } });
    render({ ...baseWorkspace, indicator: { text: 'SSH' } });
    expect(pill()?.textContent).toBe('SSH');
  });
});
