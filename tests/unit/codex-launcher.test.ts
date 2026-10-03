import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import path from 'path';
import { WebSocket } from 'ws';
import { CodexSessionTracker } from '../../src/cli/codex-session-tracker';
import { codexLaunchPlan } from '../../src/cli/wmux-codex';
import { createCodexRelay, type CodexRelay } from '../../src/cli/codex-relay';

const A = '11111111-2222-3333-4444-555555555555';
const B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const wire = (value: unknown) => JSON.stringify(value);

describe('Codex conversation capture', () => {
  it('pairs successful root responses with this client and follows resume/fork/new', () => {
    const found = vi.fn();
    const tracker = new CodexSessionTracker(found);
    tracker.response(wire({ method: 'thread/started', params: { thread: { id: B } } }));
    tracker.response(wire({ id: 99, result: { thread: { id: B } } }));
    for (const [id, method, thread] of [[1, 'thread/start', A], [2, 'thread/resume', A], [3, 'thread/fork', B]]) {
      tracker.request(wire({ id, method }));
      tracker.response(wire({ id, result: { thread: { id: thread } } }));
    }
    expect(found.mock.calls).toEqual([[A], [B]]);
  });

  it('ignores ephemeral threads requested internally when the first prompt is sent', () => {
    const found = vi.fn();
    const tracker = new CodexSessionTracker(found);
    tracker.request(wire({ id: 1, method: 'thread/start' }));
    tracker.response(wire({ id: 1, result: { thread: { id: A, ephemeral: false } } }));
    tracker.request(wire({ id: 2, method: 'thread/start', params: { ephemeral: true } }));
    tracker.response(wire({ id: 2, result: { thread: { id: B } } }));
    tracker.request(wire({ id: 3, method: 'thread/start' }));
    tracker.response(wire({ id: 3, result: { thread: { id: B, ephemeral: true } } }));
    expect(tracker.sessionId).toBe(A);
    expect(found).toHaveBeenCalledTimes(1);
  });

  it.each([
    { error: { message: 'not found' } },
    { result: { thread: { id: B, parentThreadId: A } } },
    { result: { thread: { id: B, source: { subAgent: {} } } } },
    { result: { thread: { id: '--invalid; command' } } },
  ])('does not replace a saved ID with errors, children or invalid handles', response => {
    const found = vi.fn();
    const tracker = new CodexSessionTracker(found);
    tracker.request(wire({ id: 1, method: 'thread/resume' }));
    tracker.response(wire({ id: 1, ...response }));
    expect(found).not.toHaveBeenCalled();
  });
});

describe('Codex launch compatibility', () => {
  it.each([
    ['exec', 'prompt'], ['-c', 'model="x"', 'exec', 'prompt'], ['app-server', '--stdio'],
    ['--help'], ['--version'], ['--remote=ws://localhost:1234'], ['resume', '--help'],
    ['--profile', 'custom'], ['--worktree'], ['--oss'], ['doctor'],
  ])('passes through native invocations %j', (...args) => {
    expect(codexLaunchPlan(args, process.cwd()).interactive).toBe(false);
  });
  it('preserves quoted overrides and selects the correct backend configuration directory', () => {
    const cwd = process.cwd();
    const plan = codexLaunchPlan(['-c', 'model="a b"', '--enable=feature', '--cd', 'project', 'resume', A], cwd);
    expect(plan).toEqual({ interactive: true, serverArgs: ['app-server', '--stdio', '-c', 'model="a b"', '--enable', 'feature'], cwd: path.join(cwd, 'project') });
  });
  it.each([[], ['resume', A], ['fork', A], ['--no-daemon'], ['--', '--help'], ['Explain > and < literally']])('integrates interactive launches %j', (...args) => {
    expect(codexLaunchPlan(args, process.cwd()).interactive).toBe(true);
  });
});

