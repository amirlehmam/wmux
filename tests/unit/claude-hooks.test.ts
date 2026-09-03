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
      `node "${HOOK}" --event Notification`,
    ]);
    expect(wmuxCmds(out.hooks.Stop)).toEqual([
      `node "${HOOK}" --event Stop`,
    ]);
  });

  // Grok (and other agents that load ~/.claude/settings.json) run these
  // commands in PowerShell on Windows. `2>/dev/null` becomes Out-File of
  // `C:\dev\null` and every hook fails; a PowerShell-only `2>$null` would
  // equally break Claude Code under Git Bash. No redirect is the portable form.
  it('emits hook commands that bash, cmd and PowerShell can all run', () => {
    const out = applyWmuxHooks({}, HOOK);
    const all = Object.values(out.hooks).flatMap((entries: any) => wmuxCmds(entries));
    expect(all.length).toBeGreaterThan(0);
    for (const cmd of all) {
      expect(cmd).toMatch(/^node "/);
      expect(cmd).not.toMatch(/\/dev\/null/);
      expect(cmd).not.toMatch(/\|\|/);
      expect(cmd).not.toMatch(/2>\$null/);
    }
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

  // Every wmux hook is an observer; the per-tool-call ones sat on the critical
  // path of every tool call for 125-145 ms each. Claude Code only skips the
  // wait when the entry says `async: true`, and a pre-existing install has the
  // field missing, so applyWmuxHooks must add it on the rewrite it already does.
  it('marks the per-tool-call observer hooks async and leaves the lifecycle ones sync', () => {
    const out = applyWmuxHooks({}, HOOK);
    const wmuxHooks = (entries: any[]) =>
      entries.flatMap((e) => (e.hooks || []).filter((h: any) => h.command.includes('wmux-hook.js')));

    for (const event of ['PostToolUse', 'PreToolUse', 'UserPromptSubmit']) {
      const hooks = wmuxHooks(out.hooks[event]);
      expect(hooks.length).toBeGreaterThan(0);
      expect(hooks.every((h: any) => h.async === true)).toBe(true);
    }
    for (const event of ['SessionStart', 'Stop', 'SessionEnd']) {
      expect(wmuxHooks(out.hooks[event]).every((h: any) => h.async === undefined)).toBe(true);
    }
  });

  it('upgrades a wmux install that predates the async flag', () => {
    const legacy = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: `node "${HOOK}" --event PreToolUse 2>/dev/null || true` }] }],
      },
    };
    const out = applyWmuxHooks(legacy, HOOK);
    expect(out.hooks.PreToolUse).toHaveLength(1);
    expect(out.hooks.PreToolUse[0].hooks[0].async).toBe(true);
    expect(out.hooks.PreToolUse[0].hooks[0].command).toBe(`node "${HOOK}" --event PreToolUse`);
  });
});
