import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pluginNeedsUpdate } from '../../src/main/agent-plugin-file';
import type { SurfaceId } from '../../src/shared/types';
import factory from '../../resources/omp-extension/wmux.js';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
import { getAgentState, reportAgent, reportAgentSession, releaseAgent, resetAgentState } from '../../src/main/agent-state';
import { reportSubagent, getActivity, clearActivity, endDeclaredSubagents } from '../../src/main/claude-observer';

// Replace only process creation; keep wmux's real state resolver as the consumer.
let failNextExec = false;
vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _opts: unknown, done: Function) => {
    if (failNextExec) {
      failNextExec = false;
      done(new Error('simulated transient CLI failure'), '', '');
      return;
    }
    const flag = (name: string) => args[args.indexOf(name) + 1];
    const surface = flag('--surface') as SurfaceId;
    if (args[1] === 'report-session') {
      reportAgentSession(surface, {
        sessionId: args[2],
        provider: flag('--provider'),
      });
    } else if (args[1] === 'release-agent') {
      releaseAgent(surface);
      endDeclaredSubagents(surface);
    } else if (args[1] === 'report-subagent') {
      reportSubagent(surface, {
        id: args[2],
        name: args.includes('--name') ? flag('--name') : undefined,
        detail: args.includes('--detail') ? flag('--detail') : undefined,
        done: args.includes('--done'),
      });
    } else reportAgent(surface, {
      runDepth: Number(flag('--run-depth')),
      awaitingHuman: args.includes('--blocked'),
      reason: args.includes('--blocked') ? flag('--blocked') : undefined,
    });
    done(null, '', '');
  },
}));

const surface = 'surf-omp' as SurfaceId;
const savedEnv = { ...process.env };
let tick: () => unknown;
const shutdowns: (() => Promise<void>)[] = [];

async function start(kind = 'main', id = kind, parentId = 'main', smOverrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, (event: Record<string, unknown>, context: unknown) => unknown>();
  const sm = {
    getSessionFile: () => 'C:/Users/test/.omp/agent/sessions/--test--/session.jsonl',
    isSessionOnDisk: () => true,
    ...smOverrides,
  };
  const context = {
    agent: { kind, id, name: kind, depth: kind === 'main' ? 0 : 1, parentId: kind === 'main' ? undefined : parentId },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getAsyncJobSnapshot: () => ({ running: [] as { id: string }[], recent: [], delivery: {} }),
    setInterval: (fn: () => unknown) => { tick = fn; return 1; },
    clearTimer: vi.fn(),
    sessionManager: sm,
  };
  factory({ on: (name: string, handler: (event: Record<string, unknown>, context: unknown) => unknown) => handlers.set(name, handler) });
  const fire = async (name: string, event = {}) => {
    await handlers.get(name)?.(event, context);
    await new Promise((r) => setImmediate(r));
  };
  await fire('session_start');
  shutdowns.push(() => fire('session_shutdown'));
  return { context, fire };
}

