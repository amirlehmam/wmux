import { describe, expect, it } from 'vitest';
import { sshTargetParams } from '../../src/cli/wmux';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

/**
 * `wmux set-ssh-target` / `clear-ssh-target`, run as the shipped CLI against
 * a fake pipe that records what it was asked. Both turn into the one V2 method
 * `workspace.set_ssh_target`; an empty argv is what clears the target.
 */
const CLI = path.resolve(__dirname, '../../resources/cli/wmux.js');
// WMUX_REMOTE is blanked in run(): inside a devcontainer it is set, the CLI
// prefers it over WMUX_PIPE, and the test would talk to the real wmux.

interface Run {
  code: number | null;
  stderr: string;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
}

async function run(args: string[], env: Record<string, string> = {}, error?: string): Promise<Run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cli-ssh-target-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux-cli-ssh-target-${process.pid}-${Date.now()}`
    : path.join(dir, 'pipe.sock');
  const requests: Run['requests'] = [];
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const request = JSON.parse(chunk.toString().split('\n')[0]);
      requests.push({ method: request.method, params: request.params });
      socket.write(JSON.stringify(error
        ? { id: request.id, error: { code: -32000, message: error } }
        : { id: request.id, result: { ok: true } }) + '\n');
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.on('error', reject);
      server.listen(socketPath, () => resolve());
    });
    return await new Promise<Run>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        env: { ...process.env, WMUX_PIPE: socketPath, WMUX_PIPE_TOKEN: 'test-token', WMUX_SURFACE_ID: '', WMUX_REMOTE: '', WMUX_REMOTE_TOKEN: '', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, stderr, requests }));
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ARGV = ['ssh', '-F', 'C:\\Users\\me\\cfg dir\\config', '-p', '2222', 'dev@box.example'];
const argvJson = JSON.stringify(ARGV);

describe('sshTargetParams', () => {
  it('keeps the argv as a JSON array, so no option is re-split', () => {
    expect(sshTargetParams(['--argv-json', argvJson, '--path', '/work/my repo', '--workspace', 'ws-1']))
      .toEqual({ params: { argv: ARGV, path: '/work/my repo', workspaceId: 'ws-1' } });
  });

  it('leaves the workspace out when not given', () => {
    expect(sshTargetParams(['--argv-json', argvJson, '--path', '/w'])).toEqual({ params: { argv: ARGV, path: '/w' } });
  });

  it.each([
    [[], /requires --argv-json/],
    [['--argv-json', 'not json', '--path', '/w'], /JSON array of strings/],
    [['--argv-json', '"ssh host"', '--path', '/w'], /non-empty JSON array/],
    [['--argv-json', '[]', '--path', '/w'], /non-empty JSON array/],
    [['--argv-json', '["ssh", 5]', '--path', '/w'], /non-empty JSON array/],
    [['--argv-json', argvJson], /requires --path/],
    [['--argv-json', argvJson, '--path', '  '], /requires --path/],
    [['--argv-json', argvJson, '--path'], /needs a value/],
    [['--argv-json', argvJson, '--path', '/w', '--wsl-distro'], /needs a value/],
    [['--argv-json', argvJson, '--path', '/w', 'extra'], /./],
  ])('refuses %j', (args, message) => {
    const result = sshTargetParams(args as string[]);
    expect('error' in result && result.error).toMatch(message as RegExp);
  });
});

describe('wmux set-ssh-target', () => {
  it('sends the argv array, path and workspace as one V2 call', async () => {
    const result = await run(['set-ssh-target', '--workspace', 'ws-1', '--argv-json', argvJson, '--path', '/work/repo']);
    expect(result.code).toBe(0);
    expect(result.requests).toEqual([{
      method: 'workspace.set_ssh_target',
      params: { argv: ARGV, path: '/work/repo', workspaceId: 'ws-1' },
    }]);
  });

  it('sends --wsl-distro as wslDistro, and refuses a bad one without calling wmux', async () => {
    const result = await run(['set-ssh-target', '--workspace', 'ws-1', '--argv-json', argvJson, '--path', '/w', '--wsl-distro', 'Ubuntu-24.04']);
    expect(result.code).toBe(0);
    expect(result.requests[0].params).toEqual({ argv: ARGV, path: '/w', workspaceId: 'ws-1', wslDistro: 'Ubuntu-24.04' });
    const bad = await run(['set-ssh-target', '--argv-json', argvJson, '--path', '/w', '--wsl-distro', '-d']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('--wsl-distro');
    expect(bad.requests).toEqual([]);
  });

  it('carries the caller surface so the workspace can default to its own', async () => {
    const result = await run(['set-ssh-target', '--argv-json', argvJson, '--path', '/w'], { WMUX_SURFACE_ID: 'surf-9' });
    expect(result.requests[0].params).toEqual({ argv: ARGV, path: '/w', caller: 'surf-9' });
  });

  it('refuses bad input without calling wmux', async () => {
    const result = await run(['set-ssh-target', '--argv-json', '[]', '--path', '/w']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--argv-json');
    expect(result.stderr).toContain('wmux set-ssh-target');
    expect(result.requests).toEqual([]);
  });

  it('exits non-zero when wmux reports a miss, so the caller learns nothing changed', async () => {
    const result = await run(['set-ssh-target', '--workspace', 'ws-gone', '--argv-json', argvJson, '--path', '/w'], {}, 'Workspace not found: ws-gone');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Workspace not found: ws-gone');
  });

  it('is described by --help', async () => {
    const result = await run(['set-ssh-target', '--help']);
    expect(result.code).toBe(0);
    expect(result.requests).toEqual([]);
  });
});

describe('wmux clear-ssh-target', () => {
  it('sends an empty argv for the named workspace', async () => {
    const result = await run(['clear-ssh-target', '--workspace', 'ws-1']);
    expect(result.code).toBe(0);
    expect(result.requests).toEqual([{ method: 'workspace.set_ssh_target', params: { argv: [], workspaceId: 'ws-1' } }]);
  });

  it('sends an empty argv with no workspace, for the caller\'s own', async () => {
    const result = await run(['clear-ssh-target']);
    expect(result.requests[0].params).toEqual({ argv: [] });
  });
});
