import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import { PipeServer } from '../../src/main/pipe-server';

// Each test gets a unique pipe name to avoid reuse conflicts on Windows
let testCounter = 0;
function uniquePipe(): string {
  return `\\\\.\\pipe\\wmux-test-${process.pid}-${++testCounter}`;
}

function connectAndSend(pipePath: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.connect({ path: pipePath }, () => {
      client.write(message + '\n');
    });
    let data = '';
    client.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) {
        client.end();
        resolve(data.trim());
      }
    });
    client.on('error', reject);
    setTimeout(() => { client.end(); reject(new Error('timeout')); }, 3000);
  });
}

describe('PipeServer', () => {
  let server: PipeServer;

  afterEach(() => {
    server?.stop();
  });

  it('responds to V1 ping', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe);
    server.start();
    await new Promise(r => setTimeout(r, 200)); // wait for server to start

    const response = await connectAndSend(pipe, 'ping');
    expect(response).toBe('pong');
  });

  it('parses authenticated V1 commands', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'test-token');
    const commands: any[] = [];
    server.on('v1', (cmd) => commands.push(cmd));
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, 'auth test-token report_pwd surf-123 C:\\Users\\test');
    expect(response).toBe('ok');
    expect(commands.length).toBe(1);
    expect(commands[0].command).toBe('report_pwd');
    expect(commands[0].surfaceId).toBe('surf-123');
    expect(commands[0].args).toEqual(['C:\\Users\\test']);
  });

  // A restore command is a whole shell line — `cd '/some/path' && ./relaunch.sh`
  // (issue #19). Splitting it on whitespace like the default V1 case would turn
  // it into eight useless args, so it joins report_pwd/notify in the
  // single-free-text-argument group.
  it('keeps a report_startup_command line intact, spaces and all', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'test-token');
    const commands: any[] = [];
    server.on('v1', (cmd) => commands.push(cmd));
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const line = "cd '/workspaces/my project' && ./relaunch.sh --attach";
    const response = await connectAndSend(pipe, `auth test-token report_startup_command surf-123 ${line}`);
    expect(response).toBe('ok');
    expect(commands[0].command).toBe('report_startup_command');
    expect(commands[0].surfaceId).toBe('surf-123');
    expect(commands[0].args).toEqual([line]);
  });

  // An ssh command line is the whole point of report_command, and every
  // interesting one has spaces in it. Under the default V1 case
  // `ssh -p 2222 fortuna@honoured-accident` arrives as four args and the
  // detector sees the destination as "-p" — a pane that looks remote and
  // uploads nowhere. So it belongs in the single-free-text-argument group.
  it('keeps a report_command ssh line intact, spaces and all', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'test-token');
    const commands: any[] = [];
    server.on('v1', (cmd) => commands.push(cmd));
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const line = 'ssh -p 2222 -i C:\\keys\\id_ed25519 fortuna@honoured-accident';
    const response = await connectAndSend(pipe, `auth test-token report_command surf-123 ${line}`);
    expect(response).toBe('ok');
    expect(commands[0].command).toBe('report_command');
    expect(commands[0].surfaceId).toBe('surf-123');
    expect(commands[0].args).toEqual([line]);
  });

  it('rejects V1 state updates without a token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    const commands: any[] = [];
    server.on('v1', (cmd) => commands.push(cmd));
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, 'notify surf-123 agent needs your password');
    expect(response).toBe('unauthorized');
    expect(commands.length).toBe(0);
  });

  it('rejects V1 state updates with a wrong token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    const commands: any[] = [];
    server.on('v1', (cmd) => commands.push(cmd));
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, 'auth wrong report_pwd surf-123 C:\\evil');
    expect(response).toBe('unauthorized');
    expect(commands.length).toBe(0);
  });

  it('handles V2 JSON-RPC', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'test-token');
    server.on('v2', (req, respond) => {
      if (req.method === 'workspace.list') {
        respond({ workspaces: [] });
      }
    });
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, JSON.stringify({
      method: 'workspace.list',
      params: {},
      id: 1,
      token: 'test-token',
    }));
    const parsed = JSON.parse(response);
    expect(parsed.result.workspaces).toEqual([]);
    expect(parsed.id).toBe(1);
  });

  it('returns error for unknown V2 method', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'test-token');
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, JSON.stringify({
      method: 'unknown.method',
      params: {},
      id: 2,
      token: 'test-token',
    }));
    const parsed = JSON.parse(response);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe(-32601);
  });

  it('rejects privileged V2 methods without a token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    let handlerCalled = false;
    server.on('v2', (req, respond) => { handlerCalled = true; respond({ ok: true }); });
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, JSON.stringify({
      method: 'agent.spawn',
      params: { cmd: 'calc.exe' },
      id: 3,
    }));
    const parsed = JSON.parse(response);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe(-32001);
    expect(handlerCalled).toBe(false);
  });

  it('rejects privileged V2 methods with a wrong token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    server.on('v2', (req, respond) => respond({ ok: true }));
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, JSON.stringify({
      method: 'browser.eval',
      params: { js: '1+1' },
      id: 4,
      token: 'wrong',
    }));
    const parsed = JSON.parse(response);
    expect(parsed.error.code).toBe(-32001);
  });

  it('allows privileged V2 methods with the correct token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    server.on('v2', (req, respond) => respond({ ok: true }));
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, JSON.stringify({
      method: 'agent.spawn',
      params: { cmd: 'echo hi' },
      id: 5,
      token: 'secret',
    }));
    const parsed = JSON.parse(response);
    expect(parsed.result).toEqual({ ok: true });
  });

  it('allows public V2 methods without a token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    server.on('v2', (req, respond) => {
      if (req.method === 'system.identify') respond({ name: 'wmux' });
    });
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, JSON.stringify({
      method: 'system.identify',
      params: {},
      id: 6,
    }));
    const parsed = JSON.parse(response);
    expect(parsed.result.name).toBe('wmux');
  });

  it('rejects pane.answer_agent without a token', async () => {
    // The back-channel (issue #128) is the first agent-state method that WRITES
    // into a PTY, so it must never drift onto the public allowlist. The
    // allowlist is deny-by-default, which is exactly why this deserves a pin:
    // the guard is an absence, and absences are easy to delete by accident.
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    let handlerCalled = false;
    server.on('v2', (req, respond) => { handlerCalled = true; respond({ ok: true }); });
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, JSON.stringify({
      method: 'pane.answer_agent',
      params: { surfaceId: 'surf-1', choiceId: 'allow' },
      id: 91,
    }));
    expect(JSON.parse(response).error.code).toBe(-32001);
    expect(handlerCalled).toBe(false);
  });

  it('still accepts unauthenticated V1 ping', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const response = await connectAndSend(pipe, 'ping');
    expect(response).toBe('pong');
  });

  it('rejects hook.event and agent.activity without a token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    let handlerCalled = false;
    server.on('v2', (req, respond) => { handlerCalled = true; respond({ ok: true }); });
    server.start();
    await new Promise(r => setTimeout(r, 200));

    for (const method of ['hook.event', 'agent.activity']) {
      const response = await connectAndSend(pipe, JSON.stringify({
        method,
        params: { surfaceId: 'surf-victim', done: true, tool: 'Edit' },
        id: 7,
      }));
      const parsed = JSON.parse(response);
      expect(parsed.error?.code).toBe(-32001);
    }
    expect(handlerCalled).toBe(false);
  });

  it('allows hook.event and agent.activity with the correct token', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    server.on('v2', (req, respond) => respond({ ok: true }));
    server.start();
    await new Promise(r => setTimeout(r, 200));

    for (const method of ['hook.event', 'agent.activity']) {
      const response = await connectAndSend(pipe, JSON.stringify({
        method,
        params: { surfaceId: 'surf-1', tool: 'Edit' },
        id: 8,
        token: 'secret',
      }));
      const parsed = JSON.parse(response);
      expect(parsed.result).toEqual({ ok: true });
    }
  });
});

