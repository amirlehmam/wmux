import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
import { reportAgent, reportAgentSession, releaseAgent, clearAgentState, resetAgentState } from '../../src/main/agent-state';
import { stampAgentSessionIds } from '../../src/main/agent-session-persistence';
import type { SurfaceId } from '../../src/shared/types';

const A = '11111111-2222-3333-4444-555555555555';
const B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SA = 'surf-11111111' as SurfaceId;
const leaf = (surfaces: any[]) => ({ type: 'leaf', paneId: 'pane-test', activeSurfaceIndex: 0, surfaces });
const terminal = (id: string, extra = {}) => ({ type: 'terminal', id, ...extra });

beforeEach(() => { resetAgentState(); });

describe('Claude handle across an autosave', () => {
  // The first auto-save after a restart runs before most restored panes have
  // reported — a tab that was never shown has no PTY at all. Dropping the id
  // there is what lost every unopened Claude conversation on the next restart.
  it('keeps the restored id while the pane has not reported', () => {
    const tree = leaf([terminal(SA, { claudeSessionId: A })]);
    expect(stampAgentSessionIds(tree).surfaces[0].claudeSessionId).toBe(A);
  });

  it('keeps it when the pane reports a state but no session yet', () => {
    reportAgent(SA, { runDelta: 1 });
    const tree = leaf([terminal(SA, { claudeSessionId: A })]);
    expect(stampAgentSessionIds(tree).surfaces[0].claudeSessionId).toBe(A);
  });

  it('takes the reported id over the restored one', () => {
    reportAgentSession(SA, { sessionId: B });
    const tree = leaf([terminal(SA, { claudeSessionId: A })]);
    expect(stampAgentSessionIds(tree).surfaces[0].claudeSessionId).toBe(B);
  });

  it('forgets a conversation the user exited', () => {
    reportAgentSession(SA, { sessionId: A });
    const saved = stampAgentSessionIds(leaf([terminal(SA)]));
    expect(saved.surfaces[0].claudeSessionId).toBe(A);
    expect(releaseAgent(SA)).toBe(true);
    expect('claudeSessionId' in stampAgentSessionIds(saved).surfaces[0]).toBe(false);
  });

  it('forgets it when the PTY exited under it', () => {
    reportAgentSession(SA, { sessionId: A });
    const saved = stampAgentSessionIds(leaf([terminal(SA)]));
    clearAgentState(SA);
    expect('claudeSessionId' in stampAgentSessionIds(saved).surfaces[0]).toBe(false);
  });

  it('gives the tab to another provider that reports', () => {
    reportAgentSession(SA, { sessionId: B, provider: 'codex' });
    const out = stampAgentSessionIds(leaf([terminal(SA, { claudeSessionId: A })]));
    expect(out.surfaces[0].claudeSessionId).toBeUndefined();
    expect(out.surfaces[0].codexSessionId).toBe(B);
  });
});
