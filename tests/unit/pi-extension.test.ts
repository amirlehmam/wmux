import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';

/**
 * Issue #231 — the SHIPPED extension, not a copy of its logic.
 *
 * resources/pi-extension/wmux.js is installed verbatim into
 * ~/.pi/agent/extensions/, so the file itself is the contract. Loaded here for
 * the same reason the OpenCode plugin is (#187): that bug was one token
 * (`process.execPath`) and no test of a paraphrase would have caught it.
 */
const calls: Array<{ file: string; argv: string[]; opts: any; cb: any }> = [];
/** Set when a test wants to decide for itself when the CLI call finishes. */
let holdCallbacks = false;

vi.mock('node:child_process', () => ({
  execFile: (file: string, argv: string[], opts: any, cb: any) => {
    calls.push({ file, argv, opts, cb });
    if (!holdCallbacks && typeof cb === 'function') cb(null, '', '');
  },
}));

const EXTENSION = path.resolve(__dirname, '../../resources/pi-extension/wmux.js');
const OPENCODE_PLUGIN = path.resolve(__dirname, '../../resources/opencode-plugin/wmux.js');

const load = () => import(/* @vite-ignore */ EXTENSION);

const SURFACE = 'surf-1';
const CLI = 'C:\\wmux\\resources\\cli\\wmux.js';

/** Every wmux CLI invocation the extension made, as flat argv minus the script. */
const verbs = () => calls.map((c) => c.argv.slice(1));

type Handler = (event: any, ctx?: any) => any;

/** A stand-in for pi's ExtensionAPI that records what the extension subscribes to. */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  return {
    api: { on: (name: string, fn: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); } },
    handlers,
    fire: async (name: string, event: any = {}, ctx: any = {}) => {
      for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
    },
    has: (name: string) => handlers.has(name),
  };
}

async function extensionWith(env: Record<string, string | undefined> = {}) {
  Object.assign(process.env, {
    WMUX: '1',
    WMUX_SURFACE_ID: SURFACE,
    WMUX_CLI: CLI,
    WMUX_NODE: process.execPath,
    ...env,
  });
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  const factory = (await load()).default;
  const pi = fakePi();
  factory(pi.api);
  return pi;
}

const savedEnv = { ...process.env };

beforeEach(() => {
  calls.length = 0;
  holdCallbacks = false;
});

