/**
 * exec-worker.ts — a long-lived `wsl.exe -> ssh -> sh` per remote host (or
 * `wsl.exe -d <distro> --exec sh` per WSL distro, see exec-location.ts) that serves
 * view calls over its stdin and stdout instead of one process start per call.
 *
 * **Correctness never depends on the worker.** Any problem with it (it does not
 * start, answers badly, dies, hangs) ends in the per-call spawn for that request,
 * and the worker is torn down and not started again for a while.
 * `WMUX_SSH_WORKER=0` switches it off, for ssh targets and WSL folders alike.
 *
 * Callers keep building the per-call `wsl.exe ... ssh <options> <destination> <command>`
 * argv (`ssh-exec.ts`). The routed runners (`exec-worker-routed.ts`) recognise that shape,
 * reuse its options and its already-encoded command as the request, and return the
 * same results and error shapes as a spawn. The gate (`exec-gate.ts`) is still held
 * around the call, so in-flight work per host stays bounded by it.
 *
 * ## Protocol
 *
 * Everything on stdin is ASCII lines, and everything user-controlled is base64:
 *
 *     Q <nonce>              start a request (nonce: 16 random bytes as hex, made here)
 *     C <base64 line>        the command, the very base64 the per-call route sends
 *     I <base64 line>        the bytes for the script's stdin
 *     G <nonce>              go: the worker runs the request now
 *
 * The worker (the constant script `LOOP_SCRIPT`) runs the decoded command in a
 * fresh subshell with `set -f`, its stdin a file holding the decoded input and its
 * stdout and stderr two files, so what a script prints cannot reach the worker's own
 * stdout. It answers:
 *
 *     <nonce> BEGIN
 *     O <base64 line>        stdout, wrapped
 *     E <base64 line>        stderr, wrapped
 *     S <status> <stdout bytes> <stderr bytes>
 *     <nonce> END
 *
 * Content cannot forge a marker: it is base64 behind an `O ` or `E ` tag, so it is
 * never a line that starts with the nonce or `S `. Parsing is strict
 * (`WorkerProcess.onLine`): lines before our `BEGIN` are dropped as noise (an sshd
 * banner); afterwards a line out of order, with bad base64, with sizes that do not
 * add up, or after `END`, is a worker failure.
 *
 * ## Which failures re-run the request
 *
 * A request is "started" once its `G` line began to be written; the worker runs
 * nothing before that. After a failure (died, malformed or truncated answer, timeout):
 *
 * - never started: run it per call, whatever it is;
 * - started and **idempotent** (callers say so; unsaid means not): run it per call;
 * - started and **not idempotent** (save, create, rename, delete): never run again,
 *   because the first run may have happened. A timeout is reported as a timeout; any
 *   other failure as "could not reach the remote host" (ssh status 255).
 *
 * ## Lifecycle and concurrency
 *
 * Started lazily by the first request of a host, after a handshake (a request whose
 * answer is a random token), or ahead of it by `warmExecWorker` (exec-warm.ts). A failed
 * handshake marks the host unusable for five minutes; a later failure backs off 30 s,
 * doubling to five minutes, and a success resets it. A worker idle for as long as the
 * shared ssh connection persists gets its stdin closed (the remote `sh` exits, and ssh
 * with it) and is killed if it lingers. It is killed as a tree on a timeout or protocol
 * failure, when its target is cleared or changed (`releaseExecWorkers`), on quit
 * (`shutdownExecWorkers`) and on process exit. Its stderr is read and dropped.
 *
 * One request at a time per worker, because a shell cannot safely interleave two
 * answers on one stdout. Up to `MAX_WORKERS_PER_HOST` workers per host, a second one
 * only when a request has to wait behind a busy first. Waiting requests start
 * foreground first, then in arrival order, so a click is not queued behind a poll.
 *
 * `WMUX_SSH_TRACE=1` logs each worker start and stop and marks a request that waited
 * for a start `cold=1` (`exec-trace.ts`); nothing else about a host, path or request.
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import type { ExecLocKind } from './exec-location';
import type { SpawnPriority } from './exec-gate';
import { SSH_CONNECTION_PERSIST_S } from './ssh-exec';
import { system32 } from './system32';
import { traceWorkerStart, traceWorkerStop, type WorkerStartReason, type WorkerStopReason } from './exec-trace';
import { parseWorkerInvocation, WORKER_REMOTE_COMMAND, type WorkerInvocation } from './exec-worker-script';

const MAX_WORKERS_PER_HOST = 2;
/** An idle worker lives as long as the shared ssh connection under it (`ControlPersist`, ssh-exec.ts). */
const IDLE_MS = SSH_CONNECTION_PERSIST_S * 1000;
const LINGER_KILL_MS = 3_000;
const HANDSHAKE_TIMEOUT_MS = 12_000;
const HANDSHAKE_BACKOFF_MS = 5 * 60_000;
const FAILURE_BACKOFF_BASE_MS = 30_000;
const FAILURE_BACKOFF_MAX_MS = 5 * 60_000;
/** Characters per `C` and `I` line, a multiple of 4. */
const LINE_CHARS = 3072;
/** Bytes written to the worker's stdin at a time. */
const WRITE_SLICE = 256 * 1024;
/** Lines before `BEGIN` that are dropped; more than this is not a banner. */
const MAX_NOISE_BYTES = 256 * 1024;
/** The longest line of an answer or of noise that is held while waiting for its end. */
const MAX_LINE_BYTES = 1024 * 1024;

