import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneId, SurfaceId, WorkspaceId, WorkspaceInfo } from '../../src/shared/types';

// ─────────────────────────────────────────────────────────────────────────────
// The phone's Remote Console names a workspace the way the desktop does (#343):
// `__wmux_remoteRoster` carries the derived label. The CLI's answers do not —
// `list-workspaces` and `current-workspace` keep the stored title, which is what
// a script renames and matches on.
// ─────────────────────────────────────────────────────────────────────────────

// The xterm registry is not what is under test, and loading it needs a DOM.
vi.mock('../../src/renderer/hooks/useTerminal', () => ({
  surfaceTerminalRegistry: new Map(),
  showPaneNotice: () => {},
}));

import { useStore } from '../../src/renderer/store';
import { initPipeBridge } from '../../src/renderer/pipe-bridge';

const WS = 'ws-phone' as WorkspaceId;
const AGENT = 'surf-phone' as SurfaceId;
const workspace: WorkspaceInfo = {
  id: WS, title: 'Workspace 3', titleIsDefault: true, pinned: false, shell: 'pwsh', unreadCount: 0, cwd: 'C:\\repo',
  splitTree: { type: 'leaf', paneId: 'pane-phone' as PaneId, activeSurfaceIndex: 0, surfaces: [{ id: AGENT, type: 'terminal' }] },
};

interface Bridge {
  __wmux_remoteRoster: () => Array<{ workspaceTitle: string }>;
  __wmux_listWorkspaces: () => Array<{ title: string }>;
  __wmux_currentWorkspace: (workspaceId: string, surfaceId: string) => { title: string } | null;
}
const bridge = () => globalThis.window as unknown as Bridge;

function announce(title: string): void {
  useStore.setState((state) => ({
    terminalPrefs: { ...state.terminalPrefs, oscTitleWorkspaces: true },
    oscTitles: { [AGENT]: { title, at: 0 } },
  }));
}

beforeEach(() => {
  useStore.setState({ workspaces: [workspace], activeWorkspaceId: WS, agentIdentities: {}, agentDetections: {} });
  useStore.getState().setAgentState({ surfaceId: AGENT, state: 'working' });
  (globalThis as Record<string, unknown>).window = {};
  initPipeBridge();
});

describe('workspace names over the pipe bridge', () => {
  it('gives the phone the name the desktop shows', () => {
    announce('✳ Fix login bug');
    expect(bridge().__wmux_remoteRoster().map((e) => e.workspaceTitle)).toEqual(['Fix login bug']);
  });

  it('gives the phone the same name on every spinner frame', () => {
    // main sends a phone the roster only when rosterChangeKey changes, and the
    // key includes workspaceTitle.
    const names = ['◐', '◑', '◒', '◓', '⠋', '✳'].map((glyph) => {
      announce(`${glyph} Fix login bug`);
      return bridge().__wmux_remoteRoster()[0]?.workspaceTitle;
    });
    expect(new Set(names)).toEqual(new Set(['Fix login bug']));
  });

  it('keeps the stored title in the CLI\'s answers', () => {
    announce('✳ Fix login bug');
    expect(bridge().__wmux_listWorkspaces().map((w) => w.title)).toEqual(['Workspace 3']);
    expect(bridge().__wmux_currentWorkspace(WS, AGENT)?.title).toBe('Workspace 3');
  });
});
