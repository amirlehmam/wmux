import { afterEach, describe, expect, it } from 'vitest';
import type { PaneId, SplitNode, SurfaceId, WorkspaceId, WorkspaceInfo } from '../../src/shared/types';
import { useStore } from '../../src/renderer/store';
import { officeLayoutKey } from '../../src/renderer/components/Hub/office-layout';
import {
  getStoredWorkspaceLabel,
  selectWorkspaceLabel,
} from '../../src/renderer/components/SplitPane/use-osc-title';

// ─────────────────────────────────────────────────────────────────────────────
// Every place that names a workspace asks the store for the same label the
// sidebar shows (#343). getWorkspaceLabel has its own tests; these pin the
// store-facing half the non-React call sites share: the pref gate, the title
// map and what marks a pane as an agent are read from the one place.
// ─────────────────────────────────────────────────────────────────────────────

type Labelled = Pick<WorkspaceInfo, 'title' | 'titleIsDefault' | 'splitTree'>;

function terminalLeaf(id: SurfaceId): SplitNode {
  return { type: 'leaf', paneId: `pane-${id}` as PaneId, activeSurfaceIndex: 0, surfaces: [{ id, type: 'terminal' }] };
}

const surfaceId = 'surf-label' as SurfaceId;
const tree = terminalLeaf(surfaceId);
const named: Labelled = { title: 'Workspace 3', titleIsDefault: true, splitTree: tree };

// A [shell | agent] workspace: the shell pane comes first in tree order.
const shellId = 'surf-shell' as SurfaceId;
const agentId = 'surf-agent' as SurfaceId;
const split: Labelled = {
  title: 'Workspace 3',
  titleIsDefault: true,
  splitTree: { type: 'branch', direction: 'horizontal', ratio: 0.5, children: [terminalLeaf(shellId), terminalLeaf(agentId)] },
};

function announce(title: string, oscTitleWorkspaces = true): void {
  useStore.setState((state) => ({
    terminalPrefs: { ...state.terminalPrefs, oscTitleWorkspaces },
    oscTitles: { [surfaceId]: { title, at: 0 } },
  }));
}