const relays: CodexRelay[] = [];
const sockets: WebSocket[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const relay of relays.splice(0)) await relay.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function relay(onSession = vi.fn()) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wmux-codex-relay-'));
  dirs.push(dir);
  const script = path.join(dir, 'server.cjs');
  writeFileSync(script, `require('readline').createInterface({input:process.stdin}).on('line',line=>{
    const request=JSON.parse(line);
    setTimeout(()=>process.stdout.write(JSON.stringify({id:request.id,result:{thread:{id:request.params.threadId,ephemeral:false},pid:process.pid}})+'\\n'),request.params.delayMs||0);
  });`);
  const instance = await createCodexRelay({ executable: process.execPath, args: [script], cwd: dir, env: process.env, onSession });
  relays.push(instance);
  return instance;
}
function connect(instance: CodexRelay, token = instance.token, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(instance.url, { headers: { Authorization: `Bearer ${token}` }, origin });
    sockets.push(socket);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}
function request(socket: WebSocket, threadId: string) {
  return new Promise<string>(resolve => {
    socket.once('message', data => resolve(data.toString()));
    socket.send(wire({ id: 1, method: 'thread/resume', params: { threadId } }));
  });
}

describe('authenticated local relay', () => {
  it('rejects unauthenticated clients and browser origins, then accepts the terminal', async () => {
    const instance = await relay();
    await expect(connect(instance, 'wrong')).rejects.toThrow('401');
    await expect(connect(instance, instance.token, 'https://example.com')).rejects.toThrow('401');
    const socket = await connect(instance);
    expect(JSON.parse(await request(socket, A)).result.thread.id).toBe(A);
    await expect(connect(instance, 'wrong')).rejects.toThrow('401');
    await expect(connect(instance, instance.token, 'https://example.com')).rejects.toThrow('401');
  });
  it('lets the session picker connect while the TUI is connected, with independent request IDs', async () => {
    const found = vi.fn();
    const instance = await relay(found);
    const tui = await connect(instance);
    const picker = await connect(instance);
    const tuiReply = new Promise<string>(resolve => tui.once('message', data => resolve(data.toString())));
    tui.send(wire({ id: 1, method: 'thread/resume', params: { threadId: A, delayMs: 100 } }));
    const pickerReply = new Promise<string>(resolve => picker.once('message', data => resolve(data.toString())));
    // A second connection may reuse id=1. Its read response must not consume
    // the TUI's pending resume, even if it happens to contain a thread object.
    picker.send(wire({ id: 1, method: 'thread/read', params: { threadId: B } }));
    expect(JSON.parse(await pickerReply).result.thread.id).toBe(B);
    expect(found).not.toHaveBeenCalled();
    expect(JSON.parse(await tuiReply).result.thread.id).toBe(A);
    expect(found.mock.calls).toEqual([[A]]);
    picker.close();
    expect(JSON.parse(await request(tui, B)).result.thread.id).toBe(B);
  });
  it('accepts a new connection after the picker disconnects', async () => {
    const found = vi.fn();
    const instance = await relay(found);
    const picker = await connect(instance);
    await new Promise<void>(resolve => { picker.once('close', () => resolve()); picker.close(); });
    const tui = await connect(instance);
    expect(JSON.parse(await request(tui, A)).result.thread.id).toBe(A);
    expect(found.mock.calls).toEqual([[A]]);
  });
  it('retires a disconnected client backend without killing other clients, then closes all', async () => {
    const instance = await relay();
    const first = await connect(instance);
    const second = await connect(instance);
    const firstPid = JSON.parse(await request(first, A)).result.pid;
    const secondPid = JSON.parse(await request(second, B)).result.pid;
    expect(firstPid).not.toBe(secondPid);
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    first.close();
    await vi.waitFor(() => expect(alive(firstPid)).toBe(false));
    expect(alive(secondPid)).toBe(true);
    expect(JSON.parse(await request(second, B)).result.thread.id).toBe(B);
    await instance.close();
    await vi.waitFor(() => expect(alive(secondPid)).toBe(false));
    expect(instance.sessionId).toBe(B);
  });
  it('keeps simultaneous same-directory conversations separate and forwards responses unchanged', async () => {
    const foundA = vi.fn();
    const foundB = vi.fn();
    const first = await relay(foundA);
    const second = await relay(foundB);
    const [a, b] = await Promise.all([connect(first), connect(second)]);
    const responses = await Promise.all([request(a, A), request(b, B)]);
    expect(responses.map(text => JSON.parse(text).result.thread.id)).toEqual([A, B]);
    expect(foundA.mock.calls).toEqual([[A]]);
    expect(foundB.mock.calls).toEqual([[B]]);
    await first.close();
    // Closing a transport does not generate a release event or erase recovery.
    expect(first.sessionId).toBe(A);
  });
});

