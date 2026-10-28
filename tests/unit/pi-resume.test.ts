import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
import { getAgentState, resetAgentState, clearAgentState } from '../../src/main/agent-state';
import { handleAgentStateV2 } from '../../src/main/agent-state-rpc';
import { stampAgentSessionIds } from '../../src/main/agent-session-persistence';
import {
  decidePiShutdown,
  isValidPiSessionFile,
  piSessionSeqs,
  piSessionsDir,
  pruneDeadPiSessions,
  PiSeqGate,
} from '../../src/main/pi-resume';
import { mergeResume } from '../../src/renderer/hooks/agent-launcher';
import { withClaudeResume, resetResumedSurfaces } from '../../src/renderer/hooks/claude-resume-command';
import { instantiateLayout } from '../../src/renderer/store/split-utils';
import type { SurfaceId, SplitLeaf, SurfaceRef, PaneId } from '../../src/shared/types';

/**
 * Issue #382 — pi restores the exact session FILE a pane was on, with
 * `pi --session <path>`, behind `workspacePrefs.restorePiSessions`.
 *
 * pi's agent dir is pinned through PI_CODING_AGENT_DIR (the override pi itself
 * honours, read by pi-context.ts) so the containment check is deterministic.
 */
const AGENT_DIR = 'C:\\pi-test\\agent';
const SESSIONS = `${AGENT_DIR}\\sessions`;
const FILE_A = `${SESSIONS}\\--C--work-app--\\2026-10-27T10-00-00-000Z_aaaa.jsonl`;
const FILE_B = `${SESSIONS}\\--C--work-app--\\2026-10-27T11-00-00-000Z_bbbb.jsonl`;
const FILE_SPACE = `${SESSIONS}\\--C--my projects-R&D--\\it's $HOME.jsonl`;
const WSL_FILE = '/home/user/.pi/agent/sessions/--home-user-project--/session.jsonl';
const SA = 'surf-11111111' as SurfaceId;
const SB = 'surf-22222222' as SurfaceId;

const leaf = (surfaces: SurfaceRef[]): SplitLeaf => ({ type: 'leaf', paneId: 'pane-test' as PaneId, activeSurfaceIndex: 0, surfaces });
const terminal = (id: string, extra: Partial<SurfaceRef> = {}): SurfaceRef => ({ type: 'terminal', id: id as SurfaceId, cwd: 'C:/work/app', ...extra });

function rpc(method: string, params: Record<string, unknown>): any {
  let response: unknown;
  expect(handleAgentStateV2(method, params, value => { response = value; }, (_code, message) => { throw new Error(message); })).toBe(true);
  return response;
}

let seq = 1_000;
const report = (surfaceId: SurfaceId, file: string, s = ++seq) =>
  rpc('pane.report_agent_session', { surfaceId, sessionId: file, provider: 'pi', seq: s });
const shutdown = (surfaceId: SurfaceId, reason: string | undefined, file: string | null, s = ++seq) =>
  rpc('pane.release_pi_session', { surfaceId, reason, sessionId: file, seq: s });

const saved = (surfaceId: SurfaceId) =>
  stampAgentSessionIds(leaf([terminal(surfaceId)])).surfaces[0].piSessionFile;

function restore(surface: SurfaceRef, opts: { enabled?: boolean; shell?: string; base?: string[] } = {}) {
  return withClaudeResume({
    base: opts.base,
    surfaceId: surface.id,
    claudeSessionId: surface.claudeSessionId,
    enabled: true,
    ompSessionId: surface.ompSessionId,
    ompEnabled: true,
    piSessionFile: surface.piSessionFile,
    piEnabled: opts.enabled ?? true,
    shell: opts.shell,
  });
}

const savedEnv = process.env.PI_CODING_AGENT_DIR;
beforeEach(() => {
  process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
  resetAgentState();
  resetResumedSurfaces();
  piSessionSeqs.clear();
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedEnv;
});