// ─── Switches ────────────────────────────────────────────────────────────────

interface WorkerConfig {
  /** Tests: true or false overrides the environment. */
  enabled?: boolean;
  /** Unset: the default (`IDLE_MS`). */
  idleMs?: number;
  lingerKillMs: number;
  maxWorkers: number;
  handshakeTimeoutMs: number;
}

const defaultConfig = (): WorkerConfig => ({
  lingerKillMs: LINGER_KILL_MS,
  maxWorkers: MAX_WORKERS_PER_HOST,
  handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
});

let config = defaultConfig();

/** Tests only. Passing nothing restores the defaults. */
export function configureExecWorker(next: Partial<WorkerConfig> = {}): void {
  config = { ...defaultConfig(), ...next };
}

/** How long a worker may sit without a request before it is closed, in ms. */
function sshWorkerIdleMs(): number {
  return config.idleMs ?? IDLE_MS;
}

/**
 * `WMUX_SSH_WORKER=0` turns the worker of both places (an ssh host, a WSL distro) off. Unset
 * or anything else: on where the WSL route exists (Windows), and nowhere else. Tests set
 * `configureExecWorker({ enabled })` instead of the environment.
 */
export function workerEnabled(): boolean {
  if (config.enabled !== undefined) return config.enabled;
  if (process.env.WMUX_SSH_WORKER === '0') return false;
  return process.platform === 'win32';
}

// ─── Killing ─────────────────────────────────────────────────────────────────

/**
 * Kill `child` and everything under it. On Windows `child.kill()` ends only
 * wsl.exe, so the tree goes with `taskkill /T /F` (absolute path, as the PTY
 * kill does). Never throws.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (process.platform === 'win32' && typeof pid === 'number' && pid > 0) {
    try {
      const killer = spawn(system32('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      killer.on('error', () => undefined);
      killer.unref();
    } catch {
      /* fall through to child.kill */
    }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

// ─── One exchange ────────────────────────────────────────────────────────────

type ExchangeResult =
  | { ok: true; status: number; stdout: Buffer; stderr: Buffer; overflow: boolean }
  | { ok: false; reason: string; started: boolean; timedOut: boolean };

interface ExchangeSpec {
  payload: string;
  input: Buffer | undefined;
  maxBuffer: number;
  timeoutMs: number;
}

interface Exchange extends ExchangeSpec {
  nonce: string;
  resolve: (result: ExchangeResult) => void;
  /** `wait`: before our BEGIN. Then `out`, `err`, `tail` (S seen), and done at END. */
  phase: 'wait' | 'out' | 'err' | 'tail';
  noise: number;
  started: boolean;
  done: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  stdout: Buffer[];
  stderr: Buffer[];
  outBytes: number;
  errBytes: number;
  overflow: boolean;
  status: number;
  reportedOut: number;
  reportedErr: number;
}

