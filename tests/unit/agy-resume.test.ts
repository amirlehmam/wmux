import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
import { reportAgentSession, getAgentState, releaseAgyAtPrompt, resetAgentState } from '../../src/main/agent-state';
import { handleAgentStateV2 } from '../../src/main/agent-state-rpc';
import { stampAgentSessionIds } from '../../src/main/agent-session-persistence';
import { isValidAgyConversationId } from '../../src/main/agy-resume';
import { AgentIdentityTracker } from '../../src/main/agent-identity';
import { identifyAgentCommand } from '../../src/main/agent-argv';
import { withClaudeResume, resetResumedSurfaces } from '../../src/renderer/hooks/claude-resume-command';
import { instantiateLayout } from '../../src/renderer/store/split-utils';
import type { SurfaceId, SplitNode } from '../../src/shared/types';

// `agy --conversation <id>` on restore, beside Claude (#186), Codex (#261) and
// OpenCode (#290). The id is agy's `conversationId`, reported by wmux's agy plugin.
const AGY = '46b139cc-e5cf-4c37-887b-188e6274d14a';
const AGY2 = 'a6116a3e-18f1-4fc6-93cf-75ab92f13b56';
const CLAUDE = '11111111-2222-3333-4444-555555555555';
const OC = 'ses_ebee54158ffe0s9gKyn9y27AJz';
const SA = 'surf-11111111' as SurfaceId;
const SB = 'surf-22222222' as SurfaceId;
const leaf = (surfaces: any[]) => ({ type: 'leaf', paneId: 'pane-test', activeSurfaceIndex: 0, surfaces });
const terminal = (id: string, extra = {}) => ({ type: 'terminal', id, cwd: 'D:/same-project', ...extra });
function rpc(method: string, params: any): any {
  let response: any;
  expect(handleAgentStateV2(method, params, value => { response = value; }, (_code, message) => { throw new Error(message); })).toBe(true);
  return response;
}
function restore(surface: any, agyEnabled = true) {
  return withClaudeResume({ base: undefined, surfaceId: surface.id, claudeSessionId: surface.claudeSessionId,
    codexSessionId: surface.codexSessionId, opencodeSessionId: surface.opencodeSessionId,
    agySessionId: surface.agySessionId, agyEnabled, enabled: true, codexEnabled: true, opencodeEnabled: true });
}
const savedAgy = (tree: unknown) => (stampAgentSessionIds(tree) as any).surfaces[0].agySessionId;
beforeEach(() => { resetAgentState(); resetResumedSurfaces(); });

describe('agy per-tab restore', () => {
  it('round-trips two tabs in one folder to their own conversations', () => {
    rpc('pane.report_agent_session', { surfaceId: SA, sessionId: AGY, provider: 'agy' });
    rpc('pane.report_agent_session', { surfaceId: SB, sessionId: AGY2, provider: 'agy' });
    const saved = JSON.parse(JSON.stringify(stampAgentSessionIds(leaf([terminal(SA), terminal(SB)]))));
    resetAgentState();
    expect(restore(saved.surfaces[0])).toEqual([`agy --conversation ${AGY}`]);
    expect(restore(saved.surfaces[1])).toEqual([`agy --conversation ${AGY2}`]);
  });

  it('never stamps an agy id as a Claude session, though Claude\'s validator would accept it', () => {
    reportAgentSession(SA, { sessionId: AGY, provider: 'agy' });
    const s: any = stampAgentSessionIds(leaf([terminal(SA, { claudeSessionId: CLAUDE })])).surfaces[0];
    expect(s.claudeSessionId).toBeUndefined();
    expect(s.agySessionId).toBe(AGY);
  });

  it('refuses ids that are not agy conversation ids', () => {
    expect(isValidAgyConversationId(OC)).toBe(false);
    expect(isValidAgyConversationId(`${AGY}; calc`)).toBe(false);
    expect(isValidAgyConversationId('abcdefgh')).toBe(false);
    rpc('pane.report_agent_session', { surfaceId: SA, sessionId: `${AGY} && calc`, provider: 'agy' });
    expect(getAgentState(SA)?.sessionId).toBeNull();
    expect(restore(terminal(SA, { agySessionId: `${AGY} && calc` }))).toBeUndefined();
  });

  it('is opt-in, and resumes once, after the shell setup', () => {
    expect(restore(terminal(SA, { agySessionId: AGY }), false)).toBeUndefined();
    const options = { base: ['activate-env'], surfaceId: SA, claudeSessionId: undefined, enabled: true,
      agySessionId: AGY, agyEnabled: true };
    expect(withClaudeResume(options)).toEqual(['activate-env', `agy --conversation ${AGY}`]);
    expect(withClaudeResume(options)).toBe(options.base);
  });

  // #302: a pane whose own startup command IS the launcher gets the resume
  // merged into it, flags kept; one that launches another agent gets nothing.
  it('merges into the pane\'s own agy launcher, and never types into another agent', () => {
    const own = { base: ['agy --model fast'], surfaceId: SA, claudeSessionId: undefined, enabled: true,
      agySessionId: AGY, agyEnabled: true };
    expect(withClaudeResume(own)).toEqual([`agy --model fast --conversation ${AGY}`]);
    const other = { ...own, surfaceId: SB, base: ['codex'] };
    expect(withClaudeResume(other)).toBe(other.base);
  });

  it('types nothing when a tab carries two providers\' handles', () => {
    expect(restore(terminal(SA, { agySessionId: AGY, claudeSessionId: CLAUDE }))).toBeUndefined();
    expect(restore(terminal(SB, { agySessionId: AGY, opencodeSessionId: OC }))).toBeUndefined();
  });

  it('keeps the handle while a restored agy has not reported yet', () => {
    // A resumed conversation reports at its first message, not when it opens.
    expect(savedAgy(leaf([terminal(SA, { agySessionId: AGY })]))).toBe(AGY);
  });

  it('a session report alone does not claim the pane is idle', () => {
    reportAgentSession(SA, { sessionId: AGY, provider: 'agy' });
    expect(getAgentState(SA)?.state).toBe('unknown');
  });

  it('a layout preset does not carry a conversation into new tabs', () => {
    const template = leaf([terminal(SA, { agySessionId: AGY })]) as unknown as SplitNode;
    const tree: any = instantiateLayout(template);
    expect(tree.surfaces[0].agySessionId).toBeUndefined();
  });
});

