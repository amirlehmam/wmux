import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Issues #187 / #188 — the SHIPPED plugin, not a copy of its logic.
 *
 * resources/opencode-plugin/wmux.js is installed verbatim into
 * ~/.config/opencode/plugin/, so the file itself is the contract. It is loaded
 * here rather than reimplemented because #187 was a one-token bug
 * (`process.execPath`) that no test of a paraphrase would have caught.
 */
const calls: Array<{ file: string; argv: string[]; opts: any }> = [];

vi.mock('node:child_process', () => ({
  execFile: (file: string, argv: string[], opts: any, cb: any) => {
    calls.push({ file, argv, opts });
    if (typeof cb === 'function') cb(null, '', '');
  },
}));

const PLUGIN = path.resolve(__dirname, '../../resources/opencode-plugin/wmux.js');
const load = () => import(/* @vite-ignore */ PLUGIN);

/**
 * The plugin's helpers, which are deliberately NOT exports (#191): OpenCode
 * calls every export of a plugin file as a plugin factory. Reaching them
 * through the one real export is what keeps that surface at exactly one.
 */
const internals = async () => (await load()).WmuxPlugin.__wmuxInternals;

/** Every wmux CLI invocation the plugin made, as flat argv (minus the script). */
const verbs = () => calls.map((c) => c.argv.slice(1));

const SURFACE = 'surf-1';

async function pluginWith(env: Record<string, string> = {}) {
  Object.assign(process.env, {
    WMUX: '1',
    WMUX_SURFACE_ID: SURFACE,
    WMUX_CLI: 'C:\\wmux\\resources\\cli\\wmux.js',
    WMUX_NODE: process.execPath,
    ...env,
  });
  const { WmuxPlugin } = await load();
  return WmuxPlugin();
}

beforeEach(() => {
  calls.length = 0;
  for (const k of [
    'WMUX',
    'WMUX_SURFACE_ID',
    'WMUX_CLI',
    'WMUX_NODE',
    'WMUX_NODE_ELECTRON',
    'WMUX_PLUGIN_DEBUG',
  ]) {
    delete process.env[k];
  }
});

