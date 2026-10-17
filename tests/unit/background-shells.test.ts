import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'child_process';
import net from 'net';
import path from 'path';

const sendMock = vi.fn();
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: sendMock } }],
  },
}));

import { getActivity, clearActivity, markAllAgentsDone, reportSubagent, endDeclaredSubagents } from '../../src/main/claude-observer';
import {
  agentsForWorkspace, runningBackgroundShells, DECLARED_SUBAGENT_TTL_MS, BACKGROUND_SHELL_TTL_MS,
} from '../../src/renderer/store/agent-view';
import { resolveStatusText, statusClassFor, stateDotClassFor, type StatusTextInputs } from '../../src/renderer/components/Sidebar/workspace-status';
import { SplitNode, SurfaceId, PaneId } from '../../src/shared/types';

/**
 * Issue #276: Claude Code left tests running in the background ("2 shells still
 * running") and the pane read "Idle". Claude Code has no hook for a background
 * shell finishing; it reports one by feeding a `<task-notification>` to its next
 * turn, which fires UserPromptSubmit. These tests pin both ends of that.
 */

const HOOK_SCRIPT = path.resolve(__dirname, '../../resources/cli/wmux-hook.js');

function runHook(args: string[], port: number, stdin: string): Promise<void> {
  const env = {
    ...process.env,
    WMUX_REMOTE: `127.0.0.1:${port}`,
    WMUX_REMOTE_TOKEN: 't',
    WMUX_SURFACE_ID: 'surf-bg',
  } as Record<string, string>;
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [HOOK_SCRIPT, ...args], { env, timeout: 15000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
    child.stdin?.end(stdin);
  });
}