// The server closes the connection itself, right behind the reply.
//
// Every wmux client is one request per connection and one reply per request, and
// every one of them used to finish with `socket.end()` — a half-close. On a Windows
// named pipe libuv answers a half-close by arming a 50 ms `eof_timeout`
// (src/win/pipe.c) before it will report EOF, and since the server never closed its
// side, every round trip paid that timer: `wmux ping` measured 96 ms against a pipe
// that answers in 1 ms. A server that replies with `end()` does not help — both
// sides then arm the timer. It has to be `write(reply, () => destroy())`, and the
// client has to see 'close' within a few ms of the reply, not 50+.
function replyThenClose(pipePath: string, message: string): Promise<{ reply: string; closeAfterReplyMs: number }> {
  return new Promise((resolve, reject) => {
    const client = net.connect({ path: pipePath }, () => {
      client.write(message + '\n');
    });
    let data = '';
    let repliedAt = 0;
    client.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n') && !repliedAt) repliedAt = performance.now();
    });
    // Deliberately no end() and no destroy() here: the point is that the SERVER
    // finishes the connection.
    client.on('close', () => {
      if (!repliedAt) return reject(new Error('closed before any reply'));
      resolve({ reply: data.trim(), closeAfterReplyMs: performance.now() - repliedAt });
    });
    client.on('error', reject);
    setTimeout(() => { client.destroy(); reject(new Error('timeout')); }, 3000);
  });
}