describe('#382 pi session file validation (the command-line boundary)', () => {
  it('derives the sessions dir from the agent dir pi uses', () => {
    expect(piSessionsDir()).toBe(SESSIONS);
  });

  it('accepts an absolute .jsonl inside the sessions dir, any case or separator', () => {
    expect(isValidPiSessionFile(FILE_A)).toBe(true);
    expect(isValidPiSessionFile(FILE_SPACE)).toBe(true);
    expect(isValidPiSessionFile(FILE_A.replace(/\\/g, '/'))).toBe(true);
    expect(isValidPiSessionFile(FILE_A.toUpperCase().replace('.JSONL', '.jsonl'))).toBe(true);
  });

  it.each([
    ['not a string', 42],
    ['empty', ''],
    ['relative', 'sessions\\x\\a.jsonl'],
    ['not .jsonl', `${SESSIONS}\\x\\a.json`],
    ['outside the sessions dir', 'C:\\Users\\me\\Desktop\\a.jsonl'],
    ['the sessions dir prefix only', `${AGENT_DIR}\\sessions-evil\\a.jsonl`],
    ['traversal out of it', `${SESSIONS}\\..\\auth.jsonl`],
    ['traversal back into it', `${SESSIONS}\\x\\..\\a.jsonl`],
    ['another drive', 'D:\\pi-test\\agent\\sessions\\a.jsonl'],
    ['a POSIX network path', '//server/share/a.jsonl'],
    ['a POSIX traversal', '/home/user/.pi/agent/sessions/../auth.jsonl'],
    ['a UNC path', '\\\\server\\share\\sessions\\a.jsonl'],
    ['a line break', `${SESSIONS}\\x\\a\n.jsonl`],
    ['a carriage return', `${SESSIONS}\\x\\a\r.jsonl`],
    ['a NUL', `${SESSIONS}\\x\\a\0.jsonl`],
    ['a double quote', `${SESSIONS}\\x\\a".jsonl`],
    ['too long', `${SESSIONS}\\${'x'.repeat(4100)}.jsonl`],
  ])('refuses %s', (_label, file) => {
    expect(isValidPiSessionFile(file)).toBe(false);
  });

  it('accepts absolute Linux session files without resolving them against the Windows Pi root', () => {
    expect(isValidPiSessionFile(WSL_FILE)).toBe(true);
    expect(isValidPiSessionFile('/home/user/pi sessions/it\'s $HOME.jsonl')).toBe(true);
  });

  it('is enforced at report time: an invalid file is stored as no handle at all', () => {
    expect(report(SA, 'C:\\Windows\\System32\\drivers\\etc\\hosts.jsonl')).toEqual({ accepted: true });
    expect(getAgentState(SA)?.sessionId).toBeNull();
    expect(saved(SA)).toBeUndefined();
  });

  it('is enforced again when the restored tree is pruned (session.json is editable)', () => {
    const tree = leaf([terminal(SA, { piSessionFile: 'C:\\Users\\me\\.ssh\\id_rsa.jsonl' })]);
    const result = pruneDeadPiSessions(tree, () => 100);
    expect(result.dropped).toBe(1);
    expect(result.tree.surfaces[0].piSessionFile).toBeUndefined();
  });
});

