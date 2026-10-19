import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
import { reportAgentSession, getAgentState, resetAgentState } from '../../src/main/agent-state';
import { handleAgentStateV2 } from '../../src/main/agent-state-rpc';
import { stampAgentSessionIds } from '../../src/main/agent-session-persistence';
import { isValidOmpSessionId, pruneDeadOmpSessions } from '../../src/main/omp-resume';
import { quoteOmpArg } from '../../src/renderer/hooks/agent-launcher';
import { withClaudeResume, resetResumedSurfaces } from '../../src/renderer/hooks/claude-resume-command';
import { instantiateLayout } from '../../src/renderer/store/split-utils';
import type { SurfaceId, SplitNode, SplitLeaf, SurfaceRef, PaneId } from '../../src/shared/types';

const OMP_A = 'C:/Users/test/.omp/agent/sessions/--test--/01923456-789a-7bc0-8123-456789abcdef.jsonl';
const OMP_B = 'C:/Users/test/.omp/agent/sessions/--test--/01923456-789b-7bc0-8123-456789fedcba.jsonl';
const OMP_SPACE = 'C:/Users/test/my projects/.omp/sessions/session.jsonl';
const OMP_AMP = 'C:/Users/test/R&D/.omp/sessions/session.jsonl';
const OMP_POSIX = '/home/user/.omp/agent/sessions/--test--/01923456-789a-7bc0-8123-456789abcdef.jsonl';
const CLAUDE = '11111111-2222-3333-4444-555555555555';
const SA = 'surf-11111111' as SurfaceId;
const SB = 'surf-22222222' as SurfaceId;

const leaf = (surfaces: SurfaceRef[]): SplitLeaf => ({ type: 'leaf', paneId: 'pane-test' as PaneId, activeSurfaceIndex: 0, surfaces });
const terminal = (id: string, extra: Partial<SurfaceRef> = {}): SurfaceRef => ({ type: 'terminal', id: id as SurfaceId, cwd: 'C:/same-project', ...extra });

function rpc(method: string, params: Record<string, unknown>): unknown {
  let response: unknown;
  expect(handleAgentStateV2(method, params, value => { response = value; }, (_code, message) => { throw new Error(message); })).toBe(true);
  return response;
}

function restore(surface: SurfaceRef, ompEnabled = true, shell?: string, base?: string[]) {
  return withClaudeResume({
    base,
    surfaceId: surface.id,
    claudeSessionId: surface.claudeSessionId,
    codexSessionId: surface.codexSessionId,
    opencodeSessionId: surface.opencodeSessionId,
    ompSessionId: surface.ompSessionId,
    enabled: true,
    codexEnabled: true,
    opencodeEnabled: true,
    ompEnabled,
    shell,
  });
}

beforeEach(() => {
  resetAgentState();
  resetResumedSurfaces();
});