const BASE64_LINE = /^[A-Za-z0-9+/]*={0,2}$/;
const STATUS_LINE = /^S (\d{1,3}) (\d{1,12}) (\d{1,12})$/;

function chunkText(text: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += LINE_CHARS) parts.push(text.slice(i, i + LINE_CHARS));
  return parts;
}

/**
 * The word a trace shows for why a worker ended, from the reason it was ended
 * with. The other side closing the pipes (the remote `sh`, ssh or wsl.exe gone,
 * or a write that found stdin closed) is `closed-by-peer`; a timeout is a timeout;
 * `clear` and `quit` are wmux ending it on purpose; anything else is the worker
 * not behaving (a handshake or answer that was not right, or no start at all).
 */
function stopReasonOf(reason: string): WorkerStopReason {
  switch (reason) {
    case 'timeout': return 'timeout';
    case 'clear': return 'clear';
    case 'quit': return 'quit';
    case 'exit':
    case 'error':
    case 'write': return 'closed-by-peer';
    default: return 'protocol';
  }
}

class WorkerProcess {
  state: 'starting' | 'idle' | 'busy' | 'closing' | 'dead' = 'starting';
  /** True once the handshake answered; a worker that dies before that is a failed handshake. */
  private ready = false;
  private child: ChildProcess | undefined;
  private buffer = '';
  private current: Exchange | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private lingerTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly createdAt = Date.now();
  private stopTraced = false;

  constructor(
    private readonly pool: Pool,
    readonly group: Group,
    private readonly reason: WorkerStartReason,
  ) {}

  /** The one `worker:stop` trace line of this worker, whichever way it ends first. */
  noteStop(reason: WorkerStopReason): void {
    if (this.stopTraced) return;
    this.stopTraced = true;
    traceWorkerStop(reason, Date.now() - this.createdAt, this.group.loc);
  }

