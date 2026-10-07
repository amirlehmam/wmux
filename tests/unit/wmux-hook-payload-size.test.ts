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

describe('wmux-hook.js Notification kind (issue #253)', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it('forwards notification_type, which is what tells the idle reminder from a prompt', async () => {
    const server = await startCapturingServer();
    close = server.close;

    await runHook(['--event', 'Notification'], envFor(server.port), JSON.stringify({
      session_id: 'abc123DEF-456_789',
      hook_event_name: 'Notification',
      message: 'Claude is waiting for your input',
      notification_type: 'idle_prompt',
    }));

    const req = await server.requests;
    expect(req.params.event).toBe('Notification');
    expect(req.params.notificationType).toBe('idle_prompt');
    expect(req.params.message).toBe('Claude is waiting for your input');
  });

  it("reads Grok Build's camelCase envelope, but never its sessionId", async () => {
    const server = await startCapturingServer();
    close = server.close;

    // Grok runs the ~/.claude/settings.json hooks through its Claude
    // compatibility and fires idle_prompt at every turn end. Without the type
    // the pane reads "Needs you"; with Grok's session id, restore would run
    // `claude --resume` on an id Claude has never seen. Shape and env as
    // captured from grok 1.0.44: both id spellings, GROK_HOOK_EVENT set.
    const env = { ...envFor(server.port), GROK_HOOK_EVENT: 'notification' };
    await runHook(['--event', 'Notification'], env, JSON.stringify({
      hookEventName: 'notification',
      hook_event_name: 'Notification',
      sessionId: 'grok-session-0001',
      session_id: 'grok-session-0001',
      toolName: 'run_terminal_command',
      message: 'Grok is waiting for your input',
      notificationType: 'idle_prompt',
    }));

    const req = await server.requests;
    expect(req.params.notificationType).toBe('idle_prompt');
    expect(req.params.tool).toBe('run_terminal_command');
    expect(req.params.sessionId).toBeUndefined();
  });

  it('reports Grok\'s StopCancelled as the turn ending, and a subagent\'s as SubagentStop', async () => {
    for (const [event, payload, expected] of [
      ['StopCancelled', { hook_event_name: 'StopCancelled', reason: 'user_interrupt' }, 'Stop'],
      ['StopFailure', { hook_event_name: 'StopFailure', subagentType: 'explore' }, 'SubagentStop'],
    ] as const) {
      const server = await startCapturingServer();
      close = server.close;
      await runHook(['--event', event], envFor(server.port), JSON.stringify(payload));
      expect((await server.requests).params.event).toBe(expected);
      await server.close();
      close = undefined;
    }
  });

  it("reports nothing for a Grok subagent's own SessionEnd or UserPromptSubmit", async () => {
    // A Grok subagent is its own session firing on the PARENT's pane. Its
    // SessionEnd would release the pane's record mid-turn; its UserPromptSubmit
    // (the task brief) would clear a "Needs you" nobody answered and enter the
    // prompt log as something the user typed.
    for (const [event, payload] of [
      ['SessionEnd', { hook_event_name: 'SessionEnd', reason: 'completed', subagentType: 'explore' }],
      ['UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt: 'find the config loader', subagentType: 'explore' }],
    ] as const) {
      const server = await startCapturingServer();
      close = server.close;
      await runHook(['--event', event], envFor(server.port), JSON.stringify(payload));
      // The helper has exited; a frame it sent would already be here.
      const got = await Promise.race([
        server.requests,
        new Promise((r) => setTimeout(() => r('nothing'), 300)),
      ]);
      expect(got).toBe('nothing');
      await server.close();
      close = undefined;
    }
  });

  it("still reports the MAIN session's SessionEnd and UserPromptSubmit under Grok", async () => {
    const server = await startCapturingServer();
    close = server.close;
    const env = { ...envFor(server.port), GROK_HOOK_EVENT: 'user_prompt_submit' };
    await runHook(['--event', 'UserPromptSubmit'], env, JSON.stringify({
      hook_event_name: 'UserPromptSubmit', sessionId: 'grok-session-0001', prompt: 'fix the build',
    }));
    const req = await server.requests;
    expect(req.params.event).toBe('UserPromptSubmit');
    expect(req.params.prompt).toBe('fix the build');
  });

  it("keeps a Grok subagent's tool events and turn ending on the pane", async () => {
    for (const [event, payload, expected] of [
      ['PreToolUse', { hook_event_name: 'PreToolUse', toolName: 'read_file', subagentType: 'explore' }, 'PreToolUse'],
      ['StopCancelled', { hook_event_name: 'StopCancelled', reason: 'max_turns', subagentType: 'explore' }, 'SubagentStop'],
    ] as const) {
      const server = await startCapturingServer();
      close = server.close;
      await runHook(['--event', event], envFor(server.port), JSON.stringify(payload));
      expect((await server.requests).params.event).toBe(expected);
      await server.close();
      close = undefined;
    }
  });

  it('forwards a Claude session id — the Grok guard is on the env, not the payload', async () => {
    const server = await startCapturingServer();
    close = server.close;
    const env = envFor(server.port);
    delete env.GROK_HOOK_EVENT;
    await runHook(['--event', 'Stop'], env, JSON.stringify({
      session_id: 'abc123DEF-456_789', hook_event_name: 'Stop',
    }));
    const req = await server.requests;
    expect(req.params.event).toBe('Stop');
    expect(req.params.sessionId).toBe('abc123DEF-456_789');
  });

  it('drops a notification_type that is not an identifier', async () => {
    const server = await startCapturingServer();
    close = server.close;

    await runHook(['--event', 'Notification'], envFor(server.port), JSON.stringify({
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
      notification_type: 'x'.repeat(500),
    }));

    const req = await server.requests;
    expect(req.params.notificationType).toBeUndefined();
    expect(req.params.message).toBe('Claude needs your permission to use Bash');
  });
});

describe('wmux-hook.js subagent identity (issue #272)', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it('forwards agent_id and agent_type from a hook fired inside a subagent', async () => {
    const server = await startCapturingServer();
    close = server.close;

    await runHook(['--event', 'SubagentStart'], envFor(server.port), JSON.stringify({
      hook_event_name: 'SubagentStart',
      agent_id: 'a1b2c3',
      agent_type: 'general-purpose',
    }));

    const req = await server.requests;
    expect(req.params.event).toBe('SubagentStart');
    expect(req.params.agentId).toBe('a1b2c3');
    expect(req.params.agentType).toBe('general-purpose');
  });

  it('drops an agent_id that is not an identifier', async () => {
    const server = await startCapturingServer();
    close = server.close;

    await runHook(['--event', 'PreToolUse'], envFor(server.port), JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      agent_id: 'not an id; rm -rf',
      agent_type: 'Explore',
    }));

    const req = await server.requests;
    expect(req.params.tool).toBe('Bash');
    expect(req.params.agentId).toBeUndefined();
    expect(req.params.agentType).toBeUndefined();
  });
});
