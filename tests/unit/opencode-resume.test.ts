import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
import { reportAgentSession, getAgentState, resetAgentState } from '../../src/main/agent-state';
import { handleAgentStateV2 } from '../../src/main/agent-state-rpc';
import { stampAgentSessionIds } from '../../src/main/agent-session-persistence';
import { isValidOpencodeSessionId } from '../../src/main/opencode-resume';
import { withClaudeResume, resetResumedSurfaces } from '../../src/renderer/hooks/claude-resume-command';
import { instantiateLayout } from '../../src/renderer/store/split-utils';
import type { SurfaceId, SplitNode } from '../../src/shared/types';

// Issue #290 — `opencode -s <id>` on restore, beside Claude (#186) and Codex (#261).
const OC = 'ses_ebee54158ffe0s9gKyn9y27AJz';
const OC2 = 'ses_ebee49dd7ffeliSGc2ATav2wlN';
const LOOP = 'ses_loop_964e1bb45a26f32c336b';
const CLAUDE = '11111111-2222-3333-4444-555555555555';
const SA = 'surf-11111111' as SurfaceId;
const SB = 'surf-22222222' as SurfaceId;
const leaf = (surfaces: any[]) => ({ type: 'leaf', paneId: 'pane-test', activeSurfaceIndex: 0, surfaces });
const terminal = (id: string, extra = {}) => ({ type: 'terminal', id, cwd: 'D:/same-project', ...extra });
function rpc(method: string, params: any): any {
  let response: any;
  expect(handleAgentStateV2(method, params, value => { response = value; }, (_code, message) => { throw new Error(message); })).toBe(true);
  return response;
}
function restore(surface: any, opencodeEnabled = true) {
  return withClaudeResume({ base: undefined, surfaceId: surface.id, claudeSessionId: surface.claudeSessionId,
    codexSessionId: surface.codexSessionId, opencodeSessionId: surface.opencodeSessionId, opencodeEnabled, enabled: true, codexEnabled: true });
}
beforeEach(() => { resetAgentState(); resetResumedSurfaces(); });

describe('OpenCode per-tab restore (#290)', () => {
  it('round-trips two tabs in one folder to their own sessions', () => {
    // The reporter's workaround, `opencode -c`, resumed the SAME session in both.
    rpc('pane.report_agent_session', { surfaceId: SA, sessionId: OC, provider: 'opencode' });
    rpc('pane.report_agent_session', { surfaceId: SB, sessionId: OC2, provider: 'opencode' });
    const saved = JSON.parse(JSON.stringify(stampAgentSessionIds(leaf([terminal(SA), terminal(SB)]))));
    resetAgentState();
    expect(restore(saved.surfaces[0])).toEqual([`opencode -s ${OC}`]);
    expect(restore(saved.surfaces[1])).toEqual([`opencode -s ${OC2}`]);
  });

  it('round-trips a loop session — a real, resumable id with an underscore', () => {
    expect(isValidOpencodeSessionId(LOOP)).toBe(true);
    rpc('pane.report_agent_session', { surfaceId: SA, sessionId: LOOP, provider: 'opencode' });
    const saved = JSON.parse(JSON.stringify(stampAgentSessionIds(leaf([terminal(SA)]))));
    resetAgentState();
    expect(restore(saved.surfaces[0])).toEqual([`opencode -s ${LOOP}`]);
  });

  it('never stamps an OpenCode id as a Claude session, though Claude\'s validator would accept it', () => {
    reportAgentSession(SA, { sessionId: OC, provider: 'opencode' });
    const s: any = stampAgentSessionIds(leaf([terminal(SA)])).surfaces[0];
    expect(s.claudeSessionId).toBeUndefined();
    expect(s.codexSessionId).toBeUndefined();
    expect(s.opencodeSessionId).toBe(OC);
  });

  it('switching the tab from OpenCode to Claude clears the OpenCode handle', () => {
    reportAgentSession(SA, { sessionId: OC, provider: 'opencode' });
    const first = stampAgentSessionIds(leaf([terminal(SA)]));
    reportAgentSession(SA, { sessionId: CLAUDE });
    const s: any = stampAgentSessionIds(first).surfaces[0];
    expect(s.opencodeSessionId).toBeUndefined();
    expect(s.claudeSessionId).toBe(CLAUDE);
  });

  it('refuses ids that are not OpenCode session ids', () => {
    expect(isValidOpencodeSessionId(CLAUDE)).toBe(false);
    expect(isValidOpencodeSessionId('ses_abc; calc')).toBe(false);
    rpc('pane.report_agent_session', { surfaceId: SA, sessionId: 'ses_x && calc', provider: 'opencode' });
    expect(getAgentState(SA)?.sessionId).toBeNull();
    expect(restore(terminal(SA, { opencodeSessionId: 'ses_x && calc' }))).toBeUndefined();
  });

  it('is opt-in, and resumes once, after the shell setup', () => {
    expect(restore(terminal(SA, { opencodeSessionId: OC }), false)).toBeUndefined();
    const options = { base: ['activate-env'], surfaceId: SA, claudeSessionId: undefined, enabled: true,
      opencodeSessionId: OC, opencodeEnabled: true };
    expect(withClaudeResume(options)).toEqual(['activate-env', `opencode -s ${OC}`]);
    expect(withClaudeResume(options)).toBe(options.base);
  });

  it('types nothing when a tab carries two providers\' handles', () => {
    expect(restore(terminal(SA, { opencodeSessionId: OC, claudeSessionId: CLAUDE }))).toBeUndefined();
  });

  it('keeps the handle while a restored OpenCode has not reported yet', () => {
    const tree = leaf([terminal(SA, { opencodeSessionId: OC })]);
    expect((stampAgentSessionIds(tree).surfaces[0] as any).opencodeSessionId).toBe(OC);
  });

  it('forgets a session OpenCode exited, but only that one', () => {
    reportAgentSession(SA, { sessionId: OC2, provider: 'opencode' });
    expect(rpc('pane.release_opencode_session', { surfaceId: SA, sessionId: OC }).released).toBe(false);
    const saved = stampAgentSessionIds(leaf([terminal(SA)]));
    expect(rpc('pane.release_opencode_session', { surfaceId: SA, sessionId: OC2 }).released).toBe(true);
    expect((stampAgentSessionIds(saved).surfaces[0] as any).opencodeSessionId).toBeUndefined();
  });

  it('a session report alone does not claim the pane is idle', () => {
    reportAgentSession(SA, { sessionId: OC, provider: 'opencode' });
    expect(getAgentState(SA)?.state).toBe('unknown');
  });

  it('a layout preset does not carry a session handle into new tabs', () => {
    const template = leaf([terminal(SA, { opencodeSessionId: OC })]) as unknown as SplitNode;
    const tree: any = instantiateLayout(template);
    expect(tree.surfaces[0].opencodeSessionId).toBeUndefined();
  });
});