  /** Spawn the process, and handshake. Resolves when it can serve, or says why not. */
  async start(file: string, cwd: string | undefined): Promise<boolean> {
    let child: ChildProcess;
    try {
      child = spawn(file, [...this.group.prefix, WORKER_REMOTE_COMMAND], {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      this.die('spawn');
      return false;
    }
    this.child = child;
    child.stdin?.on('error', () => undefined);
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    // Drained and dropped: it carries ssh's own messages, which can hold local paths.
    child.stderr?.on('data', () => undefined);
    child.stderr?.on('error', () => undefined);
    child.stdout?.on('error', () => undefined);
    child.on('error', () => this.die('error'));
    child.on('exit', () => this.die('exit'));
    this.pool.noteSpawned(child);

    const token = randomBytes(16).toString('hex');
    const result = await this.exchange({
      payload: Buffer.from(`printf %s ${token}`, 'utf8').toString('base64'),
      input: undefined,
      maxBuffer: 4096,
      timeoutMs: config.handshakeTimeoutMs,
    });
    if (!result.ok || result.status !== 0 || result.overflow || result.stdout.toString('latin1') !== token) {
      this.die('handshake');
      return false;
    }
    if (this.state !== 'starting') return false;
    this.ready = true;
    traceWorkerStart(Date.now() - this.createdAt, this.group.liveCount(), this.reason, this.group.loc);
    this.becomeIdle();
    return true;
  }

  exchange(spec: ExchangeSpec): Promise<ExchangeResult> {
    return new Promise<ExchangeResult>((resolve) => {
      const ex: Exchange = {
        ...spec,
        nonce: randomBytes(16).toString('hex'),
        resolve,
        phase: 'wait',
        noise: 0,
        started: false,
        done: false,
        timer: undefined,
        stdout: [],
        stderr: [],
        outBytes: 0,
        errBytes: 0,
        overflow: false,
        status: 0,
        reportedOut: 0,
        reportedErr: 0,
      };
      if (this.state === 'dead' || this.state === 'closing' || !this.child?.stdin?.writable) {
        ex.done = true;
        resolve({ ok: false, reason: 'unusable', started: false, timedOut: false });
        return;
      }
      this.current = ex;
      ex.timer = setTimeout(() => this.fail(ex, 'timeout', true), spec.timeoutMs);
      ex.timer.unref();
      this.send(ex).catch(() => this.fail(ex, 'write', false));
    });
  }

  private write(data: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin || stdin.destroyed || !stdin.writable) {
        reject(new Error('stdin closed'));
        return;
      }
      stdin.write(data, 'latin1', (err) => (err ? reject(err) : resolve()));
    });
  }

  private async send(ex: Exchange): Promise<void> {
    const lines = [`Q ${ex.nonce}\n`];
    for (const part of chunkText(ex.payload)) lines.push(`C ${part}\n`);
    if (ex.input && ex.input.length > 0) {
      for (const part of chunkText(ex.input.toString('base64'))) lines.push(`I ${part}\n`);
    }
    const text = lines.join('');
    for (let at = 0; at < text.length; at += WRITE_SLICE) {
      if (ex.done) return;
      await this.write(text.slice(at, at + WRITE_SLICE));
    }
    if (ex.done) return;
    // From here the worker may run it: an ambiguous failure must not re-run a write.
    ex.started = true;
    await this.write(`G ${ex.nonce}\n`);
  }

  private fail(ex: Exchange, reason: string, timedOut: boolean): void {
    if (ex.done) return;
    ex.done = true;
    if (ex.timer) clearTimeout(ex.timer);
    if (this.current === ex) this.current = undefined;
    ex.resolve({ ok: false, reason, started: ex.started, timedOut });
    // A worker in an unknown state is never reused.
    this.die(reason, true);
  }

  private finish(ex: Exchange): void {
    if (ex.done) return;
    if (!ex.overflow && (ex.outBytes !== ex.reportedOut || ex.errBytes !== ex.reportedErr)) {
      this.fail(ex, 'sizes', false);
      return;
    }
    ex.done = true;
    if (ex.timer) clearTimeout(ex.timer);
    this.current = undefined;
    ex.resolve({
      ok: true,
      status: ex.status,
      stdout: Buffer.concat(ex.stdout),
      stderr: Buffer.concat(ex.stderr),
      overflow: ex.overflow,
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('latin1');
    let from = 0;
    for (;;) {
      const eol = this.buffer.indexOf('\n', from);
      if (eol < 0) break;
      let line = this.buffer.slice(from, eol);
      from = eol + 1;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.onLine(line);
    }
    this.buffer = this.buffer.slice(from);
    // A line with no end that keeps growing is not an answer.
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = '';
      if (this.current) this.fail(this.current, 'long-line', false);
    }
  }

  private onLine(line: string): void {
    const ex = this.current;
    if (!ex || ex.done) return; // idle noise
    if (ex.phase === 'wait') {
      if (line === `${ex.nonce} BEGIN`) ex.phase = 'out';
      else {
        ex.noise += line.length + 1;
        if (ex.noise > MAX_NOISE_BYTES) this.fail(ex, 'noise', false);
      }
      return;
    }
    if (line === `${ex.nonce} END`) {
      if (ex.phase !== 'tail') this.fail(ex, 'early-end', false);
      else this.finish(ex);
      return;
    }
    if (line.startsWith('O ') && ex.phase === 'out') {
      this.take(ex, line.slice(2), true);
    } else if (line.startsWith('E ') && (ex.phase === 'out' || ex.phase === 'err')) {
      ex.phase = 'err';
      this.take(ex, line.slice(2), false);
    } else if (line.startsWith('S ') && ex.phase !== 'tail') {
      const match = STATUS_LINE.exec(line);
      if (!match) { this.fail(ex, 'status', false); return; }
      ex.phase = 'tail';
      ex.status = Number(match[1]);
      ex.reportedOut = Number(match[2]);
      ex.reportedErr = Number(match[3]);
    } else {
      this.fail(ex, 'malformed', false);
    }
  }

  private take(ex: Exchange, text: string, isStdout: boolean): void {
    if (!BASE64_LINE.test(text)) { this.fail(ex, 'base64', false); return; }
    const bytes = Buffer.from(text, 'base64');
    if (isStdout) ex.outBytes += bytes.length; else ex.errBytes += bytes.length;
    if (ex.outBytes > ex.maxBuffer || ex.errBytes > ex.maxBuffer) ex.overflow = true;
    // Past the cap the answer is still read to its end, so the worker stays usable, but not kept.
    if (!ex.overflow) (isStdout ? ex.stdout : ex.stderr).push(bytes);
  }

  becomeIdle(): void {
    this.state = 'idle';
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.closeGracefully(), sshWorkerIdleMs());
    this.idleTimer.unref();
  }

  markBusy(): void {
    this.state = 'busy';
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /** No request for a while: close stdin so the remote `sh` ends, and kill the tree if it lingers. */
  private closeGracefully(): void {
    if (this.state !== 'idle') return;
    this.state = 'closing';
    this.noteStop('idle');
    this.group.remove(this);
    try { this.child?.stdin?.end(); } catch { /* already closed */ }
    this.lingerTimer = setTimeout(() => {
      if (this.child) killTree(this.child);
      this.state = 'dead';
    }, config.lingerKillMs);
    this.lingerTimer.unref();
  }

  /**
   * End the worker for good, and whatever it was doing. `during` says it was
   * serving a request (a failure to count), as opposed to an idle worker that the
   * host or the network closed.
   */
  die(reason: string, during: boolean = this.current !== undefined && !this.current.done): void {
    if (this.state === 'dead') return;
    const wasClosing = this.state === 'closing';
    this.noteStop(stopReasonOf(reason));
    this.state = 'dead';
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.idleTimer = undefined;
    this.lingerTimer = undefined;
    this.group.remove(this);
    if (this.child) killTree(this.child);
    const ex = this.current;
    if (ex && !ex.done) {
      ex.done = true;
      if (ex.timer) clearTimeout(ex.timer);
      this.current = undefined;
      ex.resolve({ ok: false, reason, started: ex.started, timedOut: false });
    }
    if (!wasClosing) this.pool.workerEnded(this.group, reason, this.ready ? during : 'handshake');
  }
}

