#!/usr/bin/env node
/** Launched by wmux's private PATH shims using wmux's resolved Node runtime. */
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { CodexRelay, CodexRelayOptions } from './codex-relay';

const NON_INTERACTIVE = new Set([
  'agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server',
  'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug',
  'apply', 'a', 'queue', 'archive', 'delete', 'migrate-rollouts', 'unarchive',
  'cloud', 'exec-server', 'features', 'help',
]);
const VALUE_OPTIONS = new Set([
  '-c', '--config', '--enable', '--disable', '--code-mode-host', '-m', '--model',
  '-i', '--image', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir',
  '-a', '--ask-for-approval', '--local-provider', '--remote', '--remote-auth-token-env',
]);
const SERVER_OPTIONS = new Set(['-c', '--config', '--enable', '--disable', '--code-mode-host']);
/** Options that keep an invocation native. The second half: a remote TUI cannot
 *  apply local profile/worktree/provider bootstrapping, so these run unwrapped
 *  instead of silently changing their meaning. */
const NATIVE_ONLY_OPTIONS = new Set([
  '-h', '--help', '-V', '--version', '--remote', '--remote-auth-token-env',
  '-p', '--profile', '--worktree', '--oss', '--local-provider',
]);

interface LaunchPlan {
  interactive: boolean;
  serverArgs: string[];
  clientArgs: string[];
  cwd: string;
  yolo: boolean;
}

const YOLO_OPTIONS = new Set(['--yolo', '--dangerously-bypass-approvals-and-sandbox']);
const PERMISSION_OPTIONS = new Set([
  '-a', '--ask-for-approval', '-s', '--sandbox', '--approve-for-me', '--not-so-yolo',
  '--full-auto', '--add-dir',
]);
const PERMISSION_CONFIG = /^(?:approval_policy|approvals_reviewer|sandbox_mode|sandbox_workspace_write|default_permissions|permissions|network)(?:\.|\s*=)/;

/** Apply one value-taking option. Returns how many argv entries it consumed, or
 *  0 when its value is missing (which ends the scan as non-interactive). */
function applyValueOption(plan: LaunchPlan, key: string, arg: string, next: string | undefined): number {
  const inline = arg.includes('=');
  const value = inline ? arg.slice(arg.indexOf('=') + 1) : next;
  if (value === undefined) return 0;
  if (SERVER_OPTIONS.has(key)) plan.serverArgs.push(key, value);
  if (key === '-C' || key === '--cd') plan.cwd = path.resolve(plan.cwd, value);
  return inline ? 1 : 2;
}

