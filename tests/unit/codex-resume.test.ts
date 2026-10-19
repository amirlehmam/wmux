import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
import { reportAgent, reportAgentSession, getAgentState, releaseAgent, resetAgentState } from '../../src/main/agent-state';
import { handleAgentStateV2 } from '../../src/main/agent-state-rpc';
import { stampAgentSessionIds } from '../../src/main/agent-session-persistence';
import { isValidCodexSessionId } from '../../src/main/codex-resume';
import { withClaudeResume, resetResumedSurfaces } from '../../src/renderer/hooks/claude-resume-command';
import { instantiateLayout } from '../../src/renderer/store/split-utils';
import { CodexSessionTracker } from '../../src/cli/codex-session-tracker';
import type { SurfaceId, SplitNode } from '../../src/shared/types';

const A = '11111111-2222-3333-4444-555555555555';
const B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SA = 'surf-11111111' as SurfaceId;
const SB = 'surf-22222222' as SurfaceId;
const leaf = (surfaces: any[]) => ({ type: 'leaf', paneId: 'pane-test', activeSurfaceIndex: 0, surfaces });
const terminal = (id: string, extra = {}) => ({ type: 'terminal', id, cwd: 'D:/same-project', ...extra });
function rpc(method: string, params: any): any {
  let response: any;
  expect(handleAgentStateV2(method, params, value => { response = value; }, (_code, message) => { throw new Error(message); })).toBe(true);
  return response;
}
function restore(surface: any, codexEnabled = true, enabled = true) {
  return withClaudeResume({ base: undefined, surfaceId: surface.id, claudeSessionId: surface.claudeSessionId,
    codexSessionId: surface.codexSessionId, codexEnabled, enabled });
}
beforeEach(() => { resetAgentState(); resetResumedSurfaces(); });

