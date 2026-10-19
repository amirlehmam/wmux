import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASH_TEST_TIMEOUT_MS, bashExists, forBash, hasBash } from '../helpers/bash-path';
import { createWmuxStub, removeWmuxStub, type WmuxStub } from '../helpers/wmux-stub';

const SCRIPTS = path.resolve(__dirname, '../../resources/wmux-orchestrator/scripts');
const REAP = path.join(SCRIPTS, 'reap-wave.sh');
const SPAWN = path.join(SCRIPTS, 'spawn-agents.sh');
const CLEANUP = path.join(SCRIPTS, 'cleanup.sh');
const JSON_TOOL = path.join(SCRIPTS, 'json-tool.js');

const reapPath = forBash(REAP);
const canRun = hasBash() && bashExists(reapPath);

let tmp: string;
let orchDir: string;
let stub: WmuxStub;

interface AgentFixture {
  id: string;
  status?: string;
  wmuxAgentId?: string;
  surfaceId?: string;
  paneId?: string;
  reapedAt?: string;
  label?: string;
}

function writeState(waves: AgentFixture[][], extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(orchDir, 'state.json'),
    JSON.stringify({
      id: 'test',
      task: 't',
      status: 'running',
      coordinatorPaneId: 'pane-coord',
      waves: waves.map((agents) => ({ status: 'complete', agents: agents.map((a) => ({ status: 'exited', ...a })) })),
      ...extra,
    }),
  );
}

const readState = () => JSON.parse(fs.readFileSync(path.join(orchDir, 'state.json'), 'utf8'));
const agentOf = (wave: number, i = 0) => readState().waves[wave].agents[i];

function reap(sel: string, env: Record<string, string> = {}) {
  return stub.bash(`bash "${reapPath}" "${forBash(orchDir)}" ${sel}`, env);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-reap-'));
  orchDir = path.join(tmp, 'wmux-orch-test');
  fs.mkdirSync(orchDir);
  stub = createWmuxStub();
});

