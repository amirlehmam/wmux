/**
 * exec-trace.ts — optional timing of every remote spawn a workspace makes.
 *
 * Off unless `WMUX_SSH_TRACE=1` is set when wmux starts. Then each spawn that reaches a
 * remote host or a WSL distro writes ONE line, to the console and to
 * `%APPDATA%\wmux\logs\main.log`:
 *
 *     ssh-trace op=git:status loc=ssh prio=fg wait=0 ms=171 exit=0 out=1832
 *
 * `loc` is `ssh` (a workspace on a remote host) or `wsl` (a folder on a WSL share,
 * exec-location.ts); the variable name covers both. A call on a route with the persistent
 * worker on (exec-worker.ts) ends in `via=worker` or `via=spawn`, and in `cold=1` when it
 * had to start, or wait for the start of, a worker. The worker's own life is one line
 * per event (`traceWorkerStart`, `traceWorkerStop`):
 *
 *     ssh-trace op=worker:start loc=ssh ms=612 workers=1 reason=first
 *     ssh-trace op=worker:stop loc=ssh reason=idle age_s=300
 *
 * A line holds only an operation NAME from a fixed vocabulary, `prio=fg|bg` (whether a
 * person or a poll asked), `wait` (ms queued behind the per-host cap), the duration of the
 * spawn, the exit status and the byte count of stdout, or for a worker a duration, a count
 * and a word from a fixed list. Never a path, a file name, file content, a host or distro
 * name, the argument vector or stderr: a trace is something a person pastes into an issue.
 * The git sub-command is named only when it is one of a known few (`gitTraceOp`), so a
 * renderer-supplied word cannot reach the log.
 *
 * Off costs one boolean read per spawn: `traceSpawn` returns undefined, and the operation
 * name is a function so it is not even built.
 */

import { logDiagnostic } from './crash-diagnostics';
import type { ExecLocKind } from './exec-location';
import type { SpawnSlot } from './exec-gate';

let enabled = process.env.WMUX_SSH_TRACE === '1';

type Sink = (line: string, fields: Record<string, string | number>) => void;

const defaultSink: Sink = (line, fields) => {
  console.log(`[${line}]`);
  logDiagnostic('ssh-trace', fields);
};

let sink: Sink = defaultSink;

/** Tests only: switch tracing on or off, and where a line goes. */
export function configureExecTrace(on: boolean, to: Sink = defaultSink): void {
  enabled = on;
  sink = to;
}

export function execTraceEnabled(): boolean {
  return enabled;
}

/** The git sub-commands wmux runs remotely. Anything else is reported as `other`. */
const TRACED_GIT = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'worktree', 'for-each-ref', 'symbolic-ref', 'merge-base',
]);

/**
 * `git:<subcommand>` for a git argv, skipping the global options in front of
 * it (`-c key=value`, `--literal-pathspecs`). Only a name from `TRACED_GIT` is
 * ever returned; a path or ref that happens to sit where a sub-command would
 * is `git:other`.
 */
export function gitTraceOp(gitArgs: readonly string[]): string {
  for (let i = 0; i < gitArgs.length; i++) {
    const arg = gitArgs[i];
    if (arg === '-c') { i++; continue; }
    if (arg.startsWith('-')) continue;
    return TRACED_GIT.has(arg) ? `git:${arg}` : 'git:other';
  }
  return 'git:other';
}

/** An execFile-style failure (or none) as the exit status a trace line shows. */
export function traceExitStatus(err: unknown): number {
  if (!err) return 0;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' ? code : 1;
}

/**
 * Start timing one spawn. Returns the function to call when it ends (with `via`
 * when the call was routed through a persistent worker or fell back to a
 * spawn, exec-worker.ts), or
 * undefined when tracing is off.
 */
export function traceSpawn(
  op: string | (() => string),
  slot?: SpawnSlot,
  loc: ExecLocKind = 'ssh',
): ((status: number, bytesOut: number, via?: SpawnVia, cold?: boolean) => void) | undefined {
  if (!enabled) return undefined;
  const name = typeof op === 'function' ? op() : op;
  // A spawn that did not queue (no slot passed) is a foreground one that waited for nothing.
  const prio = slot?.prio ?? 'fg';
  const wait = Math.max(0, Math.round(slot?.waitMs ?? 0));
  const started = Date.now();
  return (status, bytesOut, via, cold) => {
    const ms = Date.now() - started;
    let line = `ssh-trace op=${name} loc=${loc} prio=${prio} wait=${wait} ms=${ms} exit=${status} out=${bytesOut}`;
    const fields: Record<string, string | number> = { op: name, loc, prio, wait, ms, exit: status, out: bytesOut };
    // `via` is only known on the WSL route with the worker on (exec-worker.ts); a line otherwise has none.
    if (via) { line += ` via=${via}`; fields.via = via; }
    // `cold`: the call started, or waited for the start of, a worker. Absent otherwise, not `cold=0`.
    if (cold) { line += ' cold=1'; fields.cold = 1; }
    sink(line, fields);
  };
}

/** Which way a call travelled: a persistent worker (`exec-worker.ts`) or a spawn of its own. */
export type SpawnVia = 'worker' | 'spawn';

/** Why a worker was started, for `traceWorkerStart`. */
export type WorkerStartReason = 'first' | 'click' | 'warm' | 'restart';

/** Why a worker ended, for `traceWorkerStop`. */
export type WorkerStopReason = 'idle' | 'timeout' | 'protocol' | 'clear' | 'quit' | 'exit' | 'closed-by-peer';

/**
 * A worker finished its handshake and can serve: `ms` is the time from starting
 * its process to the handshake's answer, `workers` how many workers the host has
 * now (this one included). Nothing about the host or the request.
 */
export function traceWorkerStart(ms: number, workers: number, reason: WorkerStartReason, loc: ExecLocKind = 'ssh'): void {
  if (!enabled) return;
  const rounded = Math.max(0, Math.round(ms));
  sink(`ssh-trace op=worker:start loc=${loc} ms=${rounded} workers=${workers} reason=${reason}`,
    { op: 'worker:start', loc, ms: rounded, workers, reason });
}

/** A worker ended, `ageMs` after its process started. */
export function traceWorkerStop(reason: WorkerStopReason, ageMs: number, loc: ExecLocKind = 'ssh'): void {
  if (!enabled) return;
  const age = Math.max(0, Math.round(ageMs / 1000));
  sink(`ssh-trace op=worker:stop loc=${loc} reason=${reason} age_s=${age}`, { op: 'worker:stop', loc, reason, age_s: age });
}