describe('PipeServer closes right behind its reply (libuv eof_timeout)', () => {
  let server: PipeServer;

  afterEach(() => {
    server?.stop();
  });

  it('V1: the client sees close within 20 ms of pong', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe);
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const { reply, closeAfterReplyMs } = await replyThenClose(pipe, 'ping');
    expect(reply).toBe('pong');
    expect(closeAfterReplyMs).toBeLessThan(20);
  });

  it('V1: the same for an authenticated ok and for unauthorized', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    server.on('v1', () => {});
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const ok = await replyThenClose(pipe, 'auth secret report_pwd surf-1 C:/work');
    expect(ok.reply).toBe('ok');
    expect(ok.closeAfterReplyMs).toBeLessThan(20);

    const nope = await replyThenClose(pipe, 'report_pwd surf-1 C:/work');
    expect(nope.reply).toBe('unauthorized');
    expect(nope.closeAfterReplyMs).toBeLessThan(20);
  });

  it('V2: the client sees close within 20 ms of the result, and of an error', async () => {
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    server.on('v2', (req, respond, respondError) => {
      // Answer asynchronously, the way the real handlers do (executeJavaScript
      // round trips to the renderer): the close must follow the REPLY, not the
      // request.
      if (req.method === 'workspace.list') setTimeout(() => respond({ workspaces: [] }), 30);
      else respondError(-32601, `Method not found: ${req.method}`);
    });
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const ok = await replyThenClose(pipe, JSON.stringify({ method: 'workspace.list', params: {}, id: 1, token: 'secret' }));
    expect(JSON.parse(ok.reply).result).toEqual({ workspaces: [] });
    expect(ok.closeAfterReplyMs).toBeLessThan(20);

    const err = await replyThenClose(pipe, JSON.stringify({ method: 'nope', params: {}, id: 2, token: 'secret' }));
    expect(JSON.parse(err.reply).error.code).toBe(-32601);
    expect(err.closeAfterReplyMs).toBeLessThan(20);

    const unauth = await replyThenClose(pipe, JSON.stringify({ method: 'workspace.list', params: {}, id: 3 }));
    expect(JSON.parse(unauth.reply).error.code).toBe(-32001);
    expect(unauth.closeAfterReplyMs).toBeLessThan(20);
  });

  it('V2: a reply that is not the last one pending keeps the connection open', async () => {
    // No wmux client pipelines two requests on one connection (audited: the CLI,
    // the hook helper, the shell integrations, the OpenCode plugin and the bridge
    // are all one-shot). The framing loop still handles a chunk carrying two
    // lines, so a close on the FIRST reply would eat the second — hence the
    // guard: close only when nothing is still owed.
    const pipe = uniquePipe();
    server = new PipeServer(pipe, 'secret');
    server.on('v2', (req, respond) => {
      setTimeout(() => respond({ echo: req.id }), req.id === 1 ? 10 : 40);
    });
    server.start();
    await new Promise(r => setTimeout(r, 200));

    const replies = await new Promise<string[]>((resolve, reject) => {
      const client = net.connect({ path: pipe }, () => {
        const a = JSON.stringify({ method: 'x', params: {}, id: 1, token: 'secret' });
        const b = JSON.stringify({ method: 'x', params: {}, id: 2, token: 'secret' });
        client.write(a + '\n' + b + '\n');
      });
      let data = '';
      client.on('data', (chunk) => { data += chunk.toString(); });
      client.on('close', () => resolve(data.split('\n').filter(Boolean)));
      client.on('error', reject);
      setTimeout(() => { client.destroy(); reject(new Error('timeout')); }, 3000);
    });
    expect(replies.map((l) => JSON.parse(l).result)).toEqual([{ echo: 1 }, { echo: 2 }]);
  });
});
