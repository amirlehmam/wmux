import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
import { reportAgent, reportAgentSession, releaseAgent, clearAgentState, resetAgentState } from '../../src/main/agent-state';
import { stampAgentSessionIds } from '../../src/main/agent-session-persistence';
import { pruneDeadClaudeSessions } from '../../src/main/claude-resume';
import { readFileSync } from 'fs';
import { resolve } from 'path';
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

  it('forgets a conversation the user exited before the shell died', () => {
    reportAgentSession(SA, { sessionId: A });
    const saved = stampAgentSessionIds(leaf([terminal(SA)]));
    releaseAgent(SA);
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

describe('a pane whose process was killed under its agent', () => {
  // A Microsoft Store update of PowerShell terminates every packaged pwsh.exe
  // at once. Each PTY exit used to release its pane's handle, so the next
  // autosave wrote every Claude and Codex tab as a plain shell, and the restore
  // after the reboot brought exactly that back.
  it('keeps the Claude id through the PTY exit', () => {
    reportAgentSession(SA, { sessionId: A });
    const saved = stampAgentSessionIds(leaf([terminal(SA)]));
    clearAgentState(SA);
    expect(stampAgentSessionIds(saved).surfaces[0].claudeSessionId).toBe(A);
  });

  it('keeps it on a tree that never carried it', () => {
    // The live tree holds no stamped id (only the persisted copy does), so the
    // handle has to come from agent-state, not from the tree being saved.
    reportAgentSession(SA, { sessionId: A });
    clearAgentState(SA);
    expect(stampAgentSessionIds(leaf([terminal(SA)])).surfaces[0].claudeSessionId).toBe(A);
  });

  it('keeps a Codex handle under its own provider', () => {
    reportAgentSession(SA, { sessionId: B, provider: 'codex' });
    clearAgentState(SA);
    const out = stampAgentSessionIds(leaf([terminal(SA, { claudeSessionId: A })]));
    expect(out.surfaces[0].codexSessionId).toBe(B);
    expect(out.surfaces[0].claudeSessionId).toBeUndefined();
  });

  it('keeps a restored id whose agent had reported a state but no session', () => {
    reportAgent(SA, { runDelta: 1 });
    clearAgentState(SA);
    expect(stampAgentSessionIds(leaf([terminal(SA, { claudeSessionId: A })])).surfaces[0].claudeSessionId).toBe(A);
  });

  it('takes a new report in the respawned shell over the kept handle', () => {
    reportAgentSession(SA, { sessionId: A });
    clearAgentState(SA);
    reportAgentSession(SA, { sessionId: B });
    expect(stampAgentSessionIds(leaf([terminal(SA)])).surfaces[0].claudeSessionId).toBe(B);
  });

  it('forgets the kept handle once a later agent in that tab is released', () => {
    reportAgentSession(SA, { sessionId: A });
    clearAgentState(SA);
    reportAgent(SA, { runDelta: 1 });
    releaseAgent(SA);
    expect('claudeSessionId' in stampAgentSessionIds(leaf([terminal(SA, { claudeSessionId: A })])).surfaces[0]).toBe(false);
  });
});

/**
 * #428: the hook in a WSL pane reports with `host: 'wsl'`, and that mark has to
 * reach session.json next to the id, or the startup prune (which reads only the
 * Windows transcripts) throws the id away and restore types nothing.
 */
describe('a Claude session reported from a WSL pane', () => {
  it('is saved with its host, and survives a prune against the Windows transcripts', () => {
    reportAgentSession(SA, { sessionId: A, host: 'wsl' });
    const saved = stampAgentSessionIds(leaf([terminal(SA)]));
    expect(saved.surfaces[0]).toMatchObject({ claudeSessionId: A, claudeSessionHost: 'wsl' });
    const { tree, dropped } = pruneDeadClaudeSessions(saved, new Set([B]));
    expect(dropped).toBe(0);
    expect(tree.surfaces[0].claudeSessionId).toBe(A);
  });

  it('keeps its host through a PTY exit', () => {
    reportAgentSession(SA, { sessionId: A, host: 'wsl' });
    clearAgentState(SA);
    expect(stampAgentSessionIds(leaf([terminal(SA)])).surfaces[0].claudeSessionHost).toBe('wsl');
  });

  it('loses the mark when the tab reports a Windows Claude', () => {
    reportAgentSession(SA, { sessionId: A, host: 'wsl' });
    const saved = stampAgentSessionIds(leaf([terminal(SA)]));
    reportAgentSession(SA, { sessionId: B });
    expect('claudeSessionHost' in stampAgentSessionIds(saved).surfaces[0]).toBe(false);
  });

  it('ignores a host value it does not know', () => {
    reportAgentSession(SA, { sessionId: A, host: 'mars' });
    expect('claudeSessionHost' in stampAgentSessionIds(leaf([terminal(SA)])).surfaces[0]).toBe(false);
  });

  it('drops id and mark together when the user exits Claude', () => {
    reportAgentSession(SA, { sessionId: A, host: 'wsl' });
    const saved = stampAgentSessionIds(leaf([terminal(SA)]));
    releaseAgent(SA);
    expect(stampAgentSessionIds(saved).surfaces[0]).toEqual(terminal(SA));
  });

  it('is forwarded by the hook handler in index.ts', () => {
    const source = readFileSync(resolve(__dirname, '../../src/main/index.ts'), 'utf8');
    const call = source.slice(source.indexOf('reportAgentSession(params.surfaceId as SurfaceId, {'));
    expect(call.slice(0, call.indexOf('});'))).toContain("host: params.host === 'wsl' ? 'wsl' : undefined");
  });
});
