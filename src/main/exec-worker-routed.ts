/**
 * exec-worker-routed.ts — the runners that serve a call from a persistent worker when they can.
 *
 * `runSshRouted`, `execFileRouted` and `execFileRoutedAsync` take the argv a caller already builds,
 * recognise it (exec-worker-script.ts), ask the engine (exec-worker.ts) and hand back the results and
 * error shapes of a spawn; any fallback is the spawn that caller always made.
 */

import { execFile, type ExecFileException, type ExecFileOptions } from 'child_process';
import { currentSpawnPriority } from './exec-gate';
import { DEFAULT_MAX_BUFFER, runSsh, type RunOptions, type RunResult, type SshRunner } from './ssh-exec';
import type { SpawnVia } from './exec-trace';
import { FALLBACK, runOnWorker, workerEnabled, type WorkerOutcome } from './exec-worker';
import { parseWorkerInvocation } from './exec-worker-script';

/** The most request bytes (command base64 plus input) sent to a worker; a larger one is run per call. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** A call that names no timeout still gets one: the explorer's. */
const DEFAULT_TIMEOUT_MS = 30_000;

// ─── Routed runners ──────────────────────────────────────────────────────────

export interface RoutedRun {
  cwd?: string;
  timeout: number;
  input?: string | Buffer;
  maxBuffer?: number;
  signal?: AbortSignal;
  /** The call only reads, so repeating it after a failure is safe. Unsaid: it may write. */
  idempotent?: boolean;
  /**
   * For a single git call in a WSL distro: the variables it forwards through WSLENV (what the worker
   * sets for it). Unsaid, such a call is a spawn.
   */
  wslEnv?: Record<string, string>;
}

/** True when a call with this argv would go through the worker if it were healthy. */
export function isWorkerRoute(args: readonly string[], wslEnv?: Record<string, string>): boolean {
  const invocation = parseWorkerInvocation(args, wslEnv);
  return invocation !== undefined && workerEnabled();
}

/** Ask the worker for one call. `fallback` means: do it as a spawn. */
async function tryWorker(file: string, args: readonly string[], run: RoutedRun): Promise<WorkerOutcome> {
  if (run.signal) return FALLBACK;
  const invocation = parseWorkerInvocation(args, run.wslEnv);
  if (!invocation || !workerEnabled()) return FALLBACK;
  // A WSL folder's worker only ever serves reads: there is no "could not reach it" status for a write to map to.
  if (invocation.loc === 'wsl' && run.idempotent !== true) return FALLBACK;
  const input = run.input === undefined ? undefined : Buffer.from(run.input);
  if (invocation.payload.length + (input?.length ?? 0) * 4 / 3 > MAX_REQUEST_BYTES) return FALLBACK;
  try {
    const outcome = await runOnWorker({
      file,
      invocation,
      cwd: run.cwd,
      timeoutMs: run.timeout,
      input,
      maxBuffer: run.maxBuffer ?? DEFAULT_MAX_BUFFER,
      idempotent: run.idempotent === true,
      prio: currentSpawnPriority(),
    });
    if (invocation.perCallOn125 && outcome.kind === 'done' && outcome.status === 125) {
      return outcome.cold ? { kind: 'fallback', cold: true } : FALLBACK;
    }
    return outcome;
  } catch {
    return FALLBACK;
  }
}

/** The `runSsh` result for a worker outcome that is not a fallback. */
function toRunResult(outcome: Exclude<WorkerOutcome, { kind: 'fallback' }>): RunResult {
  const empty = Buffer.alloc(0);
  switch (outcome.kind) {
    case 'done': {
      const stderr = outcome.stderr.toString();
      return {
        status: outcome.status,
        stdout: outcome.stdout.toString(),
        stderr: outcome.status === 0 ? stderr : stderr || 'Command failed',
        stdoutBuffer: outcome.stdout,
        via: 'worker',
      };
    }
    case 'overflow':
      return { status: 1, stdout: '', stderr: 'stdout maxBuffer length exceeded', stdoutBuffer: empty, via: 'worker' };
    case 'timeout':
      return { status: 1, stdout: '', stderr: 'Command timed out', stdoutBuffer: empty, via: 'worker' };
    case 'lost':
      // Ssh's own "could not connect" status: the view reports the host unreachable.
      return { status: 255, stdout: '', stderr: 'ssh worker lost the request', stdoutBuffer: empty, via: 'worker' };
  }
}

/**
 * `runSsh` that serves a WSL-route call from a worker when it can. The same
 * results and statuses as a spawn; `via` says which one answered.
 */