// agy has no session-end hook: the shell coming back to its prompt is its exit.
describe('agy exit, seen as the shell returning to its prompt', () => {
  it('forgets the conversation the user quit', () => {
    reportAgentSession(SA, { sessionId: AGY, provider: 'agy' });
    const saved = stampAgentSessionIds(leaf([terminal(SA)]));
    expect(releaseAgyAtPrompt(SA, true)).toBe(true);
    expect(savedAgy(saved)).toBeUndefined();
  });

  it('forgets a resumed conversation quit before its first message', () => {
    // It never reported, so there is no record — only the restored id, and the
    // fact that the command that just ended was agy.
    const tree = leaf([terminal(SA, { agySessionId: AGY })]);
    expect(releaseAgyAtPrompt(SA, true)).toBe(true);
    expect(savedAgy(tree)).toBeUndefined();
  });

  it('leaves a restored id alone at a prompt that did not follow agy', () => {
    // The pane's first prompt comes before the restore types its command.
    const tree = leaf([terminal(SA, { agySessionId: AGY })]);
    expect(releaseAgyAtPrompt(SA, false)).toBe(false);
    expect(savedAgy(tree)).toBe(AGY);
  });

  it('never releases another provider\'s session', () => {
    reportAgentSession(SA, { sessionId: CLAUDE });
    expect(releaseAgyAtPrompt(SA, true)).toBe(false);
    expect(getAgentState(SA)?.sessionId).toBe(CLAUDE);
  });

  it('a new agy run in the same tab is captured again after a release', () => {
    reportAgentSession(SA, { sessionId: AGY, provider: 'agy' });
    releaseAgyAtPrompt(SA, true);
    reportAgentSession(SA, { sessionId: AGY2, provider: 'agy' });
    expect(savedAgy(leaf([terminal(SA)]))).toBe(AGY2);
  });

  it('`agy` typed at a prompt is identified, so its exit can be recognised', () => {
    expect(identifyAgentCommand('agy')).toBe('agy');
    expect(identifyAgentCommand(`agy --conversation ${AGY}`)).toBe('agy');
    expect(identifyAgentCommand('agy-tools')).toBeNull();
  });

  it('a prompt report older than the running command is refused, so it cannot release it', () => {
    const tracker = new AgentIdentityTracker();
    tracker.reportCommand(SA, 'agy', 6);
    expect(tracker.clearReported(SA, 5)).toBe(false);
    expect(tracker.identify(SA)?.kind).toBe('agy');
    expect(tracker.clearReported(SA, 7)).toBe(true);
  });
});
