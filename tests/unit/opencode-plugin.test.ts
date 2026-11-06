import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
const execResults: Array<{ error?: Error | null; stdout?: string; stderr?: string }> = [];

vi.mock('node:child_process', () => ({
  execFile: (file: string, argv: string[], opts: any, cb: any) => {
    calls.push({ file, argv, opts });
    const result = execResults.shift() ?? { error: null, stdout: '', stderr: '' };
    if (typeof cb === 'function') cb(result.error ?? null, result.stdout ?? '', result.stderr ?? '');
  },
  execFileSync: (file: string, argv: string[], opts: any) => {
    calls.push({ file, argv, opts });
    return '';
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
const verbs = () => calls.map((c) => {
  const argv = c.argv.slice(1);
  // The ordering stamp is asserted separately; keep exact-shape assertions
  // readable.
  return argv.filter((x, i, a) => x !== '--seq' && a[i - 1] !== '--seq');
});

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
  execResults.length = 0;
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

afterEach(async () => {
  const { resetPendingReleases } = await internals();
  resetPendingReleases();
  vi.useRealTimers();
});

describe('the plugin file itself', () => {
  const src = fs.readFileSync(PLUGIN, 'utf8');

  it('carries a version marker, or wmux cannot know to reinstall it', () => {
    // pluginNeedsUpdate() compares this; an install stuck on v4 keeps #191.
    // v5 → v6 is #271: every v5 install is the file OpenCode v2 rejects.
    // v7 → v8 is #304: without the bump no installed copy gains the prompt hook.
    // v9 → v10 retries a lost session report, keeps a shared server's signals
    // out of the starter pane, and stops a reload from releasing the handle.
    expect(src).toMatch(/wmux-plugin-version:\s*10/);
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

  it('orders blocked and unblocked reports with an increasing seq', async () => {
    const p = await pluginWith();
    await p.event({ event: { type: 'permission.asked', properties: { title: 'Run?' } } });
    await p.event({ event: { type: 'permission.replied', properties: { requestID: 'per_1' } } });
    const blocked = calls.find((c) => c.argv.includes('--blocked'));
    const unblocked = calls.find((c) => c.argv.includes('--unblocked'));
    const seqOf = (c: any) => Number(c.argv[c.argv.indexOf('--seq') + 1]);
    expect(seqOf(unblocked)).toBeGreaterThan(seqOf(blocked));
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
 * A stand-in for OpenCode v2's promise `Context`, holding exactly the four
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
    session: { hook: hook('session') },
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

  /**
   * Issue #304 — the prompt log. Its only agent-side producer is a
   * `UserPromptSubmit` hook event, and until now nothing on the OpenCode side
   * ever sent one: the outline/Prompts pane/`wmux prompts` were empty for every
   * OpenCode pane, on every version.
   */
  it('forwards a submitted prompt to the prompt log (#304)', async () => {
    const { hooks, cleanup } = await v2PluginWith();
    await hooks['session.prompt']({ prompt: { text: 'fix the flaky test' }, sessionID: 's', messageID: 'msg_1' });
    expect(verbs()).toEqual([['hook', '--event', 'UserPromptSubmit', '--prompt', 'fix the flaky test']]);
    await cleanup();
  });

  it('reports one prompt per message, however many times admission reruns (#304)', async () => {
    // v2 documents prompt admission as retry-safe but NOT exactly-once; a
    // second entry for one prompt would put two jump marks on one line.
    const { hooks, cleanup } = await v2PluginWith();
    const event = { prompt: { text: 'again' }, sessionID: 's', messageID: 'msg_2' };
    await hooks['session.prompt'](event);
    await hooks['session.prompt'](event);
    expect(verbs()).toEqual([['hook', '--event', 'UserPromptSubmit', '--prompt', 'again']]);
    await cleanup();
  });

  it('drops an empty prompt — attachments alone are not a prompt (#304)', async () => {
    const { hooks, cleanup } = await v2PluginWith();
    await hooks['session.prompt']({ prompt: { text: '   ' }, sessionID: 's', messageID: 'msg_3' });
    await hooks['session.prompt']({ prompt: {}, sessionID: 's', messageID: 'msg_4' });
    await hooks['session.prompt']({ sessionID: 's', messageID: 'msg_5' });
    expect(calls).toEqual([]);
    await cleanup();
  });

  it('caps a pasted prompt at the 4000 chars wmux-hook.js uses (#304)', async () => {
    const { hooks, cleanup } = await v2PluginWith();
    await hooks['session.prompt']({ prompt: { text: 'x'.repeat(5000) }, sessionID: 's', messageID: 'msg_6' });
    const verb = verbs()[0];
    expect(verb.slice(0, 4)).toEqual(['hook', '--event', 'UserPromptSubmit', '--prompt']);
    expect(verb[4].length).toBe(4000);
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
    expect(disposed.sort()).toEqual(['session.prompt', 'shell.create.before', 'tool.execute.after', 'tool.execute.before']);
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

describe('session handle for restore (#290)', () => {
  // Real ids and shapes, captured from opencode-ai 1.18.35 and @opencode/cli
  // 2.0.24 running a task subagent.
  const PARENT = 'ses_ebee54158ffe0s9gKyn9y27AJz';
  const CHILD = 'ses_ebee52e87ffevI7qoPYR1XlB05';
  const reports = () => verbs()
    .filter((v) => v[0] === 'report-session' || v[0] === 'release-agent')
    // The ordering stamp is asserted separately; keep the existing exact-shape
    // assertions readable.
    .map((v) => v.filter((x, i, a) => x !== '--seq' && a[i - 1] !== '--seq'));

  /** Run with process.once('exit') captured, so the exit release can be fired by hand. */
  async function withExitHook<T>(fn: (fireExit: () => void) => Promise<T>): Promise<T> {
    const listeners: Array<() => void> = [];
    const spy = vi.spyOn(process, 'once').mockImplementation(((event: string, l: () => void) => {
      if (event === 'exit') listeners.push(l);
      return process;
    }) as any);
    try {
      return await fn(() => listeners.forEach((l) => l()));
    } finally {
      spy.mockRestore();
    }
  }

  it('reports the top-level session once and never a v1 subagent', async () => {
    await withExitHook(async () => {
      const hooks = await pluginWith();
      await hooks.event({ event: { type: 'session.created', properties: { sessionID: PARENT, info: { id: PARENT } } } });
      await hooks.event({ event: { type: 'message.updated', properties: { sessionID: PARENT, info: { sessionID: PARENT, parentID: 'msg_1411a6db00015oeUxf8Sfku2Ak' } } } });
      await hooks.event({ event: { type: 'session.created', properties: { sessionID: CHILD, info: { id: CHILD, parentID: PARENT } } } });
      await hooks.event({ event: { type: 'session.status', properties: { sessionID: CHILD, status: { type: 'busy' } } } });
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: PARENT } } });
      expect(reports()).toEqual([['report-session', PARENT, '--provider', 'opencode', '--surface', SURFACE]]);
    });
  });

  it('follows the user to another top-level session', async () => {
    await withExitHook(async () => {
      const hooks = await pluginWith();
      const OTHER = 'ses_ebee49dd7ffeliSGc2ATav2wlN';
      await hooks.event({ event: { type: 'session.status', properties: { sessionID: PARENT, status: {} } } });
      await hooks.event({ event: { type: 'session.status', properties: { sessionID: OTHER, status: {} } } });
      expect(reports().map((r) => r[1])).toEqual([PARENT, OTHER]);
    });
  });

  it('reads the mapped v2 session shape', async () => {
    const { sessionFacts } = await internals();
    expect(sessionFacts({ type: 'session.created', properties: { sessionID: PARENT, projectID: 'p' } }))
      .toEqual({ id: PARENT, child: false });
    expect(sessionFacts({ type: 'session.created', properties: { sessionID: CHILD, parentID: PARENT } }))
      .toEqual({ id: CHILD, child: true });
  });

  it('maps a raw v2 event to the shape sessionFacts reads', async () => {
    const { v2SessionSource } = await internals();
    expect(v2SessionSource({ type: 'session.created', data: { sessionID: PARENT, projectID: 'p' } }))
      .toEqual({ type: 'session.created', properties: { sessionID: PARENT, projectID: 'p' } });
    expect(v2SessionSource({ type: 'session.idle', properties: { sessionID: PARENT } }))
      .toEqual({ type: 'session.idle', properties: { sessionID: PARENT } });
    expect(v2SessionSource(null)).toBeNull();
  });

  it('leaves v2 session handles to the TUI half', async () => {
    // v2 has a TUI process per pane, and its TUI half knows which session is
    // being viewed. The server half cannot tell a background session from the
    // one on screen, so it must not write the restore handle.
    await withExitHook(async () => {
      const { push, cleanup } = await v2PluginWith();
      await push({ type: 'session.created', data: { sessionID: PARENT, projectID: 'p' } });
      await push({ type: 'session.inbox.enqueued', data: { sessionID: PARENT, inboxID: 'msg_x' } });
      await push({ type: 'session.created', data: { sessionID: CHILD, parentID: PARENT } });
      await push({ type: 'session.execution.started', data: { sessionID: CHILD } });
      expect(reports()).toEqual([]);
      await cleanup();
    });
  });

  it('releases the handle on exit, synchronously, and on deletion', async () => {
    await withExitHook(async (fireExit) => {
      const hooks = await pluginWith();
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: PARENT } } });
      calls.length = 0;
      fireExit();
      expect(reports()).toEqual([['release-agent', '--provider', 'opencode', '--session', PARENT, '--surface', SURFACE]]);
      expect(calls[0].opts.timeout).toBeGreaterThan(0);
    });
    await withExitHook(async (fireExit) => {
      const hooks = await pluginWith();
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: PARENT } } });
      await hooks.event({ event: { type: 'session.deleted', properties: { sessionID: PARENT, info: { id: PARENT } } } });
      calls.length = 0;
      fireExit();
      expect(reports()).toEqual([]);
    });
  });

  it("reports nothing pane-specific from OpenCode 2's shared background server", async () => {
    // `opencode serve --service` hosts every pane's sessions; its
    // WMUX_SURFACE_ID is just the pane that started it. The TUI half owns every
    // pane-specific signal for that server.
    const argv = process.argv;
    process.argv = [...argv, 'serve', '--service'];
    try {
      await withExitHook(async () => {
        const hooks = await pluginWith();
        expect(hooks.event).toBeUndefined();
        expect(hooks['shell.env']).toBeUndefined();
        expect(reports()).toEqual([]);
      });
    } finally {
      process.argv = argv;
    }
  });

  it('treats any `serve` invocation as shared, not only --service', async () => {
    // A plain `opencode serve --port 4096` is just as shared as --service. The
    // old check looked only for --service, so the server half would attribute
    // every pane's session to whoever started the server.
    const argv = process.argv;
    process.argv = [...argv, 'serve', '--port', '4096'];
    try {
      await withExitHook(async () => {
        const hooks = await pluginWith();
        expect(hooks.event).toBeUndefined();
        expect(reports()).toEqual([]);
      });
    } finally {
      process.argv = argv;
    }
  });

  it('treats a standalone private server as private, not shared', async () => {
    // `opencode --standalone` spawns `opencode serve --stdio --port 0`; that
    // server belongs to one TUI, so its session handle is attributable. Only a
    // serve without --stdio (and --service) is shared.
    const argv = process.argv;
    process.argv = [...argv, 'serve', '--stdio', '--port', '0'];
    try {
      await withExitHook(async () => {
        const hooks = await pluginWith();
        expect(hooks.event).toBeDefined();
        await hooks.event({ event: { type: 'session.created', properties: { sessionID: PARENT } } });
        expect(reports()).toHaveLength(1);
      });
    } finally {
      process.argv = argv;
    }
  });

  it('registers no pane-specific v2 hooks on a shared server', async () => {
    const argv = process.argv;
    process.argv = [...argv, 'serve'];
    try {
      const fake = fakeV2Context();
      const { default: def } = await load();
      const cleanup = await def.setup(fake.ctx);
      expect(cleanup).toBeUndefined();
      expect(fake.hooks).toEqual({});
      await fake.push({ type: 'permission.asked', data: { sessionID: PARENT } });
      expect(verbs()).toEqual([]);
    } finally {
      process.argv = argv;
    }
  });

  it('does not hold or release a v2 session handle', async () => {
    // The TUI half owns v2 handles, so dispose and exit have nothing to release
    // here — and a plugin reload therefore cannot clear the TUI's handle.
    await withExitHook(async (fireExit) => {
      const { push, cleanup } = await v2PluginWith();
      await push({ type: 'session.execution.started', data: { sessionID: PARENT } });
      calls.length = 0;
      await cleanup();
      fireExit();
      expect(reports()).toEqual([]);
    });
  });

  /** Let wmuxAsync's promise callbacks run after the mocked execFile resolves. */
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it('retries a report that never landed, then confirms it', async () => {
    vi.useFakeTimers();
    await withExitHook(async () => {
      execResults.push({ error: new Error('All pipe instances are busy') });
      const hooks = await pluginWith();
      await hooks.event({ event: { type: 'session.created', properties: { sessionID: PARENT } } });
      await flush();
      expect(reports()).toEqual([['report-session', PARENT, '--provider', 'opencode', '--surface', SURFACE]]);

      await vi.advanceTimersByTimeAsync(1000);
      await flush();
      expect(reports()).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(reports()).toHaveLength(2);
    });
  });

  it('does not retry a report the main process rejected', async () => {
    vi.useFakeTimers();
    await withExitHook(async () => {
      execResults.push({ stdout: '{"accepted":false}' });
      const hooks = await pluginWith();
      await hooks.event({ event: { type: 'session.created', properties: { sessionID: PARENT } } });
      await flush();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(reports()).toEqual([['report-session', PARENT, '--provider', 'opencode', '--surface', SURFACE]]);
    });
  });

  it('drops a pending retry when the user switches sessions', async () => {
    vi.useFakeTimers();
    await withExitHook(async () => {
      const OTHER = 'ses_ebee49dd7ffeliSGc2ATav2wlN';
      execResults.push({ error: new Error('All pipe instances are busy') });
      const hooks = await pluginWith();
      await hooks.event({ event: { type: 'session.created', properties: { sessionID: PARENT } } });
      await flush();
      await hooks.event({ event: { type: 'session.created', properties: { sessionID: OTHER } } });
      await flush();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(reports().map((r) => r[1])).toEqual([PARENT, OTHER]);
    });
  });

  it('reasserts a confirmed handle on a later turn, once per throttle window', async () => {
    vi.useFakeTimers();
    await withExitHook(async () => {
      const hooks = await pluginWith();
      await hooks.event({ event: { type: 'session.created', properties: { sessionID: PARENT } } });
      await flush();
      expect(reports()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(31_000);
      await hooks.event({ event: { type: 'session.status', properties: { sessionID: PARENT, status: { type: 'busy' } } } });
      await flush();
      expect(reports()).toHaveLength(2);
    });
  });

  it('cancels a pending retry when the session is deleted, and releases it', async () => {
    vi.useFakeTimers();
    await withExitHook(async () => {
      execResults.push({ error: new Error('All pipe instances are busy') });
      const hooks = await pluginWith();
      await hooks.event({ event: { type: 'session.created', properties: { sessionID: PARENT } } });
      await flush();
      await hooks.event({ event: { type: 'session.deleted', properties: { sessionID: PARENT, info: { id: PARENT } } } });
      await flush();
      expect(reports().some((r) => r[0] === 'release-agent')).toBe(true);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(reports().filter((r) => r[0] === 'report-session')).toHaveLength(1);
    });
  });

  it('tries again on a later event after the retry budget is exhausted', async () => {
    vi.useFakeTimers();
    await withExitHook(async () => {
      for (let i = 0; i < 5; i++) execResults.push({ error: new Error('All pipe instances are busy') });
      const hooks = await pluginWith();
      await hooks.event({ event: { type: 'session.created', properties: { sessionID: PARENT } } });
      await flush();
      await vi.advanceTimersByTimeAsync(1000);
      await flush();
      await vi.advanceTimersByTimeAsync(3000);
      await flush();
      await vi.advanceTimersByTimeAsync(10_000);
      await flush();
      expect(reports()).toHaveLength(4);

      // The next event is a new chance, not a permanently deduped id.
      await hooks.event({ event: { type: 'session.status', properties: { sessionID: PARENT, status: { type: 'busy' } } } });
      await flush();
      expect(reports()).toHaveLength(5);
    });
  });

  it('stamps reports with an increasing seq so a late report cannot win', async () => {
    vi.useFakeTimers();
    await withExitHook(async () => {
      const OTHER = 'ses_ebee49dd7ffeliSGc2ATav2wlN';
      const hooks = await pluginWith();
      await hooks.event({ event: { type: 'session.created', properties: { sessionID: PARENT } } });
      await hooks.event({ event: { type: 'session.created', properties: { sessionID: OTHER } } });
      await flush();
      const seqs = calls
        .filter((c) => c.argv[1] === 'report-session')
        .map((c) => Number(c.argv[c.argv.indexOf('--seq') + 1]));
      expect(seqs).toHaveLength(2);
      expect(seqs[1]).toBeGreaterThan(seqs[0]);
    });
  });

  it('releases after a v1 dispose when no new instance replaces it', async () => {
    vi.useFakeTimers();
    await withExitHook(async () => {
      const hooks = await pluginWith();
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: PARENT } } });
      await flush();
      calls.length = 0;
      hooks.__wmuxShutdown();
      // A dispose may be a reload: nothing may be released immediately.
      expect(reports()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1400);
      expect(reports()).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      expect(reports()).toEqual([['release-agent', '--provider', 'opencode', '--session', PARENT, '--surface', SURFACE]]);
    });
  });

  it('does not release when a v1 plugin is disposed for a reload', async () => {
    vi.useFakeTimers();
    await withExitHook(async () => {
      const hooks = await pluginWith();
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: PARENT } } });
      await flush();
      calls.length = 0;
      hooks.__wmuxShutdown();
      // The replacement instance starts before the delayed release fires.
      await pluginWith();
      await vi.advanceTimersByTimeAsync(2000);
      expect(reports()).toEqual([]);
    });
  });

  it('releases once when dispose is followed by a real exit', async () => {
    vi.useFakeTimers();
    await withExitHook(async (fireExit) => {
      const hooks = await pluginWith();
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: PARENT } } });
      await flush();
      calls.length = 0;
      hooks.__wmuxShutdown();
      expect(reports()).toEqual([]);
      fireExit();
      expect(reports()).toEqual([['release-agent', '--provider', 'opencode', '--session', PARENT, '--surface', SURFACE]]);
      expect(calls[0].opts.stdio).toBe('ignore');
      await vi.advanceTimersByTimeAsync(2000);
      expect(reports()).toHaveLength(1);
    });
  });

  it('ignores anything that is not an OpenCode session id', async () => {
    const { sessionFacts } = await internals();
    expect(sessionFacts({ type: 'message.updated', properties: { info: { sessionID: PARENT, parentID: 'msg_1' } } })).toEqual({ id: PARENT, child: false });
    await withExitHook(async () => {
      const hooks = await pluginWith();
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: '; rm -rf /' } } });
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's' } } });
      expect(reports()).toEqual([]);
    });
  });
});
