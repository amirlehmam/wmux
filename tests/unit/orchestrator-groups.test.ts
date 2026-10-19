import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASH_TEST_TIMEOUT_MS, bashExists, forBash, hasBash } from '../helpers/bash-path';
import { createWmuxStub, removeWmuxStub, type WmuxStub } from '../helpers/wmux-stub';

const SPAWN = path.resolve(__dirname, '../../resources/wmux-orchestrator/scripts/spawn-agents.sh');
const spawnPath = forBash(SPAWN);
const canRun = hasBash() && bashExists(spawnPath);

interface AgentFixture {
  id: string;
  group?: unknown;
  status?: string;
  wmuxAgentId?: string;
  surfaceId?: string;
  paneId?: string;
}

let tmp: string;
let orchDir: string;
let stub: WmuxStub;

function writeState(waves: AgentFixture[][]): void {
  fs.writeFileSync(
    path.join(orchDir, 'state.json'),
    JSON.stringify({
      id: 'test',
      task: 't',
      status: 'running',
      cwd: '/work',
      coordinatorPaneId: 'pane-coord',
      waves: waves.map((agents) => ({
        status: 'pending',
        agents: agents.map((a) => ({ status: 'pending', label: `label-${a.id}`, ...a })),
      })),
    }),
  );
}

const readState = () => JSON.parse(fs.readFileSync(path.join(orchDir, 'state.json'), 'utf8'));
const agentOf = (wave: number, id: string) =>
  readState().waves[wave].agents.find((a: { id: string }) => a.id === id);

const layoutReply = (panes: number) =>
  JSON.stringify({
    newPaneIds: Array.from({ length: panes }, (_, i) => `pane-w${i + 1}`),
    anchorPaneId: 'pane-anchor',
  });

/** What the real CLI prints when it stops waiting for `agent.spawn` (src/cli/wmux.ts `timeoutMessage`). */
const SPAWN_TIMEOUT =
  'agent.spawn timed out after 5000ms — wmux accepted the request but sent no reply. The command may still have completed.';

interface CounterOptions {
  /** 1-based spawns that fail with an ordinary error. */
  fail?: number[];
  /** 1-based spawns that fail with the CLI's timeout text. */
  timeout?: number[];
  /** 1-based spawns whose reply carries no surfaceId. */
  noSurface?: number[];
}

/**
 * The stub answers every `agent spawn` with the same reply, which cannot tell
 * two members of a group apart. This wrapper sits before it on PATH, still
 * forwards every call to the stub so the log stays complete, and answers
 * `agent spawn` with a running counter: agent N gets `surf-N`.
 */
function installSpawnCounter(opts: CounterOptions = {}): string {
  const dir = path.join(tmp, 'counter');
  fs.mkdirSync(dir);
  const script = `#!/usr/bin/env bash
dir="$(cd "$(dirname "$0")" && pwd)"
real="${forBash(stub.dir)}/wmux"
if [ "$1" = agent ] && [ "$2" = spawn ]; then
  "$real" "$@" >/dev/null
  n=$(cat "$dir/n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$dir/n"
  if [ -f "$dir/fail-$n" ]; then echo "spawn refused" >&2; exit 1; fi
  if [ -f "$dir/timeout-$n" ]; then echo "${SPAWN_TIMEOUT}" >&2; exit 1; fi
  if [ -f "$dir/nosurface-$n" ]; then printf '{"agentId":"wagent-%s"}\\n' "$n"; exit 0; fi
  printf '{"agentId":"wagent-%s","surfaceId":"surf-%s"}\\n' "$n" "$n"
  exit 0
fi
exec "$real" "$@"
`;
  fs.writeFileSync(path.join(dir, 'wmux'), script, { mode: 0o755 });
  for (const n of opts.fail ?? []) fs.writeFileSync(path.join(dir, `fail-${n}`), '');
  for (const n of opts.timeout ?? []) fs.writeFileSync(path.join(dir, `timeout-${n}`), '');
  for (const n of opts.noSurface ?? []) fs.writeFileSync(path.join(dir, `nosurface-${n}`), '');
  return forBash(dir);
}

function spawn(wave: number, counterDir?: string) {
  const prefix = counterDir ? `export PATH="${counterDir}:$PATH"; ` : '';
  return stub.bash(`${prefix}bash "${spawnPath}" "${forBash(orchDir)}" ${wave}`, { TMPDIR: forBash(tmp) });
}

