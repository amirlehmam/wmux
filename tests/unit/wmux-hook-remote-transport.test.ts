import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import net from 'net';
import path from 'path';

// Exercises the real compiled wmux-hook.js (resources/cli/wmux-hook.js) over
// its TCP remote-mode transport (WMUX_REMOTE, issue #19/#78) against a raw
// TCP server standing in for `wmux bridge`. Unlike the named-pipe path, this
// script has no exported functions to unit test directly (it's a
// fire-and-forget CLI leaf), so we verify its actual process behavior
// end-to-end instead.

const HOOK_SCRIPT = path.resolve(__dirname, '../../resources/cli/wmux-hook.js');

function runHook(args: string[], env: Record<string, string>, stdin = ''): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('node', [HOOK_SCRIPT, ...args], { env, timeout: 5000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
    child.stdin?.end(stdin);
  });
}

function startCapturingServer(): Promise<{ port: number; requests: Promise<any>; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    let resolveRequest: (v: any) => void;
    const requests = new Promise<any>((r) => { resolveRequest = r; });

    const server = net.createServer((socket) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\n')) {
          resolveRequest(JSON.parse(data.trim()));
          socket.end();
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe('wmux-hook.js TCP remote-mode transport (issue #19)', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it('sends hook.event over TCP with the token when WMUX_REMOTE is set', async () => {
    const server = await startCapturingServer();
    close = server.close;

    await runHook(['Bash'], {
      ...process.env,
      WMUX_REMOTE: `127.0.0.1:${server.port}`,
      WMUX_REMOTE_TOKEN: 'secret-token',
      WMUX_SURFACE_ID: 'pane-1',
    } as Record<string, string>);

    const req = await server.requests;
    expect(req.method).toBe('hook.event');
    expect(req.token).toBe('secret-token');
    // Same frame the pipe path sends, including the `at` fire stamp wmux orders
    // racing hook processes by (issue #151) — the transport is all that differs.
    expect(req.params).toEqual({ tool: 'Bash', surfaceId: 'pane-1', at: expect.any(Number) });
    expect(req.params.at).toBeGreaterThan(0);
  });

  it('includes file_path from PostToolUse Edit/Write stdin payloads', async () => {
    const server = await startCapturingServer();
    close = server.close;

    await runHook(
      ['Edit'],
      { ...process.env, WMUX_REMOTE: `127.0.0.1:${server.port}`, WMUX_REMOTE_TOKEN: 't', WMUX_SURFACE_ID: 'pane-2' } as Record<string, string>,
      JSON.stringify({ tool_input: { file_path: '/workspaces/repo/foo.ts' } }),
    );

    const req = await server.requests;
    expect(req.params).toEqual({ tool: 'Edit', file: '/workspaces/repo/foo.ts', surfaceId: 'pane-2', at: expect.any(Number) });
  });

  it('sends the --event flag as the event field for Notification/Stop', async () => {
    const server = await startCapturingServer();
    close = server.close;

    await runHook(
      ['--event', 'Notification'],
      { ...process.env, WMUX_REMOTE: `127.0.0.1:${server.port}`, WMUX_REMOTE_TOKEN: 't', WMUX_SURFACE_ID: '' } as Record<string, string>,
      JSON.stringify({ message: 'Permission needed' }),
    );

    const req = await server.requests;
    expect(req.params).toEqual({ event: 'Notification', message: 'Permission needed', at: expect.any(Number) });
  });

  it('defaults to port 9787 when WMUX_REMOTE has no explicit port', async () => {
    // Can't bind 9787 in a shared test env reliably, so just assert it doesn't
    // fall back to the named pipe (would hang/error differently) — connection
    // refused on the default port is the expected, quick failure mode here.
    await expect(
      runHook(['Bash'], {
        ...process.env,
        WMUX_REMOTE: '127.0.0.1',
        WMUX_REMOTE_TOKEN: 't',
      } as Record<string, string>),
    ).resolves.toBeUndefined();
  });

  it('exits cleanly (does not hang or throw) when the remote target is unreachable', async () => {
    await expect(
      runHook(['Bash'], {
        ...process.env,
        WMUX_REMOTE: '127.0.0.1:1', // nothing listens on port 1
        WMUX_REMOTE_TOKEN: 't',
      } as Record<string, string>),
    ).resolves.toBeUndefined();
  });
});