describe('Codex per-tab restore', () => {
  it('round-trips exact conversations for two tabs sharing the same cwd', () => {
    for (const [surfaceId, sessionId] of [[SA, A], [SB, B]]) {
      const tracker = new CodexSessionTracker(id => rpc('pane.report_codex_session', { surfaceId, sessionId: id }));
      tracker.request(JSON.stringify({ id: 1, method: 'thread/start' }));
      tracker.response(JSON.stringify({ id: 1, result: { thread: { id: sessionId, ephemeral: false } } }));
      // A new thread is saved at its first turn: before that Codex has written nothing to resume.
      tracker.request(JSON.stringify({ id: 2, method: 'turn/start', params: { threadId: sessionId } }));
    }
    const saved = JSON.parse(JSON.stringify(stampAgentSessionIds(leaf([terminal(SA), terminal(SB)]))));
    resetAgentState(); // main process restarted
    expect(restore(saved.surfaces[0])).toEqual([`codex resume ${A}`]);
    expect(restore(saved.surfaces[1])).toEqual([`codex resume ${B}`]);
    expect(saved.surfaces.every((s: any) => !s.claudeSessionId)).toBe(true);
    expect(saved.surfaces.map((s: any) => s.cwd)).toEqual(['D:/same-project', 'D:/same-project']);
  });

  it('keeps Claude and Codex providers independent in a mixed workspace', () => {
    reportAgentSession(SA, { sessionId: A });
    reportAgentSession(SB, { sessionId: B, provider: 'codex' });
    const tree: any = stampAgentSessionIds({ type: 'split', children: [leaf([terminal(SA)]), leaf([terminal(SB)])] });
    expect(restore(tree.children[0].surfaces[0], false)).toEqual([`claude --resume ${A}`]);
    expect(restore(tree.children[1].surfaces[0], true, false)).toEqual([`codex resume ${B}`]);
  });

  it('does not launch Codex with its checkbox off, even when Claude restore is on', () => {
    expect(restore(terminal(SA, { codexSessionId: A }), false, true)).toBeUndefined();
    expect(restore(terminal(SA, { codexSessionId: A }))).toEqual([`codex resume ${A}`]);
  });

  it('resumes once on remount, and appends after shell setup', () => {
    const options = { base: ['activate-env'], surfaceId: SA, claudeSessionId: undefined,
      codexSessionId: A, enabled: false, codexEnabled: true };
    expect(withClaudeResume(options)).toEqual(['activate-env', `codex resume ${A}`]);
    expect(withClaudeResume(options)).toBe(options.base);
  });

  it('keeps the ID if autosave happens before the restored agent reports', () => {
    const tree = leaf([terminal(SA, { codexSessionId: A })]);
    expect(stampAgentSessionIds(tree).surfaces[0].codexSessionId).toBe(A);
  });

  it('forgets a deliberately exited conversation', () => {
    reportAgentSession(SA, { sessionId: A, provider: 'codex' });
    const saved = stampAgentSessionIds(leaf([terminal(SA)]));
    expect(rpc('pane.release_codex_session', { surfaceId: SA, sessionId: A }).released).toBe(true);
    expect(stampAgentSessionIds(saved).surfaces[0].codexSessionId).toBeUndefined();
  });

  it('does not let a delayed launcher exit remove the next session in the same tab', () => {
    reportAgentSession(SA, { sessionId: B, provider: 'codex' });
    expect(rpc('pane.release_codex_session', { surfaceId: SA, sessionId: A }).released).toBe(false);
    expect(getAgentState(SA)?.sessionId).toBe(B);
  });

  it('replaces a stale provider and leaves nonterminal surfaces alone', () => {
    reportAgentSession(SA, { sessionId: B });
    const saved = stampAgentSessionIds(leaf([terminal(SA, { codexSessionId: A }), { id: SB, type: 'browser' }]));
    expect(saved.surfaces[0].claudeSessionId).toBe(B);
    expect(saved.surfaces[0].codexSessionId).toBeUndefined();
    expect(saved.surfaces[1]).toEqual({ id: SB, type: 'browser' });
  });

  it('never clones a conversation through a reusable layout', () => {
    const tree = instantiateLayout(leaf([terminal(SA, { codexSessionId: A })]) as SplitNode);
    expect(tree.type === 'leaf' && tree.surfaces[0].codexSessionId).toBeUndefined();
  });

  it('refuses mixed provider IDs in an edited save', () => {
    expect(restore(terminal(SA, { codexSessionId: A, claudeSessionId: B }))).toBeUndefined();
  });

  it.each(['--dangerously-bypass-approvals-and-sandbox', 'abcdefgh; whoami', 'abcdefgh$(whoami)', 'a b c d e f g h', '../session', 'short', 'a'.repeat(129)])('rejects unsafe ID %s at capture and restore', id => {
    expect(isValidCodexSessionId(id)).toBe(false);
    reportAgentSession(SA, { sessionId: id, provider: 'codex' });
    expect(getAgentState(SA)?.sessionId).toBeNull();
    expect(restore(terminal(SA, { codexSessionId: id }))).toBeUndefined();
  });

  it('does not misreport a captured Codex conversation as idle', () => {
    reportAgentSession(SA, { sessionId: A, provider: 'codex' });
    expect(getAgentState(SA)?.state).toBe('unknown');
    reportAgent(SA, { runDepth: 1 });
    expect(getAgentState(SA)?.state).toBe('working');
  });

  it('reports the application identity from the captured session', () => {
    reportAgentSession(SA, { sessionId: A, provider: 'codex' });
    expect(rpc('pane.agent_state', { surfaceId: SA }).state).toMatchObject({ agent: 'codex', agentSource: 'session', sessionId: A });
  });

  it('rejects unknown providers without overwriting the current session', () => {
    reportAgentSession(SA, { sessionId: A, provider: 'codex' });
    expect(reportAgentSession(SA, { sessionId: B, provider: 'other' })).toBeNull();
    expect(getAgentState(SA)?.sessionId).toBe(A);
  });

  // A restored tab whose thread Codex does not have (one left empty, never
  // written) failed `codex resume` on every restart: it never reported, so
  // nothing released it, and silence keeps a restored id.
  it('forgets a restored id Codex cannot open — only that id, in that tab', () => {
    const tree = leaf([terminal(SA, { codexSessionId: A }), terminal(SB, { codexSessionId: B })]);
    expect(rpc('pane.codex_session_missing', { surfaceId: SA, sessionId: A }).accepted).toBe(true);
    const saved: any = stampAgentSessionIds(tree);
    expect(saved.surfaces[0].codexSessionId).toBeUndefined();
    expect(saved.surfaces[1].codexSessionId).toBe(B);
    expect(restore(saved.surfaces[0])).toBeUndefined();
  });

  it('keeps a different id than the one Codex refused', () => {
    rpc('pane.codex_session_missing', { surfaceId: SA, sessionId: B });
    expect(stampAgentSessionIds(leaf([terminal(SA, { codexSessionId: A })])).surfaces[0].codexSessionId).toBe(A);
  });

  it('a later report in the tab wins over an earlier refusal', () => {
    rpc('pane.codex_session_missing', { surfaceId: SA, sessionId: A });
    reportAgentSession(SA, { sessionId: A, provider: 'codex' });
    expect(stampAgentSessionIds(leaf([terminal(SA)])).surfaces[0].codexSessionId).toBe(A);
  });

  it('refuses a missing-session note that is not a session id', () => {
    expect(rpc('pane.codex_session_missing', { surfaceId: SA, sessionId: 'x; rm -rf /' }).accepted).toBe(false);
  });


});
