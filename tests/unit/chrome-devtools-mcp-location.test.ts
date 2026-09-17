/**
 * Issue #237, first blocker: wmux wrote its `chrome-devtools` MCP entry into
 * `~/.claude/settings.json`, a file that has no `mcpServers` key. The settings
 * schema strips unknown keys rather than erroring, so the entry landed, changed
 * nothing, and wmux logged "Configured chrome-devtools-mcp … → localhost:9222".
 * `claude mcp list` never showed it.
 *
 * The failure is silent by construction — "written" and "written where nobody
 * reads" are indistinguishable unless you go and look — so what is pinned here
 * is the shape of the two files, not the logging.
 */
import { describe, it, expect } from 'vitest';
import {
  applyChromeDevtoolsMcp,
  buildChromeDevtoolsMcpServer,
  stripChromeDevtoolsMcp,
} from '../../src/main/claude-context';

const theirs = { command: 'node', args: ['/home/me/my-cdp-server.js'] };
const otherPort = { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.7.0', '--browserUrl=http://127.0.0.1:9333'] };

describe('applyChromeDevtoolsMcp (issue #237)', () => {
  it('adds the entry to a config that has no mcpServers at all', () => {
    const { next, changed } = applyChromeDevtoolsMcp({ numStartups: 12 });
    expect(changed).toBe(true);
    expect(next.mcpServers['chrome-devtools']).toEqual(buildChromeDevtoolsMcpServer());
  });

  it('keeps every unrelated key in Claude Code\'s state file', () => {
    // ~/.claude.json holds the OAuth account, per-project history and onboarding
    // flags; wmux rewrites it whole, so nothing may be dropped on the way.
    const { next } = applyChromeDevtoolsMcp({ oauthAccount: { id: 'x' }, projects: { '/a': {} } });
    expect(next.oauthAccount).toEqual({ id: 'x' });
    expect(next.projects).toEqual({ '/a': {} });
  });

  it('leaves other MCP servers alone', () => {
    const { next } = applyChromeDevtoolsMcp({ mcpServers: { fetch: theirs } });
    expect(next.mcpServers.fetch).toEqual(theirs);
  });

  it('reports no change when the entry is already exactly right', () => {
    // "changed" has to be exact: every needless write to this file is a chance
    // to lose something Claude Code wrote a millisecond earlier.
    const once = applyChromeDevtoolsMcp({});
    expect(applyChromeDevtoolsMcp(once.next).changed).toBe(false);
  });

  it('never retunes an entry the user pointed somewhere of their own', () => {
    const mine = { mcpServers: { 'chrome-devtools': theirs } };
    expect(applyChromeDevtoolsMcp(mine).changed).toBe(false);
    expect(mine.mcpServers['chrome-devtools']).toEqual(theirs);
  });

  it('leaves a chrome-devtools-mcp aimed at a different port alone', () => {
    // Same package, another target — someone's own Chrome, not wmux's panel.
    const mine = { mcpServers: { 'chrome-devtools': otherPort } };
    expect(applyChromeDevtoolsMcp(mine).changed).toBe(false);
  });

  it('DOES migrate an entry an older wmux wrote, when the pin has moved', () => {
    const old = { mcpServers: { 'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.2.0', '--browserUrl=http://127.0.0.1:9222'] } } };
    const { next, changed } = applyChromeDevtoolsMcp(old);
    expect(changed).toBe(true);
    expect(next.mcpServers['chrome-devtools']).toEqual(buildChromeDevtoolsMcpServer());
  });

  it('survives a corrupt config without claiming a change', () => {
    for (const bad of [null, undefined, 'nonsense', 7, []]) {
      expect(applyChromeDevtoolsMcp(bad).changed).toBe(false);
    }
  });

  it('replaces an mcpServers that is not an object', () => {
    const { next, changed } = applyChromeDevtoolsMcp({ mcpServers: 'oops' });
    expect(changed).toBe(true);
    expect(next.mcpServers['chrome-devtools']).toEqual(buildChromeDevtoolsMcpServer());
  });
});

describe('stripChromeDevtoolsMcp (issue #132 + the #237 migration)', () => {
  it('removes the entry, and the empty mcpServers with it', () => {
    // An empty key left behind is still a footprint in a file wmux was asked to
    // stay out of.
    const { next, changed } = stripChromeDevtoolsMcp(applyChromeDevtoolsMcp({ a: 1 }).next);
    expect(changed).toBe(true);
    expect(next.mcpServers).toBeUndefined();
    expect(next.a).toBe(1);
  });

  it('keeps mcpServers when somebody else\'s server is still in it', () => {
    const cfg = applyChromeDevtoolsMcp({ mcpServers: { fetch: theirs } }).next;
    const { next } = stripChromeDevtoolsMcp(cfg);
    expect(next.mcpServers).toEqual({ fetch: theirs });
  });

  it('leaves a user\'s own chrome-devtools entry in place', () => {
    const mine = { mcpServers: { 'chrome-devtools': theirs } };
    expect(stripChromeDevtoolsMcp(mine).changed).toBe(false);
    expect(mine.mcpServers['chrome-devtools']).toEqual(theirs);
  });

  it('clears the stale entry older releases left in settings.json', () => {
    // The same function does the migration: the shape is identical, and it is
    // wmux's litter wherever it sits. #237 was reported by someone who found it
    // there, correct in every detail, while `claude mcp list` disagreed.
    const settings = {
      enabledPlugins: { 'chrome-devtools-mcp@claude-plugins-official': false },
      mcpServers: { 'chrome-devtools': buildChromeDevtoolsMcpServer() },
    };
    const { next, changed } = stripChromeDevtoolsMcp(settings);
    expect(changed).toBe(true);
    expect(next.mcpServers).toBeUndefined();
    // The plugin flag IS read from settings.json and is not this function's business.
    expect(next.enabledPlugins['chrome-devtools-mcp@claude-plugins-official']).toBe(false);
  });

  it('is a no-op on a config that never had one', () => {
    expect(stripChromeDevtoolsMcp({ numStartups: 3 }).changed).toBe(false);
    expect(stripChromeDevtoolsMcp(null).changed).toBe(false);
  });
});