// ─── Groups and the pool ─────────────────────────────────────────────────────

export type WorkerOutcome = (
  | { kind: 'done'; status: number; stdout: Buffer; stderr: Buffer }
  | { kind: 'overflow' }
  | { kind: 'timeout' }
  | { kind: 'lost' }
  | { kind: 'fallback' }
) & {
  /** The request had to start, or wait for the start of, a worker (traced as `cold=1`). */
  cold?: true;
};

export const FALLBACK: WorkerOutcome = { kind: 'fallback' };

export interface WorkerRequest {
  file: string;
  invocation: WorkerInvocation;
  cwd: string | undefined;
  timeoutMs: number;
  input: Buffer | undefined;
  maxBuffer: number;
  idempotent: boolean;
  prio: SpawnPriority;
}

interface Pending {
  request: WorkerRequest;
  resolve: (outcome: WorkerOutcome) => void;
}

class Group {
  workers: WorkerProcess[] = [];
  queue: Pending[] = [];
  failures = 0;
  unusableUntil = 0;
  /** A worker of this host has started since it was last released: the next start is not its first. */
  everStarted = false;
  /** The last worker ended by failing (not by idling or being closed): the next start is a restart. */
  restartPending = false;

  constructor(
    readonly file: string,
    readonly cwd: string | undefined,
    readonly prefix: string[],
    readonly distro: string,
    readonly destination: string,
    readonly loc: ExecLocKind = 'ssh',
  ) {}

  remove(worker: WorkerProcess): void {
    const at = this.workers.indexOf(worker);
    if (at >= 0) this.workers.splice(at, 1);
  }

  /** Workers that are starting or serving, not ones that are closing. */
  liveCount(): number {
    return this.workers.filter((w) => w.state !== 'dead' && w.state !== 'closing').length;
  }

  /** The trace reason for the next worker start a request needs. */
  requestReason(): WorkerStartReason {
    if (this.restartPending) return 'restart';
    return this.everStarted ? 'click' : 'first';
  }
}

class Pool {
  private groups = new Map<string, Group>();
  private exitHooked = false;
  private spawned = new Set<ChildProcess>();

