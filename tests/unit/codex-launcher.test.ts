import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import path from 'path';
import { WebSocket } from 'ws';
import { CodexSessionTracker } from '../../src/cli/codex-session-tracker';
import {
  codexLaunchPlan, resumeTarget, supportsRemote, wmuxRequestPatiently, isTransientWmuxError,
} from '../../src/cli/wmux-codex';
import { createCodexRelay, MAX_BACKENDS, type CodexRelay } from '../../src/cli/codex-relay';

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
    // Every resumed or forked root reply is reported; the relay dedupes on the
    // id it saves. A started thread waits for its first turn (next test).
    expect(found.mock.calls).toEqual([[A], [B]]);
  });

  // Codex writes a new thread only once it has a turn. Reported at
  // thread/start, an empty tab saved an id no `codex resume` could open.
  it('reports a new thread at its first turn, and never one left empty', () => {
    const found = vi.fn();
    const tracker = new CodexSessionTracker(found);
    tracker.request(wire({ id: 1, method: 'thread/start' }));
    tracker.response(wire({ id: 1, result: { thread: { id: A } } }));
    expect(found).not.toHaveBeenCalled();
    tracker.request(wire({ id: 2, method: 'turn/start', params: { threadId: B } }));
    expect(found).not.toHaveBeenCalled();
    tracker.request(wire({ id: 3, method: 'turn/start', params: { threadId: A } }));
    tracker.request(wire({ id: 4, method: 'turn/start', params: { threadId: A } }));
    expect(found.mock.calls).toEqual([[A]]);
    expect(tracker.sessionId).toBe(A);
  });

  it.each(['review/start', 'thread/shellCommand', 'thread/inject_items'])('also takes %s as a new thread\'s first content', method => {
    const found = vi.fn();
    const tracker = new CodexSessionTracker(found);
    tracker.request(wire({ id: 1, method: 'thread/start' }));
    tracker.response(wire({ id: 1, result: { thread: { id: A } } }));
    tracker.request(wire({ id: 2, method, params: { threadId: A } }));
    expect(found.mock.calls).toEqual([[A]]);
  });

  it('names a resumed thread Codex does not have, and nothing else', () => {
    const missing = vi.fn();
    const tracker = new CodexSessionTracker(vi.fn(), missing);
    const fail = (id: number, method: string, threadId: string, message: string) => {
      tracker.request(wire({ id, method, params: { threadId } }));
      tracker.response(wire({ id, error: { code: -32600, message } }));
    };
    fail(1, 'thread/resume', A, `no rollout found for thread id ${A}`);
    fail(2, 'thread/resume', B, 'stream disconnected before completion');
    fail(3, 'thread/fork', B, `no rollout found for thread id ${B}`);
    fail(4, 'thread/resume', B, `no rollout found for thread id ${A}`);
    expect(missing.mock.calls).toEqual([[A]]);
  });

  it('ignores ephemeral threads requested internally when the first prompt is sent', () => {
    const found = vi.fn();
    const tracker = new CodexSessionTracker(found);
    tracker.request(wire({ id: 1, method: 'thread/start' }));
    tracker.response(wire({ id: 1, result: { thread: { id: A, ephemeral: false } } }));
    tracker.request(wire({ id: 9, method: 'turn/start', params: { threadId: A } }));
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
    expect(plan).toEqual({
      interactive: true, serverArgs: ['app-server', '--stdio', '-c', 'model="a b"', '--enable', 'feature'],
      clientArgs: ['-c', 'model="a b"', '--enable=feature', '--cd', 'project', 'resume', A],
      cwd: path.join(cwd, 'project'), yolo: false,
    });
  });
  it.each([[], ['resume', A], ['fork', A], ['--no-daemon'], ['--', '--help'], ['Explain > and < literally']])('integrates interactive launches %j', (...args) => {
    expect(codexLaunchPlan(args, process.cwd()).interactive).toBe(true);
  });
  it.each(['--yolo', '--dangerously-bypass-approvals-and-sandbox'])('routes %s to the local relay for new/resume/fork and pickers', flag => {
    for (const command of [[], ['resume'], ['resume', '--last'], ['resume', A], ['fork', A]]) {
      for (const args of [[flag, ...command], [...command, flag]]) {
        const plan = codexLaunchPlan(args, process.cwd());
        expect(plan.interactive).toBe(true);
        expect(plan.yolo).toBe(true);
        expect(plan.clientArgs).toEqual(command);
        expect(plan.serverArgs).toEqual(['app-server', '--stdio']);
      }
    }
  });
  it.each([
    ['--', '--yolo'], ['resume', A, '--', '--yolo'], ['--model', '--yolo'],
    ['--config', 'model="--yolo"'], ['Explain --yolo'], ['--yolo=false'],
  ])('does not interpret prompt text, option values or invalid flags as permission to bypass: %j', (...args) => {
    const plan = codexLaunchPlan(args, process.cwd());
    expect(plan.yolo).toBe(false);
    expect(plan.clientArgs).toEqual(args);
  });
  it.each([
    ['--yolo'], ['--dangerously-bypass-approvals-and-sandbox'], ['-a', 'on-request'],
    ['--ask-for-approval=never'], ['-aon-request'], ['--sandbox', 'read-only'],
    ['--approve-for-me'], ['--not-so-yolo'], ['--full-auto'], ['--add-dir', 'other'],
    ['-c', 'approval_policy="on-request"'], ['-csandbox_mode="read-only"'],
    ['--config=sandbox_workspace_write.network_access=true'], ['-c', '"sandbox_mode"="read-only"'],
    ['--remote', 'ws://localhost:1234'], ['--profile', 'custom'], ['exec', 'prompt'],
  ])('leaves mixed/unsupported yolo invocations to native argument validation: %j', (...extra) => {
    expect(codexLaunchPlan(['--yolo', ...extra], process.cwd()).interactive).toBe(false);
  });
});

