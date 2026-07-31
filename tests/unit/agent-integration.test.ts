import { describe, it, expect } from 'vitest';
import { applyWmuxHooks, removeWmuxHooks, stripWmuxBlock } from '../../src/main/claude-context';
import { parseConsent, INTEGRATION_FEATURES } from '../../src/main/agent-integration';

const HOOK = '/res/cli/wmux-hook.js';

// Issue #132: wmux wrote into ~/.claude on every launch with no prompt and no
// record of a decision, so deleting any of it was futile — the next launch put
// it straight back. These cover the two halves of the fix: an inverse for every
// write, and a consent record that fails toward asking rather than assuming.

describe('removeWmuxHooks (issue #132)', () => {
  it('takes back exactly what applyWmuxHooks installed', () => {
    const restored = removeWmuxHooks(applyWmuxHooks({}, HOOK));
    // Not merely "no wmux entries" — an empty `hooks: {}` left behind is still a
    // footprint in a file wmux was asked to stay out of.
    expect(restored.hooks).toBeUndefined();
  });

  it('leaves the user\'s own hooks in place', () => {
    const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-audit.sh' }] };
    const withBoth = applyWmuxHooks({ hooks: { PostToolUse: [userHook] } }, HOOK);
    const restored = removeWmuxHooks(withBoth);
    expect(restored.hooks.PostToolUse).toEqual([userHook]);
  });

  it('keeps every other setting untouched', () => {
    const settings = applyWmuxHooks({ model: 'opus', env: { FOO: '1' } }, HOOK);
    const restored = removeWmuxHooks(settings);
    expect(restored.model).toBe('opus');
    expect(restored.env).toEqual({ FOO: '1' });
  });

  it('is a no-op on settings that never had wmux hooks', () => {
    const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } };
    expect(removeWmuxHooks(settings)).toEqual(settings);
  });

  it('survives settings with no hooks key at all', () => {
    expect(removeWmuxHooks({ model: 'opus' })).toEqual({ model: 'opus' });
    expect(removeWmuxHooks({})).toEqual({});
  });

  it('does not mutate the settings it was given', () => {
    const settings = applyWmuxHooks({}, HOOK);
    const before = JSON.stringify(settings);
    removeWmuxHooks(settings);
    expect(JSON.stringify(settings)).toBe(before);
  });

  it('is idempotent — a second launch after declining rewrites nothing', () => {
    const once = removeWmuxHooks(applyWmuxHooks({}, HOOK));
    expect(removeWmuxHooks(once)).toEqual(once);
  });
});

describe('stripWmuxBlock (issue #132)', () => {
  const BLOCK = '<!-- wmux:start -->\ninstructions here\n<!-- wmux:end -->';

  it('reports nothing to do when the document has no wmux block', () => {
    // null, not '' — the caller skips the write entirely rather than rewriting
    // a file it did not change.
    expect(stripWmuxBlock('# My notes\n')).toBeNull();
  });

  it('empties a document that was nothing but the wmux block', () => {
    // '' is the signal to delete the file: wmux created it, so leaving an empty
    // CLAUDE.md behind is still a file the user never asked for.
    expect(stripWmuxBlock(BLOCK)).toBe('');
  });

  it('keeps the user text that surrounded the block', () => {
    const out = stripWmuxBlock(`# Mine\n\n${BLOCK}\n\n## Also mine\n`);
    expect(out).toContain('# Mine');
    expect(out).toContain('## Also mine');
    expect(out).not.toContain('wmux:start');
    expect(out).not.toContain('instructions here');
  });

  it('does not leave a growing gap where the block was', () => {
    const out = stripWmuxBlock(`# Mine\n\n${BLOCK}\n\n## Also mine\n`);
    expect(out).toBe('# Mine\n\n## Also mine\n');
  });

  it('removes a block whose end marker was lost to a hand-edit', () => {
    // Matches how ensureClaudeContext repairs the same damage: an unterminated
    // block is taken to run to end-of-file.
    expect(stripWmuxBlock('# Mine\n\n<!-- wmux:start -->\ndangling\n')).toBe('# Mine\n');
  });

  it('is idempotent', () => {
    const once = stripWmuxBlock(`# Mine\n\n${BLOCK}\n`)!;
    expect(stripWmuxBlock(once)).toBeNull();
  });
});

describe('parseConsent (issue #132)', () => {
  it('treats a missing record as unset, so the user is asked', () => {
    expect(parseConsent(undefined).decision).toBe('unset');
    expect(parseConsent(null).decision).toBe('unset');
  });

  it('falls back to asking — never to granting — on a corrupt record', () => {
    // The whole complaint in #132 is wmux writing without being asked. A
    // settings file that fails to parse must not become a silent yes.
    expect(parseConsent('garbage').decision).toBe('unset');
    expect(parseConsent({ decision: 'yes-please' }).decision).toBe('unset');
    expect(parseConsent(42).decision).toBe('unset');
  });

  it('round-trips a real decision', () => {
    expect(parseConsent({ decision: 'granted' }).decision).toBe('granted');
    expect(parseConsent({ decision: 'declined' }).decision).toBe('declined');
  });

  it('honours an explicitly disabled feature', () => {
    const c = parseConsent({ decision: 'granted', features: { hooks: false } });
    expect(c.features.hooks).toBe(false);
    expect(c.features.instructions).toBe(true);
  });

  it('defaults a feature added by a later version to on, not off', () => {
    // An older record simply lacks the key. Defaulting it to off would silently
    // withhold a feature the user granted wholesale.
    const c = parseConsent({ decision: 'granted', features: {} });
    for (const f of INTEGRATION_FEATURES) expect(c.features[f]).toBe(true);
  });

  it('ignores a non-boolean feature value rather than trusting it', () => {
    const c = parseConsent({ decision: 'granted', features: { hooks: 'nope' } });
    expect(c.features.hooks).toBe(true);
  });
});