/** `--cmd` carries machine-specific launcher and prompt paths; everything else is compared verbatim. */
const norm = (calls: string[]) => calls.map((c) => c.replace(/--cmd .* --label/, '--cmd <cmd> --label'));
const spawnCalls = (calls: string[]) => norm(calls).filter((c) => c.startsWith('agent spawn'));
const spawnLine = (id: string, pane: string, replaceTab: boolean) =>
  `agent spawn --cmd <cmd> --label label-${id} --cwd /work --pane ${pane}${replaceTab ? ' --replace-tab' : ''}`;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-groups-'));
  orchDir = path.join(tmp, 'wmux-orch-test');
  fs.mkdirSync(orchDir);
  stub = createWmuxStub();
});

afterEach(() => {
  removeWmuxStub(stub);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Each script run spawns a node process per JSON access under Git Bash: see BASH_TEST_TIMEOUT_MS.
const SLOW = BASH_TEST_TIMEOUT_MS;

describe.skipIf(!canRun)('spawn-agents.sh with groups', { timeout: SLOW }, () => {
  it('puts a group in one pane, replaces the idle tab once, and focuses the first member', () => {
    writeState([[{ id: 'a', group: 'g1' }, { id: 'b' }, { id: 'c', group: 'g1' }, { id: 'd', group: ' g1 ' }]]);
    stub.reply('layout agents', { stdout: layoutReply(2) });
    stub.assertReachable();

    const r = spawn(0, installSpawnCounter());

    expect(r.status).toBe(0);
    const calls = stub.calls();
    expect(calls.length).toBeGreaterThan(0);
    expect(norm(calls)).toEqual([
      'ping',
      'layout agents --count 2 --type terminal',
      spawnLine('a', 'pane-w1', true),
      spawnLine('b', 'pane-w2', true),
      spawnLine('c', 'pane-w1', false),
      spawnLine('d', 'pane-w1', false),
      'focus-surface surf-1',
    ]);
    expect(['a', 'c', 'd'].map((id) => agentOf(0, id).paneId)).toEqual(['pane-w1', 'pane-w1', 'pane-w1']);
    expect(agentOf(0, 'b').paneId).toBe('pane-w2');
    expect(['a', 'b', 'c', 'd'].map((id) => agentOf(0, id).surfaceId)).toEqual(['surf-1', 'surf-2', 'surf-3', 'surf-4']);
    expect(agentOf(0, 'c')).toMatchObject({ status: 'running', wmuxAgentId: 'wagent-3' });
  });

  it('lets the next member take over the idle tab when the first one fails to spawn (A7, A8)', () => {
    writeState([[{ id: 'a', group: 'g' }, { id: 'b', group: 'g' }, { id: 'c', group: 'g' }]]);
    stub.reply('layout agents', { stdout: layoutReply(1) });
    stub.assertReachable();

    const r = spawn(0, installSpawnCounter({ fail: [1] }));

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Failed to spawn agent a');
    expect(norm(stub.calls())).toEqual([
      'ping',
      'layout agents --count 1 --type terminal',
      spawnLine('a', 'pane-w1', true),
      spawnLine('b', 'pane-w1', true),
      spawnLine('c', 'pane-w1', false),
      'focus-surface surf-2',
    ]);
    expect(agentOf(0, 'a').surfaceId).toBeUndefined();
    expect(agentOf(0, 'b')).toMatchObject({ paneId: 'pane-w1', surfaceId: 'surf-2' });
  });

  it('never focuses a cell with fewer than two spawned members (A6)', () => {
    writeState([[{ id: 'a', group: 'solo' }, { id: 'b', group: 'g' }, { id: 'c', group: 'g' }]]);
    stub.reply('layout agents', { stdout: layoutReply(2) });
    stub.assertReachable();

    spawn(0, installSpawnCounter({ fail: [3] }));

    const calls = stub.calls();
    expect(spawnCalls(calls)).toHaveLength(3);
    expect(calls.some((c) => c.startsWith('focus-surface'))).toBe(false);
  });

  it('warns and carries on when focus-surface fails', () => {
    writeState([[{ id: 'a', group: 'g' }, { id: 'b', group: 'g' }]]);
    stub.reply('layout agents', { stdout: layoutReply(1) });
    stub.reply('focus-surface', { exit: 1, stderr: 'Unknown command: focus-surface' });
    stub.assertReachable();

    const r = spawn(0, installSpawnCounter());

    expect(r.status).toBe(0);
    expect(stub.calls()).toContain('focus-surface surf-1');
    expect(r.stderr).toContain('WARNING: could not focus surf-1');
    expect(agentOf(0, 'b')).toMatchObject({ status: 'running', paneId: 'pane-w1' });
  });

  it('asks for the cell count, not the agent count, on the `layout grid` fallback too (A10)', () => {
    writeState([[{ id: 'a', group: 'g' }, { id: 'b', group: 'g' }, { id: 'c' }]]);
    stub.reply('layout agents', { exit: 1, stderr: 'Unknown layout subcommand: agents' });
    stub.reply('layout grid', { stdout: JSON.stringify({ newPaneIds: ['pane-g1', 'pane-g2'] }) });
    stub.assertReachable();

    const r = spawn(0, installSpawnCounter());

    expect(r.status).toBe(0);
    const calls = norm(stub.calls());
    expect(calls).toContain('layout agents --count 2 --type terminal');
    expect(calls).toContain('layout grid --count 3 --type terminal');
    expect(calls.slice(-4)).toEqual([
      spawnLine('a', 'pane-g1', true),
      spawnLine('b', 'pane-g1', false),
      spawnLine('c', 'pane-g2', true),
      'focus-surface surf-1',
    ]);
  });

  it('reports a missing pane for every member of the cell without spawning them', () => {
    writeState([[{ id: 'a' }, { id: 'b', group: 'g' }, { id: 'c', group: 'g' }]]);
    stub.reply('layout agents', { stdout: layoutReply(1) });
    stub.assertReachable();

    const r = spawn(0, installSpawnCounter());

    expect(r.stderr).toContain('No pane at index 1 for agent b');
    expect(r.stderr).toContain('No pane at index 1 for agent c');
    expect(spawnCalls(stub.calls())).toEqual([spawnLine('a', 'pane-w1', true)]);
  });
});

describe.skipIf(!canRun)('spawn-agents.sh focus pass', { timeout: SLOW }, () => {
  it('focuses the first member of every multi-member cell, in cell order', () => {
    writeState([
      [{ id: 'a', group: 'g1' }, { id: 'b', group: 'g2' }, { id: 'c', group: 'g1' }, { id: 'd', group: 'g2' }, { id: 'e' }],
    ]);
    stub.reply('layout agents', { stdout: layoutReply(3) });
    stub.assertReachable();

    const r = spawn(0, installSpawnCounter());

    expect(r.status).toBe(0);
    expect(norm(stub.calls()).slice(1)).toEqual([
      'layout agents --count 3 --type terminal',
      spawnLine('a', 'pane-w1', true),
      spawnLine('b', 'pane-w2', true),
      spawnLine('c', 'pane-w1', false),
      spawnLine('d', 'pane-w2', false),
      spawnLine('e', 'pane-w3', true),
      'focus-surface surf-1',
      'focus-surface surf-2',
    ]);
  });

  it('warns instead of focusing when the cell\'s first spawned member has no surfaceId', () => {
    writeState([[{ id: 'a', group: 'g' }, { id: 'b', group: 'g' }]]);
    stub.reply('layout agents', { stdout: layoutReply(1) });
    stub.assertReachable();

    const r = spawn(0, installSpawnCounter({ noSurface: [1] }));

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('WARNING: the first agent spawned in cell 0 reported no surfaceId; not focusing that cell');
    const calls = norm(stub.calls());
    expect(calls).toContain(spawnLine('b', 'pane-w1', false));
    expect(calls.some((c) => c.startsWith('focus-surface'))).toBe(false);
  });
});

describe.skipIf(!canRun)('spawn-agents.sh after a timed-out spawn', { timeout: SLOW }, () => {
  const listed = (label: string, paneId: string, agentId: string, spawnTime: number, status = 'running') => ({
    agentId,
    surfaceId: `surf-${agentId}`,
    paneId,
    workspaceId: 'ws-1',
    label,
    cmd: 'node launch-agent.js',
    status,
    spawnTime,
  });

  it('records the agent wmux started anyway, and treats it as the cell\'s first member', () => {
    writeState([[{ id: 'a', group: 'g' }, { id: 'b', group: 'g' }]]);
    stub.reply('layout agents', { stdout: layoutReply(1) });
    stub.reply('agent list', {
      stdout: JSON.stringify(
        {
          agents: [
            listed('label-a', 'pane-w1', 'older', 100),
            listed('label-a', 'pane-w1', 'late', 200),
            listed('label-a', 'pane-coord', 'elsewhere', 300),
            listed('label-a', 'pane-w1', 'gone', 400, 'exited'),
          ],
        },
        null,
        2,
      ),
    });
    stub.assertReachable();

    const r = spawn(0, installSpawnCounter({ timeout: [1] }));

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('WARNING: spawn of a timed out, but wmux started it as late');
    expect(r.stderr).not.toContain('Failed to spawn agent a');
    expect(norm(stub.calls()).slice(1)).toEqual([
      'layout agents --count 1 --type terminal',
      spawnLine('a', 'pane-w1', true),
      'agent list',
      spawnLine('b', 'pane-w1', false),
      'focus-surface surf-late',
    ]);
    expect(agentOf(0, 'a')).toMatchObject({
      status: 'running',
      wmuxAgentId: 'late',
      surfaceId: 'surf-late',
      paneId: 'pane-w1',
    });
  });

  it('keeps the failure when no running agent under that label is in the pane', () => {
    writeState([[{ id: 'a', group: 'g' }, { id: 'b', group: 'g' }]]);
    stub.reply('layout agents', { stdout: layoutReply(1) });
    stub.reply('agent list', {
      stdout: JSON.stringify({
        agents: [listed('label-a', 'pane-other', 'x', 1), listed('label-b', 'pane-w1', 'y', 2), listed('label-a', 'pane-w1', 'z', 3, 'exited')],
      }),
    });
    stub.assertReachable();

    const r = spawn(0, installSpawnCounter({ timeout: [1] }));

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Failed to spawn agent a');
    expect(r.stderr).toContain('may still have completed');
    expect(norm(stub.calls()).slice(1)).toEqual([
      'layout agents --count 1 --type terminal',
      spawnLine('a', 'pane-w1', true),
      'agent list',
      spawnLine('b', 'pane-w1', true),
    ]);
    expect(agentOf(0, 'a').wmuxAgentId).toBeUndefined();
    expect(agentOf(0, 'a').surfaceId).toBeUndefined();
  });

  it('does not look anything up after an ordinary spawn error', () => {
    writeState([[{ id: 'a' }]]);
    stub.reply('layout agents', { stdout: layoutReply(1) });
    stub.reply('agent list', { stdout: JSON.stringify({ agents: [listed('label-a', 'pane-w1', 'x', 1)] }) });
    stub.assertReachable();

    const r = spawn(0, installSpawnCounter({ fail: [1] }));

    const calls = norm(stub.calls());
    expect(calls.length).toBeGreaterThan(0);
    expect(r.stderr).toContain('Failed to spawn agent a');
    expect(calls).not.toContain('agent list');
    expect(agentOf(0, 'a').wmuxAgentId).toBeUndefined();
  });
});

describe.skipIf(!canRun)('spawn-agents.sh without groups (R2.6)', { timeout: SLOW }, () => {
  it('wave 0: ping, layout agents, one replace-tab spawn per agent, nothing else', () => {
    writeState([[{ id: 'a' }, { id: 'b' }]]);
    stub.reply('layout agents', { stdout: layoutReply(2) });
    stub.assertReachable();

    const r = spawn(0, installSpawnCounter());

    expect(r.status).toBe(0);
    expect(norm(stub.calls())).toEqual([
      'ping',
      'layout agents --count 2 --type terminal',
      spawnLine('a', 'pane-w1', true),
      spawnLine('b', 'pane-w2', true),
    ]);
  });

  it('wave 1: reaps wave 0 first, then the same layout and spawn sequence', () => {
    writeState([
      [{ id: 'z', status: 'exited', wmuxAgentId: 'g0', surfaceId: 's0', paneId: 'p0' }],
      [{ id: 'a' }, { id: 'b' }],
    ]);
    stub.reply('layout agents', { stdout: layoutReply(2) });
    stub.assertReachable();

    const r = spawn(1, installSpawnCounter());

    expect(r.status).toBe(0);
    expect(norm(stub.calls())).toEqual([
      'ping',
      'ping',
      'agent kill g0',
      'close-surface s0',
      'layout agents --count 2 --type terminal',
      spawnLine('a', 'pane-w1', true),
      spawnLine('b', 'pane-w2', true),
    ]);
  });
});
