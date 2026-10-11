/** Opt in with WMUX_TEST_CODEX_EXE=<native codex.exe>, after build:main.
 * Real Windows TUI + app-server, isolated CODEX_HOME, no account or inference.
 * A localhost HTTP error materializes a fixture conversation without a model.
 */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import net from 'net';
import { createServer } from 'http';
import { stripVTControlCharacters } from 'util';
import { WebSocket } from 'ws';
import { createCodexRelay, type CodexRelay } from '../../src/cli/codex-relay';

const executable = process.env.WMUX_TEST_CODEX_EXE;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function client(relay: CodexRelay) {
  const socket = new WebSocket(relay.url, { headers: { Authorization: `Bearer ${relay.token}` } });
  cleanup.push(() => socket.terminate());
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let next = 0;
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  let completed = false;
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.method === 'turn/completed') completed = true;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await request('initialize', { clientInfo: { name: 'wmux_test', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: 'initialized' }));
  return { request, get completed() { return completed; } };
}

it.skipIf(process.platform !== 'win32' || !executable)('resumes with full access through the real Windows TUI and keeps automatic restore tracking', async () => {
  const { spawn } = await import('node-pty');
  const dir = mkdtempSync(path.join(tmpdir(), 'wmux-codex-yolo-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const http = createServer((_req, res) => { res.writeHead(503); res.end('No inference in this test'); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => http.close(() => resolve())));
  const port = (http.address() as net.AddressInfo).port;
  const config = `model = "gpt-5.4"
model_provider = "wmux_test"
approval_policy = "on-request"
sandbox_mode = "read-only"
check_for_update_on_startup = false
[model_providers.wmux_test]
name = "wmux test"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
[projects.${JSON.stringify(dir)}]
trust_level = "trusted"
`;
  writeFileSync(path.join(dir, 'config.toml'), config);
  const env = { ...process.env, CODEX_HOME: dir, TERM: 'xterm-256color' };
  delete env.ELECTRON_RUN_AS_NODE;
  const relay = async () => {
    const instance = await createCodexRelay({ executable: executable!, args: ['app-server', '--stdio'], cwd: dir, env, onSession() {} });
    cleanup.push(() => instance.close());
    return instance;
  };
  const first = await relay();
  const seed = await client(first);
  const started = await seed.request('thread/start', { cwd: dir, approvalPolicy: 'on-request', sandbox: 'read-only' });
  const threadId = started.thread.id;
  expect(started.approvalPolicy).toBe('on-request');
  expect(started.sandbox.type).toBe('readOnly');
  await seed.request('turn/start', { threadId, input: [{ type: 'text', text: 'Fixture for resume test', text_elements: [] }] });
  await expect.poll(() => seed.completed, { timeout: 20000 }).toBe(true);
  await first.close();

  const pipe = `\\\\.\\pipe\\wmux-codex-yolo-test-${process.pid}-${Date.now()}`;
  const calls: Array<{ method: string; params: any }> = [];
  const wmux = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.split('\n')[0]);
      expect(request.token).toBe('test-only');
      calls.push(request);
      socket.write(JSON.stringify({ id: request.id, result: { enabled: true } }) + '\n', () => socket.destroy());
    });
  });
  await new Promise<void>(resolve => wmux.listen(pipe, resolve));
  cleanup.push(() => new Promise<void>(resolve => wmux.close(() => resolve())));
  const tui = spawn(process.execPath, [path.resolve('dist/cli/wmux-codex.js'), 'resume', threadId, '--yolo'], {
    name: 'xterm-256color', cols: 100, rows: 30, cwd: dir,
    env: { ...env, WMUX_CODEX_EXE: executable!, WMUX_PIPE: pipe, WMUX_PIPE_TOKEN: 'test-only', WMUX_SURFACE_ID: 'surf-yolo-test' },
  });
  let output = '';
  let exited = false;
  const tuiExit = new Promise<void>(resolve => tui.onExit(() => { exited = true; resolve(); }));
  cleanup.push(async () => { if (!exited) tui.kill(); await tuiExit; });
  tui.onData(data => { output += data; if (data.includes('\x1b[6n')) tui.write('\x1b[1;1R'); });
  await expect.poll(() => calls.some(call => call.method === 'pane.report_codex_session' && call.params.sessionId === threadId), { timeout: 20000 }).toBe(true);
  expect(output).not.toContain('Permission overrides are not supported');
  await expect.poll(() => output, { timeout: 10000 }).toContain('Fixture');
  tui.write('/status');
  await expect.poll(() => output, { timeout: 5000 }).toContain('/status');
  tui.write('\r');
  const visible = () => stripVTControlCharacters(output.replace(/\x1b\[(\d+)C/g, (_, count) => ' '.repeat(Number(count))));
  await expect.poll(visible, { timeout: 10000 }).toContain('Full Access');
  tui.write('/quit');
  await expect.poll(() => output, { timeout: 5000 }).toContain('/quit');
  tui.write('\r');
  await expect.poll(() => ({ exited, output }), { timeout: 15000 }).toMatchObject({ exited: true });
  expect(calls.some(call => call.method === 'pane.release_codex_session' && call.params.sessionId === threadId)).toBe(true);

  // A flag-free restore must still find the same conversation. Codex owns
  // settings persistence: legacy sandbox choices can revert to config.toml
  // defaults on a later plain resume (including with the native launcher).
  const restored = await client(await relay());
  const resumed = await restored.request('thread/resume', { threadId });
  expect(resumed.thread.id).toBe(threadId);
  expect(resumed.approvalPolicy).toBe('never');
  // The TUI may append its own first-run preferences, but wmux must not persist
  // the launch's permission choices into the user's configuration defaults.
  expect(readFileSync(path.join(dir, 'config.toml'), 'utf8')).toContain(config.trim());
}, 90000);
