import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASH_TEST_TIMEOUT_MS, bashExists, forBash, hasBash } from '../helpers/bash-path';
import { createWmuxStub, removeWmuxStub, type WmuxStub } from '../helpers/wmux-stub';

const SCRIPTS = path.resolve(__dirname, '../../resources/wmux-orchestrator/scripts');
const STOP = path.join(SCRIPTS, 'on-stop.sh');
const STATE_LIB = path.join(SCRIPTS, 'orchestration-state.sh');

const stopPath = forBash(STOP);
const stateLibPath = forBash(STATE_LIB);
const canRun = hasBash() && bashExists(stopPath);

let base: string;
let stub: WmuxStub;

function writeRun(name: string, state: Record<string, unknown>): string {
  const dir = path.join(base, `wmux-orch-${name}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ id: name, task: 't', ...state }));
  return dir;
}

// The surface the hook runs in unless a test says otherwise: the coordinator's.
const COORD_SURFACE = 'surf-coord';

function finishedRun(name: string, extra: Record<string, unknown> = {}): string {
  return writeRun(name, {
    status: 'complete',
    coordinatorPaneId: 'pane-coord',
    coordinatorSurfaceId: COORD_SURFACE,
    waves: [
      {
        status: 'complete',
        agents: [{ id: `${name}-a1`, status: 'exited', wmuxAgentId: `agent-${name}`, surfaceId: `surf-${name}`, paneId: `pane-${name}` }],
      },
    ],
    ...extra,
  });
}

const readState = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

/** Run the hook as the session in `surface`; `null` is a session outside wmux. */
function stop(surface: string | null = COORD_SURFACE, on: WmuxStub = stub) {
  const env: Record<string, string> = { TMPDIR: forBash(base) };
  if (surface !== null) env.WMUX_SURFACE_ID = surface;
  return on.bash(`bash "${stopPath}"`, env);
}

/** `wmux list-panes` as the CLI prints it, with `surface` sitting in `paneId`. */
const panesWith = (paneId: string, surface: string) =>
  JSON.stringify({ panes: [{ paneId: 'pane-else', surfaces: [{ id: 'surf-else', type: 'terminal' }] }, { paneId, surfaces: [{ id: surface, type: 'terminal' }] }] });

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-final-reap-'));
  stub = createWmuxStub();
});

afterEach(() => {
  removeWmuxStub(stub);
  fs.rmSync(base, { recursive: true, force: true });
});

// Each hook run spawns several node processes under Git Bash: see BASH_TEST_TIMEOUT_MS.
const SLOW = BASH_TEST_TIMEOUT_MS;

describe.skipIf(!canRun)('on-stop.sh final reap', { timeout: SLOW }, () => {
  it('reaps a complete run once and marks it reaped', () => {
    const dir = finishedRun('one');
    stub.assertReachable();

    const first = stop();

    expect(first.status).toBe(0);
    expect(stub.calls()).toEqual(['ping', 'agent kill agent-one', 'close-surface surf-one']);
    expect(readState(dir).reapedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(readState(dir).waves[0].agents[0].reapedAt).toBeTruthy();

    stub.clearCalls();
    const second = stop();

    expect(second.status).toBe(0);
    expect(stub.calls()).toEqual([]);
  });

  // A failed or aborted run's panes are the evidence: the hook must not tear
  // them down the moment the run is marked, only an explicit cleanup.sh may.
  it.each(['aborted', 'failed'])('leaves a %s run alone, so its panes stay for inspection', (status) => {
    const dir = finishedRun('x', { status });
    stub.assertReachable();

    const r = stop();

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual([]);
    expect(readState(dir).reapedAt).toBeUndefined();
    expect(readState(dir).waves[0].agents[0].reapedAt).toBeUndefined();
  });

  it("does not reap another coordinator's run", () => {
    const theirs = finishedRun('theirs', { coordinatorSurfaceId: 'surf-other-coord', coordinatorPaneId: 'pane-other' });
    stub.assertReachable();

    const r = stop();

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual([]);
    expect(readState(theirs).reapedAt).toBeUndefined();
  });

  it("reaps its own run and leaves another coordinator's alone in the same call", () => {
    const mine = finishedRun('mine');
    const theirs = finishedRun('theirs', { coordinatorSurfaceId: 'surf-other-coord' });
    stub.assertReachable();

    stop();

    expect(stub.calls()).toEqual(['ping', 'agent kill agent-mine', 'close-surface surf-mine']);
    expect(readState(mine).reapedAt).toBeTruthy();
    expect(readState(theirs).reapedAt).toBeUndefined();
  });

  it('does nothing in a worker session, even for the run that worker belongs to', () => {
    const dir = finishedRun('one');
    stub.assertReachable();

    const r = stop('surf-one');

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual([]);
    expect(readState(dir).reapedAt).toBeUndefined();
  });

  it('does nothing in a session outside wmux (no WMUX_SURFACE_ID)', () => {
    const dir = finishedRun('one');
    stub.assertReachable();

    const r = stop(null);

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual([]);
    expect(readState(dir).reapedAt).toBeUndefined();
  });

  describe('a run that recorded only the coordinator pane', () => {
    const paneOnly = (name: string, pane = 'pane-coord') =>
      finishedRun(name, { coordinatorSurfaceId: undefined, coordinatorPaneId: pane });

    it('is reaped when the caller sits in that pane', () => {
      const dir = paneOnly('one');
      stub.reply('list-panes', { stdout: panesWith('pane-coord', COORD_SURFACE) });
      stub.assertReachable();

      stop();

      expect(stub.calls()).toEqual(['list-panes', 'ping', 'agent kill agent-one', 'close-surface surf-one']);
      expect(readState(dir).reapedAt).toBeTruthy();
    });

    it('is left alone when the caller sits in another pane', () => {
      const dir = paneOnly('one');
      stub.reply('list-panes', { stdout: panesWith('pane-elsewhere', COORD_SURFACE) });
      stub.assertReachable();

      stop();

      expect(stub.calls()).toEqual(['list-panes']);
      expect(readState(dir).reapedAt).toBeUndefined();
    });

    it.each([
      ['wmux cannot list the panes', { exit: 1, stderr: 'No window' }],
      ["the caller's surface is in none of them", { stdout: panesWith('pane-coord', 'surf-somebody-else') }],
      ['the reply is not JSON', { stdout: 'wmux: timed out' }],
    ])('is left alone when %s', (_why, reply) => {
      const dir = paneOnly('one');
      stub.reply('list-panes', reply);
      stub.assertReachable();

      const r = stop();

      expect(r.status).toBe(0);
      expect(stub.calls()).toEqual(['list-panes']);
      expect(readState(dir).reapedAt).toBeUndefined();
    });

    it("looks the caller's pane up once, however many runs need it", () => {
      const a = paneOnly('a');
      const b = paneOnly('b');
      const other = paneOnly('c', 'pane-other-coord');
      stub.reply('list-panes', { stdout: panesWith('pane-coord', COORD_SURFACE) });
      stub.assertReachable();

      stop();

      const calls = stub.calls();
      expect(calls.filter((c) => c === 'list-panes')).toHaveLength(1);
      expect(calls).toContain('close-surface surf-a');
      expect(calls).toContain('close-surface surf-b');
      expect(calls).not.toContain('close-surface surf-c');
      expect(readState(a).reapedAt).toBeTruthy();
      expect(readState(b).reapedAt).toBeTruthy();
      expect(readState(other).reapedAt).toBeUndefined();
    });
  });

  it('retries a run whose close failed on the next Stop, and only then marks it reaped', () => {
    const dir = finishedRun('one');
    stub.reply('close-surface', { exit: 1, stderr: 'timed out' });
    stub.assertReachable();

    stop();

    expect(stub.calls()).toEqual(['ping', 'agent kill agent-one', 'close-surface surf-one']);
    expect(readState(dir).reapedAt).toBeUndefined();
    expect(readState(dir).waves[0].agents[0].reapedAt).toBeUndefined();

    stub.reply('close-surface', { exit: 0 });
    stub.clearCalls();
    stop();

    expect(stub.calls()).toEqual(['ping', 'agent kill agent-one', 'close-surface surf-one']);
    expect(readState(dir).reapedAt).toBeTruthy();
    expect(readState(dir).waves[0].agents[0].reapedAt).toBeTruthy();
  });

  it('skips a running run, a run with no recorded coordinator and an already reaped run', () => {
    const running = finishedRun('run', { status: 'running' });
    const noCoord = finishedRun('nocoord', { coordinatorPaneId: undefined, coordinatorSurfaceId: undefined });
    const reaped = finishedRun('done', { reapedAt: '2026-01-01T00:00:00Z' });
    stub.assertReachable();

    const r = stop();

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual([]);
    expect(readState(running).reapedAt).toBeUndefined();
    expect(readState(noCoord).reapedAt).toBeUndefined();
    expect(readState(reaped).reapedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('makes no wmux call when there is no run at all', () => {
    stub.assertReachable();

    const r = stop();

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(stub.calls()).toEqual([]);
  });

  it('reaps every finished run in one hook call', () => {
    const a = finishedRun('a');
    const b = finishedRun('b');
    stub.assertReachable();

    stop();

    const calls = stub.calls();
    expect(calls).toContain('close-surface surf-a');
    expect(calls).toContain('close-surface surf-b');
    expect(readState(a).reapedAt).toBeTruthy();
    expect(readState(b).reapedAt).toBeTruthy();
  });

  it('keeps the in-progress warning and does not reap the running run', () => {
    writeRun('live', {
      status: 'running',
      coordinatorPaneId: 'pane-coord',
      waves: [{ status: 'running', agents: [{ id: 'a1', status: 'running', surfaceId: 's1', paneId: 'p1' }] }],
    });
    stub.assertReachable();

    const r = stop();

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('WARNING: wmux orchestration in progress with 1 active agent(s).');
    expect(stub.calls()).toEqual([]);
  });

  it('still warns about a running run while reaping a finished one', () => {
    writeRun('live', {
      status: 'running',
      waves: [{ status: 'running', agents: [{ id: 'a1', status: 'running' }] }],
    });
    const dir = finishedRun('old');
    stub.assertReachable();

    const r = stop();

    expect(r.stdout).toContain('WARNING: wmux orchestration in progress');
    expect(stub.calls()).toContain('close-surface surf-old');
    expect(readState(dir).reapedAt).toBeTruthy();
  });

  it('leaves a finished run alone when wmux is unreachable, so the next Stop retries', () => {
    const down = createWmuxStub({ pingFails: true });
    try {
      const dir = finishedRun('one');
      down.assertReachable();

      const r = stop(COORD_SURFACE, down);

      expect(r.status).toBe(0);
      expect(down.calls().every((c) => c === 'ping')).toBe(true);
      expect(down.calls().length).toBeGreaterThan(0);
      expect(readState(dir).reapedAt).toBeUndefined();
      expect(readState(dir).waves[0].agents[0].reapedAt).toBeUndefined();
    } finally {
      removeWmuxStub(down);
    }
  });

  it('reaps a run whose coordinator-pane agent has no reapedAt, and marks the run', () => {
    const dir = finishedRun('mixed', {
      waves: [
        {
          status: 'complete',
          agents: [
            { id: 'w1', status: 'exited', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'pane-w1' },
            { id: 'c1', status: 'exited', wmuxAgentId: 'g2', surfaceId: 's2', paneId: 'pane-coord' },
          ],
        },
      ],
    });
    stub.assertReachable();

    stop();

    expect(stub.calls()).toEqual(['ping', 'agent kill g1', 'close-surface s1']);
    expect(readState(dir).reapedAt).toBeTruthy();
    expect(readState(dir).waves[0].agents[1].reapedAt).toBeUndefined();

    stub.clearCalls();
    stop();
    expect(stub.calls()).toEqual([]);
  });
});

describe.skipIf(!canRun)('find_unreaped_finished_orchs', { timeout: SLOW }, () => {
  it('scans every run dir with a single node process and makes no wmux call', () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-node-shim-'));
    try {
      const realNode = stub.bash('command -v node').stdout.trim();
      expect(realNode).not.toBe('');
      const log = path.join(shimDir, 'node.log');
      fs.writeFileSync(log, '');
      fs.writeFileSync(path.join(shimDir, 'node'), `#!/usr/bin/env bash\necho x >> "${forBash(log)}"\nexec "${realNode}" "$@"\n`, { mode: 0o755 });

      const a = finishedRun('a');
      const b = finishedRun('b', { coordinatorSurfaceId: undefined });
      finishedRun('c', { status: 'running' });
      finishedRun('d', { reapedAt: '2026-01-01T00:00:00Z' });
      finishedRun('e', { coordinatorPaneId: undefined, coordinatorSurfaceId: undefined });
      finishedRun('f', { status: 'failed' });
      finishedRun('g', { coordinatorSurfaceId: 'surf-other-coord' });
      stub.assertReachable();

      const r = stub.bash(
        `export PATH="${forBash(shimDir)}:$PATH"; source "${stateLibPath}"; : > "${forBash(log)}"; find_unreaped_finished_orchs`,
        { TMPDIR: forBash(base), WMUX_SURFACE_ID: COORD_SURFACE },
      );

      // "<claim>\t<dir>": "-" is a run proven by its coordinator surface, a pane
      // id one the hook still has to match against the caller's pane.
      const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('\t'));
      expect(lines.map(([claim, dir]) => [claim, path.basename(dir)])).toEqual([
        ['-', path.basename(a)],
        ['pane-coord', path.basename(b)],
      ]);
      expect(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
      expect(stub.calls()).toEqual([]);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});
