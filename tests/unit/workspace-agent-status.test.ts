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

function render(
  states: Record<string, DeclaredAgentSnapshot> = {},
  overrides: Partial<WorkspaceInfo> = {},
  history: Pick<React.ComponentProps<typeof WorkspaceRow>, 'hookActivity' | 'claudeActivity'> = {},
) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const update = (nextStates: Record<string, DeclaredAgentSnapshot>) => {
    act(() => root!.render(React.createElement(WorkspaceRow, {
      workspace: { ...workspace, ...overrides }, isActive: false,
      onSelect: () => {}, onClose: () => {}, agentStates: nextStates,
      hookActivity: {}, claudeActivity: {}, ...history,
    })));
  };
  update(states);
  return update;
}
/** `base` plus its BEM modifier, or `base` alone when the chain yielded none. */
function withModifier(base: string, modifier: string): string {
  return modifier ? `${base} ${base}--${modifier}` : base;
}

function expectStatus(text: string, status: string, dot: string) {
  expect(container.querySelector('.workspace-row__status')?.textContent).toBe(text);
  expect(container.querySelector('.workspace-row__status')?.className.trim())
    .toBe(withModifier('workspace-row__status', status));
  expect(container.querySelector('.workspace-row__state-dot')?.className.trim())
    .toBe(withModifier('workspace-row__state-dot', dot));
}

describe('workspace status shares the roster state (#235)', () => {
  it('updates Codex detail rows and the provider-neutral summary through a whole turn', () => {
    render({ a: { state: 'unknown' }, b: { state: 'unknown' }, c: { state: 'unknown' } });
    const detail = () => [...container.querySelectorAll('.workspace-row__sessions .workspace-row__agent-detail')]
      .map(el => el.textContent);
    expect(detail()).toEqual([]);
    act(() => store.setState({ agentDetections: {
      a: { agent: 'codex', state: 'working' },
      b: { agent: 'codex', state: 'idle' }, c: { agent: 'codex', state: 'idle' },
    } }));
    expectStatus('1/3 running', 'working', 'running');
    expect(detail()).toEqual(['Running…', 'Idle', 'Idle']);
    act(() => store.setState({ agentDetections: {
      a: { agent: 'codex', state: 'idle' },
      b: { agent: 'codex', state: 'idle' }, c: { agent: 'codex', state: 'idle' },
    } }));
    expectStatus('Idle', 'idle', 'idle');
    expect(detail()).toEqual(['Idle', 'Idle', 'Idle']);
  });
  it('removes released pi rows despite retained tool history and restores shell status', () => {
    const now = Date.now();
    const update = render({
      a: { state: 'idle', sessionId: '/sessions/a.jsonl', sessionProvider: 'pi' },
      b: { state: 'idle', sessionId: '/sessions/b.jsonl', sessionProvider: 'pi' },
    }, { shellState: 'running' }, {
      hookActivity: { a: { lastTool: 'Edit', toolCount: 1, lastSeen: now } },
      claudeActivity: { b: { agents: [], lastTool: 'Bash', lastUpdate: now, isDone: false } },
    });
    expect(container.querySelectorAll('.workspace-row__session')).toHaveLength(2);
    update({ a: { state: 'unknown', sessionId: null }, b: { state: 'unknown', sessionId: null } });
    expect(container.querySelectorAll('.workspace-row__session')).toHaveLength(0);
    expectStatus('Running', 'running', 'running');
  });

  it('preserves first-observer skill selection while ignoring released panes', () => {
    const update = render({ a: { state: 'idle' }, b: { state: 'idle' } }, {}, {
      claudeActivity: {
        a: { agents: [], activeSkill: null },
        b: { agents: [], activeSkill: 'debugging' },
      },
    });
    expect(container.querySelector('.workspace-row__skill')).toBeNull();
    update({ a: { state: 'unknown', sessionId: null }, b: { state: 'idle' } });
    expect(container.querySelector('.workspace-row__skill')?.textContent).toBe('debugging');
  });

  it('shows genuinely present unknown agents as silent, not idle', () => {
    store.setState({ agentIdentities: {
      a: { kind: 'pi', source: 'command' }, b: { kind: 'codex', source: 'command' },
    } });
    render({ a: { state: 'unknown' } }, { shellState: 'running' });
    expect([...container.querySelectorAll('.workspace-row__sessions .workspace-row__agent-detail')]
      .map(el => el.textContent)).toEqual(['reports no state', 'reports no state']);
    expect(container.querySelectorAll('.workspace-row__session--idle')).toHaveLength(0);
    expectStatus('Running', 'running', 'running');
  });

  it('includes silent agents in mixed-session totals without labeling their detail idle', () => {
    store.setState({ agentIdentities: { b: { kind: 'codex', source: 'command' } } });
    render({ a: { state: 'working' } });
    expectStatus('1/2 running', 'working', 'running');
    expect([...container.querySelectorAll('.workspace-row__sessions .workspace-row__agent-detail')]
      .map(el => el.textContent)).toEqual(['Running…', 'reports no state']);
  });

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

  // An agent that is PRESENT but silent is the case the declared-state protocol
  // exists for (issue #128): `unknown` means "we know an agent is here and it
  // has not said what it is doing". It must fall THROUGH to the heuristics — a
  // row cannot go blank-dotted just because the roster learned a pane exists.
  it('an identified but silent agent falls through to the shell, dot included', () => {
    store.setState({ agentIdentities: { a: { kind: 'claude', source: 'command' } },
      agentDetections: { a: { agent: null, state: 'unknown' } } });
    render({}, { shellState: 'running' });
    expectStatus('Running', 'running', 'running');
  });

  // The invariant, stated as a parity: learning that a silent agent EXISTS must
  // not change one pixel of the row. Anything a silent agent does change, it
  // changed by overriding a finer signal it knows nothing about.
  it.each(['running', 'interrupted', 'idle', undefined] as const)(
    'a silent agent renders identically to no agent at all (shell: %s)', shellState => {
      render({}, { shellState });
      const before = container.innerHTML;
      act(() => store.setState({
        agentIdentities: { a: { kind: 'claude', source: 'command' } },
        agentDetections: { a: { agent: 'claude', state: 'unknown' } },
      }));
      expect(container.innerHTML).toBe(before);
    });

  it('a screen-identified agent stays on the shell until a state is detected', () => {
    store.setState({ agentDetections: { a: { agent: 'claude', state: 'unknown' } } });
    render({}, { shellState: 'running' });
    expectStatus('Running', 'running', 'running');
    act(() => store.setState({ agentDetections: { a: { agent: 'claude', state: 'idle' } } }));
    // An idle CLAIM does outrank the shell — that is priority 2, unchanged.
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