// The installed Windows PowerShell 5.1 launcher must preserve literal shell
// punctuation and embedded quotes before Node ever sees the arguments.
describe.skipIf(process.platform !== 'win32')('PowerShell launcher arguments', () => {
  it('preserves literal metacharacters, empty arguments and quotes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wmux-codex-args-'));
    dirs.push(dir);
    const capture = path.join(dir, 'capture.cjs');
    const output = path.join(dir, 'argv.json');
    writeFileSync(capture, `require('fs').writeFileSync(process.env.WMUX_TEST_OUTPUT,JSON.stringify(process.argv.slice(2)));`);
    const script = path.join(dir, 'invoke.ps1');
    const shim = path.resolve('src/codex-bin-ps/codex.ps1').replace(/'/g, "''");
    writeFileSync(script, `& '${shim}' 'Explain > and < & | literally' '-c' 'model="a b"' '' 'C:\\space dir\\'`);
    execFileSync('powershell.exe', ['-NoProfile', '-File', script], {
      windowsHide: true, timeout: 10000,
      env: { ...process.env, WMUX_CODEX_RUNTIME: process.execPath, WMUX_CODEX_LAUNCHER: capture, WMUX_TEST_OUTPUT: output },
    });
    expect(JSON.parse(require('fs').readFileSync(output, 'utf8'))).toEqual([
      'Explain > and < & | literally', '-c', 'model="a b"', '', 'C:\\space dir\\',
    ]);
  });
});

describe.runIf(process.platform === 'win32')('codexShimDirs — which shell gets which shim', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  async function layout() {
    const { mkdirSync } = await import('fs');
    const root = mkdtempSync(path.join(tmpdir(), 'wmux-codex-shim-'));
    dirs.push(root);
    for (const d of ['cli-bin', 'codex-bin', 'codex-bin-ps']) mkdirSync(path.join(root, d));
    writeFileSync(path.join(root, 'codex-bin', 'codex.cmd'), '@echo off\r\n');
    writeFileSync(path.join(root, 'codex-bin-ps', 'codex.ps1'), '#\n');
    const launcher = path.join(root, 'wmux-codex.js');
    writeFileSync(launcher, '');
    return { root, launcher, cliBinDir: path.join(root, 'cli-bin') };
  }

  it('never hands PowerShell the .cmd shim when the .ps1 is unverified (#154)', async () => {
    const { codexShimDirs } = await import('../../src/main/codex-launcher');
    const { launcher, cliBinDir } = await layout();
    const env: Record<string, string> = {};
    const got = codexShimDirs({ shellType: 'powershell', executable: 'C:\codex.exe', cliBinDir, psVerified: false, env, runtime: 'node', launcher });
    expect(got).toEqual([]);
    expect(env.WMUX_CODEX_EXE).toBeUndefined();
  });

  it('gives PowerShell the .ps1 ahead of the .cmd when verified, and cmd only the .cmd', async () => {
    const { codexShimDirs } = await import('../../src/main/codex-launcher');
    const { root, launcher, cliBinDir } = await layout();
    const ps: Record<string, string> = {};
    expect(codexShimDirs({ shellType: 'powershell', executable: 'C:\codex.exe', cliBinDir, psVerified: true, env: ps, runtime: 'node', launcher }))
      .toEqual([path.join(root, 'codex-bin-ps'), path.join(root, 'codex-bin')]);
    expect(ps.WMUX_CODEX_EXE).toBe('C:\codex.exe');
    const cmd: Record<string, string> = {};
    expect(codexShimDirs({ shellType: 'cmd', executable: 'C:\codex.exe', cliBinDir, psVerified: false, env: cmd, runtime: 'node', launcher }))
      .toEqual([path.join(root, 'codex-bin')]);
  });
});