  /** Run `request` on a worker of its host, or say `fallback`. Never rejects. */
  run(request: WorkerRequest): Promise<WorkerOutcome> {
    const group = this.groupFor(request);
    if (Date.now() < group.unusableUntil) return Promise.resolve(FALLBACK);
    // Nothing alive and ready to take it: this request is the one that waits for a start.
    const cold = !group.workers.some((w) => w.state === 'idle' || w.state === 'busy');
    return new Promise<WorkerOutcome>((resolve) => {
      group.queue.push({
        request,
        resolve: cold ? (outcome) => resolve({ ...outcome, cold: true }) : resolve,
      });
      this.settle(group);
    });
  }

  private groupFor(request: Pick<WorkerRequest, 'file' | 'invocation' | 'cwd'>): Group {
    const { invocation } = request;
    const key = JSON.stringify([request.file, invocation.prefix]);
    let group = this.groups.get(key);
    if (!group) {
      group = new Group(request.file, request.cwd, invocation.prefix, invocation.distro, invocation.destination, invocation.loc);
      this.groups.set(key, group);
    }
    return group;
  }

  noteSpawned(child: ChildProcess): void {
    this.spawned.add(child);
    child.once('exit', () => this.spawned.delete(child));
    if (!this.exitHooked) {
      this.exitHooked = true;
      // Never leave a wsl.exe behind when wmux itself goes.
      process.once('exit', () => this.noteProcessExit());
    }
  }

  /** wmux itself is exiting: each worker still there ends with it (traced as `exit`), and nothing is left behind. */
  noteProcessExit(): void {
    for (const group of this.groups.values()) for (const worker of group.workers) worker.noteStop('exit');
    this.killAll();
  }

  killAll(): void {
    for (const child of this.spawned) killTree(child);
    this.spawned.clear();
  }