afterEach(() => {
  removeWmuxStub(stub);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Each script run spawns several node processes under Git Bash: see BASH_TEST_TIMEOUT_MS.
const SLOW = BASH_TEST_TIMEOUT_MS;

describe.skipIf(!canRun)('reap-wave.sh', { timeout: SLOW }, () => {
  it('kills the agent, then closes its surface, then stamps reapedAt', () => {
    writeState([[{ id: 'a1', wmuxAgentId: 'agent-1', surfaceId: 'surf-1', paneId: 'pane-1' }]]);
    stub.assertReachable();

    const r = reap('0');

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual(['ping', 'agent kill agent-1', 'close-surface surf-1']);
    expect(agentOf(0).reapedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('reaps only the named wave', () => {
    writeState([
      [{ id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }],
      [{ id: 'b1', wmuxAgentId: 'g2', surfaceId: 's2', paneId: 'p2' }],
    ]);
    stub.assertReachable();

    reap('1');

    expect(stub.calls()).toEqual(['ping', 'agent kill g2', 'close-surface s2']);
    expect(agentOf(0).reapedAt).toBeUndefined();
    expect(agentOf(1).reapedAt).toBeDefined();
  });

  it('reaps every wave and stamps the run when given "all"', () => {
    writeState([
      [{ id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }],
      [{ id: 'b1', wmuxAgentId: 'g2', surfaceId: 's2', paneId: 'p2' }],
    ]);
    stub.assertReachable();

    reap('all');

    expect(stub.calls()).toEqual(['ping', 'agent kill g1', 'close-surface s1', 'agent kill g2', 'close-surface s2']);
    const state = readState();
    expect(state.reapedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(state.waves[0].agents[0].reapedAt).toBeDefined();
    expect(state.waves[1].agents[0].reapedAt).toBeDefined();
  });

  it('does not stamp the run for a single wave', () => {
    writeState([[{ id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }]]);
    stub.assertReachable();

    reap('0');

    expect(readState().reapedAt).toBeUndefined();
  });

  it('reaps whatever the agent status, a failed one included', () => {
    writeState([[{ id: 'a1', status: 'failed', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }]]);
    stub.assertReachable();

    reap('0');

    expect(stub.calls()).toEqual(['ping', 'agent kill g1', 'close-surface s1']);
  });

  it('a second run calls nothing beyond ping', () => {
    writeState([[{ id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }]]);
    stub.assertReachable();
    reap('all');
    expect(stub.calls().length).toBeGreaterThan(1);
    stub.clearCalls();

    const r = reap('all');

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual(['ping']);
  });

  it('closes the surface even when the agent id is unknown', () => {
    writeState([[{ id: 'a1', surfaceId: 's1', paneId: 'p1' }]]);
    stub.assertReachable();

    reap('0');

    expect(stub.calls()).toEqual(['ping', 'close-surface s1']);
    expect(agentOf(0).reapedAt).toBeDefined();
  });

  it('ignores a failing kill (the agent is already gone) and still closes and stamps', () => {
    writeState([[{ id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }]]);
    stub.reply('agent kill', { exit: 1, stderr: 'Agent not found' });
    stub.assertReachable();

    const r = reap('0');

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual(['ping', 'agent kill g1', 'close-surface s1']);
    expect(agentOf(0).reapedAt).toBeDefined();
  });

  // `close-surface` answers ok for a surface that is already gone, so a
  // failure means the pane may still be there. Stamping it reaped would make
  // every later run skip it: the leak would be permanent.
  it('does not stamp reapedAt when the close failed, and closes it on the next run', () => {
    writeState([
      [
        { id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' },
        { id: 'a2', wmuxAgentId: 'g2', surfaceId: 's2', paneId: 'p2' },
      ],
    ]);
    stub.reply('close-surface', { exit: 1, stderr: 'wmux: timed out' });
    stub.assertReachable();

    const first = reap('all');

    expect(first.status).toBe(0);
    expect(first.stderr).toContain('could not close surface s1');
    // One failure does not stop the loop: the second agent is still attempted.
    expect(stub.calls()).toEqual(['ping', 'agent kill g1', 'close-surface s1', 'agent kill g2', 'close-surface s2']);
    expect(agentOf(0, 0).reapedAt).toBeUndefined();
    expect(agentOf(0, 1).reapedAt).toBeUndefined();
    // Nor is the RUN stamped, or the Stop hook would never come back to it.
    expect(readState().reapedAt).toBeUndefined();

    stub.reply('close-surface', { exit: 0 });
    stub.clearCalls();
    const second = reap('all');

    expect(second.status).toBe(0);
    expect(stub.calls()).toEqual(['ping', 'agent kill g1', 'close-surface s1', 'agent kill g2', 'close-surface s2']);
    expect(agentOf(0, 0).reapedAt).toBeDefined();
    expect(agentOf(0, 1).reapedAt).toBeDefined();
    expect(readState().reapedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('skips agents with no surface (never spawned)', () => {
    writeState([[{ id: 'a1', status: 'pending' }]]);
    stub.assertReachable();

    reap('all');

    expect(stub.calls()).toEqual(['ping']);
    expect(agentOf(0).reapedAt).toBeUndefined();
  });

  it('never closes an agent that sits in the coordinator pane', () => {
    writeState([
      [
        { id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'pane-coord' },
        { id: 'a2', wmuxAgentId: 'g2', surfaceId: 's2', paneId: 'p2' },
      ],
    ]);
    stub.assertReachable();

    const r = reap('0');

    expect(stub.calls()).toEqual(['ping', 'agent kill g2', 'close-surface s2']);
    expect(r.stderr).toContain('coordinator');
    expect(agentOf(0, 0).reapedAt).toBeUndefined();
  });

  it('touches nothing when wmux does not answer ping', () => {
    removeWmuxStub(stub);
    stub = createWmuxStub({ pingFails: true });
    writeState([[{ id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }]]);
    stub.assertReachable();

    const r = reap('all');

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual(['ping']);
    const state = readState();
    expect(state.waves[0].agents[0].reapedAt).toBeUndefined();
    expect(state.reapedAt).toBeUndefined();
  });

  // Closing it last was not enough: it is still the shell running the reap
  // (and, for a coordinator, the session the user is talking to).
  it("never kills or closes the caller's own surface, and leaves it unstamped", () => {
    writeState([
      [
        { id: 'a1', wmuxAgentId: 'g1', surfaceId: 'own', paneId: 'p1' },
        { id: 'a2', wmuxAgentId: 'g2', surfaceId: 's2', paneId: 'p2' },
        { id: 'a3', wmuxAgentId: 'g3', surfaceId: 's3', paneId: 'p3' },
      ],
    ]);
    stub.assertReachable();

    const r = reap('0', { WMUX_SURFACE_ID: 'own' });

    expect(stub.calls()).toEqual(['ping', 'agent kill g2', 'close-surface s2', 'agent kill g3', 'close-surface s3']);
    expect(r.stderr).toContain("the caller's own surface");
    expect(agentOf(0, 0).reapedAt).toBeUndefined();
    expect(agentOf(0, 1).reapedAt).toBeDefined();
    expect(agentOf(0, 2).reapedAt).toBeDefined();
  });

  // The `layout grid` fallback (an older wmux) never learns a coordinatorPaneId,
  // so the pane rule above protects nothing there. The recorded surface does,
  // whoever runs the reap.
  it("never closes the recorded coordinator surface, with no coordinatorPaneId to go by", () => {
    writeState(
      [
        [
          { id: 'a1', wmuxAgentId: 'g1', surfaceId: 'surf-coord', paneId: 'p1' },
          { id: 'a2', wmuxAgentId: 'g2', surfaceId: 's2', paneId: 'p2' },
        ],
      ],
      { coordinatorPaneId: undefined, coordinatorSurfaceId: 'surf-coord' },
    );
    stub.assertReachable();

    const r = reap('all', { WMUX_SURFACE_ID: 'surf-somebody-else' });

    expect(stub.calls()).toEqual(['ping', 'agent kill g2', 'close-surface s2']);
    expect(r.stderr).toContain("the coordinator's surface");
    expect(agentOf(0, 0).reapedAt).toBeUndefined();
  });

  it("skips the caller's own surface even when no coordinator is recorded at all", () => {
    writeState(
      [
        [
          { id: 'a1', wmuxAgentId: 'g1', surfaceId: 'own', paneId: 'p1' },
          { id: 'a2', wmuxAgentId: 'g2', surfaceId: 's2', paneId: 'p2' },
        ],
      ],
      { coordinatorPaneId: undefined },
    );
    stub.assertReachable();

    reap('all', { WMUX_SURFACE_ID: 'own' });

    expect(stub.calls()).toEqual(['ping', 'agent kill g2', 'close-surface s2']);
    expect(agentOf(0, 0).reapedAt).toBeUndefined();
  });

  it('exits 0 with no wmux call when state.json is missing', () => {
    fs.rmSync(path.join(orchDir, 'state.json'), { force: true });
    stub.assertReachable();

    const r = reap('all');

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual([]);
  });

  it('rejects a bad wave selector with exit 1', () => {
    writeState([[]]);
    expect(reap('nope').status).toBe(1);
  });

  it.each(['1x', '0abc', '-1', '1.5'])('rejects the malformed selector %s without touching wmux', (sel) => {
    writeState([[{ id: 'a', wmuxAgentId: 'ag-1', surfaceId: 'surf-1', paneId: 'pane-w' }]]);
    stub.assertReachable();

    const r = reap(`'${sel}'`);

    expect(r.status).toBe(1);
    expect(stub.calls()).toEqual([]);
    expect(agentOf(0).reapedAt).toBeUndefined();
  });
});

describe.skipIf(!hasBash())('json-tool reaping queries', { timeout: SLOW }, () => {
  const tool = (...args: string[]) =>
    execFileSync(process.execPath, [JSON_TOOL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const mkRuns = () => {
    const mk = (name: string, state: Record<string, unknown> | null) => {
      const d = path.join(tmp, name);
      fs.mkdirSync(d);
      if (state) fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(state));
    };
    mk('wmux-orch-mine', { status: 'complete', coordinatorSurfaceId: 'surf-me', coordinatorPaneId: 'p' });
    mk('wmux-orch-mine-grid', { status: 'complete', coordinatorSurfaceId: 'surf-me' });
    mk('wmux-orch-paneonly', { status: 'complete', coordinatorPaneId: 'pane-x' });
    mk('wmux-orch-theirs', { status: 'complete', coordinatorSurfaceId: 'surf-them', coordinatorPaneId: 'p' });
    mk('wmux-orch-aborted', { status: 'aborted', coordinatorSurfaceId: 'surf-me' });
    mk('wmux-orch-failed', { status: 'failed', coordinatorSurfaceId: 'surf-me' });
    mk('wmux-orch-running', { status: 'running', coordinatorSurfaceId: 'surf-me' });
    mk('wmux-orch-nocoord', { status: 'complete' });
    mk('wmux-orch-reaped', { status: 'complete', coordinatorSurfaceId: 'surf-me', reapedAt: '2026-01-01T00:00:00Z' });
    mk('wmux-orch-nostate', null);
    mk('wmux-orch-garbage', null);
    fs.writeFileSync(path.join(tmp, 'wmux-orch-garbage', 'state.json'), '{not json');
    mk('unrelated', { status: 'complete', coordinatorSurfaceId: 'surf-me' });
  };
  const claims = (out: string) =>
    out.split('\n').filter(Boolean).map((line) => {
      const [claim, dir] = line.split('\t');
      return [claim, dir.split('/').pop()];
    });

  it("find-unreaped-finished lists only the caller's own completed, unreaped runs", () => {
    mkRuns();

    expect(claims(tool('find-unreaped-finished', tmp, 'surf-me'))).toEqual([
      ['-', 'wmux-orch-mine'],
      ['-', 'wmux-orch-mine-grid'],
      ['pane-x', 'wmux-orch-paneonly'],
    ]);
  });

  it('find-unreaped-finished gives another surface only what is provably its own', () => {
    mkRuns();

    expect(claims(tool('find-unreaped-finished', tmp, 'surf-them'))).toEqual([
      ['pane-x', 'wmux-orch-paneonly'],
      ['-', 'wmux-orch-theirs'],
    ]);
  });

  it.each([[[]], [['']]])('find-unreaped-finished lists nothing without a caller surface (%j)', (caller) => {
    mkRuns();

    expect(tool('find-unreaped-finished', tmp, ...caller)).toBe('');
  });

  it('find-unreaped-finished prints nothing for a missing base dir', () => {
    expect(tool('find-unreaped-finished', path.join(tmp, 'nope'), 'surf-me')).toBe('');
  });

  it('find-unreaped-finished tolerates a trailing separator on the base dir', () => {
    mkRuns();

    const out = tool('find-unreaped-finished', `${tmp}//`, 'surf-them');

    expect(out).not.toContain('///');
    expect(claims(out).map(([, name]) => name)).toEqual(['wmux-orch-paneonly', 'wmux-orch-theirs']);
  });

  it("reap-candidates skips reaped and surface-less agents, the caller's surface and the coordinator's", () => {
    writeState(
      [
        [
          { id: 'a1', wmuxAgentId: 'g1', surfaceId: 'own', paneId: 'p1' },
          { id: 'a2', surfaceId: 's2' },
          { id: 'a3', surfaceId: 's3', paneId: 'p3', reapedAt: 'x' },
          { id: 'a4', status: 'pending' },
          { id: 'a5', wmuxAgentId: 'g5', surfaceId: 'surf-coord', paneId: 'p5' },
          { id: 'a6', wmuxAgentId: 'g6', surfaceId: 's6', paneId: 'p6' },
        ],
      ],
      { coordinatorSurfaceId: 'surf-coord' },
    );

    const out = tool('query', path.join(orchDir, 'state.json'), 'reap-candidates', 'all', 'own');

    expect(out.split('\n').filter(Boolean)).toEqual(['a2\t-\ts2\t-', 'a6\tg6\ts6\tp6']);
  });

  it('pane-of-surface finds the pane holding a surface in `wmux list-panes` output', () => {
    const panes = JSON.stringify({
      panes: [
        { paneId: 'pane-1', surfaces: [{ id: 'surf-a', type: 'terminal' }] },
        { paneId: 'pane-2', surfaces: [{ id: 'surf-b', type: 'terminal' }, { id: 'surf-c', type: 'browser' }] },
      ],
    });
    const paneOf = (surface: string, input: string) =>
      execFileSync(process.execPath, [JSON_TOOL, 'pane-of-surface', surface], { encoding: 'utf8', input });

    expect(paneOf('surf-c', panes)).toBe('pane-2\n');
    expect(paneOf('surf-zzz', panes)).toBe('');
    expect(paneOf('surf-a', 'not json')).toBe('');
    expect(paneOf('surf-a', '{"panes":null}')).toBe('');
  });
});

const spawnPath = forBash(SPAWN);
const cleanupPath = forBash(CLEANUP);
const canSpawn = hasBash() && bashExists(spawnPath) && bashExists(cleanupPath);

const LAYOUT_OK = JSON.stringify({
  newPaneIds: ['pane-w1', 'pane-w2'],
  newPanes: [
    { paneId: 'pane-w1', surfaceId: 'surf-w1' },
    { paneId: 'pane-w2', surfaceId: 'surf-w2' },
  ],
  anchorPaneId: 'pane-anchor',
  cols: 1,
  rows: 2,
});
const SPAWN_OK = JSON.stringify({ agentId: 'wagent-1', surfaceId: 'surf-new' });

const pendingAgent = (id: string): AgentFixture => ({ id, label: `label-${id}`, status: 'pending' });

function spawn(wave: number, env: Record<string, string> = {}) {
  return stub.bash(`bash "${spawnPath}" "${forBash(orchDir)}" ${wave}`, env);
}

describe.skipIf(!canSpawn)('spawn-agents.sh', { timeout: SLOW }, () => {
  it('lays the wave out with `layout agents` and records what reaping needs', () => {
    writeState([[pendingAgent('a1'), pendingAgent('a2')]], { coordinatorPaneId: undefined });
    stub.reply('layout agents', { stdout: LAYOUT_OK });
    stub.reply('agent spawn', { stdout: SPAWN_OK });
    stub.assertReachable();

    const r = spawn(0);

    expect(r.status).toBe(0);
    const calls = stub.calls();
    expect(calls[0]).toBe('ping');
    expect(calls[1]).toBe('layout agents --count 2 --type terminal');
    expect(calls.filter((c) => c.startsWith('agent spawn'))).toHaveLength(2);
    expect(calls.some((c) => c.startsWith('layout grid'))).toBe(false);
    expect(calls.some((c) => c.includes('--anchor-pane'))).toBe(false);
    expect(readState().coordinatorPaneId).toBe('pane-anchor');
    expect(agentOf(0, 0)).toMatchObject({ wmuxAgentId: 'wagent-1', paneId: 'pane-w1', surfaceId: 'surf-new', status: 'running' });
    expect(agentOf(0, 1)).toMatchObject({ wmuxAgentId: 'wagent-1', paneId: 'pane-w2' });
    expect(calls.filter((c) => c.startsWith('agent spawn'))[1]).toContain('--pane pane-w2');
  });

  it('keeps a coordinatorPaneId that is already recorded', () => {
    writeState([[pendingAgent('a1')]], { coordinatorPaneId: 'pane-first' });
    stub.reply('layout agents', { stdout: LAYOUT_OK });
    stub.reply('agent spawn', { stdout: SPAWN_OK });
    stub.assertReachable();

    spawn(0);

    expect(readState().coordinatorPaneId).toBe('pane-first');
  });

  const OLD_WMUX: [string, string][] = [
    ['current CLI', 'Unknown layout subcommand: agents'],
    ['older CLI', 'Unknown layout command: agents'],
    ['new CLI, old app', 'Method not found: layout.agents'],
  ];
  it.each(OLD_WMUX)('falls back to `layout grid` on %s', (_name, message) => {
    writeState([[pendingAgent('a1'), pendingAgent('a2')]], { coordinatorPaneId: undefined });
    stub.reply('layout agents', { exit: 1, stderr: message });
    stub.reply('layout grid', { stdout: JSON.stringify({ newPaneIds: ['pane-g1', 'pane-g2'] }) });
    stub.reply('agent spawn', { stdout: SPAWN_OK });
    stub.assertReachable();

    const r = spawn(0);

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('falling back');
    const calls = stub.calls();
    expect(calls).toContain('layout agents --count 2 --type terminal');
    expect(calls).toContain('layout grid --count 3 --type terminal');
    expect(agentOf(0, 0)).toMatchObject({ paneId: 'pane-g1', wmuxAgentId: 'wagent-1' });
    expect(readState().coordinatorPaneId).toBeUndefined();
  });

  // The grid fallback learns no coordinator pane, so the surface is the only
  // thing a later reap (and the Stop hook's ownership check) has to go by.
  it.each([
    ['layout agents', () => stub.reply('layout agents', { stdout: LAYOUT_OK })],
    ['the layout grid fallback', () => {
      stub.reply('layout agents', { exit: 1, stderr: 'Unknown layout subcommand: agents' });
      stub.reply('layout grid', { stdout: JSON.stringify({ newPaneIds: ['pane-g1'] }) });
    }],
  ])("records the coordinator's surface with %s", (_name, arrange) => {
    writeState([[pendingAgent('a1')]], { coordinatorPaneId: undefined });
    arrange();
    stub.reply('agent spawn', { stdout: SPAWN_OK });
    stub.assertReachable();

    const r = spawn(0, { WMUX_SURFACE_ID: 'surf-coord' });

    expect(r.status).toBe(0);
    expect(readState().coordinatorSurfaceId).toBe('surf-coord');
  });

  it('keeps a coordinatorSurfaceId that is already recorded, and records none outside wmux', () => {
    writeState([[pendingAgent('a1')], [pendingAgent('b1')]], { coordinatorSurfaceId: 'surf-first' });
    stub.reply('layout agents', { stdout: LAYOUT_OK });
    stub.reply('agent spawn', { stdout: SPAWN_OK });
    stub.assertReachable();

    spawn(0, { WMUX_SURFACE_ID: 'surf-later' });
    expect(readState().coordinatorSurfaceId).toBe('surf-first');

    writeState([[pendingAgent('a1')]]);
    spawn(0);
    expect(readState().coordinatorSurfaceId).toBeUndefined();
  });

  it('exits 1 without touching `layout grid` when the anchor does not resolve', () => {
    writeState([[pendingAgent('a1')]]);
    stub.reply('layout agents', { exit: 1, stderr: 'No active workspace or invalid anchor' });
    stub.reply('layout grid', { stdout: JSON.stringify({ newPaneIds: ['pane-g1'] }) });
    stub.assertReachable();

    const r = spawn(0);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('invalid anchor');
    const calls = stub.calls();
    expect(calls).toContain('layout agents --count 1 --type terminal');
    expect(calls.some((c) => c.startsWith('layout grid'))).toBe(false);
    expect(calls.some((c) => c.startsWith('agent spawn'))).toBe(false);
  });

  it('reaps waves 0..N-1 before laying out wave N', () => {
    writeState([
      [{ id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }],
      [{ id: 'b1', wmuxAgentId: 'g2', surfaceId: 's2', paneId: 'p2' }],
      [pendingAgent('c1')],
    ]);
    stub.reply('layout agents', { stdout: LAYOUT_OK });
    stub.reply('agent spawn', { stdout: SPAWN_OK });
    stub.assertReachable();

    const r = spawn(2);

    expect(r.status).toBe(0);
    const calls = stub.calls();
    const layoutAt = calls.indexOf('layout agents --count 1 --type terminal');
    expect(layoutAt).toBeGreaterThan(-1);
    expect(calls.slice(0, layoutAt)).toEqual(
      expect.arrayContaining(['agent kill g1', 'close-surface s1', 'agent kill g2', 'close-surface s2']),
    );
    expect(calls.slice(layoutAt).some((c) => c.startsWith('close-surface'))).toBe(false);
    expect(agentOf(0).reapedAt).toBeDefined();
    expect(agentOf(1).reapedAt).toBeDefined();
    expect(agentOf(2).reapedAt).toBeUndefined();
  });

  it('reaps nothing for wave 0', () => {
    writeState([[pendingAgent('a1')]]);
    stub.reply('layout agents', { stdout: LAYOUT_OK });
    stub.reply('agent spawn', { stdout: SPAWN_OK });
    stub.assertReachable();

    spawn(0);

    expect(stub.calls().some((c) => c.startsWith('close-surface') || c.startsWith('agent kill'))).toBe(false);
  });
});

describe.skipIf(!canSpawn)('cleanup.sh', { timeout: SLOW }, () => {
  it('reaps the run before deleting its directory', () => {
    writeState([[{ id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }]]);
    stub.assertReachable();

    const r = stub.bash(`bash "${cleanupPath}" "${forBash(orchDir)}"`);

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual(['ping', 'agent kill g1', 'close-surface s1']);
    expect(fs.existsSync(orchDir)).toBe(false);
  });

  // The Stop hook leaves a failed or aborted run's panes up for inspection;
  // this is the explicit step that takes them down.
  it.each(['failed', 'aborted'])('reaps a %s run: cleanup is the explicit teardown the hook no longer does', (status) => {
    writeState([[{ id: 'a1', status: 'failed', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }]], { status });
    stub.assertReachable();

    const r = stub.bash(`bash "${cleanupPath}" "${forBash(orchDir)}"`);

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual(['ping', 'agent kill g1', 'close-surface s1']);
    expect(fs.existsSync(orchDir)).toBe(false);
  });

  it('just deletes the directory when there is no state.json', () => {
    fs.writeFileSync(path.join(orchDir, 'junk.txt'), 'x');
    stub.assertReachable();

    const r = stub.bash(`bash "${cleanupPath}" "${forBash(orchDir)}"`);

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual([]);
    expect(fs.existsSync(orchDir)).toBe(false);
  });
});
