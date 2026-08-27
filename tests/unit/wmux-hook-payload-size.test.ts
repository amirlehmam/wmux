import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import net from 'net';
import path from 'path';

/**
 * What a LARGE hook payload does to the fields wmux reads out of it (issue #207).
 *
 * The prompt log made stdin size a correctness question rather than a comfort
 * one. Before it, every field this helper extracted was short — a file path, a
 * notification message — and the 64 KB stdin cap was unreachable in practice.
 * A prompt carries whatever the user typed, so a pasted file reaches the cap
 * routinely; and because a cut-off payload is invalid JSON, `JSON.parse` used
 * to throw for the WHOLE object and take `session_id` with it, silently killing
 * `claude --resume` on the next workspace restore (issue #186).
 *
 * Exercised against the real compiled resources/cli/wmux-hook.js over its TCP
 * remote transport, the same way wmux-hook-remote-transport.test.ts does: this
 * script is a fire-and-forget CLI leaf with no exported functions, and the
 * behaviour under test is precisely what the shipped process does with bytes on
 * its stdin.
 */

const HOOK_SCRIPT = path.resolve(__dirname, '../../resources/cli/wmux-hook.js');

/** Mirrors MAX_PROMPT in src/cli/wmux-hook.ts. */
const MAX_PROMPT = 4000;

function runHook(args: string[], env: Record<string, string>, stdin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // process.execPath, not a bare 'node': the runtime that is already running
    // this test, resolved absolutely, so nothing on PATH decides what executes.
    const child = execFile(process.execPath, [HOOK_SCRIPT, ...args], { env, timeout: 15000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
    child.stdin?.end(stdin);
  });
}

interface CapturingServer {
  port: number;
  requests: Promise<any>;
  close: () => Promise<void>;
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((done) => server.close(() => done()));
}

/** One newline-delimited JSON-RPC frame off a connection, then hang up. */
function collectFrame(socket: net.Socket, deliver: (frame: any) => void): void {
  let data = '';
  socket.on('data', (chunk) => {
    data += chunk.toString();
    if (!data.includes('\n')) return;
    deliver(JSON.parse(data.trim()));
    socket.end();
  });
}

function startCapturingServer(): Promise<CapturingServer> {
  let deliver: (frame: any) => void;
  const requests = new Promise<any>((r) => { deliver = r; });
  const server = net.createServer((socket) => collectFrame(socket, deliver));
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      ready({
        port: typeof addr === 'object' && addr ? addr.port : 0,
        requests,
        close: () => closeServer(server),
      });
    });
  });
}

function envFor(port: number): Record<string, string> {
  return {
    ...process.env,
    WMUX_REMOTE: `127.0.0.1:${port}`,
    WMUX_REMOTE_TOKEN: 't',
    WMUX_SURFACE_ID: 'surf-payload',
  } as Record<string, string>;
}

describe('wmux-hook.js oversized payloads (issue #207)', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it('parses a UserPromptSubmit payload far past the old 64 KB cap', async () => {
    const server = await startCapturingServer();
    close = server.close;

    // 400 KB of prompt: unreachable under the old cap, ordinary for someone who
    // pasted a source file into their prompt.
    const payload = JSON.stringify({
      session_id: 'abc123DEF-456_789',
      cwd: '/workspaces/repo',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'x'.repeat(400_000),
    });
    expect(payload.length).toBeGreaterThan(64 * 1024);

    await runHook(['--event', 'UserPromptSubmit'], envFor(server.port), payload);

    const req = await server.requests;
    // The whole object survived — session_id included, which is the field whose
    // loss is invisible until a restore fails to resume anything.
    expect(req.params.sessionId).toBe('abc123DEF-456_789');
    // The prompt is still clamped to MAX_PROMPT: a bigger stdin cap is about
    // being able to READ the payload, not about what travels the pipe.
    expect(req.params.prompt).toHaveLength(MAX_PROMPT);
  });

  it('still recovers session_id when the payload is not valid JSON', async () => {
    const server = await startCapturingServer();
    close = server.close;

    // A payload cut off mid-prompt — what the stdin cap produces, and what any
    // writer that died halfway produces. There is no object to read fields off.
    const truncated = JSON.stringify({
      session_id: 'salvage-me-01234',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'y'.repeat(500),
    }).slice(0, 300);
    expect(() => JSON.parse(truncated)).toThrow();

    await runHook(['--event', 'UserPromptSubmit'], envFor(server.port), truncated);

    const req = await server.requests;
    // Degraded, not failed: resume survives a payload the prompt could not.
    expect(req.params.sessionId).toBe('salvage-me-01234');
    expect(req.params.prompt).toBeUndefined();
  });

  it('does not salvage a session_id buried past the head of the payload', async () => {
    const server = await startCapturingServer();
    close = server.close;

    // The exact thing a whole-payload scan would get wrong: a user pastes a
    // document that itself contains the characters `"session_id": "..."`. The
    // scan window stops well before it, so nothing is salvaged and resume is
    // simply unavailable — the right way to be wrong, since the alternative is
    // resuming a conversation the user never named.
    const decoy = `{"prompt":"${'z'.repeat(5000)}","session_id":"not-mine-000000"`;
    expect(() => JSON.parse(decoy)).toThrow();

    await runHook(['--event', 'UserPromptSubmit'], envFor(server.port), decoy);

    const req = await server.requests;
    expect(req.params.sessionId).toBeUndefined();
  });
});
