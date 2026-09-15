// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceInfo, WorkspaceId, PaneId, SurfaceId } from '../../src/shared/types';
import type { AgentIdentitySnapshot, DeclaredAgentSnapshot, DetectionSnapshot } from '../../src/renderer/store/agent-rollup';
import { rollupAgents, workspaceAgentState } from '../../src/renderer/store/agent-rollup';
import WorkspaceRow from '../../src/renderer/components/Sidebar/WorkspaceRow';

const store = create(() => ({
  sidebarPrefs: { activeTabIndicator: 'leftRail' },
  appearancePrefs: { uiMode: 'classic' },
  surfaceProgress: {},
  agentMeta: new Map(),
  agentIdentities: {} as Record<string, AgentIdentitySnapshot>,
  agentDetections: {} as Record<string, DetectionSnapshot>,
}));
vi.mock('../../src/renderer/store', () => ({ get useStore() { return store; } }));
vi.mock('../../src/renderer/i18n', () => ({ useT: () => (_key: string, fallback: string) => fallback }));

const workspace: WorkspaceInfo = {
  id: 'ws-1' as WorkspaceId, title: 'Remote', pinned: false, shell: 'pwsh', unreadCount: 0,
  shellState: 'idle',
  splitTree: {
    type: 'leaf', paneId: 'pane-1' as PaneId, activeSurfaceIndex: 0,
    surfaces: ['a', 'b', 'c'].map(id => ({ id: id as SurfaceId, type: 'terminal' as const, title: id })),
  },
};
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  store.setState({ agentIdentities: {}, agentDetections: {} });
});

function render(states: Record<string, DeclaredAgentSnapshot> = {}, overrides: Partial<WorkspaceInfo> = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(React.createElement(WorkspaceRow, {
    workspace: { ...workspace, ...overrides }, isActive: false,
    onSelect: () => {}, onClose: () => {}, agentStates: states,
    hookActivity: {}, claudeActivity: {},
  })));
}
function expectStatus(text: string, status: string, dot: string) {
  expect(container.querySelector('.workspace-row__status')?.textContent).toBe(text);
  expect(container.querySelector('.workspace-row__status')?.className.trim()).toBe(
    `workspace-row__status${status ? ` workspace-row__status--${status}` : ''}`);
  expect(container.querySelector('.workspace-row__state-dot')?.className.trim()).toBe(
    `workspace-row__state-dot${dot ? ` workspace-row__state-dot--${dot}` : ''}`);
}

describe('workspace status shares the roster state (#235)', () => {
  it('updates the mounted row for a detected working remote tab without hook reports', () => {
    render();
    expectStatus('Idle', 'done', 'idle');
    act(() => store.setState({ agentDetections: {
      a: { agent: 'claude', state: 'working' },
      b: { agent: null, state: 'unknown' }, c: { agent: null, state: 'unknown' },
      elsewhere: { agent: 'claude', state: 'blocked' },
    } }));
    expectStatus('Running…', 'working', 'running');
    const rollup = rollupAgents([workspace], {}, 0, {}, store.getState().agentDetections);
    expect(rollup.byWorkspace[workspace.id]).toEqual(rollup.totals);
    expect(workspaceAgentState(rollup.totals)).toBe('working');
  });

  it('prioritizes blocked tabs over working tabs and counts only this workspace', () => {
    store.setState({ agentDetections: {
      a: { agent: 'claude', state: 'working' },
      b: { agent: 'claude', state: 'blocked' }, c: { agent: 'claude', state: 'blocked' },
      elsewhere: { agent: 'claude', state: 'blocked' },
    } });
    render();
    expectStatus('Needs you · 2', 'blocked', 'blocked');
  });

  it.each(['working', 'idle', 'blocked'] as const)('declared %s wins over conflicting detection', state => {
    store.setState({ agentDetections: { a: { agent: 'claude', state: state === 'blocked' ? 'working' : 'blocked' } } });
    render({ a: { state } });
    const expected = {
      working: ['Running…', 'working', 'running'],
      idle: ['Idle', 'idle', 'idle'], blocked: ['Needs you', 'blocked', 'blocked'],
    }[state];
    expectStatus(expected[0], expected[1], expected[2]);
  });

  it('keeps an identified but unmatched agent unknown even with a running shell', () => {
    store.setState({ agentIdentities: { a: { kind: 'claude', source: 'command' } },
      agentDetections: { a: { agent: null, state: 'unknown' } } });
    render({}, { shellState: 'running' });
    expectStatus('Unknown', '', '');
  });

  it('keeps screen-identified agents unknown until a state is detected', () => {
    store.setState({ agentDetections: { a: { agent: 'claude', state: 'unknown' } } });
    render();
    expectStatus('Unknown', '', '');
    act(() => store.setState({ agentDetections: { a: { agent: 'claude', state: 'idle' } } }));
    expectStatus('Idle', 'idle', 'idle');
  });

  it('retains shell behavior for unmatched screens with no identified agent', () => {
    store.setState({ agentDetections: { a: { agent: null, state: 'unknown' } } });
    render({}, { shellState: 'running' });
    expectStatus('Running', 'running', 'running');
  });

  it.each(['idle', 'running'] as const)('honors the manual %s override over blocked detection', statusOverride => {
    store.setState({ agentDetections: { a: { agent: 'claude', state: 'blocked' } } });
    render({}, { statusOverride });
    expectStatus(statusOverride === 'idle' ? 'Idle' : 'Running', statusOverride, statusOverride);
  });
});
