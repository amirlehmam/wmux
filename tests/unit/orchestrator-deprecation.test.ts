/**
 * Issue #239: the bundled wmux-orchestrator plugin never loaded in Claude Code,
 * and is retired rather than repaired (parallel orchestration is native now).
 *
 * The install path is gone, so there is nothing left to test on that side. What
 * needs pinning is the UNINSTALL, because it edits two files wmux does not own
 * and has to tell three states apart in them:
 *
 *   1. the malformed entry wmux itself wrote  → remove it
 *   2. a plugin installed the supported way   → leave it completely alone
 *   3. neither                                → change nothing, write nothing
 *
 * Getting (2) wrong is the expensive one: the deprecation notice tells people to
 * install the orchestrator from its own repo, and a cleanup that cannot tell the
 * replacement from the wreckage would uninstall the thing it just recommended.
 */
import { describe, it, expect } from 'vitest';
import {
  isWmuxOrchestratorRegistration,
  orchestratorFlagIsStale,
  pruneOrchestratorRegistration,
} from '../../src/main/claude-context';
import { INTEGRATION_CONSENT_DETAIL } from '../../src/main/agent-integration';

const KEY = 'wmux-orchestrator@wmux';

/** What Claude Code's own v2 file looks like, trimmed to what matters here. */
const claudeCodeRegistry = () => ({
  version: 2,
  plugins: {
    'frontend-design@claude-plugins-official': [
      { scope: 'user', installPath: 'C:\\Users\\x\\.claude\\plugins\\cache\\claude-plugins-official\\frontend-design\\1.0.0', version: '1.0.0' },
    ],
  },
});

/** What wmux wrote: top level, outside `plugins`, an object instead of an array. */
const wmuxEntry = () => ({
  scope: 'user',
  installPath: 'C:\\Users\\x\\.claude\\plugins\\cache\\wmux-orchestrator\\0.1.3',
  version: '0.1.3',
  installedAt: '2026-09-16T17:15:16.238Z',
  lastUpdated: '2026-09-16T17:15:16.238Z',
});

describe('isWmuxOrchestratorRegistration', () => {
  it('recognises the bare object wmux wrote', () => {
    expect(isWmuxOrchestratorRegistration(wmuxEntry())).toBe(true);
  });

  it('refuses an array — that is Claude Code\'s own shape, whoever put it there', () => {
    expect(isWmuxOrchestratorRegistration([wmuxEntry()])).toBe(false);
  });

  it('refuses absence and primitives', () => {
    expect(isWmuxOrchestratorRegistration(undefined)).toBe(false);
    expect(isWmuxOrchestratorRegistration(null)).toBe(false);
    expect(isWmuxOrchestratorRegistration(true)).toBe(false);
    expect(isWmuxOrchestratorRegistration('0.1.3')).toBe(false);
  });
});

describe('pruneOrchestratorRegistration (issue #239)', () => {
  it('drops the top-level entry wmux wrote', () => {
    const { next, changed } = pruneOrchestratorRegistration({ ...claudeCodeRegistry(), [KEY]: wmuxEntry() });
    expect(changed).toBe(true);
    expect(next[KEY]).toBeUndefined();
  });

  it('leaves every other plugin exactly as it found it', () => {
    const before = claudeCodeRegistry();
    const { next } = pruneOrchestratorRegistration({ ...claudeCodeRegistry(), [KEY]: wmuxEntry() });
    expect(next.version).toBe(2);
    expect(next.plugins).toEqual(before.plugins);
  });

  it('never touches a properly registered orchestrator under `plugins`', () => {
    const registry: any = claudeCodeRegistry();
    registry.plugins[KEY] = [{ scope: 'user', installPath: 'C:\\hand\\installed', version: '0.1.3' }];
    const { next, changed } = pruneOrchestratorRegistration(registry);
    // Nothing of wmux's at the top level ⇒ nothing to do, and above all no
    // write: the hand-installed copy is the replacement, not the wreckage.
    expect(changed).toBe(false);
    expect(next.plugins[KEY]).toHaveLength(1);
  });

  it('reports no change when there is nothing of wmux\'s to remove', () => {
    expect(pruneOrchestratorRegistration(claudeCodeRegistry()).changed).toBe(false);
  });

  it('survives a corrupt or absent registry without claiming a change', () => {
    for (const bad of [null, undefined, 'nonsense', 42, []]) {
      expect(pruneOrchestratorRegistration(bad).changed).toBe(false);
    }
  });
});

describe('orchestratorFlagIsStale (issue #239)', () => {
  it('is stale when the flag points at an install that only ever existed in wmux\'s head', () => {
    const settings = { enabledPlugins: { [KEY]: true } };
    expect(orchestratorFlagIsStale(settings, { ...claudeCodeRegistry(), [KEY]: wmuxEntry() })).toBe(true);
  });

  it('is stale when the flag is the last thing standing after the entry is gone', () => {
    expect(orchestratorFlagIsStale({ enabledPlugins: { [KEY]: true } }, claudeCodeRegistry())).toBe(true);
  });

  it('is NOT stale once the plugin is installed the supported way', () => {
    const registry: any = claudeCodeRegistry();
    registry.plugins[KEY] = [{ scope: 'user', installPath: 'C:\\hand\\installed', version: '0.1.3' }];
    // Clearing the flag here would switch off a plugin the user installed on
    // purpose — the exact move the deprecation notice asks them to make.
    expect(orchestratorFlagIsStale({ enabledPlugins: { [KEY]: true } }, registry)).toBe(false);
  });

  it('treats an empty install-record array as no install at all', () => {
    const registry: any = claudeCodeRegistry();
    registry.plugins[KEY] = [];
    expect(orchestratorFlagIsStale({ enabledPlugins: { [KEY]: true } }, registry)).toBe(true);
  });

  it('is false when there is no flag to clear', () => {
    expect(orchestratorFlagIsStale({ enabledPlugins: { other: true } }, claudeCodeRegistry())).toBe(false);
    expect(orchestratorFlagIsStale({}, claudeCodeRegistry())).toBe(false);
    expect(orchestratorFlagIsStale(null, null)).toBe(false);
  });

  it('clears a flag the user themselves set to false, which is still ours to tidy', () => {
    // `false` is what wmux writes for chrome-devtools and what a user leaves
    // behind after disabling a plugin that no longer exists. Either way the key
    // names an installation that is not there.
    expect(orchestratorFlagIsStale({ enabledPlugins: { [KEY]: false } }, claudeCodeRegistry())).toBe(true);
  });
});

describe('the consent disclosure no longer promises a Claude Code plugin (issue #239)', () => {
  it('does not offer to write into ~/.claude/plugins', () => {
    // The disclosure is the contract: it must not name a write that no longer
    // happens, or the prompt is asking for permission wmux does not use.
    expect(INTEGRATION_CONSENT_DETAIL).not.toContain('~/.claude/plugins');
  });

  it('still names the OpenCode plugin, which is not deprecated', () => {
    expect(INTEGRATION_CONSENT_DETAIL).toContain('~/.config/opencode/plugin/wmux.js');
  });
});