// A restore starts every saved Codex at once. Each launcher used to get one
// 2 s answer from wmux and one 5 s `codex --help`; under that burst about half
// timed out and ran without session capture.
describe('launcher patience during a restore burst', () => {
  const busy = () => Object.assign(new Error('wmux did not respond'), { name: 'WmuxBusyError' });
  // The real busy error is a private class; reproduce it through the request itself.
  function flaky(failures: number, error: () => Error = () => { const e = new Error('x') as NodeJS.ErrnoException; e.code = 'EBUSY'; return e; }) {
    const timeouts: number[] = [];
    let calls = 0;
    const request = async (_method: string, _params: Record<string, unknown>, timeoutMs: number) => {
      timeouts.push(timeoutMs);
      if (calls++ < failures) throw error();
      return { enabled: true };
    };
    return { request, timeouts, calls: () => calls };
  }

  it('asks a busy wmux again, with longer attempts, and says so once', async () => {
    const { request, timeouts } = flaky(2);
    const onWait = vi.fn();
    const result = await wmuxRequestPatiently('pane.codex_restore_config', {}, { budgetMs: 60_000, firstAttemptMs: 3_000, onWait }, request);
    expect(result).toEqual({ enabled: true });
    expect(timeouts).toEqual([3_000, 6_000, 12_000]);
    expect(onWait).toHaveBeenCalledTimes(1);
  });

  it('gives up at the end of its budget', async () => {
    let clock = 0;
    const { request, calls } = flaky(Infinity);
    const now = () => (clock += 4_000);
    await expect(wmuxRequestPatiently('m', {}, { budgetMs: 20_000, firstAttemptMs: 3_000 }, request, now)).rejects.toThrow();
    expect(calls()).toBeLessThan(6);
  });

  it.each([
    ['no wmux at all', () => Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' })],
    ['an older wmux refusing the method', () => new Error('Unknown method')],
    ['outside wmux', () => new Error('Outside wmux')],
  ])('answers at once for %s', async (_label, error) => {
    const { request, calls } = flaky(Infinity, error);
    await expect(wmuxRequestPatiently('m', {}, { budgetMs: 60_000, firstAttemptMs: 3_000 }, request)).rejects.toThrow();
    expect(calls()).toBe(1);
  });

  it('treats a dropped or busy pipe as transient', () => {
    for (const code of ['EBUSY', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']) {
      expect(isTransientWmuxError(Object.assign(new Error(code), { code }))).toBe(true);
    }
    expect(isTransientWmuxError(busy())).toBe(false); // only the launcher's own class, not a lookalike
    expect(isTransientWmuxError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
  });

  it('probes `codex --help` once per executable, and remembers only a yes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wmux-codex-cap-'));
    dirs.push(dir);
    const exe = path.join(dir, 'codex.exe');
    writeFileSync(exe, 'v1');
    const cache = path.join(dir, 'cache.json');
    const yes = vi.fn(async () => true);
    expect(await supportsRemote(exe, {}, yes, cache)).toBe(true);
    expect(await supportsRemote(exe, {}, yes, cache)).toBe(true);
    expect(yes).toHaveBeenCalledTimes(1);
    writeFileSync(exe, 'v2, an update'); // size changes: the cached answer no longer applies
    const no = vi.fn(async () => false);
    expect(await supportsRemote(exe, {}, no, cache)).toBe(false);
    expect(await supportsRemote(exe, {}, no, cache)).toBe(false);
    expect(no).toHaveBeenCalledTimes(2);
  });

  it('retries a probe that timed out, and does not call silence a "no"', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wmux-codex-cap-'));
    dirs.push(dir);
    const exe = path.join(dir, 'codex.exe');
    writeFileSync(exe, 'v1');
    const slowThenYes = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(true);
    expect(await supportsRemote(exe, {}, slowThenYes, path.join(dir, 'c.json'))).toBe(true);
    const silent = vi.fn(async () => null);
    expect(await supportsRemote(exe, {}, silent, path.join(dir, 'd.json'))).toBeNull();
    expect(silent).toHaveBeenCalledTimes(2);
  });

  it.each([
    [['resume', A], A],
    [['-c', 'model="resume"', 'resume', A], A],
    [['--model', 'o3', 'resume', A], A],
    [['resume', '--last'], undefined],
    [['resume'], undefined],
    [['fork', A], undefined],
    [[], undefined],
    [['--', 'resume', A], undefined],
  ])('finds the conversation a launch was asked to reopen in %j', (args, expected) => {
    expect(resumeTarget(args as string[])).toBe(expected);
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
async function relay(onSession = vi.fn(), yolo = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wmux-codex-relay-'));
  dirs.push(dir);
  const script = path.join(dir, 'server.cjs');
  // \`holdUntil\` names a file: the reply waits until it exists, so a test can
  // order two backends' replies without betting on how fast each one starts.
  writeFileSync(script, `const fs=require('fs');require('readline').createInterface({input:process.stdin}).on('line',line=>{
    const request=JSON.parse(line);
    const reply=()=>process.stdout.write(JSON.stringify({id:request.id,result:{thread:{id:request.params?.threadId,ephemeral:false},pid:process.pid,request,raw:line}})+'\\n');
    const hold=request.params?.holdUntil;
    if(hold){const t=setInterval(()=>{if(fs.existsSync(hold)){clearInterval(t);reply();}},10);return;}
    setTimeout(reply,request.params?.delayMs||0);
  });`);
  const instance = await createCodexRelay({ executable: process.execPath, args: [script], cwd: dir, env: process.env, onSession, yolo });
  relays.push(instance);
  relayDirs.set(instance, dir);
  return instance;
}
const relayDirs = new WeakMap<CodexRelay, string>();
const relayDir = (instance: CodexRelay) => relayDirs.get(instance)!;
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
  it.each(['thread/start', 'thread/resume', 'thread/fork'])('applies explicit yolo to %s while retaining automatic session capture', async method => {
    const found = vi.fn();
    const instance = await relay(found, true);
    const socket = await connect(instance);
    const response = new Promise<string>(resolve => socket.once('message', data => resolve(data.toString())));
    socket.send(wire({ id: 1, method, params: {
      threadId: A, approvalPolicy: 'on-request', sandbox: 'read-only', permissions: 'read-only', model: 'test-model',
    } }));
    expect(JSON.parse(await response).result.request).toEqual({ id: 1, method, params: {
      threadId: A, approvalPolicy: 'never', sandbox: 'danger-full-access', permissions: null, model: 'test-model',
    } });
    // A started thread is captured at its first turn.
    if (method === 'thread/start') {
      expect(found).not.toHaveBeenCalled();
      const turn = new Promise<string>(resolve => socket.once('message', data => resolve(data.toString())));
      socket.send(wire({ id: 2, method: 'turn/start', params: { threadId: A } }));
      await turn;
    }
    expect(found.mock.calls).toEqual([[A]]);
    expect(instance.sessionId).toBe(A);
  });
  it('never re-applies yolo to turns, settings changes, approval replies or read-only requests', async () => {
    const instance = await relay(vi.fn(), true);
    const socket = await connect(instance);
    for (const message of [
      { id: 2, method: 'turn/start', params: { threadId: A, approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } } },
      { id: 3, method: 'thread/settings/update', params: { threadId: A, approvalPolicy: 'on-request' } },
      { id: 4, method: 'thread/read', params: { threadId: A } },
      { id: 5, result: { decision: 'decline' } },
      { method: 'thread/resume', params: { threadId: A } },
      { id: 6, method: 'thread/resume', params: [] },
      { id: 7, method: 'thread/start', params: null },
      { id: 8, method: 'thread/start' },
    ]) {
      const text = JSON.stringify(message, null, 2);
      // The transport is line-delimited; use spaces to retain noncanonical JSON.
      const raw = text.replace(/\n/g, ' ');
      const response = new Promise<string>(resolve => socket.once('message', data => resolve(data.toString())));
      socket.send(raw);
      expect(JSON.parse(await response).result.raw).toBe(raw);
    }
  });
  it('leaves plain automatic/manual resume byte-for-byte unchanged, even beside a yolo terminal', async () => {
    const regular = await relay();
    const yolo = await relay(vi.fn(), true);
    const [a, b] = await Promise.all([connect(regular), connect(yolo)]);
    const [regularReply, yoloReply] = await Promise.all([request(a, A), request(b, B)]);
    expect(JSON.parse(regularReply).result.request.params).toEqual({ threadId: A });
    expect(JSON.parse(yoloReply).result.request.params).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
  });
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
    // Held until the picker has been answered. A 100 ms delay used to stand in
    // for this, and lost whenever the picker's own backend took longer than that
    // to start — a loaded machine, or a full parallel test run.
    const release = path.join(relayDir(instance), 'release-tui');
    tui.send(wire({ id: 1, method: 'thread/resume', params: { threadId: A, holdUntil: release } }));
    const pickerReply = new Promise<string>(resolve => picker.once('message', data => resolve(data.toString())));
    // A second connection may reuse id=1. Its read response must not consume
    // the TUI's pending resume, even if it happens to contain a thread object.
    picker.send(wire({ id: 1, method: 'thread/read', params: { threadId: B } }));
    expect(JSON.parse(await pickerReply).result.thread.id).toBe(B);
    expect(found).not.toHaveBeenCalled();
    writeFileSync(release, '');
    expect(JSON.parse(await tuiReply).result.thread.id).toBe(A);
    expect(found.mock.calls).toEqual([[A]]);
    picker.close();
    expect(JSON.parse(await request(tui, B)).result.thread.id).toBe(B);
  });
  it('records the TUI switching back to a thread after a picker connection resumed another', async () => {
    const found = vi.fn();
    const instance = await relay(found);
    const tui = await connect(instance);
    const picker = await connect(instance);
    await request(tui, A);
    await request(picker, B);
    await request(tui, A);
    expect(found.mock.calls).toEqual([[A], [B], [A]]);
    expect(instance.sessionId).toBe(A);
    await request(tui, A);
    expect(found).toHaveBeenCalledTimes(3);
  });
  it('refuses connections past the backend cap with 503', async () => {
    const instance = await relay();
    for (let i = 0; i < MAX_BACKENDS; i++) await connect(instance);
    await expect(connect(instance)).rejects.toThrow('503');
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
