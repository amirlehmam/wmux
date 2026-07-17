import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OrchAgentStatus, OrchWaveStatus, OrchRunStatus } from '../../src/shared/types';

const SCRIPTS = path.resolve(__dirname, '../../resources/wmux-orchestrator/scripts');
const HOOK = path.join(SCRIPTS, 'on-agent-stop.sh');
const JSON_TOOL = path.join(SCRIPTS, 'json-tool.js');

// The only status words the app understands. Typed against src/shared/types.ts so
// these arrays stop compiling if either union changes without this test noticing.
const AGENT_STATUSES: OrchAgentStatus[] = ['pending', 'running', 'exited', 'failed'];
const WAVE_STATUSES: OrchWaveStatus[] = ['pending', 'running', 'complete', 'failed'];
const RUN_STATUSES: OrchRunStatus[] = ['pending', 'running', 'complete', 'failed'];

let tmp: string;
let orchDir: string;

const readState = () => JSON.parse(fs.readFileSync(path.join(orchDir, 'state.json'), 'utf8'));

function writeState(overrides: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(orchDir, 'state.json'),
    JSON.stringify({
      id: 'test',
      task: 'test run',
      status: 'running',
      dashboardSurfaceId: null,
      waves: [{ status: 'running', agents: [{ id: 'a1', status: 'running', task: 'do a thing' }] }],
      ...overrides,
    }),
  );
}

// find_active_orch() scans $TMPDIR for wmux-orch-*/ dirs whose state.json is "running".
function runHook(agentId = 'a1', exitCode = '0'): void {
  execFileSync('bash', [HOOK], {
    env: { ...process.env, TMPDIR: tmp, WMUX_AGENT_ID: agentId, CLAUDE_EXIT_CODE: exitCode },
    encoding: 'utf8',
  });
}

const query = (...args: string[]): string =>
  execFileSync('node', [JSON_TOOL, 'query', path.join(orchDir, 'state.json'), ...args], {
    encoding: 'utf8',
  }).trim();

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-vocab-'));
  orchDir = path.join(tmp, 'wmux-orch-test');
  fs.mkdirSync(orchDir);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('on-agent-stop.sh status vocabulary (#99)', () => {
  it('marks a successful agent "exited" — the word the sidebar counts, not "completed"', () => {
    writeState();
    runHook();

    const agent = readState().waves[0].agents[0];
    expect(agent.status).toBe('exited');
    expect(agent.exitCode).toBe(0);
    expect(AGENT_STATUSES).toContain(agent.status);
  });

  it('marks the finished wave "complete", not "completed"', () => {
    writeState();
    runHook();

    const wave = readState().waves[0];
    expect(wave.status).toBe('complete');
    expect(WAVE_STATUSES).toContain(wave.status);
  });

  it('marks the finished run "complete" once every wave is done', () => {
    writeState();
    runHook();

    const state = readState();
    expect(state.status).toBe('complete');
    expect(RUN_STATUSES).toContain(state.status);
  });

  it('still records a failing agent as "failed" with its exit code', () => {
    writeState();
    runHook('a1', '3');

    const agent = readState().waves[0].agents[0];
    expect(agent.status).toBe('failed');
    expect(agent.exitCode).toBe(3);
    expect(AGENT_STATUSES).toContain(agent.status);
  });

  it('leaves an unfinished wave running while another agent is still going', () => {
    writeState({
      waves: [
        {
          status: 'running',
          agents: [
            { id: 'a1', status: 'running', task: 'one' },
            { id: 'a2', status: 'running', task: 'two' },
          ],
        },
      ],
    });
    runHook('a1');

    const state = readState();
    expect(state.waves[0].agents[0].status).toBe('exited');
    expect(state.waves[0].status).toBe('running');
    expect(state.status).toBe('running');
  });
});

describe('json-tool.js reads the same vocabulary it is written (#99)', () => {
  it('wave-complete treats "exited" agents as done', () => {
    writeState({
      waves: [{ status: 'running', agents: [{ id: 'a1', status: 'exited', exitCode: 0 }] }],
    });
    expect(query('wave-complete', '0')).toBe('true');
  });

  it('wave-complete treats a mix of "exited" and "failed" as done', () => {
    writeState({
      waves: [
        {
          status: 'running',
          agents: [
            { id: 'a1', status: 'exited', exitCode: 0 },
            { id: 'a2', status: 'failed', exitCode: 1 },
          ],
        },
      ],
    });
    expect(query('wave-complete', '0')).toBe('true');
  });

  it('wave-complete is false while an agent is still running', () => {
    writeState({
      waves: [
        {
          status: 'running',
          agents: [
            { id: 'a1', status: 'exited', exitCode: 0 },
            { id: 'a2', status: 'running' },
          ],
        },
      ],
    });
    expect(query('wave-complete', '0')).toBe('false');
  });
});

describe('no orchestrator script writes the pre-#99 "completed" status', () => {
  it('has no "status=completed" or bare "completed" status writes left', () => {
    const dir = SCRIPTS;
    const offenders: string[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (!/\.(sh|js)$/.test(file)) continue;
      const body = fs.readFileSync(path.join(dir, file), 'utf8');
      body.split('\n').forEach((line, i) => {
        if (line.trim().startsWith('#')) return;
        if (/status=completed|status === 'completed'|"status"\s*:\s*"completed"/.test(line)) {
          offenders.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