export const runSshRouted: SshRunner = async (executable, args, timeout, options: RunOptions = {}) => {
  const outcome = await tryWorker(executable, args, {
    cwd: options.cwd,
    timeout,
    input: options.input,
    maxBuffer: options.maxBuffer,
    signal: options.signal,
    idempotent: options.idempotent,
  });
  const cold = outcome.cold === true ? { cold: true } : {};
  if (outcome.kind !== 'fallback') return { ...toRunResult(outcome), ...cold };
  const ran = await runSsh(executable, args, timeout, options);
  return isWorkerRoute(args) ? { ...ran, via: 'spawn', ...cold } : ran;
};

/** `via` and `cold` are the trace's (`exec-trace.ts`): which way the call travelled, and whether it waited for a worker to start. */
export type RoutedCallback = (
  err: ExecFileException | null,
  stdout: string,
  stderr: string,
  via?: SpawnVia,
  cold?: boolean,
) => void;

/** An execFile-style error: `code` a number for an exit status, `killed` for a timeout. */
function execError(message: string, fields: Record<string, unknown>): ExecFileException {
  return Object.assign(new Error(message), fields) as unknown as ExecFileException;
}

type Answered = Exclude<WorkerOutcome, { kind: 'fallback' }>;

/** The error an execFile callback would have had for this outcome, or undefined for a clean exit. */
function workerFailure(outcome: Answered): ExecFileException | undefined {
  switch (outcome.kind) {
    case 'done':
      return outcome.status === 0
        ? undefined
        : execError('Command failed', {
          code: outcome.status, killed: false, stdout: outcome.stdout.toString(), stderr: outcome.stderr.toString(),
        });
    case 'overflow':
      return execError('stdout maxBuffer length exceeded', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: false, stdout: '', stderr: '' });
    case 'timeout':
      return execError('Command timed out', { code: null, killed: true, signal: 'SIGTERM', stdout: '', stderr: '' });
    case 'lost':
      return execError('ssh worker lost the request', { code: 255, killed: false, stdout: '', stderr: '' });
  }
}

/** `promisify(execFile)`'s shape: what a caller that keeps its own promisified execFile passes as the spawn. */
export type PlainExecAsync = (
  file: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

/** `execFile` as a promise, for a caller that has no promisified one of its own; a failure carries `stdout` and `stderr`. */
export const execFilePlain: PlainExecAsync = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (err, stdout, stderr) => {
    if (err) reject(Object.assign(err, { stdout: stdout as string, stderr: stderr as string }));
    else resolve({ stdout: stdout as string, stderr: stderr as string });
  });
});

/**
 * The promise form for a caller that already has its own `promisify(execFile)`
 * (diff-provider.ts): the call goes to `plain` unchanged unless it is a WSL-route
 * call the worker may serve, and a fallback is a call of `plain`, so the spawn
 * is the one that caller always made. Resolves `{ stdout, stderr, via }` and
 * rejects with the error, which carries `stdout`, `stderr` and `via`.
 */
export async function execFileRoutedAsync(
  file: string,
  args: string[],
  options: ExecFileOptions & { idempotent?: boolean; wslEnv?: Record<string, string> },
  plain: PlainExecAsync,
): Promise<{ stdout: string; stderr: string; via?: SpawnVia; cold?: boolean }> {
  const { idempotent, wslEnv, ...execOptions } = options;
  if (!isWorkerRoute(args, wslEnv)) return plain(file, args, execOptions);
  const outcome = await tryWorker(file, args, {
    cwd: options.cwd === undefined ? undefined : String(options.cwd),
    timeout: options.timeout || DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer,
    idempotent,
    wslEnv,
  });
  if (outcome.kind === 'fallback') {
    try {
      return { ...(await plain(file, args, execOptions)), via: 'spawn', cold: outcome.cold };
    } catch (err) {
      throw Object.assign(err as Error, { via: 'spawn', cold: outcome.cold });
    }
  }
  const failure = workerFailure(outcome);
  if (failure) throw Object.assign(failure, { via: 'worker', cold: outcome.cold });
  const done = outcome as Extract<WorkerOutcome, { kind: 'done' }>;
  return { stdout: done.stdout.toString(), stderr: done.stderr.toString(), via: 'worker', cold: outcome.cold };
}

/**
 * `execFile` (text output) for the git callers that spawn on their own, serving a
 * WSL-route call from a worker when it can and otherwise calling `execFile`. The
 * error carries what execFile's does: a numeric `code`, `killed` on a timeout,
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` on overflow, and `stdout` and `stderr`.
 * It is `execFileRoutedAsync` over a promisified `execFile`, called back.
 */
export function execFileRouted(
  file: string,
  args: string[],
  options: ExecFileOptions & { idempotent?: boolean; wslEnv?: Record<string, string> },
  callback: RoutedCallback,
): void {
  execFileRoutedAsync(file, args, options, execFilePlain).then(
    ({ stdout, stderr, via, cold }) => callback(null, stdout, stderr, via, cold),
    (err: ExecFileException & { via?: SpawnVia; cold?: boolean }) => callback(err, String(err.stdout ?? ''), String(err.stderr ?? ''), err.via, err.cold),
  );
}
