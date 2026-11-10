import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { createWorkspaceSlice, WorkspaceSlice } from '../../src/renderer/store/workspace-slice';
import { createSurfaceSlice, SurfaceSlice } from '../../src/renderer/store/surface-slice';
import { createLeaf } from '../../src/renderer/store/split-utils';
import { withClaudeResume, resetResumedSurfaces } from '../../src/renderer/hooks/claude-resume-command';
import { WorkspaceId, PaneId, SplitNode, SurfaceRef } from '../../src/shared/types';

type TestStore = WorkspaceSlice & SurfaceSlice & { agentStates: Record<string, unknown> };

function makeStore() {
  return create<TestStore>()((...args) => ({
    ...createWorkspaceSlice(...args),
    ...createSurfaceSlice(...args),
    agentStates: {},
  }));
}

const CLAUDE_ID = '0b9c6a52-1f3e-4d7a-9c1b-2e5f8a7d6c40';
const CODEX_ID = '019a1b2c-3d4e-7f50-8a9b-0c1d2e3f4a5b';

describe('Ctrl+Shift+T reopens the agent session of the most recently closed tab', () => {
  let useStore: ReturnType<typeof makeStore>;
  let workspaceId: WorkspaceId;
  let paneId: PaneId;

  beforeEach(() => {
    useStore = makeStore();
    workspaceId = useStore.getState().createWorkspace({ title: 'WS', splitTree: createLeaf() });
    paneId = (useStore.getState().workspaces[0].splitTree as Extract<SplitNode, { type: 'leaf' }>).paneId;
    // The reopen stack is module state shared across tests: drain it.
    while (useStore.getState().reopenClosedSurface(workspaceId, paneId)) { /* drain */ }
    resetResumedSurfaces();
  });

  function surface(id: string): SurfaceRef {
    const leaf = useStore.getState().workspaces[0].splitTree as Extract<SplitNode, { type: 'leaf' }>;
    return leaf.surfaces.find((s) => s.id === id)!;
  }

  function closeAgentTab(state: unknown): string {
    const id = useStore.getState().addSurface(workspaceId, paneId, 'terminal')!;
    useStore.setState({ agentStates: { [id]: state } });
    useStore.getState().closeSurface(workspaceId, paneId, id);
    return id;
  }

  it('stamps the live Claude session onto the reopened tab and resumes it with the restore pref off', () => {
    closeAgentTab({ state: 'idle', sessionId: CLAUDE_ID, sessionProvider: 'claude' });
    const reopened = useStore.getState().reopenClosedSurface(workspaceId, paneId)!;
    expect(surface(reopened).claudeSessionId).toBe(CLAUDE_ID);

    const commands = withClaudeResume({ base: undefined, surfaceId: reopened, claudeSessionId: CLAUDE_ID, enabled: false });
    expect(commands).toEqual([`claude --resume ${CLAUDE_ID}`]);
  });

  it('maps a non-Claude provider to its own field', () => {
    closeAgentTab({ state: 'idle', sessionId: CODEX_ID, sessionProvider: 'codex' });
    const reopened = useStore.getState().reopenClosedSurface(workspaceId, paneId)!;
    expect(surface(reopened).codexSessionId).toBe(CODEX_ID);
    expect(surface(reopened).claudeSessionId).toBeUndefined();
  });

  it('only the most recent close keeps its session: an older agent tab reopens as a plain shell', () => {
    closeAgentTab({ state: 'idle', sessionId: CLAUDE_ID, sessionProvider: 'claude' });
    const plain = useStore.getState().addSurface(workspaceId, paneId, 'terminal')!;
    useStore.getState().closeSurface(workspaceId, paneId, plain);

    const first = useStore.getState().reopenClosedSurface(workspaceId, paneId)!;
    expect(surface(first).claudeSessionId).toBeUndefined();
    const second = useStore.getState().reopenClosedSurface(workspaceId, paneId)!;
    expect(surface(second).claudeSessionId).toBeUndefined();
  });

  it('does not resume an agent that already exited (released session)', () => {
    const id = useStore.getState().addSurface(workspaceId, paneId, 'terminal')!;
    useStore.getState().updateSurface(workspaceId, paneId, id, { claudeSessionId: CLAUDE_ID });
    useStore.setState({ agentStates: { [id]: { state: 'unknown', sessionId: null } } });
    useStore.getState().closeSurface(workspaceId, paneId, id);
    const reopened = useStore.getState().reopenClosedSurface(workspaceId, paneId)!;
    expect(surface(reopened).claudeSessionId).toBeUndefined();
  });

  it('carries a restored tab’s stamped handle when its agent has not reported yet', () => {
    const id = useStore.getState().addSurface(workspaceId, paneId, 'terminal')!;
    useStore.getState().updateSurface(workspaceId, paneId, id, { codexSessionId: CODEX_ID });
    useStore.getState().closeSurface(workspaceId, paneId, id);
    const reopened = useStore.getState().reopenClosedSurface(workspaceId, paneId)!;
    expect(surface(reopened).codexSessionId).toBe(CODEX_ID);
  });

  it('a plain reopened tab is not force-resumed', () => {
    const plain = useStore.getState().addSurface(workspaceId, paneId, 'terminal')!;
    useStore.getState().closeSurface(workspaceId, paneId, plain);
    const reopened = useStore.getState().reopenClosedSurface(workspaceId, paneId)!;
    // Even handed an id, the pref still gates a surface nothing forced.
    expect(withClaudeResume({ base: undefined, surfaceId: reopened, claudeSessionId: CLAUDE_ID, enabled: false })).toBeUndefined();
  });
});