export function codexLaunchPlan(args: string[], cwd: string): LaunchPlan {
  const plan: LaunchPlan = { interactive: true, serverArgs: ['app-server', '--stdio'], clientArgs: [], cwd, yolo: false };
  let positional = false;
  let otherPermissions = false;
  let i = 0;
  while (i < args.length && args[i] !== '--') {
    const arg = args[i];
    const key = arg.split('=')[0];
    if (NATIVE_ONLY_OPTIONS.has(key)) plan.interactive = false;
    if (YOLO_OPTIONS.has(arg)) {
      // Do not hide duplicate-flag errors from Codex's own argument parser.
      if (plan.yolo) plan.interactive = false;
      plan.yolo = true;
      i++;
      continue;
    }
    if (PERMISSION_OPTIONS.has(key) || /^-[as].+/.test(arg)) otherPermissions = true;
    if (key === '-c' || key === '--config' || /^-c.+/.test(arg)) {
      const value = key === '-c' || key === '--config'
        ? (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[i + 1])
        : arg.slice(2);
      // Quoted TOML keys and compound permission settings stay with the native
      // parser: the relay must not guess their precedence against --yolo.
      if (value && (PERMISSION_CONFIG.test(value.trim()) || /^["']/.test(value.trim()))) otherPermissions = true;
    }
    if (key === '--strict-config') plan.serverArgs.push(arg);
    if (VALUE_OPTIONS.has(key)) {
      const consumed = applyValueOption(plan, key, arg, args[i + 1]);
      if (consumed === 0) { plan.interactive = false; break; }
      plan.clientArgs.push(...args.slice(i, i + consumed));
      i += consumed;
      continue;
    }
    // Only the FIRST positional is the subcommand; a prompt like `codex exec` as
    // text after it is not.
    if (!arg.startsWith('-') && !positional) {
      positional = true;
      plan.interactive &&= !NON_INTERACTIVE.has(arg);
    }
    plan.clientArgs.push(arg);
    i++;
  }
  plan.clientArgs.push(...args.slice(i));
  // Preserve native validation/precedence for mixed permission choices, instead
  // of silently removing an option that conflicts with --yolo.
  if (plan.yolo && otherPermissions) plan.interactive = false;
  return plan;
}

/** `codex resume <id>` → the id; anything else (a picker, a new chat) → undefined. */
export function resumeTarget(clientArgs: string[]): string | undefined {
  for (let i = 0; i < clientArgs.length; i++) {
    const arg = clientArgs[i];
    if (arg === '--') return undefined;
    if (arg.startsWith('-')) { if (VALUE_OPTIONS.has(arg)) i++; continue; }
    if (arg !== 'resume') return undefined;
    const id = clientArgs[i + 1];
    return id && !id.startsWith('-') ? id : undefined;
  }
  return undefined;
}

/** wmux is there but did not answer in time, or dropped the connection. */
class WmuxBusyError extends Error {}

export type WmuxRequest = (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<any>;
/** true / false, or null when `codex --help` gave no answer in time. */
export type RemoteProbe = (executable: string, env: NodeJS.ProcessEnv) => Promise<boolean | null>;

/** Authenticated local pipe only; never send environment variables or transcripts. */
const wmuxRequest: WmuxRequest = (method, params, timeoutMs) => {
  return new Promise((resolve, reject) => {
    const pipe = process.env.WMUX_PIPE;
    const token = process.env.WMUX_PIPE_TOKEN;
    if (!pipe || !token) { reject(new Error('Outside wmux')); return; }
    const socket = net.connect(pipe);
    let data = '';
    const timer = setTimeout(() => finish(new WmuxBusyError('wmux did not respond')), timeoutMs);
    const finish = (error?: Error, result?: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, params, token }) + '\n'));
    socket.on('data', chunk => {
      data += chunk.toString();
      if (data.length > 64 * 1024) { finish(new Error('Invalid wmux response')); return; }
      const line = data.split('\n')[0];
      if (!data.includes('\n')) return;
      try {
        const response = JSON.parse(line);
        if (response.error) finish(new Error(response.error.message));
        else finish(undefined, response.result);
      } catch { finish(new Error('Invalid wmux response')); }
    });
    socket.on('error', error => finish(error));
    socket.on('end', () => finish(new WmuxBusyError('wmux disconnected')));
  });
};

/**
 * Worth asking again: wmux exists but was too busy to answer. Restoring a
 * session starts every saved Codex at once, beside every other pane, and
 * wmux's main process answers none of them until that burst is through.
 * ENOENT (no wmux at all), "Outside wmux" and an error REPLY (an older wmux
 * that does not know the method) are answers, and are never retried.
 */
export function isTransientWmuxError(error: unknown): boolean {
  if (error instanceof WmuxBusyError) return true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBUSY' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT';
}

export interface Patience {
  /** Total time to keep trying. */
  budgetMs: number;
  /** First attempt's timeout; each retry doubles it, within the budget. */
  firstAttemptMs: number;
  /** Told once, when the first attempt failed and a retry is coming. */
  onWait?: () => void;
}

/**
 * The request, asked again while wmux is merely busy. A single 2 s attempt
 * used to decide each launch: during a restore, roughly half the Codex panes
 * timed out and started without session capture, so wmux lost track of
 * them — a `/new` or a quit there was never recorded.
 */
export async function wmuxRequestPatiently(
  method: string,
  params: Record<string, unknown>,
  patience: Patience,
  request: WmuxRequest = wmuxRequest,
  now: () => number = Date.now,
): Promise<any> {
  const deadline = now() + patience.budgetMs;
  let attemptMs = patience.firstAttemptMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await request(method, params, Math.max(1, Math.min(attemptMs, deadline - now())));
    } catch (error) {
      const pause = Math.min(250 * (attempt + 1), 1000);
      if (!isTransientWmuxError(error) || now() + pause >= deadline) throw error;
      if (attempt === 0) patience.onWait?.();
      await new Promise(resolve => setTimeout(resolve, pause));
      attemptMs *= 2;
    }
  }
}