  /**
   * A worker ended. A handshake that failed makes the host unusable for five
   * minutes; a worker that died serving a request backs the host off (30 s,
   * doubling); an idle one closed by the other side costs nothing, and the next
   * request starts a new one.
   */
  workerEnded(group: Group, reason: string, during: boolean | 'handshake'): void {
    if (reason === 'clear' || reason === 'quit') return;
    // Ended by failing, not by idling or being closed: whatever starts next is a restart.
    if (during) group.restartPending = true;
    if (during === 'handshake') {
      group.unusableUntil = Date.now() + HANDSHAKE_BACKOFF_MS;
    } else if (during) {
      group.failures++;
      const delay = Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** (group.failures - 1), FAILURE_BACKOFF_MAX_MS);
      group.unusableUntil = Date.now() + delay;
    }
    this.settle(group);
  }

  /** The state of a group changed: serve, start a worker, or send the queue to the per-call route. */
  private settle(group: Group): void {
    if (Date.now() < group.unusableUntil) {
      this.flush(group);
      return;
    }
    this.dispatch(group);
    if (group.queue.length === 0) return;
    const live = group.workers;
    if (live.some((w) => w.state === 'starting')) return;
    if (live.length === 0 || (live.length < config.maxWorkers && live.every((w) => w.state === 'busy'))) {
      void this.startWorker(group, group.requestReason());
    }
  }

  private startWorker(group: Group, reason: WorkerStartReason): Promise<void> {
    const worker = new WorkerProcess(this, group, reason);
    group.everStarted = true;
    group.restartPending = false;
    group.workers.push(worker);
    return worker.start(group.file, group.cwd).then((ready) => {
      if (ready) {
        this.settle(group);
        return;
      }
      // die() has already counted it and removed it.
      if (group.workers.length === 0) this.flush(group);
    });
  }

  /**
   * Start a worker for a host before anything asked for it, so that the first
   * request does not pay the start. Resolves when the worker is ready or failed
   * (a failure is counted as for any worker: the host is unusable for a while, and
   * nothing is thrown). Does nothing for a host that has a worker, one starting,
   * or is backed off. A request that arrives meanwhile queues behind the start,
   * as it would behind its own.
   */
  warm(request: Pick<WorkerRequest, 'file' | 'invocation' | 'cwd'>): Promise<void> {
    const group = this.groupFor(request);
    if (Date.now() < group.unusableUntil || group.workers.length > 0) return Promise.resolve();
    return this.startWorker(group, 'warm');
  }

  private flush(group: Group): void {
    const waiting = group.queue.splice(0);
    for (const p of waiting) p.resolve(FALLBACK);
  }

  private takeNext(group: Group): Pending | undefined {
    const at = group.queue.findIndex((p) => p.request.prio === 'fg');
    return group.queue.splice(at >= 0 ? at : 0, 1)[0];
  }

  private dispatch(group: Group): void {
    for (const worker of [...group.workers]) {
      if (worker.state !== 'idle' || group.queue.length === 0) continue;
      const next = this.takeNext(group);
      if (next) void this.serve(group, worker, next);
    }
  }

  private async serve(group: Group, worker: WorkerProcess, p: Pending): Promise<void> {
    const { request } = p;
    worker.markBusy();
    const result = await worker.exchange({
      payload: request.invocation.payload,
      input: request.input,
      maxBuffer: request.maxBuffer,
      timeoutMs: request.timeoutMs,
    });
    if (result.ok) {
      group.failures = 0;
      p.resolve(result.overflow
        ? { kind: 'overflow' }
        : { kind: 'done', status: result.status, stdout: result.stdout, stderr: result.stderr });
      if (worker.state === 'busy') worker.becomeIdle();
      this.settle(group);
      return;
    }
    // The worker is already dead and counted. What happens to THIS request:
    if (!result.started || request.idempotent) p.resolve(FALLBACK);
    else p.resolve(result.timedOut ? { kind: 'timeout' } : { kind: 'lost' });
  }

  /** Kill the workers of a host, and send what waits on them to the per-call route. */
  release(distro: string, destination: string): void {
    for (const group of this.groups.values()) {
      if (group.distro !== distro || group.destination !== destination) continue;
      this.shutdownGroup(group, 'clear');
    }
  }

  shutdownAll(): void {
    for (const group of this.groups.values()) this.shutdownGroup(group, 'quit');
  }

  /** `clear`: the host's target went away. `quit`: wmux is ending. Either way the host starts afresh. */
  private shutdownGroup(group: Group, reason: 'clear' | 'quit'): void {
    for (const worker of [...group.workers]) worker.die(reason);
    this.flush(group);
    group.failures = 0;
    group.unusableUntil = 0;
    group.everStarted = false;
    group.restartPending = false;
  }

  /** Tests: forget everything, after killing it. */
  reset(): void {
    this.shutdownAll();
    this.killAll();
    this.groups.clear();
  }

  /** Tests: how many workers are alive. */
  liveWorkers(): number {
    let n = 0;
    for (const group of this.groups.values()) n += group.workers.length;
    return n;
  }
}

const pool = new Pool();

/** Serve one request from a worker of its host, starting one if it has none (see `Pool.run`). */
export function runOnWorker(request: WorkerRequest): Promise<WorkerOutcome> {
  return pool.run(request);
}

/** Kill every worker (wmux is quitting). Safe to call twice. */
export function shutdownExecWorkers(): void {
  pool.shutdownAll();
  pool.killAll();
}

/**
 * Start the worker of the host an `argv` of the WSL route names, in the
 * background, if it has none (see `Pool.warm`). Resolves when it is ready or has
 * failed; never rejects. Nothing when the worker is switched off (`WMUX_SSH_WORKER=0`)
 * or the argv is not the WSL route's.
 */
export async function warmExecWorker(file: string, args: readonly string[], cwd: string | undefined): Promise<void> {
  const invocation = parseWorkerInvocation(args);
  if (!invocation || !workerEnabled()) return;
  try {
    await pool.warm({ file, invocation, cwd });
  } catch {
    /* a warm-up is an optimisation: whatever went wrong, the first request starts its own */
  }
}

/** Kill the workers of one host: its workspace's target was cleared or changed. */
export function releaseExecWorkers(distro: string, destination: string): void {
  pool.release(distro, destination);
}

/** Tests only. */
export function resetExecWorkersForTests(): void {
  pool.reset();
}

/** Tests only: what the process's `exit` event does to the workers. */
export function noteExecWorkersProcessExitForTests(): void {
  pool.noteProcessExit();
}

/** Tests only. */
export function liveExecWorkerCount(): number {
  return pool.liveWorkers();
}