describe('the plugin file itself', () => {
  const src = fs.readFileSync(PLUGIN, 'utf8');

  it('carries a version marker, or wmux cannot know to reinstall it', () => {
    // pluginNeedsUpdate() compares this; an install stuck on v4 keeps #191.
    // v5 → v6 is #271: every v5 install is the file OpenCode v2 rejects.
    expect(src).toMatch(/wmux-plugin-version:\s*6/);
  });

  it('exports WmuxPlugin and the default definition, NOTHING else (#191, #271)', async () => {
    // OpenCode v1's legacy loader calls every export as a plugin factory, then
    // invokes a `config` hook on the result. v3/v4 also exported four helpers,
    // so it called `summarize(ctx)`, got a string back, and crashed OpenCode at
    // startup on `null.config`. Helpers now hang off
    // WmuxPlugin.__wmuxInternals, which the loader never looks at.
    const mod = await load();
    expect(Object.keys(mod).sort()).toEqual(['WmuxPlugin', 'default']);
  });

  it('has the default definition BOTH OpenCode generations accept (#271)', async () => {
    // v2 rejects the file unless `default` is `{ id, effect | setup }`; v1
    // (>= 1.3.4) sees the `id`, calls `default.server` and stops calling every
    // export — which is what keeps WmuxPlugin from being invoked twice.
    const { default: def, WmuxPlugin } = await load();
    expect(def.id).toBe('wmux');
    expect(typeof def.setup).toBe('function');
    expect(def.server).toBe(WmuxPlugin);
    expect('effect' in def).toBe(false); // v2 would take the Effect branch instead
  });

  it('never logs to the console, which OpenCode\'s TUI swallows (#190)', () => {
    expect(src).not.toMatch(/console\.(error|log|warn)\s*\(/);
  });

  it('never spawns process.execPath as if it were a JS runtime (#187)', () => {
    expect(src).not.toMatch(/execFile\(\s*process\.execPath/);
  });

  it('no longer discards the error, which is why #187 was invisible', () => {
    expect(src).not.toMatch(/execFile\([^)]*\(\)\s*=>\s*\{\}\s*\)/);
  });
});

describe('resolveNodeRuntime (#187)', () => {
  const only = (...present: string[]) => (p: string) => present.includes(p);

  it('rejects opencode.exe and finds a real node instead', async () => {
    const { resolveNodeRuntime } = await internals();
    const nodePath = path.join('C:\\Program Files\\nodejs', 'node.exe');
    const runtime = resolveNodeRuntime(
      { ProgramFiles: 'C:\\Program Files' },
      'C:\\Users\\stefan\\.opencode\\bin\\opencode.exe',
      'win32',
      only(nodePath),
    );
    expect(runtime).toEqual({ file: nodePath, electron: false });
  });

  it('prefers WMUX_NODE — the only link that cannot come up empty', async () => {
    const { resolveNodeRuntime } = await internals();
    const runtime = resolveNodeRuntime(
      { WMUX_NODE: 'C:\\wmux\\wmux.exe', WMUX_NODE_ELECTRON: '1' },
      'C:\\x\\opencode.exe',
      'win32',
      only('C:\\wmux\\wmux.exe'),
    );
    expect(runtime).toEqual({ file: 'C:\\wmux\\wmux.exe', electron: true });
  });

  it('ignores a WMUX_NODE that no longer exists (stale env from an old install)', async () => {
    const { resolveNodeRuntime } = await internals();
    const runtime = resolveNodeRuntime({ WMUX_NODE: 'C:\\gone\\node.exe' }, 'C:\\x\\opencode.exe', 'win32', () => false);
    expect(runtime.file).toBe('node');
  });

  it('keeps using the host when the host is node — the Claude Code case', async () => {
    const { resolveNodeRuntime } = await internals();
    const runtime = resolveNodeRuntime({}, 'C:\\Program Files\\nodejs\\node.exe', 'win32', () => false);
    expect(runtime).toEqual({ file: 'C:\\Program Files\\nodejs\\node.exe', electron: false });
  });
});

describe('spawning', () => {
  it('runs the CLI through the resolved runtime, not the host binary', async () => {
    const p = await pluginWith();
    await p.event({ event: { type: 'message.part.updated' } });
    expect(calls[0].file).toBe(process.env.WMUX_NODE);
    expect(calls[0].argv[0]).toBe(process.env.WMUX_CLI);
  });

  it('sets ELECTRON_RUN_AS_NODE when the runtime is wmux itself', async () => {
    // Without it the same exe opens a second wmux window instead of running JS.
    const p = await pluginWith({ WMUX_NODE_ELECTRON: '1' });
    await p.event({ event: { type: 'message.part.updated' } });
    expect(calls[0].opts.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('does not set it otherwise', async () => {
    const p = await pluginWith();
    await p.event({ event: { type: 'message.part.updated' } });
    expect(calls[0].opts.env).toBeUndefined();
  });

  it('no-ops entirely outside wmux', async () => {
    delete process.env.WMUX;
    const { WmuxPlugin } = await load();
    expect(await WmuxPlugin()).toEqual({});
  });
});

describe('event mapping (#188)', () => {
  it('parks the pane on the human when a permission is asked', async () => {
    const p = await pluginWith();
    await p.event({ event: { type: 'permission.asked', properties: { title: 'Run migration?' } } });
    expect(verbs()).toEqual([['report-agent', '--surface', SURFACE, '--blocked', 'Run migration?']]);
  });

  it('releases it when the user replies', async () => {
    const p = await pluginWith();
    await p.event({ event: { type: 'question.asked' } });
    calls.length = 0;
    await p.event({ event: { type: 'question.replied' } });
    expect(verbs()[0]).toEqual(['report-agent', '--surface', SURFACE, '--unblocked']);
  });

  it('keeps the block when the ask\'s own tool part goes to "running" (#189)', async () => {
    // OpenCode emits message.part.updated ~17 ms after question.asked, for the
    // question tool itself. v3 read that as "the agent resumed" and unblocked,
    // so "Needs you" flashed for one frame and was gone before the user looked.
    const p = await pluginWith();
    await p.event({ event: { type: 'question.asked' } });
    calls.length = 0;
    await p.event({
      event: {
        type: 'message.part.updated',
        properties: { part: { type: 'tool', tool: 'question', state: { status: 'running' } } },
      },
    });
    expect(verbs().filter((v) => v.includes('--unblocked'))).toEqual([]);
    // Still tells wmux the pane is alive — only the unblock is withdrawn.
    expect(verbs()).toEqual([['agent-activity', '--surface', SURFACE, '--active']]);
  });

  it('self-heals on real tool work, which is what the unblock now rests on', async () => {
    // The unblock depends on OpenCode emitting a matching *.replied. If it ever
    // does not, a pane claiming "Needs you" forever is worse than no indicator.
    const p = await pluginWith();
    await p.event({ event: { type: 'permission.asked' } });
    calls.length = 0;
    await p['tool.execute.before']({ tool: 'bash' });
    expect(verbs()[0]).toEqual(['report-agent', '--surface', SURFACE, '--unblocked']);
  });

  it('self-heals on session.error too', async () => {
    const p = await pluginWith();
    await p.event({ event: { type: 'permission.asked' } });
    calls.length = 0;
    await p.event({ event: { type: 'session.error' } });
    expect(verbs()[0]).toEqual(['report-agent', '--surface', SURFACE, '--unblocked']);
  });

  it('only unblocks once', async () => {
    const p = await pluginWith();
    await p.event({ event: { type: 'permission.asked' } });
    await p.event({ event: { type: 'permission.replied' } });
    calls.length = 0;
    await p.event({ event: { type: 'permission.replied' } });
    expect(verbs().filter((v) => v.includes('--unblocked'))).toEqual([]);
  });

  it('does NOT unblock on session.idle — a pane awaiting a prompt IS idle', async () => {
    const p = await pluginWith();
    await p.event({ event: { type: 'permission.asked' } });
    calls.length = 0;
    await p.event({ event: { type: 'session.idle' } });
    expect(verbs()).toEqual([['agent-activity', '--surface', SURFACE, '--done']]);
  });

  it('falls back to a generic reason when the event carries no text', async () => {
    const p = await pluginWith();
    await p.event({ event: { type: 'permission.asked' } });
    expect(verbs()[0][4]).toBe('Permission requested');
  });

  it('reads a nested reason and caps its length', async () => {
    const { askReason } = await internals();
    expect(askReason({ type: 'question.asked', properties: { question: { text: 'Which?' } } })).toBe('Which?');
    expect(askReason({ type: 'question.asked', properties: { title: 'x'.repeat(500) } })).toHaveLength(200);
  });

  it('feeds the diff view on file.edited', async () => {
    const p = await pluginWith();
    await p.event({ event: { type: 'file.edited', properties: { file: 'src/a.ts' } } });
    expect(verbs()[0]).toEqual(['hook', '--event', 'PostToolUse', '--tool', 'Edit']);
  });

  it('marks a new session active', async () => {
    const p = await pluginWith();
    await p.event({ event: { type: 'session.created' } });
    expect(verbs()[0]).toEqual(['agent-activity', '--surface', SURFACE, '--active']);
  });

  it('ignores events it does not map, without throwing', async () => {
    const p = await pluginWith();
    await p.event({ event: { type: 'session.compacted' } });
    await p.event({ event: {} });
    await p.event({ event: null });
    expect(calls).toEqual([]);
  });
});

describe('debug logging (#190)', () => {
  const logPath = () => path.join(os.tmpdir(), `wmux-plugin-test-${process.pid}.log`);
  const readLog = () => (fs.existsSync(logPath()) ? fs.readFileSync(logPath(), 'utf8') : '');

  beforeEach(() => {
    if (fs.existsSync(logPath())) fs.unlinkSync(logPath());
  });

  describe('resolveDebugLog', () => {
    it('is off unless asked for', async () => {
      const { resolveDebugLog } = await internals();
      for (const v of [undefined, '', '  ', '0', 'false', 'FALSE']) {
        expect(resolveDebugLog(v)).toBeNull();
      }
    });

    it('puts the default log somewhere both the user and the agent can read it', async () => {
      const { resolveDebugLog } = await internals();
      const fakeTmp = path.join('scratch', 'tmpdir-stub');
      const expected = path.join(fakeTmp, 'wmux-plugin-debug.log');
      expect(resolveDebugLog('1', () => fakeTmp)).toBe(expected);
      expect(resolveDebugLog('true', () => fakeTmp)).toBe(expected);
    });

    it('treats any other value as an explicit path', async () => {
      const { resolveDebugLog } = await internals();
      expect(resolveDebugLog('/var/log/wmux.log')).toBe('/var/log/wmux.log');
      expect(resolveDebugLog(' C:\\Users\\me\\wmux.log ')).toBe('C:\\Users\\me\\wmux.log');
    });
  });

  describe('summarize', () => {
    it('caps length so one event cannot flood the log', async () => {
      const { summarize } = await internals();
      expect(summarize('x'.repeat(500))).toHaveLength(301); // 300 + ellipsis
    });

    it('survives a circular event payload rather than throwing into OpenCode', async () => {
      const { summarize } = await internals();
      const circular: any = { a: 1 };
      circular.self = circular;
      expect(() => summarize(circular)).not.toThrow();
      expect(summarize(circular)).toContain('object');
    });
  });

  it('records init, events and CLI calls — the chain #189 was diagnosed with', async () => {
    const p = await pluginWith({ WMUX_PLUGIN_DEBUG: logPath() });
    await p.event({ event: { type: 'question.asked', properties: { title: 'Which one?' } } });
    const log = readLog();
    expect(log).toContain('init');
    expect(log).toContain(SURFACE);
    expect(log).toContain('event');
    expect(log).toContain('question.asked');
    expect(log).toContain('cli');
    expect(log).toContain('--blocked');
    // The ordering of event → CLI call is the diagnostic; keep the writes sync.
    expect(log.indexOf('question.asked')).toBeLessThan(log.indexOf('--blocked'));
  });

  it('says so when it loaded but did nothing — the commonest silent failure', async () => {
    process.env.WMUX_PLUGIN_DEBUG = logPath();
    const { WmuxPlugin } = await load();
    expect(await WmuxPlugin()).toEqual({});
    expect(readLog()).toContain('init: inactive');
  });

  it('writes nothing at all when the flag is off', async () => {
    const p = await pluginWith();
    await p.event({ event: { type: 'question.asked' } });
    expect(readLog()).toBe('');
  });

  it('never lets a bad log path take OpenCode down', async () => {
    // A directory that does not exist, on purpose.
    const p = await pluginWith({ WMUX_PLUGIN_DEBUG: path.join(os.tmpdir(), 'no', 'such', 'd.log') });
    await expect(p.event({ event: { type: 'question.asked' } })).resolves.not.toThrow();
    expect(verbs()[0][3]).toBe('--blocked');
  });
});

/**
 * A stand-in for OpenCode v2's promise `Context`, holding exactly the three
 * domains the plugin touches. `push` feeds the event stream the way
 * `ctx.event.subscribe` would.
 */
function fakeV2Context() {
  const hooks: Record<string, (e: any) => unknown> = {};
  const disposed: string[] = [];
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  let signal: AbortSignal | undefined;
  const hook = (domain: string) => async (name: string, cb: (e: any) => unknown) => {
    hooks[`${domain}.${name}`] = cb;
    return {
      dispose: async () => {
        disposed.push(`${domain}.${name}`);
      },
    };
  };
  /** Resolves on the next push, or when the subscription is aborted. */
  const nextWake = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  const ctx = {
    tool: { hook: hook('tool') },
    shell: { hook: hook('shell') },
    event: {
      subscribe(options?: { signal?: AbortSignal }) {
        signal = options?.signal;
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal?.aborted) {
              if (queue.length) yield queue.shift();
              else await nextWake();
            }
          },
        };
      },
    },
  };
  /** Deliver one v2 event and let the plugin's loop handle it. */
  const push = async (event: any) => {
    queue.push(event);
    wake?.();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return { ctx, hooks, disposed, push };
}

async function v2PluginWith(env: Record<string, string> = {}) {
  Object.assign(process.env, {
    WMUX: '1',
    WMUX_SURFACE_ID: SURFACE,
    WMUX_CLI: 'C:\\wmux\\resources\\cli\\wmux.js',
    WMUX_NODE: process.execPath,
    ...env,
  });
  const fake = fakeV2Context();
  const { default: def } = await load();
  const cleanup = await def.setup(fake.ctx);
  return { ...fake, cleanup };
}

describe('OpenCode v2 (#271)', () => {
  it('reports tool work through execute.before / execute.after', async () => {
    const { hooks, cleanup } = await v2PluginWith();
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', input: {} });
    await hooks['tool.execute.after']({ tool: 'edit', sessionID: 's', status: 'completed' });
    expect(verbs()).toEqual([
      ['agent-activity', '--surface', SURFACE, '--active', '--tool', 'bash'],
      ['hook', '--event', 'PostToolUse', '--tool', 'edit'],
      ['agent-activity', '--surface', SURFACE, '--active', '--tool', 'edit'],
    ]);
    await cleanup();
  });

  it('exports the wmux env into shells through create.before', async () => {
    const { hooks, cleanup } = await v2PluginWith();
    const input = { command: 'ls', cwd: '.', timeout: 0, shell: 'pwsh', env: {} as Record<string, string> };
    await hooks['shell.create.before'](input);
    expect(input.env.WMUX).toBe('1');
    expect(input.env.WMUX_SURFACE_ID).toBe(SURFACE);
    await cleanup();
  });

  it('turns a v2 permission.asked into "Needs you", reading `data` not `properties`', async () => {
    const { push, cleanup } = await v2PluginWith();
    await push({ type: 'permission.asked', data: { id: 'p', sessionID: 's', action: 'bash', resources: [], message: 'Run rm -rf build?' } });
    expect(verbs()).toEqual([['report-agent', '--surface', SURFACE, '--blocked', 'Run rm -rf build?']]);
    calls.length = 0;
    await push({ type: 'permission.replied', data: { sessionID: 's', requestID: 'p', reply: 'once' } });
    expect(verbs()[0]).toEqual(['report-agent', '--surface', SURFACE, '--unblocked']);
    await cleanup();
  });

  it('falls back to the permission action when there is no message', async () => {
    const { askReason } = await internals();
    expect(askReason({ type: 'permission.asked', properties: { action: 'webfetch', resources: [] } })).toBe('webfetch');
  });

  it('maps the end of a turn to done and a failed one to an error', async () => {
    // v2's core never publishes the deprecated session.idle: a turn ends with
    // exactly one session.execution.{succeeded,interrupted,failed}.
    const { push, cleanup } = await v2PluginWith();
    await push({ type: 'permission.asked', data: {} });
    calls.length = 0;
    await push({ type: 'session.execution.succeeded', data: { sessionID: 's' } });
    // Idle is NOT an unblock, exactly as on v1.
    expect(verbs()).toEqual([['agent-activity', '--surface', SURFACE, '--done']]);
    calls.length = 0;
    await push({ type: 'session.execution.failed', data: { sessionID: 's', error: {} } });
    expect(verbs()).toEqual([
      ['report-agent', '--surface', SURFACE, '--unblocked'],
      ['agent-activity', '--surface', SURFACE, '--done'],
    ]);
    await cleanup();
  });

  it('clears the block on an interrupt, which abandons the ask with the turn', async () => {
    const { push, cleanup } = await v2PluginWith();
    await push({ type: 'permission.asked', data: {} });
    calls.length = 0;
    await push({ type: 'session.execution.interrupted', data: { sessionID: 's', reason: 'user' } });
    expect(verbs()[0]).toEqual(['report-agent', '--surface', SURFACE, '--unblocked']);
    await cleanup();
  });

  it('reads session.status only when it says idle', async () => {
    const { fromV2Event } = await internals();
    expect(fromV2Event({ type: 'session.status', data: { status: { type: 'idle' } } }).type).toBe('session.idle');
    expect(fromV2Event({ type: 'session.status', data: { status: { type: 'busy' } } })).toBeNull();
  });

  it('pings on streaming deltas but never unblocks on them (#189)', async () => {
    const { fromV2Event } = await internals();
    expect(fromV2Event({ type: 'session.text.delta', data: {} }).type).toBe('message.part.updated');
    const { push, cleanup } = await v2PluginWith();
    await push({ type: 'permission.asked', data: {} });
    calls.length = 0;
    await push({ type: 'session.text.delta', data: { delta: 'x' } });
    expect(verbs()).toEqual([['agent-activity', '--surface', SURFACE, '--active']]);
    await cleanup();
  });

  it('does not treat filesystem.changed as an agent edit — the user saving a file must not clear "Needs you"', async () => {
    const { fromV2Event } = await internals();
    expect(fromV2Event({ type: 'filesystem.changed', data: { file: 'a.ts', event: 'change' } })).toBeNull();
  });

  it('registers nothing outside wmux', async () => {
    const fake = fakeV2Context();
    const { default: def } = await load();
    expect(await def.setup(fake.ctx)).toBeUndefined();
    expect(Object.keys(fake.hooks)).toEqual([]);
  });

  it('survives a context missing a domain rather than failing OpenCode startup', async () => {
    Object.assign(process.env, { WMUX: '1', WMUX_SURFACE_ID: SURFACE, WMUX_CLI: 'x.js', WMUX_NODE: process.execPath });
    const { default: def } = await load();
    const cleanup = await def.setup({});
    await expect(cleanup()).resolves.toBeUndefined();
  });

  it('cleanup stops the event loop and disposes every hook', async () => {
    const { push, disposed, cleanup } = await v2PluginWith();
    await cleanup();
    expect(disposed.sort()).toEqual(['shell.create.before', 'tool.execute.after', 'tool.execute.before']);
    calls.length = 0;
    await push({ type: 'session.idle', data: {} });
    expect(calls).toEqual([]);
  });
});

describe('shell.env', () => {
  it('passes the runtime down, or children re-derive it and hit #187', async () => {
    const p = await pluginWith({ WMUX_NODE_ELECTRON: '1' });
    const output = { env: {} as Record<string, string> };
    await p['shell.env']({}, output);
    expect(output.env.WMUX_NODE).toBe(process.env.WMUX_NODE);
    expect(output.env.WMUX_NODE_ELECTRON).toBe('1');
    expect(output.env.WMUX_SURFACE_ID).toBe(SURFACE);
  });
});
