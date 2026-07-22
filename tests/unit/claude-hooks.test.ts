import { describe, it, expect } from 'vitest';
import { applyWmuxHooks } from '../../src/main/claude-context';

const HOOK = '/res/cli/wmux-hook.js';

const wmuxCmds = (entries: any[]): string[] =>
  entries.flatMap((e) => (e.hooks || []).map((h: any) => h.command as string));

describe('applyWmuxHooks (issue #53)', () => {
  it('installs PostToolUse, Notification and Stop wmux hooks', () => {
    const out = applyWmuxHooks({}, HOOK);

    // PostToolUse: one entry per tracked tool.
    const postCmds = wmuxCmds(out.hooks.PostToolUse);
    expect(postCmds.some((c) => c.includes('wmux-hook.js') && c.includes('Bash'))).toBe(true);
    expect(postCmds.some((c) => c.includes('Edit'))).toBe(true);

    // Notification + Stop: pass an --event flag.
    expect(wmuxCmds(out.hooks.Notification)).toEqual([
      `node "${HOOK}" --event Notification 2>/dev/null || true`,
    ]);
    expect(wmuxCmds(out.hooks.Stop)).toEqual([
      `node "${HOOK}" --event Stop 2>/dev/null || true`,
    ]);
  });

  it('preserves existing user hooks in every array', () => {
    const userPost = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-script.sh' }] };
    const userStop = { hooks: [{ type: 'command', command: 'notify-send done' }] };
    const out = applyWmuxHooks(
      { hooks: { PostToolUse: [userPost], Stop: [userStop] } },
      HOOK,
    );

    expect(wmuxCmds(out.hooks.PostToolUse)).toContain('my-own-script.sh');
    expect(wmuxCmds(out.hooks.Stop)).toContain('notify-send done');
    // ...and the wmux entries are still added alongside them.
    expect(wmuxCmds(out.hooks.Stop).some((c) => c.includes('--event Stop'))).toBe(true);
  });

  it('is idempotent — re-running replaces wmux entries, never duplicates them', () => {
    const once = applyWmuxHooks({}, HOOK);
    const twice = applyWmuxHooks(once, HOOK);

    expect(twice.hooks.Notification).toHaveLength(1);
    expect(twice.hooks.Stop).toHaveLength(1);
    // Same number of PostToolUse entries on the second pass (no accumulation).
    expect(twice.hooks.PostToolUse).toHaveLength(once.hooks.PostToolUse.length);
  });

  it('does not mutate the input settings object', () => {
    const input: any = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user' }] }] } };
    const snapshot = JSON.stringify(input);
    applyWmuxHooks(input, HOOK);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('adds a SubagentStop hook entry alongside Notification and Stop', () => {
    const result = applyWmuxHooks({}, '/abs/wmux-hook.js');
    const entries = result.hooks.SubagentStop;
    expect(entries).toHaveLength(1);
    expect(entries[0].hooks[0].command).toContain('--event SubagentStop');
  });

  it('replaces a prior wmux SubagentStop entry instead of duplicating it', () => {
    const once = applyWmuxHooks({}, '/abs/wmux-hook.js');
    const twice = applyWmuxHooks(once, '/abs/wmux-hook.js');
    expect(twice.hooks.SubagentStop).toHaveLength(1);
  });
});
