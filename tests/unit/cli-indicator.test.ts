import { describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

/**
 * `wmux set-indicator` / `clear-indicator`, run as the shipped CLI against a
 * fake pipe that records what it was asked. Both turn into the one V2 method
 * `workspace.set_indicator`; empty text is what clears the pill.
 */
const CLI = path.resolve(__dirname, '../../resources/cli/wmux.js');
// WMUX_REMOTE is blanked in run(): inside a devcontainer it is set, the CLI
// prefers it over WMUX_PIPE, and the test would talk to the real wmux.

interface Run {
  code: number | null;
  stderr: string;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
}

async function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cli-indicator-'));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\wmux-cli-indicator-${process.pid}-${Date.now()}`
    : path.join(dir, 'pipe.sock');
  const requests: Run['requests'] = [];
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const request = JSON.parse(chunk.toString().split('\n')[0]);
      requests.push({ method: request.method, params: request.params });
      socket.write(JSON.stringify({ id: request.id, result: { ok: true } }) + '\n');
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

describe('wmux set-indicator', () => {
  it('sends text, colour and workspace, keeping the text as one argument', async () => {
    const result = await run(['set-indicator', '--workspace', 'ws-1', '--text', "dev box $HOME 'x'", '--color', '#112233']);
    expect(result.code).toBe(0);
    expect(result.requests).toEqual([{
      method: 'workspace.set_indicator',
      params: { text: "dev box $HOME 'x'", workspaceId: 'ws-1', color: '#112233' },
    }]);
  });

  it('leaves workspace and colour out when not given, so the caller\'s workspace and the accent apply', async () => {
    const result = await run(['set-indicator', '--text', 'SSH']);
    expect(result.code).toBe(0);
    expect(result.requests[0].params).toEqual({ text: 'SSH' });
  });

  it('carries the caller surface so the workspace can default to its own', async () => {
    const result = await run(['set-indicator', '--text', 'SSH'], { WMUX_SURFACE_ID: 'surf-9' });
    expect(result.requests[0].params).toEqual({ text: 'SSH', caller: 'surf-9' });
  });

  it.each([[[]], [['--text', '   ']]])('refuses missing or blank text (%j) without calling wmux', async (extra) => {
    const result = await run(['set-indicator', ...extra]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('set-indicator requires --text');
    expect(result.requests).toEqual([]);
  });

  it('refuses a --text with no value without calling wmux', async () => {
    const result = await run(['set-indicator', '--text']);
    expect(result.code).toBe(1);
    expect(result.requests).toEqual([]);
  });
});

describe('wmux clear-indicator', () => {
  it('sends empty text for the named workspace', async () => {
    const result = await run(['clear-indicator', '--workspace', 'ws-1']);
    expect(result.code).toBe(0);
    expect(result.requests).toEqual([{ method: 'workspace.set_indicator', params: { text: '', workspaceId: 'ws-1' } }]);
  });

  it('sends empty text with no workspace, for the caller\'s own', async () => {
    const result = await run(['clear-indicator']);
    expect(result.requests[0].params).toEqual({ text: '' });
  });
});
