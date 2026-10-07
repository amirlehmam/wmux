import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.fn();
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: sendMock } }],
  },
}));

import {
  observePtyData, getActivity, clearActivity, markSubagentStop, markAllAgentsDone,
  reportSubagent, endDeclaredSubagents, sanitizeSubagentText,
} from '../../src/main/claude-observer';
import { agentsForWorkspace, DECLARED_SUBAGENT_TTL_MS } from '../../src/renderer/store/agent-view';
import { SplitNode, SurfaceId, PaneId } from '../../src/shared/types';

// Issue #272: a background subagent kept working after its parent's turn ended,
// and the pane read "Idle". Declared subagents (hook agent_id, or
// `wmux report-subagent`) own their own lifecycle.
const surf = 'surf-sub-1' as SurfaceId;

function tree(): SplitNode {
  return { type: 'leaf', paneId: 'pane-1' as PaneId, surfaces: [{ id: surf, type: 'terminal' }], activeSurfaceIndex: 0 } as unknown as SplitNode;
}

function lines(now = Date.now()) {
  return agentsForWorkspace(tree(), { [surf]: getActivity(surf) as any }, new Map(), now);
}

describe('declared subagents (#272)', () => {
  beforeEach(() => { sendMock.mockClear(); clearActivity(surf); });

  it('the parent Stop does not end a declared background subagent', () => {
    reportSubagent(surf, { id: 'a1', name: 'planner', detail: 'calling create_file' });
    markAllAgentsDone(surf);
    const view = lines();
    expect(view.running).toBe(1);
    expect(view.lines[0]).toMatchObject({ name: 'planner', detail: 'calling create_file', done: false });
  });

  it('its own stop ends exactly that subagent', () => {
    reportSubagent(surf, { id: 'a1', name: 'planner' });
    reportSubagent(surf, { id: 'a2', name: 'Explore' });
    reportSubagent(surf, { id: 'a1', done: true });
    const agents = getActivity(surf)!.agents;
    expect(agents.find(a => a.id === 'a1')!.done).toBe(true);
    expect(agents.find(a => a.id === 'a2')!.done).toBe(false);
  });

  it('an id-less SubagentStop never finishes a declared subagent', () => {
    reportSubagent(surf, { id: 'a1', name: 'planner' });
    markSubagentStop(surf);
    expect(getActivity(surf)!.agents[0].done).toBe(false);
  });

  it('counts tool uses and shows the latest tool', () => {
    reportSubagent(surf, { id: 'a1', name: 'general-purpose' });
    reportSubagent(surf, { id: 'a1', detail: 'Read', toolUse: true });
    reportSubagent(surf, { id: 'a1', detail: 'Bash', toolUse: true });
    expect(lines().lines[0].detail).toBe('⚒2 · Bash');
  });

  it('a finish for an agent never seen starting draws nothing', () => {
    expect(reportSubagent(surf, { id: 'ghost', done: true })).toBe(false);
    expect(getActivity(surf)?.agents ?? []).toHaveLength(0);
  });

  it('rejects an empty id', () => {
    expect(reportSubagent(surf, { id: '  ' })).toBe(false);
  });

  it('SessionEnd ends every declared subagent', () => {
    reportSubagent(surf, { id: 'a1' });
    reportSubagent(surf, { id: 'a2' });
    endDeclaredSubagents(surf);
    expect(getActivity(surf)!.agents.every(a => a.done)).toBe(true);
  });

  it('a screen repaint ("Running N agents") does not wipe declared subagents', () => {
    reportSubagent(surf, { id: 'a1', name: 'planner' });
    observePtyData(surf, 'Running 2 agents\n');
    expect(getActivity(surf)!.agents.map(a => a.id)).toEqual(['a1']);
  });

  it('declared lines replace screen-parsed ones for the same pane', () => {
    observePtyData(surf, '├─ Research the repo · 2 tool uses · 3k tokens\n');
    reportSubagent(surf, { id: 'a1', name: 'Explore' });
    expect(lines().lines.map(l => l.name)).toEqual(['Explore']);
  });

  it('a running subagent silent past the TTL is not drawn', () => {
    reportSubagent(surf, { id: 'a1', name: 'planner' });
    const later = Date.now() + DECLARED_SUBAGENT_TTL_MS + 1;
    expect(lines(later).running).toBe(0);
  });
});

describe('sanitizeSubagentText', () => {
  it('strips controls and bidi overrides, collapses whitespace, caps length', () => {
    expect(sanitizeSubagentText('  a\x1b[31m\tb‮c  ', 64)).toBe('a [31m b c');
    expect(sanitizeSubagentText('abcdef', 3)).toBe('abc');
    expect(sanitizeSubagentText('ab  cd', 3)).toBe('ab');
    expect(sanitizeSubagentText(42, 10)).toBe('');
  });
});
