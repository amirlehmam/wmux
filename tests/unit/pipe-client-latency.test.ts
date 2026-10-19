import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
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
 *
 * What they assert is the client's SEQUENCE, read from inside it by a preloaded
 * tracer (tests/helpers/socket-trace.cjs): it never half-closes while waiting,
 * and destroying the connection is the first thing it does once the reply is in.
 * They used to time the exit instead, against a 45 ms budget set just under the
 * 50 ms timer. That measured the machine as much as the client: a loaded CI
 * runner hit 20.3 ms (the budget was 20 then), and a busy Windows desktop
 * running the full suite measured 50–1114 ms for a client doing the right
 * thing — node teardown and scheduling, not the pipe.
 */

const CLI_DIR = path.resolve(__dirname, '../../resources/cli');
const HOOK_SCRIPT = path.join(CLI_DIR, 'wmux-hook.js');
const CLI_SCRIPT = path.join(CLI_DIR, 'wmux.js');
const TRACER = path.resolve(__dirname, '../helpers/socket-trace.cjs');

/**
 * A client that missed the reply would sit until its own 5 s deadline; this
 * only tells the two apart, so it can afford to be loose.
 */
const LONG_BEFORE_DEADLINE_MS = 4000;

let testCounter = 0;
function uniquePipe(): string {
  return `\\\\.\\pipe\\wmux-latency-${process.pid}-${++testCounter}`;
}

/**
 * Answer the first line on `socket` and leave the connection open — the
 * pre-fix server's behaviour. `onReplied` fires from the write callback, the
 * moment the bytes are handed to the OS.
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

interface ClientRun { exitedAt: number; code: number | null; stdout: string; trace: string[] }

function runClient(script: string, args: string[], env: Record<string, string | undefined>, stdin = ''): Promise<ClientRun> {
  const traceFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-socket-trace-')), 'trace.log');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', TRACER, script, ...args], {
      env: { ...env, WMUX_SOCKET_TRACE: traceFile } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      const exitedAt = performance.now();
      let trace: string[] = [];
      try { trace = fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean); } catch { /* no socket at all */ }
      fs.rmSync(path.dirname(traceFile), { recursive: true, force: true });
      resolve({ exitedAt, code, stdout, trace });
    });
    child.stdin.end(stdin);
    setTimeout(() => { child.kill(); reject(new Error('client did not exit')); }, 8000);
  });
}

/** The client waited for the reply without half-closing, then destroyed the connection first thing. */
function expectDestroyOnReply(trace: string[]): void {
  const reply = trace.indexOf('data');
  expect(reply, `no reply reached the client: ${JSON.stringify(trace)}`).toBeGreaterThanOrEqual(0);
  // An end() here is the bug: libuv's 50 ms eof_timeout before the client can exit.
  expect(trace.slice(0, reply)).not.toContain('end');
  expect(trace.slice(reply + 1).find((step) => step !== 'data')).toBe('destroy');
}

describe('pipe clients exit right behind the reply, against a server that never closes', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it('wmux-hook.js destroys its connection on the reply', async () => {
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
    const { exitedAt, code, trace } = await run;
    expect(code).toBe(0);
    expectDestroyOnReply(trace);
    expect(exitedAt - repliedAt).toBeLessThan(LONG_BEFORE_DEADLINE_MS);
  });

  it('wmux.js ping (sendV1) destroys its connection on pong', async () => {
    const pipe = uniquePipe();
    const server = await neverClosingServer(pipe, () => 'pong');
    close = server.close;

    const run = runClient(CLI_SCRIPT, ['ping'], { ...process.env, WMUX_PIPE: pipe, WMUX_REMOTE: undefined });
    const repliedAt = await server.repliedAt;
    const { exitedAt, code, stdout, trace } = await run;
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('pong');
    expectDestroyOnReply(trace);
    expect(exitedAt - repliedAt).toBeLessThan(LONG_BEFORE_DEADLINE_MS);
  });

  it('wmux.js identify (sendV2) destroys its connection on the result', async () => {
    const pipe = uniquePipe();
    const server = await neverClosingServer(pipe, () => JSON.stringify({ result: { app: 'wmux' }, id: 1 }));
    close = server.close;

    const run = runClient(CLI_SCRIPT, ['identify'], { ...process.env, WMUX_PIPE: pipe, WMUX_REMOTE: undefined });
    const repliedAt = await server.repliedAt;
    const { exitedAt, code, stdout, trace } = await run;
    expect(code).toBe(0);
    expect(stdout).toContain('wmux');
    expectDestroyOnReply(trace);
    expect(exitedAt - repliedAt).toBeLessThan(LONG_BEFORE_DEADLINE_MS);
  });

  // The tracer has to be able to see the bug, or the tests above prove nothing.
  it('catches a client that half-closes before its reply', async () => {
    const pipe = uniquePipe();
    const server = await neverClosingServer(pipe, () => 'pong');
    close = server.close;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-old-client-'));
    const oldClient = path.join(dir, 'old-client.js');
    fs.writeFileSync(oldClient, `const c=require('net').connect(process.env.WMUX_PIPE,()=>{c.write('ping\\n');c.end();});
      c.on('data',()=>{});c.on('close',()=>process.exit(0));`);
    try {
      const { trace } = await runClient(oldClient, [], { ...process.env, WMUX_PIPE: pipe });
      expect(trace.indexOf('end')).toBeGreaterThanOrEqual(0);
      expect(trace.indexOf('end')).toBeLessThan(trace.indexOf('data'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
