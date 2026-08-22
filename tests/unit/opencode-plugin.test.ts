import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
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
  for (const k of ['WMUX', 'WMUX_SURFACE_ID', 'WMUX_CLI', 'WMUX_NODE', 'WMUX_NODE_ELECTRON']) {
    delete process.env[k];
  }
});

describe('the plugin file itself', () => {
  const src = fs.readFileSync(PLUGIN, 'utf8');

  it('carries a version marker, or wmux cannot know to reinstall it', () => {
    // pluginNeedsUpdate() compares this; an install stuck on v2 keeps the bug.
    expect(src).toMatch(/wmux-plugin-version:\s*3/);
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
    const { resolveNodeRuntime } = await load();
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
    const { resolveNodeRuntime } = await load();
    const runtime = resolveNodeRuntime(
      { WMUX_NODE: 'C:\\wmux\\wmux.exe', WMUX_NODE_ELECTRON: '1' },
      'C:\\x\\opencode.exe',
      'win32',
      only('C:\\wmux\\wmux.exe'),
    );
    expect(runtime).toEqual({ file: 'C:\\wmux\\wmux.exe', electron: true });
  });

  it('ignores a WMUX_NODE that no longer exists (stale env from an old install)', async () => {
    const { resolveNodeRuntime } = await load();
    const runtime = resolveNodeRuntime({ WMUX_NODE: 'C:\\gone\\node.exe' }, 'C:\\x\\opencode.exe', 'win32', () => false);
    expect(runtime.file).toBe('node');
  });

  it('keeps using the host when the host is node — the Claude Code case', async () => {
    const { resolveNodeRuntime } = await load();
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

  it('self-heals: streaming tokens prove the agent is not waiting on anyone', async () => {
    // The unblock depends on OpenCode emitting a matching *.replied. If it ever
    // does not, a pane claiming "Needs you" forever is worse than no indicator.
    const p = await pluginWith();
    await p.event({ event: { type: 'permission.asked' } });
    calls.length = 0;
    await p.event({ event: { type: 'message.part.updated' } });
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
    const { askReason } = await load();
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
