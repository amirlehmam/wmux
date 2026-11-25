import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildReport,
  discoverHooks,
  formatReport,
  hooksFromConfig,
  matcherMatches,
  median,
  probeToolFor,
  resolveHookShell,
  untimedReason,
  verdictFor,
  type HookEntry,
  type PerfReport,
} from '../../src/cli/hook-audit';
import { parseFlagArgs, perfOptions } from '../../src/cli/wmux';

function hook(over: Partial<HookEntry> = {}): HookEntry {
  return {
    source: 'settings.json',
    sourceKind: 'settings',
    event: 'PostToolUse',
    matcher: '',
    type: 'command',
    command: 'true',
    async: false,
    ...over,
  };
}

describe('matcherMatches', () => {
  it('accepts every tool for an empty matcher and for *', () => {
    expect(matcherMatches('', 'Bash')).toBe(true);
    expect(matcherMatches('*', 'Read')).toBe(true);
  });

  it('matches the whole tool name, not a part of it', () => {
    expect(matcherMatches('Edit|Write', 'Edit')).toBe(true);
    expect(matcherMatches('Edit|Write', 'MultiEdit')).toBe(false);
    expect(matcherMatches('mcp__x__.*', 'mcp__x__scan')).toBe(true);
  });

  it('matches nothing for a matcher that is not a valid pattern', () => {
    expect(matcherMatches('(', 'Bash')).toBe(false);
  });
});

describe('probeToolFor', () => {
  it('picks the first probed tool the matcher accepts', () => {
    expect(probeToolFor('')).toBe('Bash');
    expect(probeToolFor('Write|Edit')).toBe('Edit');
  });

  it('answers null for a matcher that only accepts tools we do not fake', () => {
    expect(probeToolFor('mcp__hexstrike-ai__.*')).toBeNull();
    expect(probeToolFor('EnterPlanMode')).toBeNull();
  });
});

describe('hooksFromConfig', () => {
  it('flattens events, groups and hooks, keeping async, timeout and shell', () => {
    const entries = hooksFromConfig(
      {
        PostToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'a', async: true }, { command: 'b', timeout: 5 }] },
          { hooks: [{ type: 'command', command: 'c', shell: 'powershell' }] },
        ],
        Stop: [{ hooks: [{ type: 'prompt', prompt: 'check' }] }],
      },
      'plug@market',
      'plugin',
      'C:\\plug',
    );
    expect(entries.map((e) => [e.event, e.matcher, e.type, e.command, e.async])).toEqual([
      ['PostToolUse', 'Bash', 'command', 'a', true],
      ['PostToolUse', 'Bash', 'command', 'b', false],
      ['PostToolUse', '', 'command', 'c', false],
      ['Stop', '', 'prompt', '', false],
    ]);
    expect(entries[1].timeoutSec).toBe(5);
    expect(entries[2].shell).toBe('powershell');
    expect(entries.every((e) => e.pluginRoot === 'C:\\plug' && e.source === 'plug@market')).toBe(true);
  });

  it('skips what is not the documented shape instead of throwing', () => {
    expect(hooksFromConfig(null, 's', 'settings')).toEqual([]);
    expect(hooksFromConfig({ Stop: 'nope', PreToolUse: [null, { hooks: 'x' }, { hooks: [7] }] }, 's', 'settings')).toEqual([]);
  });
});

describe('untimedReason', () => {
  it('lets a plain command hook on a probed tool through', () => {
    expect(untimedReason(hook(), undefined)).toBeNull();
  });

  it('names why a hook is not run', () => {
    expect(untimedReason(hook({ type: 'prompt', command: '' }), undefined)).toContain('prompt');
    expect(untimedReason(hook({ shell: 'powershell' }), undefined)).toContain('powershell');
    expect(untimedReason(hook({ command: 'node sonar.mjs' }), 'sonar')).toBe('skipped by --skip');
    expect(untimedReason(hook({ matcher: 'EnterPlanMode' }), undefined)).toContain('probed tools');
  });
});

describe('verdictFor', () => {
  it('keeps a node hook on top of one shell start as ok', () => {
    expect(verdictFor(70)).toBe('ok');
    expect(verdictFor(100)).toBe('slow');
    expect(verdictFor(300)).toBe('heavy');
  });
});

describe('median', () => {
  it('ignores one slow outlier', () => {
    expect(median([900, 30, 32])).toBe(32);
  });
});

