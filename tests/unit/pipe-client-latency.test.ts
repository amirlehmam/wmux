import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import net from 'net';
import path from 'path';

/**
 * Every wmux pipe round trip used to carry ~60 ms of dead wait, and none of it
 * was the server thinking.
 *
 * The clients (the CLI's sendV1/sendV2, the hook helper) wrote their one request
 * and then `socket.end()`ed — a half-close. On a Windows named pipe libuv answers
 * a half-close by arming a 50 ms `eof_timeout` (libuv src/win/pipe.c) before it
 * will report EOF to the reader, and since wmux's server never closed its side,
 * the client sat on that timer before it could exit: `wmux ping` measured 96 ms
 * against a raw pipe that answers in 1 ms, a hook process 95 ms. With
 * destroy-on-reply: 36 ms and 37 ms.
 *
 * These tests pin the CLIENT half against a server that behaves like the OLD
 * wmux — answers, never closes — because that is what an installed wmux is until
 * it is upgraded, and the hook helper on disk is often older than the wmux it
 * talks to. The compiled scripts under resources/cli are exercised, not the
 * TypeScript: those are the bytes a hook actually runs.
 */

const CLI_DIR = path.resolve(__dirname, '../../resources/cli');
const HOOK_SCRIPT = path.join(CLI_DIR, 'wmux-hook.js');
const CLI_SCRIPT = path.join(CLI_DIR, 'wmux.js');

let testCounter = 0;
function uniquePipe(): string {
  return `\\\\.\\pipe\\wmux-latency-${process.pid}-${++testCounter}`;
}

/**
 * Answer the first line on `socket` and leave the connection open — the
 * pre-fix server's behaviour. `onReplied` fires from the write callback, the
 * moment the bytes are handed to the OS, so a latency measured from there is
 * only the client's.
 */
function answerAndHold(socket: net.Socket, reply: (line: string) => string, onReplied: (t: number) => void): void {
  let data = '';
  socket.on('data', (chunk) => {
    data += chunk.toString();
    const nl = data.indexOf('\n');
    if (nl === -1) return;
    const line = data.slice(0, nl);
    data = data.slice(nl + 1);
    socket.write(reply(line) + '\n', () => onReplied(performance.now()));
  });
  socket.on('error', () => {});
}

/** A wmux that answers and never closes — the pre-fix server, and every older install. */
function neverClosingServer(pipePath: string, reply: (line: string) => string): Promise<{
  repliedAt: Promise<number>;
  close: () => Promise<void>;
}> {
  let resolveReplied: (t: number) => void = () => {};
  const repliedAt = new Promise<number>((r) => { resolveReplied = r; });
  const server = net.createServer((socket) => answerAndHold(socket, reply, resolveReplied));
  const close = (): Promise<void> => new Promise((r) => server.close(() => r()));
  return new Promise((resolve) => {
    server.listen(pipePath, () => resolve({ repliedAt, close }));
  });
}

function runClient(script: string, args: string[], env: Record<string, string | undefined>, stdin = ''): Promise<{ exitedAt: number; code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ exitedAt: performance.now(), code, stdout }));
    child.stdin.end(stdin);
    setTimeout(() => { child.kill(); reject(new Error('client did not exit')); }, 8000);
  });
}

describe('pipe clients exit right behind the reply, against a server that never closes', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it('wmux-hook.js exits within 20 ms of the reply', async () => {
    const pipe = uniquePipe();
    const server = await neverClosingServer(pipe, () => JSON.stringify({ result: { ok: true }, id: 1 }));
    close = server.close;

    const run = runClient(HOOK_SCRIPT, ['Bash'], {
      ...process.env,
      WMUX_PIPE: pipe,
      WMUX_PIPE_TOKEN: 'secret',
      WMUX_SURFACE_ID: 'surf-1',
      WMUX_REMOTE: undefined,
    }, JSON.stringify({ session_id: 'abcdefgh', tool_name: 'Bash' }));

    const repliedAt = await server.repliedAt;
    const { exitedAt, code } = await run;
    expect(code).toBe(0);
    expect(exitedAt - repliedAt).toBeLessThan(20);
  });

  it('wmux.js ping (sendV1) exits within 20 ms of pong', async () => {
    const pipe = uniquePipe();
    const server = await neverClosingServer(pipe, () => 'pong');
    close = server.close;

    const run = runClient(CLI_SCRIPT, ['ping'], { ...process.env, WMUX_PIPE: pipe, WMUX_REMOTE: undefined });
    const repliedAt = await server.repliedAt;
    const { exitedAt, code, stdout } = await run;
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('pong');
    expect(exitedAt - repliedAt).toBeLessThan(20);
  });

  it('wmux.js identify (sendV2) exits within 20 ms of the result', async () => {
    const pipe = uniquePipe();
    const server = await neverClosingServer(pipe, () => JSON.stringify({ result: { app: 'wmux' }, id: 1 }));
    close = server.close;

    const run = runClient(CLI_SCRIPT, ['identify'], { ...process.env, WMUX_PIPE: pipe, WMUX_REMOTE: undefined });
    const repliedAt = await server.repliedAt;
    const { exitedAt, code, stdout } = await run;
    expect(code).toBe(0);
    expect(stdout).toContain('wmux');
    expect(exitedAt - repliedAt).toBeLessThan(20);
  });
});