describe('workspace label from the store', () => {
  const before = useStore.getState();
  afterEach(() => useStore.setState({
    terminalPrefs: before.terminalPrefs,
    oscTitles: before.oscTitles,
    agentIdentities: before.agentIdentities,
    agentStates: before.agentStates,
  }));

  it('gives the window title a workspace wmux named, to a caller outside React', () => {
    announce('Fix login bug');
    expect(getStoredWorkspaceLabel(named)).toBe('Fix login bug');
    expect(selectWorkspaceLabel(useStore.getState(), named)).toBe('Fix login bug');
  });

  it('keeps the stored name when the sidebar pref is off', () => {
    announce('Fix login bug', false);
    expect(getStoredWorkspaceLabel(named)).toBe('Workspace 3');
  });

  it('keeps a name somebody chose', () => {
    announce('Fix login bug');
    expect(getStoredWorkspaceLabel({ ...named, titleIsDefault: undefined })).toBe('Workspace 3');
  });

  // Claude Code animates a glyph at the start of its title while it works:
  // `◐ Hello greeting reply` through the frames to `✳ Hello greeting reply`.
  describe('across spinner frames', () => {
    const FRAMES = ['◐', '◑', '◒', '◓', '⠋', '✳'].map((g) => `${g} Hello greeting reply`);

    it('keeps one label, for a component and a caller outside React alike', () => {
      for (const frame of FRAMES) {
        announce(frame);
        expect(selectWorkspaceLabel(useStore.getState(), named)).toBe('Hello greeting reply');
        expect(getStoredWorkspaceLabel(named)).toBe('Hello greeting reply');
      }
    });

    it('falls back to the stored name on a title that is only a glyph', () => {
      announce('✳');
      expect(selectWorkspaceLabel(useStore.getState(), named)).toBe('Workspace 3');
      expect(getStoredWorkspaceLabel(named)).toBe('Workspace 3');
    });

    it("keeps the Hub's layout key, so the office is not rebuilt every frame", () => {
      const id = 'ws-label' as WorkspaceId;
      const agents = [{ surfaceId, workspaceId: id }];
      const keys = FRAMES.map((frame) => {
        announce(frame);
        // What HubView hands officeLayoutKey: each workspace under its label.
        return officeLayoutKey([{ id, title: getStoredWorkspaceLabel(named) }], agents);
      });
      expect(new Set(keys).size).toBe(1);
    });
  });

  describe('with an agent in a later pane', () => {
    function titleBoth(kind: string | null): void {
      useStore.setState((state) => ({
        terminalPrefs: { ...state.terminalPrefs, oscTitleWorkspaces: true },
        oscTitles: { [shellId]: { title: 'MINGW64:/c/repo', at: 0 }, [agentId]: { title: 'Fix login bug', at: 0 } },
        agentIdentities: { [agentId]: { kind, source: 'command' } },
      }));
    }

    it('names the workspace after the agent pane, not the shell before it', () => {
      titleBoth('claude');
      expect(selectWorkspaceLabel(useStore.getState(), split)).toBe('Fix login bug');
      expect(getStoredWorkspaceLabel(split)).toBe('Fix login bug');
    });

    it('takes the shell in tree order when the identity names no agent', () => {
      titleBoth(null);
      expect(selectWorkspaceLabel(useStore.getState(), split)).toBe('MINGW64:/c/repo');
      expect(getStoredWorkspaceLabel(split)).toBe('MINGW64:/c/repo');
    });
  });

  // A `claude` typed by hand into an ordinary pane usually has no identity: the
  // shell integrations report only `ssh`, and the process probe sweeps only
  // while ssh detection is awake. What Claude Code does send is its hooks, and
  // every one of them but SessionEnd carries the session id main records.
  describe('with an agent known only from its hooks', () => {
    const sessionId = '0b7c5a52-6a7e-4f43-9f0e-2c1d7e3b9a10';
    function titleBothWithoutIdentity(): void {
      useStore.setState((state) => ({
        terminalPrefs: { ...state.terminalPrefs, oscTitleWorkspaces: true },
        oscTitles: { [shellId]: { title: 'MINGW64:/c/repo', at: 0 }, [agentId]: { title: 'Fix login bug', at: 0 } },
        agentIdentities: {},
        agentStates: {},
      }));
    }

    it('names the workspace after the pane whose agent reported a session', () => {
      titleBothWithoutIdentity();
      // SessionStart: main registers the pane idle, then records its session.
      useStore.getState().setAgentState({ surfaceId: agentId, state: 'idle', sessionId });
      expect(selectWorkspaceLabel(useStore.getState(), split)).toBe('Fix login bug');
      expect(getStoredWorkspaceLabel(split)).toBe('Fix login bug');
    });

    it('keeps that pane through every turn, whatever the agent is doing', () => {
      titleBothWithoutIdentity();
      for (const state of ['idle', 'working', 'blocked', 'idle', 'unknown'] as const) {
        // `unknown` too: a working claim past its trust window reads unknown
        // while the session it belongs to is still recorded.
        useStore.getState().setAgentState({ surfaceId: agentId, state, sessionId });
        expect(getStoredWorkspaceLabel(split)).toBe('Fix login bug');
      }
    });

    it('falls back to tree order once the session ends', () => {
      titleBothWithoutIdentity();
      useStore.getState().setAgentState({ surfaceId: agentId, state: 'idle', sessionId });
      // What main broadcasts when it forgets the pane: SessionEnd, the PTY
      // exiting, `wmux release-agent`.
      useStore.getState().setAgentState({ surfaceId: agentId, state: 'unknown', sessionId: null });
      expect(getStoredWorkspaceLabel(split)).toBe('MINGW64:/c/repo');
    });

    it('does not count a declared state with no session behind it', () => {
      titleBothWithoutIdentity();
      useStore.getState().setAgentState({ surfaceId: agentId, state: 'working' });
      expect(getStoredWorkspaceLabel(split)).toBe('MINGW64:/c/repo');
    });
  });
});