describe('resolveHookShell', () => {
  it('prefers CLAUDE_CODE_GIT_BASH_PATH, then the Git install dirs, on Windows', () => {
    const env = { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\git\\bash.exe', ProgramFiles: 'C:\\Program Files' };
    expect(resolveHookShell(env, 'win32', () => true)).toBe('D:\\git\\bash.exe');
    const only = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(resolveHookShell(env, 'win32', (f) => f === only)).toBe(only);
  });

  it('answers null when no shell is installed', () => {
    expect(resolveHookShell({}, 'win32', () => false)).toBeNull();
  });

  it('uses bash by absolute path elsewhere', () => {
    expect(resolveHookShell({}, 'linux', (f) => f === '/usr/bin/bash')).toBe('/usr/bin/bash');
  });
});

describe('discoverHooks and buildReport', () => {
  let dir: string;
  let configDir: string;
  let cwd: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-perf-'));
    configDir = path.join(dir, 'claude');
    cwd = path.join(dir, 'project');
    const plugin = path.join(dir, 'plugin-on');
    const pluginOff = path.join(dir, 'plugin-off');
    for (const d of [path.join(configDir, 'plugins'), path.join(cwd, '.claude'), path.join(plugin, 'hooks'), path.join(pluginOff, 'hooks')]) {
      fs.mkdirSync(d, { recursive: true });
    }
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
      enabledPlugins: { 'on@m': true, 'off@m': true },
      statusLine: { type: 'command', command: 'echo status' },
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }, { type: 'command', command: 'true', async: true }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'exit 3' }] }],
      },
    }));
    // The project file is more specific, so it turns the second plugin off.
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'off@m': false } }));
    fs.writeFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'on@m': [{ scope: 'user', installPath: plugin }, { scope: 'project', installPath: plugin }],
        'off@m': [{ scope: 'user', installPath: pluginOff }],
      },
    }));
    const pluginHooks = { hooks: { PreToolUse: [{ matcher: 'mcp__x__.*', hooks: [{ type: 'command', command: 'true' }] }] } };
    fs.writeFileSync(path.join(plugin, 'hooks', 'hooks.json'), JSON.stringify(pluginHooks));
    fs.writeFileSync(path.join(pluginOff, 'hooks', 'hooks.json'), JSON.stringify(pluginHooks));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads settings and enabled plugins, once per install path', () => {
    const found = discoverHooks(configDir, cwd);
    expect(found.statuslineCommand).toBe('echo status');
    expect(found.hooks.map((h) => `${h.sourceKind}:${h.event}`)).toEqual([
      'settings:PostToolUse', 'settings:PostToolUse', 'settings:Stop', 'plugin:PreToolUse',
    ]);
  });

  it('with --no-run lists every blocking hook and runs none', () => {
    const report = buildReport({ runs: 1, cwd, configDir, run: false });
    expect(report.shell).toBeNull();
    expect(report.timed).toEqual([]);
    expect(report.untimed.map((u) => u.reason)).toEqual(['not run', 'matches none of the probed tools']);
    expect(report.otherSync).toEqual({ Stop: 1 });
    expect(report.asyncCount).toBe(1);
    expect(formatReport(report)).toContain('No hook was run');
  });
});

describe('formatReport', () => {
  it('names the slow hooks and where to change each one', () => {
    const report: PerfReport = {
      shell: '/bin/bash',
      floorMs: 30,
      runs: 3,
      timed: [
        { hook: hook({ source: 'p@m', sourceKind: 'plugin', matcher: 'Edit|Write', command: 'slow.sh' }), probeTool: 'Edit', ms: 420, exitCode: 0, timedOut: false, verdict: 'heavy' },
        { hook: hook({ source: 'C:\\u\\settings.json', matcher: 'Bash', command: 'missing.sh' }), probeTool: 'Bash', ms: 36, exitCode: 127, timedOut: false, verdict: 'ok' },
      ],
      untimed: [],
      otherSync: { Stop: 2 },
      asyncCount: 4,
      perTool: [{ tool: 'Bash', ms: 36, hooks: 1 }, { tool: 'Edit', ms: 420, hooks: 1 }],
      statusline: { command: 'x', ms: 250 },
    };
    const text = formatReport(report);
    expect(text).toContain('420 ms  heavy  PostToolUse [Edit|Write]  plugin p@m');
    expect(text).toContain('exit 127');
    expect(text).toContain('(1 hook)');
    expect(text).toContain('plugin p@m: disable it with /plugin');
    expect(text).toContain('C:\\u\\settings.json: add "async": true');
    expect(text).toContain('Stop 2');
  });

  it('says so when nothing is slow', () => {
    const report: PerfReport = {
      shell: '/bin/bash', floorMs: 30, runs: 3, timed: [], untimed: [], otherSync: {}, asyncCount: 0, perTool: [], statusline: null,
    };
    expect(formatReport(report)).toContain('Nothing to fix');
  });
});

describe('perfOptions', () => {
  const parse = (...tokens: string[]) =>
    parseFlagArgs(tokens, { value: ['--runs', '--skip'], bool: ['--no-run', '--json'] });

  it('defaults to three runs and running the hooks', () => {
    expect(perfOptions(parse(), '/p', '/c')).toEqual({ runs: 3, skip: undefined, cwd: '/p', configDir: '/c', run: true });
  });

  it('passes --skip and --no-run through', () => {
    expect(perfOptions(parse('--skip', 'sonar', '--no-run'), '/p', '/c')).toMatchObject({ skip: 'sonar', run: false });
  });

  it('refuses a run count that is not a whole number from 1 to 20', () => {
    for (const bad of ['0', '21', '2.5', 'many']) {
      expect(perfOptions(parse('--runs', bad), '/p', '/c')).toHaveProperty('error');
    }
  });
});