/** One hook process → the `hook.event` params it sent. */
async function hookParams(args: string[], payload: unknown): Promise<Record<string, any>> {
  let deliver!: (frame: any) => void;
  const frame = new Promise<any>((r) => { deliver = r; });
  const server = net.createServer((socket) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (!data.includes('\n')) return;
      deliver(JSON.parse(data.trim()));
      socket.end();
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
  const addr = server.address();
  try {
    await runHook(args, typeof addr === 'object' && addr ? addr.port : 0, JSON.stringify(payload));
    return (await frame).params;
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

const NOTIFICATION = (id: string, status = 'completed') =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n` +
  `<output-file>C:\\tmp\\${id}.output</output-file>\n<status>${status}</status>\n` +
  `<summary>Background command "Run tests" completed (exit code 0)</summary>\n</task-notification>`;

describe('wmux-hook.js background shells (#276)', () => {
  it('reports the task id of a Bash call moved to the background, with its description', async () => {
    const params = await hookParams(['Bash'], {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'TOKEN=hunter2 npm test', description: 'Run the backend check', run_in_background: true },
      tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b71nbhepv' },
    });
    expect(params.bgTask).toBe('b71nbhepv');
    expect(params.bgTaskDetail).toBe('Run the backend check');
  });

  it('never sends the command line, even when there is no description', async () => {
    const params = await hookParams(['Bash'], {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'TOKEN=hunter2 npm test' },
      tool_response: { backgroundTaskId: 'b2' },
    });
    expect(params.bgTask).toBe('b2');
    expect(JSON.stringify(params)).not.toContain('hunter2');
  });

  it('reports nothing for a foreground call', async () => {
    const params = await hookParams(['Bash'], {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls', description: 'List' },
      tool_response: { stdout: 'a', stderr: '', interrupted: false },
    });
    expect(params.bgTask).toBeUndefined();
  });

  it('reads ended tasks off a task notification, and keeps it out of the prompt log', async () => {
    const params = await hookParams(['--event', 'UserPromptSubmit'], {
      hook_event_name: 'UserPromptSubmit',
      prompt: `${NOTIFICATION('b1')}\n${NOTIFICATION('b2', 'failed')}\n${NOTIFICATION('b3', 'running')}`,
    });
    expect(params.bgTasksEnded).toBe('b1,b2');
    expect(params.prompt).toBeUndefined();
  });

  it('still logs a real prompt that merely mentions the tag', async () => {
    const params = await hookParams(['--event', 'UserPromptSubmit'], {
      hook_event_name: 'UserPromptSubmit',
      prompt: `why did this arrive? ${NOTIFICATION('b9')}`,
    });
    expect(params.prompt).toContain('why did this arrive?');
    expect(params.bgTasksEnded).toBeUndefined();
  });

  it('ends a task stopped with TaskStop', async () => {
    const params = await hookParams(['--event', 'PreToolUse'], {
      hook_event_name: 'PreToolUse',
      tool_name: 'TaskStop',
      tool_input: { task_id: 'b71nbhepv' },
    });
    expect(params.bgTasksEnded).toBe('b71nbhepv');
  });

  it('flags a fresh Claude Code process, not a resume or a /clear', async () => {
    const fresh = await hookParams(['--event', 'SessionStart'], { hook_event_name: 'SessionStart', source: 'startup' });
    const cleared = await hookParams(['--event', 'SessionStart'], { hook_event_name: 'SessionStart', source: 'clear' });
    expect(fresh.freshSession).toBe('1');
    expect(cleared.freshSession).toBeUndefined();
  });
});

const surf = 'surf-bg' as SurfaceId;

function tree(): SplitNode {
  return { type: 'leaf', paneId: 'pane-1' as PaneId, surfaces: [{ id: surf, type: 'terminal' }], activeSurfaceIndex: 0 } as unknown as SplitNode;
}

function view(now = Date.now()) {
  return agentsForWorkspace(tree(), { [surf]: getActivity(surf) as any }, new Map(), now);
}

function startShell(id: string, detail = 'Run the backend check') {
  reportSubagent(surf, { id: `shell:${id}`, name: 'shell', detail, kind: 'shell', done: false });
}

describe('background shells in the sidebar (#276)', () => {
  beforeEach(() => { sendMock.mockClear(); clearActivity(surf); });

  it('draws a shell line but does not count it as an agent', () => {
    startShell('b1');
    const v = view();
    expect(v.shells).toBe(1);
    expect(v.running).toBe(0);
    expect(v.total).toBe(0);
    expect(v.lines[0]).toMatchObject({ name: 'shell', detail: 'Run the backend check', done: false, shell: true });
  });

  it('outlives the turn that started it', () => {
    startShell('b1');
    markAllAgentsDone(surf);
    expect(view().shells).toBe(1);
  });

  it('ends on its own notification, leaving the others running', () => {
    startShell('b1');
    startShell('b2');
    reportSubagent(surf, { id: 'shell:b1', done: true });
    expect(runningBackgroundShells(getActivity(surf) as any, Date.now())).toBe(1);
  });

  it('ends with the session', () => {
    startShell('b1');
    endDeclaredSubagents(surf);
    expect(view().shells).toBe(0);
  });

  it('is not dropped at the subagent silence TTL — a test suite is quiet while it runs', () => {
    startShell('b1');
    const later = Date.now() + DECLARED_SUBAGENT_TTL_MS * 3;
    expect(view(later).shells).toBe(1);
    expect(view(Date.now() + BACKGROUND_SHELL_TTL_MS + 1000).shells).toBe(0);
  });
});

describe('status text with background shells (#276)', () => {
  const t = (_k: string, fallback?: string) => fallback ?? _k;
  const base: StatusTextInputs = {
    runningAgentCount: 0,
    sessionCount: 1,
    workingSessions: 0,
    blockedSessions: 0,
    currentToolLabel: null,
    claudeIsIdle: true,
    shellState: 'running',
  };

  it('reads "Background" instead of "Idle" while shells run', () => {
    const s = { ...base, backgroundShellCount: 2 };
    expect(resolveStatusText(s, t as any)).toBe('Background · 2 shells');
    expect(statusClassFor(s)).toBe('workspace-row__status--working');
    expect(stateDotClassFor(s, false)).toBe('workspace-row__state-dot--running');
  });

  it('still reads "Idle" with none', () => {
    expect(resolveStatusText({ ...base, backgroundShellCount: 0 }, t as any)).toBe('Idle');
  });

  it('gives way to the agent working — a live tool label is the finer fact', () => {
    const s = { ...base, claudeIsIdle: false, workingSessions: 1, currentToolLabel: 'Reading file...', backgroundShellCount: 1 };
    expect(resolveStatusText(s, t as any)).toBe('Reading file...');
  });

  it('summarizes several idle sessions as background work', () => {
    const s = { ...base, sessionCount: 3, backgroundShellCount: 1 };
    expect(resolveStatusText(s, t as any)).toBe('Background · 1 shell');
    expect(statusClassFor(s)).toBe('workspace-row__status--working');
  });

  it('never outranks "Needs you"', () => {
    const s = { ...base, blockedSessions: 1, backgroundShellCount: 2 };
    expect(resolveStatusText(s, t as any)).toBe('Needs you');
  });
});