beforeEach(() => {
  resetAgentState();
  clearActivity(surface);
  Object.assign(process.env, { WMUX: '1', WMUX_SURFACE_ID: surface, WMUX_CLI: 'wmux.js', WMUX_NODE: process.execPath });
});
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  for (const key of ['WMUX', 'WMUX_SURFACE_ID', 'WMUX_CLI', 'WMUX_NODE']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('omp declared state', () => {
  it('starts idle, runs during generation, and returns idle after the loop stops', async () => {
    const { context, fire } = await start();
    expect(getAgentState(surface)?.state).toBe('idle');
    context.isIdle = () => false;
    await fire('agent_start');
    expect(getAgentState(surface)?.state).toBe('working');
    context.isIdle = () => true;
    await fire('agent_end');
    expect(getAgentState(surface)?.state).toBe('idle');
  });

  it('does not declare idle while a background child is still running', async () => {
    const { context, fire } = await start();
    context.getAsyncJobSnapshot = () => ({ running: [{ id: 'child-1' }], recent: [], delivery: {} });
    await fire('agent_end');
    expect(getAgentState(surface)?.state).toBe('working');
    context.getAsyncJobSnapshot = () => ({ running: [], recent: [], delivery: {} });
    await tick();
    await new Promise((r) => setImmediate(r));
    expect(getAgentState(surface)?.state).toBe('idle');
  });

  it('a rebound child factory cannot clear the parent surface', async () => {
    const parent = await start();
    parent.context.isIdle = () => false;
    await parent.fire('agent_start');
    const child = await start('sub');
    await child.fire('agent_end');
    await child.fire('session_shutdown');
    expect(getAgentState(surface)?.state).toBe('working');
  });

  it('keeps a non-job-backed child working after the parent becomes idle', async () => {
    const parent = await start();
    const child = await start('sub');
    child.context.isIdle = () => false;
    await child.fire('agent_start');
    await parent.fire('agent_end');
    expect(getAgentState(surface)?.state).toBe('working');
    child.context.isIdle = () => true;
    await child.fire('agent_end');
    await tick();
    expect(getAgentState(surface)?.state).toBe('idle');
  });

  it('does not clear a second child when the first child exits', async () => {
    const parent = await start();
    const first = await start('sub', 'first');
    const second = await start('sub', 'second', 'first');
    second.context.isIdle = () => false;
    await second.fire('agent_start');
    await first.fire('session_shutdown');
    await parent.fire('agent_end');
    expect(getAgentState(surface)?.state).toBe('working');
    second.context.isIdle = () => true;
    await second.fire('session_shutdown');
    await first.fire('session_shutdown');
    expect(getAgentState(surface)?.state).toBe('idle');
  });

  it('lists concurrent children and finishes only the child that ended', async () => {
    const parent = await start();
    const first = await start('sub', 'RootHygiene');
    const second = await start('sub', 'ResearchAudit');
    first.context.isIdle = () => false;
    second.context.isIdle = () => false;
    await first.fire('agent_start');
    await second.fire('agent_start');
    expect(getActivity(surface)?.agents.filter(a => !a.done).map(a => a.name).sort())
      .toEqual(['ResearchAudit', 'RootHygiene']);
    await parent.fire('agent_end');
    expect(getActivity(surface)?.agents.filter(a => !a.done)).toHaveLength(2);
    first.context.isIdle = () => true;
    await first.fire('agent_end');
    expect(getActivity(surface)?.agents.filter(a => !a.done).map(a => a.name))
      .toEqual(['ResearchAudit']);
    await second.fire('session_shutdown');
    expect(getActivity(surface)?.agents.filter(a => !a.done)).toEqual([]);
  });

  it('reusing a finished child id revives it, and it can finish again', async () => {
    await start();
    const first = await start('sub', 'Scout');
    first.context.isIdle = () => false;
    await first.fire('agent_start');
    first.context.isIdle = () => true;
    await first.fire('agent_end');
    expect(getActivity(surface)!.agents.find(a => a.id === 'Scout')!.done).toBe(true);
    const revived = await start('sub', 'Scout');
    revived.context.isIdle = () => false;
    await revived.fire('agent_start');
    expect(getActivity(surface)!.agents.find(a => a.id === 'Scout')!.done).toBe(false);
    revived.context.isIdle = () => true;
    await revived.fire('agent_end');
    expect(getActivity(surface)!.agents.find(a => a.id === 'Scout')!.done).toBe(true);
  });

  it('keeps a human prompt blocked even while activity is running', async () => {
    const { context, fire } = await start();
    context.isIdle = () => false;
    await fire('agent_start');
    await fire('tool_approval_requested', { toolCallId: 'approve-1', toolName: 'bash' });
    await fire('turn_start');
    expect(getAgentState(surface)?.state).toBe('blocked');
    await fire('tool_approval_resolved', { toolCallId: 'approve-1' });
    expect(getAgentState(surface)?.state).toBe('working');
  });

  it('shutdown releases a still-working surface', async () => {
    const { context, fire } = await start();
    context.isIdle = () => false;
    await fire('agent_start');
    await fire('session_shutdown');
    expect(getAgentState(surface)).toBeUndefined();
  });

  it('reports on-disk session file at session_start and clears on shutdown', async () => {
    const file = 'C:/Users/test/.omp/agent/sessions/--test--/session-1.jsonl';
    const { fire } = await start('main', 'main', 'main', { getSessionFile: () => file, isSessionOnDisk: () => true });
    expect(getAgentState(surface)?.sessionId).toBe(file);
    expect(getAgentState(surface)?.sessionProvider).toBe('omp');

    await fire('session_shutdown');
    expect(getAgentState(surface)).toBeUndefined();
  });

  it('does not report lazy session before it hits disk, but reports once on disk at turn_end', async () => {
    let onDisk = false;
    const file = 'C:/Users/test/.omp/agent/sessions/--test--/session-lazy.jsonl';
    const { fire } = await start('main', 'main', 'main', {
      getSessionFile: () => file,
      isSessionOnDisk: () => onDisk,
    });
    // Lazy at start -> no session reported
    expect(getAgentState(surface)?.sessionId).toBeNull();

    // Lands on disk after turn 1
    onDisk = true;
    await fire('turn_end');
    expect(getAgentState(surface)?.sessionId).toBe(file);
    expect(getAgentState(surface)?.sessionProvider).toBe('omp');
  });

  it('updates session path on session_switch and session_branch', async () => {
    let currentFile = 'C:/Users/test/.omp/agent/sessions/--test--/first.jsonl';
    const { fire } = await start('main', 'main', 'main', {
      getSessionFile: () => currentFile,
      isSessionOnDisk: () => true,
    });
    expect(getAgentState(surface)?.sessionId).toBe(currentFile);

    currentFile = 'C:/Users/test/.omp/agent/sessions/--test--/second.jsonl';
    await fire('session_switch', { reason: 'resume' });
    expect(getAgentState(surface)?.sessionId).toBe(currentFile);

    currentFile = 'C:/Users/test/.omp/agent/sessions/--test--/branch.jsonl';
    await fire('session_branch', { reason: 'fork' });
    expect(getAgentState(surface)?.sessionId).toBe(currentFile);
  });

  it('subagents do not report their own session to the surface', async () => {
    const subFile = 'C:/Users/test/.omp/agent/sessions/--sub--/sub.jsonl';
    await start('sub', 'child-1', 'main', {
      getSessionFile: () => subFile,
      isSessionOnDisk: () => true,
    });
    expect(getAgentState(surface)?.sessionId).toBeUndefined();
  });

  it('pluginNeedsUpdate recognizes version 4 is newer than deployed version 3', () => {
    const extSrc = fs.readFileSync(path.join(__dirname, '../../resources/omp-extension/wmux.js'), 'utf-8');
    const deployedV3 = '// wmux-plugin-version: 3\n// old code';
    expect(pluginNeedsUpdate(extSrc, deployedV3)).toBe(true);
    expect(pluginNeedsUpdate(extSrc, extSrc)).toBe(false);
  });

  it('retries reporting session on subsequent turn if previous attempt failed', async () => {
    const file = 'C:/Users/test/.omp/agent/sessions/--test--/retry-session.jsonl';
    failNextExec = true; // First execFile fails
    const { fire } = await start('main', 'main', 'main', {
      getSessionFile: () => file,
      isSessionOnDisk: () => true,
    });
    // First attempt failed, so session was not saved in agent-state
    expect(getAgentState(surface)?.sessionId).toBeNull();

    // Subsequent turn succeeds
    await fire('turn_end');
    expect(getAgentState(surface)?.sessionId).toBe(file);
    expect(getAgentState(surface)?.sessionProvider).toBe('omp');
  });

  it('clears reported session handle when switched to a new session that is not yet on disk', async () => {
    let currentFile = 'C:/Users/test/.omp/agent/sessions/--test--/existing.jsonl';
    let onDisk = true;
    const { fire } = await start('main', 'main', 'main', {
      getSessionFile: () => currentFile,
      isSessionOnDisk: () => onDisk,
    });
    expect(getAgentState(surface)?.sessionId).toBe(currentFile);

    // Switch to a new lazy session
    currentFile = 'C:/Users/test/.omp/agent/sessions/--test--/lazy-new.jsonl';
    onDisk = false;
    await fire('session_switch', { reason: 'new' });
    // Old handle is cleared
    expect(getAgentState(surface)?.sessionId).toBeNull();
  });
});