/** Whether to record sessions: decides a restored pane's capture, so it waits for wmux. */
const CONFIG_PATIENCE = { budgetMs: 45_000, firstAttemptMs: 3_000 };
/** Session reports run beside the TUI, so they can afford to wait longer. */
const REPORT_PATIENCE = { budgetMs: 60_000, firstAttemptMs: 3_000 };
/** The release holds the prompt after Codex exits; a missed one only reopens it. */
const RELEASE_PATIENCE = { budgetMs: 10_000, firstAttemptMs: 2_000 };

/**
 * `codex --help` lists `--remote-auth-token-env` from the version that can be
 * relayed. It used to run with a 5 s limit on every launch, and a timeout read
 * as "this Codex is too old": a restore starts every saved Codex at once, so
 * the burst of `--help` processes was what ran out of time. The probe is now
 * given 30 s and its positive answer is remembered per executable (path, size,
 * mtime — an update invalidates it), so a restore runs it once, not per pane.
 */
const REMOTE_PROBE_TIMEOUT_MS = 30_000;

function capabilityCachePath(): string {
  return path.join(os.tmpdir(), 'wmux-codex-remote-support.json');
}

export function codexCapabilityKey(executable: string): string | null {
  try {
    const stat = fs.statSync(executable);
    return `${path.resolve(executable).toLowerCase()}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
  } catch { return null; }
}

function readCapabilityCache(file: string): Record<string, true> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** Remember a supported executable. Best effort: a cache that cannot be written only costs a probe. */
function rememberSupport(file: string, key: string): void {
  try {
    const next = { ...readCapabilityCache(file), [key]: true as const };
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next));
    fs.renameSync(temp, file);
  } catch { /* another launcher won the race, or tmp is read-only */ }
}

const probeRemoteSupport: RemoteProbe = (executable, env) => {
  return new Promise(resolve => {
    execFile(executable, ['--help'], { env, windowsHide: true, timeout: REMOTE_PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (error, stdout) => {
      // Killed by the timeout: no answer, which is not a "no".
      if (error && (error as { killed?: boolean }).killed) { resolve(null); return; }
      resolve(!error && stdout.includes('--remote-auth-token-env'));
    });
  });
};

/** true / false, or null when Codex never answered (not the same as "too old"). */
export async function supportsRemote(
  executable: string,
  env: NodeJS.ProcessEnv,
  probe: RemoteProbe = probeRemoteSupport,
  cacheFile: string = capabilityCachePath(),
): Promise<boolean | null> {
  const key = codexCapabilityKey(executable);
  if (key && readCapabilityCache(cacheFile)[key] === true) return true;
  // One more try for a probe that ran out of time; a real "no" is not retried.
  let supported = await probe(executable, env);
  if (supported === null) supported = await probe(executable, env);
  if (supported && key) rememberSupport(cacheFile, key);
  return supported;
}

function runCli(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    // Codex shares this console, so Ctrl+C / Ctrl+Break reach both processes.
    // Codex decides what they mean; the wrapper must not die first and hand the
    // prompt back while Codex is still writing to the same console.
    const ignore = (): void => {};
    process.on('SIGINT', ignore);
    process.on('SIGBREAK', ignore);
    const done = (): void => { process.off('SIGINT', ignore); process.off('SIGBREAK', ignore); };
    const child = spawn(executable, args, { env, stdio: 'inherit' });
    child.once('error', error => { done(); reject(error); });
    child.once('exit', code => { done(); resolve(code ?? 1); });
  });
}

/**
 * The relay, or null when it cannot start. Loaded lazily: it pulls in `ws`,
 * which ships beside this file in `cli/node_modules`, and a packaging miss
 * there must cost the restore feature — never every `codex` in every pane.
 */
async function startRelay(options: CodexRelayOptions): Promise<CodexRelay | null> {
  try {
    const { createCodexRelay } = require('./codex-relay') as typeof import('./codex-relay');
    return await createCodexRelay(options);
  } catch (error) {
    console.error(`[wmux] Codex session restore is unavailable (${(error as Error).message}). Starting Codex normally.`);
    return null;
  }
}

export async function runWmuxCodex(args = process.argv.slice(2)): Promise<number> {
  const executable = process.env.WMUX_CODEX_EXE;
  if (!executable || !path.isAbsolute(executable)) throw new Error('wmux could not locate the native Codex executable');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const surfaceId = process.env.WMUX_SURFACE_ID;
  const plan = codexLaunchPlan(args, process.cwd());
  if (!plan.interactive || !surfaceId) return runCli(executable, args, env);
  let enabled = false;
  try {
    enabled = (await wmuxRequestPatiently('pane.codex_restore_config', { surfaceId }, {
      ...CONFIG_PATIENCE,
      onWait: () => console.error('[wmux] wmux is busy; waiting for it before starting Codex with session restore...'),
    })).enabled === true;
  } catch (error) {
    // An older/offline wmux leaves the CLI usable. Say so when wmux was there
    // but never answered: that pane is about to run without session capture.
    if (isTransientWmuxError(error)) console.error('[wmux] wmux did not answer; starting Codex without session restore.');
  }
  if (!enabled) return runCli(executable, args, env);
  const remote = await supportsRemote(executable, env);
  if (remote !== true) {
    console.error(remote === null
      ? '[wmux] Codex did not answer `codex --help` in time; starting it without session restore.'
      : '[wmux] This Codex version cannot record sessions for automatic restore. Starting Codex normally.');
    return runCli(executable, args, env);
  }
  // Serialize reports so a delayed response cannot stamp an older thread last.
  let reports = Promise.resolve();
  const report = (method: string, sessionId: string): void => {
    reports = reports.then(async () => {
      try { await wmuxRequestPatiently(method, { surfaceId, sessionId }, REPORT_PATIENCE); }
      catch { /* A crashed wmux cannot receive a report; Codex still owns its history. */ }
    });
  };
  const target = resumeTarget(plan.clientArgs);
  const relay = await startRelay({
    executable, args: plan.serverArgs, cwd: plan.cwd, env, yolo: plan.yolo,
    onSession: sessionId => report('pane.report_codex_session', sessionId),
    // Only the conversation this launch was asked to reopen — what a restore
    // typed. wmux then forgets that saved id instead of retrying it forever.
    onMissing: sessionId => { if (sessionId === target) report('pane.codex_session_missing', sessionId); },
  });
  if (!relay) return runCli(executable, args, env);
  let exitCode: number;
  try {
    exitCode = await runCli(executable, [
      '--remote', relay.url, '--remote-auth-token-env', 'WMUX_CODEX_RELAY_TOKEN', ...plan.clientArgs,
    ], { ...env, WMUX_CODEX_RELAY_TOKEN: relay.token });
  } finally {
    await relay.close();
  }
  await reports;
  if (exitCode === 0 && relay.sessionId) {
    // Only an orderly CLI exit forgets the handle. A crash, socket failure or
    // wmux shutdown retains it. Main also guards this RPC while quitting.
    try { await wmuxRequestPatiently('pane.release_codex_session', { surfaceId, sessionId: relay.sessionId }, RELEASE_PATIENCE); }
    catch { /* wmux has already closed */ }
    console.log(`To resume later: codex resume ${relay.sessionId}`);
  }
  return exitCode;
}

if (require.main === module) {
  runWmuxCodex().then(code => { process.exitCode = code; }).catch(error => {
    console.error('[wmux] Could not launch Codex:', error.message);
    process.exitCode = 1;
  });
}