describe('#382 pi report and save', () => {
  it('round-trips two tabs in one folder to their own files', () => {
    report(SA, FILE_A);
    report(SB, FILE_B);
    const tree = stampAgentSessionIds(leaf([terminal(SA), terminal(SB)]));
    expect(tree.surfaces.map(s => s.piSessionFile)).toEqual([FILE_A, FILE_B]);
    expect(getAgentState(SA)?.sessionProvider).toBe('pi');
  });

  it('retains a WSL session through reporting, saving, and startup pruning without a Windows filesystem probe', () => {
    report(SA, WSL_FILE);
    expect(getAgentState(SA)?.sessionId).toBe(WSL_FILE);
    const tree = stampAgentSessionIds(leaf([terminal(SA)]));
    expect(tree.surfaces[0].piSessionFile).toBe(WSL_FILE);
    const sizeOf = vi.fn(() => { throw new Error('Linux files cannot be checked from Windows'); });
    expect(pruneDeadPiSessions(tree, sizeOf)).toEqual({ tree, dropped: 0 });
    expect(sizeOf).not.toHaveBeenCalled();
  });

  it('a newer session in the same pane replaces the older one (a /new, /resume or /fork)', () => {
    report(SA, FILE_A);
    report(SA, FILE_B);
    expect(saved(SA)).toBe(FILE_B);
  });

  it('drops a late report from the previous session', () => {
    const older = ++seq;
    report(SA, FILE_B);
    expect(report(SA, FILE_A, older)).toEqual({ accepted: false });
    expect(saved(SA)).toBe(FILE_B);
  });

  it('keeps a restored handle the pane has not re-reported yet', () => {
    const tree = stampAgentSessionIds(leaf([terminal(SA, { piSessionFile: FILE_A })]));
    expect(tree.surfaces[0].piSessionFile).toBe(FILE_A);
  });

  it('another provider reporting on the pane clears the pi handle', () => {
    report(SA, FILE_A);
    rpc('pane.report_agent_session', { surfaceId: SA, sessionId: '11111111-2222-3333-4444-555555555555', provider: 'claude' });
    const surface = stampAgentSessionIds(leaf([terminal(SA, { piSessionFile: FILE_A })])).surfaces[0];
    expect(surface.piSessionFile).toBeUndefined();
    expect(surface.claudeSessionId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('a layout preset does not carry the handle into new tabs', () => {
    const instantiated = instantiateLayout(leaf([terminal(SA, { piSessionFile: FILE_A })]));
    expect((instantiated as SplitLeaf).surfaces[0].piSessionFile).toBeUndefined();
  });

  it('a pi crash (the PTY dies under it) keeps the handle', () => {
    report(SA, FILE_A);
    clearAgentState(SA);
    expect(saved(SA)).toBe(FILE_A);
  });
});

describe('#382 pi session_shutdown: quit vs switch', () => {
  it.each(['reload', 'new', 'resume', 'fork'])('a %s keeps the record', (reason) => {
    report(SA, FILE_A);
    expect(shutdown(SA, reason, FILE_A)).toEqual({ released: false, decision: 'keep' });
    expect(saved(SA)).toBe(FILE_A);
    expect(getAgentState(SA)?.sessionId).toBe(FILE_A);
  });

  it('a switch does not spend the seq gate, so the next session can still report', () => {
    report(SA, FILE_A);
    const next = ++seq;
    shutdown(SA, 'new', FILE_A, next + 100);
    expect(report(SA, FILE_B, next)).toEqual({ accepted: true });
  });

  it('a quit releases the record, and the next save drops the handle', () => {
    report(SA, FILE_A);
    expect(shutdown(SA, 'quit', FILE_A)).toEqual({ released: true, decision: 'release' });
    expect(getAgentState(SA)).toBeUndefined();
    expect(stampAgentSessionIds(leaf([terminal(SA, { piSessionFile: FILE_A })])).surfaces[0].piSessionFile).toBeUndefined();
  });

  it('an unknown reason counts as a quit (older pi)', () => {
    report(SA, FILE_A);
    expect(shutdown(SA, undefined, FILE_A).decision).toBe('release');
  });

  it('a quit naming an OLDER file does not take the current one', () => {
    report(SA, FILE_A);
    report(SA, FILE_B);
    expect(shutdown(SA, 'quit', FILE_A)).toEqual({ released: false, decision: 'other' });
    expect(saved(SA)).toBe(FILE_B);
  });

  it('a quit older than the last report is stale', () => {
    const older = ++seq;
    report(SA, FILE_A);
    expect(shutdown(SA, 'quit', FILE_A, older)).toEqual({ released: false, decision: 'stale' });
    expect(saved(SA)).toBe(FILE_A);
  });

  it('a report that loses the race to its own quit does not resurrect the handle', () => {
    const reportSeq = ++seq;
    report(SA, FILE_A, reportSeq - 500); // an earlier report, accepted
    shutdown(SA, 'quit', FILE_A);        // the quit lands first ...
    expect(report(SA, FILE_A, reportSeq)).toEqual({ accepted: false }); // ... the slower report after it
    expect(getAgentState(SA)).toBeUndefined();
    expect(saved(SA)).toBeUndefined();
  });

  it('never releases another provider', () => {
    rpc('pane.report_agent_session', { surfaceId: SA, sessionId: '11111111-2222-3333-4444-555555555555', provider: 'claude' });
    expect(shutdown(SA, 'quit', FILE_A).decision).toBe('foreign');
    expect(getAgentState(SA)?.sessionProvider).toBe('claude');
  });

  it('ends the run of a pi that never had a file on disk', () => {
    rpc('pane.report_agent', { surfaceId: SA, runDepth: 1 });
    expect(shutdown(SA, 'quit', FILE_A)).toEqual({ released: true, decision: 'release' });
    expect(getAgentState(SA)).toBeUndefined();
  });

  it('a restored pi quit before it re-reported still drops the restored handle', () => {
    expect(shutdown(SA, 'quit', FILE_A)).toEqual({ released: true, decision: 'release' });
    expect(stampAgentSessionIds(leaf([terminal(SA, { piSessionFile: FILE_A })])).surfaces[0].piSessionFile).toBeUndefined();
  });

  it('decides purely from its inputs', () => {
    const current = { provider: 'pi', sessionId: FILE_A };
    expect(decidePiShutdown({ reason: 'fork', seqAccepted: false, named: FILE_A, current })).toBe('keep');
    expect(decidePiShutdown({ reason: 'quit', seqAccepted: false, named: FILE_A, current })).toBe('stale');
    expect(decidePiShutdown({ reason: 'quit', seqAccepted: true, named: null, current })).toBe('release');
    expect(decidePiShutdown({ reason: 'quit', seqAccepted: true, named: FILE_B, current })).toBe('other');
    expect(decidePiShutdown({ reason: 'quit', seqAccepted: true, named: FILE_A, current: null })).toBe('release');
  });
});

describe('#382 the seq gate', () => {
  it('accepts strictly increasing seqs per surface and opts out without one', () => {
    const gate = new PiSeqGate();
    expect(gate.accept(SA, 5)).toBe(true);
    expect(gate.accept(SA, 5)).toBe(false);
    expect(gate.accept(SA, 4)).toBe(false);
    expect(gate.accept(SB, 1)).toBe(true);
    expect(gate.accept(SA, undefined)).toBe(true);
    expect(gate.accept(SA, 6)).toBe(true);
  });

  it('refuses a seq that is not a safe integer', () => {
    const gate = new PiSeqGate();
    expect(gate.accept(SA, '7')).toBe(false);
    expect(gate.accept(SA, 1.5)).toBe(false);
    expect(gate.accept(SA, Number.MAX_VALUE)).toBe(false);
  });

  it('stays bounded', () => {
    const gate = new PiSeqGate();
    for (let i = 0; i < 300; i++) gate.accept(`surf-${i}` as SurfaceId, 1);
    // The oldest surfaces were evicted, so they accept again from scratch.
    expect(gate.accept('surf-0' as SurfaceId, 1)).toBe(true);
    expect(gate.accept('surf-299' as SurfaceId, 1)).toBe(false);
  });
});

describe('#382 wmux quitting', () => {
  it('index.ts refuses pane.release_pi_session while wmux quits, like the other releases', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/main/index.ts'), 'utf8');
    const guard = source.slice(source.indexOf("request.method === 'pane.release_codex_session'"), source.indexOf('&& isQuitting)') + 20);
    expect(guard).toContain("'pane.release_pi_session'");
  });
});

describe('#382 pruning at startup', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-resume-prune-'));
    process.env.PI_CODING_AGENT_DIR = dir;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('drops a handle whose file is gone or empty, and keeps a live one', () => {
    const sessions = path.join(dir, 'sessions', '--C--app--');
    fs.mkdirSync(sessions, { recursive: true });
    const live = path.join(sessions, 'live.jsonl');
    const empty = path.join(sessions, 'empty.jsonl');
    const gone = path.join(sessions, 'gone.jsonl');
    fs.writeFileSync(live, '{"type":"session"}\n');
    fs.writeFileSync(empty, '');
    const tree = leaf([
      terminal('surf-a', { piSessionFile: live }),
      terminal('surf-b', { piSessionFile: empty }),
      terminal('surf-c', { piSessionFile: gone }),
      terminal('surf-d'),
    ]);
    const result = pruneDeadPiSessions(tree);
    expect(result.dropped).toBe(2);
    expect(result.tree.surfaces.map(s => s.piSessionFile)).toEqual([live, undefined, undefined, undefined]);
  });

  it('drops a handle that names a directory', () => {
    const sub = path.join(dir, 'sessions', 'x.jsonl');
    fs.mkdirSync(sub, { recursive: true });
    expect(pruneDeadPiSessions(leaf([terminal('surf-a', { piSessionFile: sub })])).dropped).toBe(1);
  });
});

describe('#382 the restore command', () => {
  it('types `pi --session <path>` quoted for PowerShell by default', () => {
    expect(restore(terminal(SA, { piSessionFile: FILE_A }))).toEqual([`pi --session '${FILE_A}'`]);
  });

  it('quotes per shell: PowerShell, cmd and bash', () => {
    const surface = terminal(SA, { piSessionFile: FILE_SPACE });
    expect(restore(surface, { shell: 'pwsh.exe' })).toEqual([`pi --session '${FILE_SPACE.replace("'", "''")}'`]);
    resetResumedSurfaces();
    expect(restore(surface, { shell: 'cmd.exe' })).toEqual([`pi --session "${FILE_SPACE}"`]);
    resetResumedSurfaces();
    expect(restore(surface, { shell: 'C:\\Program Files\\Git\\bin\\bash.exe' })).toEqual([`pi --session '${FILE_SPACE.replace("'", "'\\''")}'`]);
  });

  it('skips a cmd pane whose path carries a percent sign, rather than let cmd expand it', () => {
    const file = `${SESSIONS}\\x\\100%done.jsonl`;
    expect(restore(terminal(SA, { piSessionFile: file }), { shell: 'cmd.exe' })).toBeUndefined();
  });

  it('is opt-in and resumes only once per surface', () => {
    const surface = terminal(SA, { piSessionFile: FILE_A });
    expect(restore(surface, { enabled: false })).toBeUndefined();
    expect(restore(surface)).toEqual([`pi --session '${FILE_A}'`]);
    expect(restore(surface)).toBeUndefined();
  });

  it('re-checks the shape of the stored file before building the command', () => {
    for (const file of ['relative.jsonl', 'C:\\x\\a.json', `C:\\x\\..\\a.jsonl`, 'C:\\x\\a\n.jsonl', 'C:\\x\\a".jsonl', '//server/share/a.jsonl']) {
      expect(restore(terminal(SA, { piSessionFile: file }))).toBeUndefined();
    }
  });

  it.each(['wsl.exe -d Ubuntu-24.04', '"C:\\Program Files\\WSL\\wsl.exe" -d Ubuntu-24.04'])('restores a Linux session with a plain Pi command in %s', (shell) => {
    expect(restore(terminal(SA, { piSessionFile: WSL_FILE }), { shell })).toEqual([
      `pi --session '${WSL_FILE}'`,
    ]);
  });

  it.each(['pwsh.exe', 'cmd.exe', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Users\\wsl-admin\\bin\\bash.exe', 'cmd.exe /c wsl', 'wsl.cmd', undefined])('does not send a Linux resume to the non-WSL shell %s', (shell) => {
    const surface = terminal(SA, { piSessionFile: WSL_FILE });
    expect(restore(surface, { shell })).toBeUndefined();
    expect(restore(surface, { shell: 'wsl.exe' })).toHaveLength(1);
  });

  it('preserves setup commands and quotes the WSL path when merging into an existing Pi launcher', () => {
    const file = "/home/user/pi sessions/it's $HOME.jsonl";
    const quoted = `'${file.replace(/'/g, "'\\''")}'`;
    expect(mergeResume(['echo setup', 'pi --model m --continue'], 'pi', file, 'wsl.exe')).toEqual([
      'echo setup', `pi --model m --session ${quoted}`,
    ]);
  });

  it('types nothing when the tab also carries another provider handle', () => {
    expect(restore(terminal(SA, { piSessionFile: FILE_A, claudeSessionId: '11111111-2222-3333-4444-555555555555' }))).toBeUndefined();
    expect(restore(terminal(SA, { piSessionFile: FILE_A, ompSessionId: 'C:/x/omp.jsonl' }))).toBeUndefined();
  });

  it('appends after setup commands', () => {
    expect(restore(terminal(SA, { piSessionFile: FILE_A }), { base: ['nvm use 22'] })).toEqual(['nvm use 22', `pi --session '${FILE_A}'`]);
  });
});

describe('#382 merging into a startup command that already runs pi', () => {
  const merge = (command: string, shell = 'pwsh.exe') => mergeResume([command], 'pi', FILE_A, shell)?.[0] ?? null;
  const q = `'${FILE_A}'`;

  it('keeps every other argument, quoting and spacing included', () => {
    expect(merge('pi --model "anthropic/claude x" --thinking high')).toBe(`pi --model "anthropic/claude x" --thinking high --session ${q}`);
    expect(merge('npx -y pi --provider openai')).toBe(`npx -y pi --provider openai --session ${q}`);
  });

  it.each([
    ['pi --continue', 'pi'],
    ['pi -c --model m', 'pi --model m'],
    ['pi --resume', 'pi'],
    ['pi -r --model m', 'pi --model m'],
    ['pi --session C:\\old.jsonl --model m', 'pi --model m'],
    ['pi --session "C:\\old dir\\a.jsonl"', 'pi'],
    ['pi --session=C:\\old.jsonl', 'pi'],
    ['pi --model m --continue --resume', 'pi --model m'],
  ])('replaces the selector in %s', (command, kept) => {
    expect(merge(command)).toBe(`${kept} --session ${q}`);
  });

  it('keeps the token after a value-less selector: it is not that selector’s value', () => {
    expect(merge('pi -r "fix the build"')).toBe(`pi "fix the build" --session ${q}`);
  });

  it.each([
    'pi --no-session',
    'pi --fork C:\\other.jsonl',
    'pi --fork=C:\\other.jsonl',
    'pi --session-id 0192',
    'pi --session-id=0192',
  ])('leaves %s alone', (command) => {
    expect(merge(command)).toBeNull();
  });

  it('does not merge a pi path into a different agent', () => {
    expect(mergeResume(['omp --profile work'], 'pi', FILE_A, 'pwsh.exe')).toBeNull();
    expect(mergeResume(['pi-monitor --watch'], 'pi', FILE_A, 'pwsh.exe')).toEqual(['pi-monitor --watch', `pi --session ${q}`]);
  });

  it('quotes the merged path for the pane shell', () => {
    expect(merge('pi --continue', 'cmd.exe')).toBe(`pi --session "${FILE_A}"`);
  });
});