afterEach(() => {
  for (const key of ['WMUX', 'WMUX_SURFACE_ID', 'WMUX_CLI', 'WMUX_NODE', 'WMUX_NODE_ELECTRON']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.useRealTimers();
});

describe('#231 pi extension: activation', () => {
  it('is completely inert outside wmux', async () => {
    // pi loads global extensions for every session on the machine, including
    // ones started from a plain terminal. Registering handlers there would
    // spawn a CLI process per event for a wmux that is not running.
    const pi = await extensionWith({ WMUX: '0' });
    expect(pi.handlers.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it('is inert with no surface id', async () => {
    const pi = await extensionWith({ WMUX_SURFACE_ID: undefined });
    expect(pi.handlers.size).toBe(0);
  });

  it('runs the CLI through WMUX_NODE, never the host binary (#187)', async () => {
    // pi also ships as a compiled single-executable binary, where
    // process.execPath is `pi` and handing it a .js file prints pi's help and
    // exits 1 — silently, which is how #187 survived a whole release line.
    const pi = await extensionWith();
    await pi.fire('agent_start');
    expect(calls[0].file).toBe(process.execPath);
    expect(calls[0].argv[0]).toBe(CLI);
  });

  it('declares ELECTRON_RUN_AS_NODE when the runtime is wmux itself', async () => {
    const pi = await extensionWith({ WMUX_NODE_ELECTRON: '1' });
    await pi.fire('agent_start');
    expect(calls[0].opts.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

describe('#231 pi extension: run state', () => {
  it('states depth absolutely rather than incrementing a refcount', async () => {
    // The whole reason this is `--run-depth` and not `--run-start`/`--run-end`.
    // pi's own docs: agent_end "fires when that run ends, but Pi may still
    // auto-retry, auto-compact and retry, or continue with queued follow-up
    // messages" — so one settle can follow several starts. A refcount would
    // never return to zero and the pane would be pinned on "working", which is
    // the exact bug #231 reports, reintroduced one layer down.
    const pi = await extensionWith();
    await pi.fire('agent_start');
    await pi.fire('agent_start');
    await pi.fire('agent_start');
    await pi.fire('agent_settled');

    const depths = verbs().filter((v) => v.includes('--run-depth'));
    expect(depths.every((v) => v[0] === 'report-agent')).toBe(true);
    expect(depths[depths.length - 1].slice(-2)).toEqual(['--run-depth', '0']);
    expect(verbs().some((v) => v.includes('--run-start') || v.includes('--run-end'))).toBe(false);
  });

  it('does not call the pane idle on agent_end', async () => {
    // agent_end is deliberately not handled: pi may still retry or drain queued
    // follow-ups after it, so reporting idle there flickers the sidebar through
    // "done" in the middle of work that is still running.
    const pi = await extensionWith();
    expect(pi.has('agent_end')).toBe(false);
  });

  it('starts a restored session from a stated idle', async () => {
    // Both halves matter, and the unblock is the one a rebind needs: pi tears
    // the old extension instance down and stands a new one up around /new,
    // /resume, /fork and /reload, so this is the first chance the new instance
    // has to say the pane is no longer parked on anyone.
    const pi = await extensionWith();
    await pi.fire('session_start', { reason: 'resume' });
    expect(verbs()).toEqual([
      ['report-agent', '--surface', SURFACE, '--unblocked'],
      ['report-agent', '--surface', SURFACE, '--run-depth', '0'],
    ]);
  });
});

describe('#231 pi extension: parked on a human', () => {
  it('blocks on ui_prompt_start and unblocks on ui_prompt_end', async () => {
    const pi = await extensionWith();
    await pi.fire('ui_prompt_start', { kind: 'confirm', title: 'Overwrite config?' });
    expect(verbs()).toContainEqual([
      'report-agent', '--surface', SURFACE, '--blocked', 'Overwrite config?',
    ]);
    calls.length = 0;
    await pi.fire('ui_prompt_end', { kind: 'confirm' });
    expect(verbs()).toEqual([['report-agent', '--surface', SURFACE, '--unblocked']]);
  });

  it('falls back to the prompt kind when there is no title', async () => {
    const pi = await extensionWith();
    await pi.fire('ui_prompt_start', { kind: 'select' });
    expect(verbs()[0].slice(-1)).toEqual(['Waiting for your select']);
  });

  it('declares no choices it cannot know', async () => {
    // wmux's back-channel relays bytes the AGENT named; pi's ui_prompt_start
    // carries a kind and a title but never the options, so a choice invented
    // here would be a button that sends the wrong key.
    const pi = await extensionWith();
    await pi.fire('ui_prompt_start', { kind: 'select', title: 'Pick one' });
    expect(verbs().some((v) => v.includes('--choices'))).toBe(false);
  });

  it('clears unconditionally, without an instance-local blocked flag', async () => {
    // pi rebinds extensions across /new, /resume, /fork and /reload, so the
    // instance asked to clear a block is not always the one that declared it.
    // A flag guarding the clear would inherit `false` by being new and no-op,
    // stranding the pane on "Needs you" — the one failure that makes every
    // other pane's indicator untrustworthy too. This asserts the clear fires
    // from an instance that never saw the corresponding start.
    const pi = await extensionWith();
    await pi.fire('ui_prompt_end', { kind: 'confirm' });
    expect(verbs()).toEqual([['report-agent', '--surface', SURFACE, '--unblocked']]);
  });

  it('does not unblock on events that are not session or run boundaries', async () => {
    const pi = await extensionWith();
    await pi.fire('turn_end');
    await pi.fire('tool_execution_start', { toolName: 'bash' });
    await pi.fire('tool_execution_end', { toolName: 'bash' });
    expect(verbs().some((v) => v.includes('--unblocked'))).toBe(false);
  });

  it('self-heals through agent_start if an end is ever lost', async () => {
    // A new run cannot begin unless the human came back. It cannot fire
    // spuriously mid-prompt either: a prompt raised during a run is strictly
    // inside that run's already-emitted agent_start.
    const pi = await extensionWith();
    await pi.fire('ui_prompt_start', { kind: 'input', title: 'Name?' });
    calls.length = 0;
    await pi.fire('agent_start');
    expect(verbs()[0]).toEqual(['report-agent', '--surface', SURFACE, '--unblocked']);
  });

  it('does not treat tool activity as an answer (#189)', async () => {
    const pi = await extensionWith();
    await pi.fire('ui_prompt_start', { kind: 'confirm', title: 'Run it?' });
    calls.length = 0;
    await pi.fire('tool_execution_start', { toolName: 'bash' });
    await pi.fire('tool_execution_end', { toolName: 'bash' });
    expect(verbs().some((v) => v.includes('--unblocked'))).toBe(false);
  });
});

describe('#231 pi extension: activity and metadata', () => {
  it('throttles activity pings so a parallel tool batch is one spawn', async () => {
    const pi = await extensionWith();
    await pi.fire('tool_execution_start', { toolName: 'read' });
    await pi.fire('tool_execution_start', { toolName: 'read' });
    await pi.fire('tool_execution_start', { toolName: 'grep' });
    expect(verbs().filter((v) => v[0] === 'agent-activity')).toEqual([
      ['agent-activity', '--surface', SURFACE, '--active', '--tool', 'read'],
    ]);
  });

  it('refreshes the diff view only for tools that can have changed the tree', async () => {
    const pi = await extensionWith();
    for (const toolName of ['read', 'ls', 'grep', 'find']) {
      await pi.fire('tool_execution_end', { toolName });
    }
    expect(verbs().some((v) => v[0] === 'hook')).toBe(false);

    await pi.fire('tool_execution_end', { toolName: 'edit' });
    expect(verbs()).toContainEqual(['hook', '--event', 'PostToolUse', '--tool', 'edit']);
  });

  it('treats an unknown tool as possibly mutating', async () => {
    // A denylist is right here: an unknown tool is most likely a user-registered
    // one doing who-knows-what, and a spurious refresh costs a coalesced git
    // call while a missed one leaves the panel stale.
    const pi = await extensionWith();
    await pi.fire('tool_execution_end', { toolName: 'deploy_to_prod' });
    expect(verbs()).toContainEqual(['hook', '--event', 'PostToolUse', '--tool', 'deploy_to_prod']);
  });

  it('reports model and context usage', async () => {
    const pi = await extensionWith();
    await pi.fire('turn_end', {}, {
      model: { provider: 'anthropic', id: 'claude-opus-5' },
      getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21.4 }),
    });
    const meta = verbs().find((v) => v[0] === 'report-metadata');
    expect(meta).toEqual([
      'report-metadata', '--surface', SURFACE,
      '--model', 'anthropic/claude-opus-5',
      '--tokens', '42000',
      '--context-pct', '21',
      '--ttl', '600000',
    ]);
  });

  it('omits what pi does not know rather than overwriting it with a placeholder', async () => {
    // tokens and percent are independently nullable in pi — they go null right
    // after a compaction, before the next response re-establishes them. An
    // omitted flag leaves the previous value standing, which beats replacing a
    // real number with a guess.
    const pi = await extensionWith();
    await pi.fire('turn_end', {}, {
      model: { provider: 'openai', id: 'gpt-x' },
      getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
    });
    const meta = verbs().find((v) => v[0] === 'report-metadata');
    expect(meta).toEqual([
      'report-metadata', '--surface', SURFACE, '--model', 'openai/gpt-x', '--ttl', '600000',
    ]);
  });

  it('sends nothing at all when there is nothing to say', async () => {
    const pi = await extensionWith();
    await pi.fire('turn_end', {}, { getContextUsage: () => undefined });
    expect(verbs().some((v) => v[0] === 'report-metadata')).toBe(false);
  });

  it('survives a ctx that throws', async () => {
    const pi = await extensionWith();
    await expect(pi.fire('turn_end', {}, {
      model: { id: 'local' },
      getContextUsage: () => { throw new Error('no session'); },
    })).resolves.toBeUndefined();
    expect(verbs().find((v) => v[0] === 'report-metadata')).toEqual([
      'report-metadata', '--surface', SURFACE, '--model', 'local', '--ttl', '600000',
    ]);
  });
});

describe('#231 pi extension: shutdown', () => {
  it('releases the pane and waits for the call to land', async () => {
    // pi awaits session_shutdown handlers and then exits. Without the wait the
    // process can be gone before the spawn lands, leaving a pane declared
    // "working" with nothing alive left to correct it.
    holdCallbacks = true;
    const pi = await extensionWith();
    let settled = false;
    const pending = pi.fire('session_shutdown', { reason: 'quit' }).then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(verbs()).toEqual([['release-agent', '--surface', SURFACE]]);

    calls[0].cb(null, '', '');
    await pending;
    expect(settled).toBe(true);
  });

  it('gives up rather than hanging pi\'s exit on a wedged wmux', async () => {
    holdCallbacks = true;
    vi.useFakeTimers();
    const pi = await extensionWith();
    const pending = pi.fire('session_shutdown', { reason: 'quit' });
    await vi.advanceTimersByTimeAsync(2500);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe('#231 pi extension: the copied runtime resolver', () => {
  it('agrees with the OpenCode plugin it was copied from', async () => {
    // Both files are installed verbatim as a SINGLE file into another program's
    // config directory, so there is nowhere shared to import from and the
    // duplication is forced. A duplicate with no enforcement is a time bomb
    // (#137, #168) — so it is pinned here instead.
    const piResolve = (await load()).default.__wmuxInternals.resolveNodeRuntime;
    const ocResolve = (await import(/* @vite-ignore */ OPENCODE_PLUGIN))
      .WmuxPlugin.__wmuxInternals.resolveNodeRuntime;

    const cases: Array<[Record<string, string>, string, NodeJS.Platform]> = [
      [{ WMUX_NODE: process.execPath }, '/opt/pi/pi', 'linux'],
      [{ WMUX_NODE: process.execPath, WMUX_NODE_ELECTRON: '1' }, '/opt/pi/pi', 'linux'],
      [{ WMUX_NODE: '/definitely/not/here/node' }, process.execPath, 'linux'],
      [{}, '/usr/local/bin/pi', 'linux'],
      [{}, 'C:\\pi\\pi.exe', 'win32'],
    ];
    for (const [env, execPath, platform] of cases) {
      const exists = (p: string) => p === process.execPath;
      expect(piResolve(env, execPath, platform, exists))
        .toEqual(ocResolve(env, execPath, platform, exists));
    }
  });
});