describe('omp per-tab session restore', () => {
  it('round-trips two tabs in one folder to their own distinct sessions', () => {
    rpc('pane.report_agent_session', { surfaceId: SA, sessionId: OMP_A, provider: 'omp' });
    rpc('pane.report_agent_session', { surfaceId: SB, sessionId: OMP_B, provider: 'omp' });

    const tree = stampAgentSessionIds(leaf([terminal(SA), terminal(SB)]));
    expect(tree.surfaces[0].ompSessionId).toBe(OMP_A);
    expect(tree.surfaces[1].ompSessionId).toBe(OMP_B);
    expect(tree.surfaces[0].claudeSessionId).toBeUndefined();
    expect(tree.surfaces[0].opencodeSessionId).toBeUndefined();

    expect(restore(tree.surfaces[0], true, 'cmd.exe')).toEqual([`omp --resume "${OMP_A}"`]);
    expect(restore(tree.surfaces[1], true, 'powershell.exe')).toEqual([`omp --resume '${OMP_B}'`]);
  });

  it('quotes paths with spaces, ampersands and special characters properly across shells', () => {
    expect(isValidOmpSessionId(OMP_SPACE)).toBe(true);
    expect(isValidOmpSessionId(OMP_AMP)).toBe(true);

    expect(quoteOmpArg(OMP_SPACE, 'cmd.exe')).toBe(`"${OMP_SPACE}"`);
    expect(quoteOmpArg(OMP_AMP, 'powershell.exe')).toBe(`'${OMP_AMP}'`);
    expect(quoteOmpArg(OMP_POSIX, 'bash')).toBe(`'${OMP_POSIX}'`);

    const resCmd = restore(terminal(SA, { ompSessionId: OMP_SPACE }), true, 'cmd.exe');
    expect(resCmd).toEqual([`omp --resume "${OMP_SPACE}"`]);

    resetResumedSurfaces();
    const resPs = restore(terminal(SA, { ompSessionId: OMP_AMP }), true, 'powershell.exe');
    expect(resPs).toEqual([`omp --resume '${OMP_AMP}'`]);

    resetResumedSurfaces();
    const resBash = restore(terminal(SA, { ompSessionId: OMP_POSIX }), true, 'bash');
    expect(resBash).toEqual([`omp --resume '${OMP_POSIX}'`]);
  });
  it('refuses invalid session identifiers (bare ids, relative paths, non-jsonl, traversal, newlines)', () => {
    expect(isValidOmpSessionId('01923456-789a-7bc0-8123-456789abcdef')).toBe(false); // bare ID rejected
    expect(isValidOmpSessionId('relative/path/session.jsonl')).toBe(false);
    expect(isValidOmpSessionId('C:/Users/test/session.txt')).toBe(false);
    expect(isValidOmpSessionId('C:/Users/test/../session.jsonl')).toBe(false);
    expect(isValidOmpSessionId('C:/Users/test/session.jsonl\ncalc.exe')).toBe(false);
    expect(isValidOmpSessionId(null)).toBe(false);
    expect(isValidOmpSessionId(123)).toBe(false);

    rpc('pane.report_agent_session', { surfaceId: SA, sessionId: 'invalid-id', provider: 'omp' });
    expect(getAgentState(SA)?.sessionId).toBeNull();
  });

  it('is opt-in and resumes only once per surface', () => {
    const surf = terminal(SA, { ompSessionId: OMP_A });
    // Disabled -> returns undefined
    expect(restore(surf, false)).toBeUndefined();

    // Enabled -> resumes
    expect(restore(surf, true)).toEqual([`omp --resume '${OMP_A}'`]);

    // Second call in same run -> returns base (consumed guard)
    expect(restore(surf, true)).toBeUndefined();
  });

  it('types nothing when a tab carries two providers handles', () => {
    expect(restore(terminal(SA, { ompSessionId: OMP_A, claudeSessionId: CLAUDE }))).toBeUndefined();
    expect(restore(terminal(SA, { ompSessionId: OMP_A, codexSessionId: 'cdx-12345678' }))).toBeUndefined();
    expect(restore(terminal(SA, { ompSessionId: OMP_A, opencodeSessionId: 'ses_123456789012' }))).toBeUndefined();
  });

  it('forgets a session omp exited cleanly via release_omp_session', () => {
    rpc('pane.report_agent_session', { surfaceId: SA, sessionId: OMP_A, provider: 'omp' });
    expect(getAgentState(SA)?.sessionId).toBe(OMP_A);

    // Mismatched session id does not release
    rpc('pane.release_omp_session', { surfaceId: SA, sessionId: OMP_B });
    expect(getAgentState(SA)?.sessionId).toBe(OMP_A);

    // Matching session releases
    rpc('pane.release_omp_session', { surfaceId: SA, sessionId: OMP_A });
    expect(getAgentState(SA)).toBeUndefined();

    // When sessionId is omitted, release is accepted unconditionally
    rpc('pane.report_agent_session', { surfaceId: SA, sessionId: OMP_A, provider: 'omp' });
    rpc('pane.release_omp_session', { surfaceId: SA });
    expect(getAgentState(SA)).toBeUndefined();

    const tree = stampAgentSessionIds(leaf([terminal(SA)]));
    expect(tree.surfaces[0].ompSessionId).toBeUndefined();
  });

  it('merges into existing omp launcher command, preserving flags and stripping conflicting flags', () => {
    const surf = terminal(SA, { ompSessionId: OMP_A });

    // Preserves profile and config with spaces in quotes
    expect(restore(surf, true, 'cmd.exe', ['omp --config "C:\\my tools\\ov.yml" --profile work'])).toEqual([
      `omp --config "C:\\my tools\\ov.yml" --profile work --resume "${OMP_A}"`,
    ]);

    // Strips --continue / -c
    resetResumedSurfaces();
    expect(restore(surf, true, 'cmd.exe', ['omp --continue --profile work'])).toEqual([
      `omp --profile work --resume "${OMP_A}"`,
    ]);

    // Replaces existing --resume / -r / --session instead of duplicating
    resetResumedSurfaces();
    expect(restore(surf, true, 'cmd.exe', ['omp --resume'])).toEqual([
      `omp --resume "${OMP_A}"`,
    ]);
    resetResumedSurfaces();
    expect(restore(surf, true, 'cmd.exe', ['omp -r old_id --profile work'])).toEqual([
      `omp --profile work --resume "${OMP_A}"`,
    ]);
    resetResumedSurfaces();
    expect(restore(surf, true, 'cmd.exe', ['omp --session old_id'])).toEqual([
      `omp --resume "${OMP_A}"`,
    ]);

    // Drops resume if --restore or --no-session is present (returns base unchanged)
    resetResumedSurfaces();
    const restoreBase = ['omp --restore session.jsonl'];
    expect(restore(surf, true, 'cmd.exe', restoreBase)).toBe(restoreBase);
    resetResumedSurfaces();
    const noSessionBase = ['omp --no-session'];
    expect(restore(surf, true, 'cmd.exe', noSessionBase)).toBe(noSessionBase);

    // Appends when commands are setup scripts without omp launcher
    resetResumedSurfaces();
    expect(restore(surf, true, 'cmd.exe', ['nvm use 20', 'cd /d C:\\app'])).toEqual([
      'nvm use 20',
      'cd /d C:\\app',
      `omp --resume "${OMP_A}"`,
    ]);
  });
  it('a layout preset does not carry omp session handle into new tabs', () => {
    const template: SplitNode = leaf([terminal(SA, { ompSessionId: OMP_A })]);
    const instantiated = instantiateLayout(template);
    expect(instantiated.surfaces[0].ompSessionId).toBeUndefined();
  });

  it('prunes dead sessions when the session file is missing from disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-resume-prune-test-'));
    try {
      const liveFile = path.join(tempDir, 'live.jsonl');
      const deadFile = path.join(tempDir, 'dead.jsonl');
      fs.writeFileSync(liveFile, '{"type":"session","id":"test"}\n');

      const tree = leaf([
        terminal(SA, { ompSessionId: liveFile }),
        terminal(SB, { ompSessionId: deadFile }),
      ]);

      const result = pruneDeadOmpSessions(tree);
      expect(result.dropped).toBe(1);
      expect(result.tree.surfaces[0].ompSessionId).toBe(liveFile);
      expect(result.tree.surfaces[1].ompSessionId).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
