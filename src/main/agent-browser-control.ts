/**
 * One control belongs to one started session; runtime owns its lifetime. All
 * callers share its bounded FIFO, including multi-command work and recovery.
 * Unknown native outcomes fence queued work rather than replaying an action.
 *
 * Public session info is non-launching. get cdp-url is NOT: only explicit
 * initialization/recovery may use it, bracketed by daemon identity checks.
 * HTTP proves the recorded Chrome endpoint lives, not that the daemon still
 * controls it. Lifecycle flags/postchecks detect some replacements after the
 * fact; they cannot eliminate that residual association/dispatch race. Remote
 * or nonstandard CDP URLs receive no invented discovery or extra CDP socket.
 */
import { promises as fs } from 'fs';
import * as http from 'http';
import * as path from 'path';
import { observedBrowserReplacement, runAgentBrowser, type RunResult } from './agent-browser-cli';
import { isWmuxSessionName, type AgentSession } from './agent-browser-session';

export type NativeCommandCheck = () => void | Promise<void>;
export type NativeCommandRunner = (argv: string[], timeoutMs?: number, check?: NativeCommandCheck) => Promise<RunResult>;

export interface NativeBinaryFingerprint {
  path: string;
  identity: string;
}

export interface AgentBrowserControlDeps {
  run?: typeof runAgentBrowser;
  fingerprint?: (binary: string, timeoutMs: number) => Promise<NativeBinaryFingerprint>;
  probeBrowser?: (cdpUrl: string, timeoutMs: number) => Promise<boolean>;
  readPort?: (file: string, timeoutMs: number) => Promise<number>;
  onPause?: (message: string) => void;
}

type ObjectValue = Record<string, unknown>;
interface DaemonIdentity {
  session: string;
  namespace: string | null;
  socketDir: string;
  pid: number;
  version: string;
}
interface Ports { port: number; streamPort: number }
interface Scope { epoch: number; deadline: number; active: boolean; closing: boolean; nativeInFlight: boolean; owner?: Scope }
interface Job {
  scope: Scope;
  execute: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  dispatchTimeoutMs?: number;
}

class Cancelled extends Error {}

const COMMAND_MS = 60_000;
const RECOVERY_MS = 10_000;
const MAX_QUEUE = 256;
const object = (v: unknown): ObjectValue | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : undefined;
const portNumber = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0 && Number(v) <= 65535;
const error = (v: unknown): Error => v instanceof Error ? v : new Error(String(v));
const version = (v: unknown): string | undefined => typeof v === 'string'
  ? /^(?:agent-browser\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/i.exec(v.trim())?.[1] : undefined;

async function fingerprint(binary: string): Promise<NativeBinaryFingerprint> {
  const real = await fs.realpath(binary);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error('Native executable is not a file');
  return { path: real, identity: JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]) };
}

async function readPort(file: string): Promise<number> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(65);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const value = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (bytesRead > 64 || !/^\d{1,5}$/.test(value) || !portNumber(Number(value))) throw new Error('Invalid native port metadata');
    return Number(value);
  } finally { await handle.close(); }
}

function probeBrowser(cdpUrl: string, timeoutMs: number): Promise<boolean> {
  let url: URL;
  try { url = new URL(cdpUrl); } catch { return Promise.resolve(false); }
  const standard = url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && portNumber(Number(url.port)) && !url.username && !url.password && !url.search && !url.hash
    && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(url.pathname);
  if (!standard) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (live: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(live);
    };
    const request = http.get({ hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port,
      path: '/json/version', agent: false }, (response) => {
      if (response.statusCode !== 200) { response.resume(); done(false); return; }
      let body = '';
      response.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
        if (body.length > 32 * 1024) done(false);
      });
      response.on('error', () => done(false));
      response.on('end', () => {
        try { done(object(JSON.parse(body))?.webSocketDebuggerUrl === cdpUrl); }
        catch { done(false); }
      });
    });
    const timer = setTimeout(() => done(false), timeoutMs);
    request.on('error', () => done(false));
  });
}

function envelope(result: RunResult): ObjectValue {
  const value = object(result.data);
  if (!value || typeof value.success !== 'boolean' || (value.success ? !('data' in value) : !('error' in value))) {
    throw new Error('Malformed native result; command outcome is unknown');
  }
  return value;
}

function hasStatus(value: ObjectValue, status: string): boolean {
  const data = object(value.data);
  const failure = object(value.error);
  return [value.code, value.status, value.outcome, value.error, failure?.code,
    data?.code, data?.status, data?.outcome].some((v) => v === status || (typeof v === 'string' && v.startsWith(`${status}:`)))
    || data?.[status] === true || value[status] === true;
}

/** Bootstrap and controlled commands must fence the same uncertain native results. */
export function uncertainNativeOutcome(result: RunResult): string | undefined {
  if (result.timedOut || /timed out/i.test(result.stderr)) return 'Native command timed out; outcome is unknown';
  const value = object(result.data);
  if (!result.spawnFailed && value && hasStatus(value, 'outcome_unknown')) return 'Native command outcome is unknown';
  return undefined;
}

/**
 * Reads leave nothing to replay, so a timed-out read fails alone instead of
 * pausing the session.
 */
function readOnlyCommand(argv: string[]): boolean {
  const args = argv.filter((arg, i) => arg !== '--json' && argv[i - 1] !== '--session' && arg !== '--session');
  return ['wait', 'snapshot', 'read', 'screenshot'].includes(args[0])
    || (args[0] === 'get' && ['text', 'url', 'title'].includes(args[1]));
}

/** Process exit zero does not prove native acceptance or completed confirmation. */
function completedCommandResult(result: RunResult): RunResult {
  if (result.spawnFailed) return result.ok ? { ...result, ok: false, stderr: result.stderr || 'Native command failed to start' } : result;
  const value = envelope(result);
  const confirmation = hasStatus(value, 'confirmation_required');
  if (value.success === true && !confirmation) return result;
  if (!result.ok && result.stderr.trim()) return result;
  const nativeError = typeof value.error === 'string' ? value.error : object(value.error)?.message;
  const message = confirmation ? 'Native command requires confirmation; no action was confirmed.'
    : typeof nativeError === 'string' && nativeError.trim() ? nativeError : 'Native command was refused';
  return { ...result, ok: false, stderr: result.stderr.trim() ? result.stderr : message };
}

export class AgentBrowserControl {
  private readonly deps: Required<Omit<AgentBrowserControlDeps, 'onPause'>> & Pick<AgentBrowserControlDeps, 'onPause'>;
  private jobs: Job[] = [];
  private running?: Job;
  private epoch = 0;
  private cancelled = false;
  private disposed = false;
  private retired = false;
  private message?: string;
  private binaryBaseline?: NativeBinaryFingerprint;
  private daemon?: DaemonIdentity;
  private ports?: Ports;
  private cdpUrl?: string;
  private initialized = false;
  private initialization?: Promise<void>;
  private recovery?: Promise<void>;
  private closing?: Promise<RunResult>;
  private closedResult?: RunResult;

  constructor(private readonly session: AgentSession, private readonly binary: string, deps: AgentBrowserControlDeps = {}) {
    if (!isWmuxSessionName(session.sessionName)) throw new Error('Invalid wmux browser session');
    this.deps = { run: deps.run ?? runAgentBrowser, fingerprint: deps.fingerprint ?? fingerprint,
      probeBrowser: deps.probeBrowser ?? probeBrowser, readPort: deps.readPort ?? readPort, onPause: deps.onPause };
  }

  get pauseMessage(): string | undefined { return this.message; }

  private assert(scope: Scope): void {
    if (this.disposed || this.retired || !scope.active || scope.owner?.active === false
      || (!scope.closing && (this.cancelled || scope.epoch !== this.epoch))) {
      throw new Cancelled('Browser control work was cancelled or became stale');
    }
    if (Date.now() >= scope.deadline) throw new Error('Browser control deadline expired');
  }

  private remaining(scope: Scope): number {
    this.assert(scope);
    return Math.max(1, scope.deadline - Date.now());
  }

  private async bounded<T>(scope: Scope, work: () => T | Promise<T>): Promise<T> {
    const ms = this.remaining(scope);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([Promise.resolve().then(() => { this.assert(scope); return work(); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Browser control deadline expired')), ms); })]);
      this.assert(scope);
      return result;
    } finally { clearTimeout(timer); }
  }

  private invalidate(): void {
    this.epoch++;
    const pending = this.jobs.filter((job) => !job.scope.closing);
    this.jobs = this.jobs.filter((job) => job.scope.closing);
    for (const job of pending) {
      job.scope.active = false;
      clearTimeout(job.timer);
      job.reject(new Error('Browser control work was cancelled or became stale'));
    }
  }

  private pause(reason: unknown): void {
    if (this.disposed || this.retired || this.message) return;
    this.message = `${error(reason).message}. Browser control paused; explicitly reconnect or start a new session. The action was not retried.`;
    this.invalidate();
    try { this.deps.onPause?.(this.message); } catch { /* Reporting must not undo the fence. */ }
  }

  private schedule<T>(work: (scope: Scope) => Promise<T>, timeoutMs?: number, closing: false | 'readback' | 'close' = false): Promise<T> {
    if (this.disposed || this.retired || (!closing && this.cancelled)) return Promise.reject(new Error('Browser control is unavailable'));
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) return Promise.reject(new Error('Invalid browser control timeout'));
    if (this.jobs.length + Number(!!this.running) >= MAX_QUEUE) return Promise.reject(new Error('Browser control queue is full'));
    const scope: Scope = { epoch: this.epoch, deadline: timeoutMs === undefined || closing === 'close' ? Infinity : Date.now() + timeoutMs,
      active: true, closing: !!closing, nativeInFlight: false };
    return new Promise<T>((resolve, reject) => {
      const job: Job = { scope, execute: () => work(scope), resolve: (v) => resolve(v as T), reject,
        dispatchTimeoutMs: closing === 'close' ? timeoutMs : undefined };
      if (timeoutMs !== undefined && closing !== 'close') job.timer = setTimeout(() => {
        scope.active = false;
        this.jobs = this.jobs.filter((queued) => queued !== job);
        if (scope.nativeInFlight) this.pause(new Error('Native command deadline expired; outcome is unknown'));
        reject(new Error('Browser control deadline expired'));
      }, timeoutMs);
      this.jobs.push(job);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    const job = this.jobs.shift();
    if (!job) return;
    this.running = job;
    if (!Number.isFinite(job.scope.deadline)) job.scope.deadline = Date.now() + (job.dispatchTimeoutMs ?? COMMAND_MS);
    try { job.resolve(await this.bounded(job.scope, job.execute)); }
    catch (reason) { job.reject(error(reason)); }
    finally {
      job.scope.active = false;
      clearTimeout(job.timer);
      this.running = undefined;
      void this.drain();
    }
  }

  private async native(scope: Scope, argv: string[], check?: NativeCommandCheck): Promise<RunResult> {
    let dispatched = false;
    let replaced = false;
    const effectful = !readOnlyCommand(argv);
    try {
      const result = await this.bounded(scope, async () => {
        if (check) await check();
        this.assert(scope);
        dispatched = true;
        scope.nativeInFlight = effectful;
        if (scope.owner) scope.owner.nativeInFlight = effectful;
        const result = await this.deps.run(this.binary, argv, this.remaining(scope));
        // Cancellation fences effects, but a completed unknown outcome must still
        // fence the final handoff. Results arriving after our deadline are inert.
        if (!this.disposed && scope.active && scope.owner?.active !== false && Date.now() < scope.deadline) {
          const uncertainty = uncertainNativeOutcome(result);
          if (uncertainty) throw new Error(uncertainty);
          if (!result.spawnFailed && argv[0] !== '--version') {
            const value = envelope(result);
            replaced = result.ok && value.success === true && observedBrowserReplacement(result);
            if (replaced) throw new Error('Native command replaced the browser');
          }
        }
        return result;
      });
      return result;
    } catch (reason) {
      if (dispatched && !(reason instanceof Cancelled) && (effectful || replaced)) this.pause(reason);
      throw reason;
    } finally {
      scope.nativeInFlight = false;
      if (scope.owner) scope.owner.nativeInFlight = false;
    }
  }

  private async info(scope: Scope): Promise<{ identity: DaemonIdentity; browserLaunched: boolean } | undefined> {
    const result = await this.native(scope, ['--session', this.session.sessionName, 'session', 'info', '--json']);
    const value = envelope(result);
    const data = object(value.data);
    if (!result.ok || value.success !== true || !data || data.session !== this.session.sessionName
      || (data.namespace !== null && typeof data.namespace !== 'string') || typeof data.socketDir !== 'string'
      || !path.isAbsolute(data.socketDir) || typeof data.active !== 'boolean') throw new Error('Cannot establish native daemon identity');
    if (!data.active) return undefined;
    const runtime = object(data.runtime);
    const parsedVersion = version(data.version);
    if (!Number.isSafeInteger(data.pid) || Number(data.pid) <= 0 || !parsedVersion || data.runtimeError !== null
      || !runtime || runtime.session !== data.session || runtime.namespace !== data.namespace
      || runtime.socketDir !== data.socketDir || runtime.backgroundPid !== data.pid || typeof runtime.browserLaunched !== 'boolean') {
      throw new Error('Incoherent native daemon identity');
    }
    return { identity: { session: data.session, namespace: data.namespace, socketDir: data.socketDir,
      pid: data.pid as number, version: parsedVersion }, browserLaunched: runtime.browserLaunched };
  }

  private async metadata(scope: Scope, daemon: DaemonIdentity): Promise<Ports> {
    const port = await this.bounded(scope, () => this.deps.readPort(path.join(daemon.socketDir, `${this.session.sessionName}.port`), this.remaining(scope)));
    const streamPort = await this.bounded(scope, () => this.deps.readPort(path.join(daemon.socketDir, `${this.session.sessionName}.stream`), this.remaining(scope)));
    if (!portNumber(port) || !portNumber(streamPort) || streamPort !== this.session.streamPort) throw new Error('Native session ports changed or are invalid');
    return { port, streamPort };
  }

  private sameDaemon(observed: DaemonIdentity): void {
    if (!this.daemon || JSON.stringify(observed) !== JSON.stringify(this.daemon)) throw new Error('Native daemon identity changed');
  }

  private async verifyBinary(scope: Scope, closing = false): Promise<void> {
    const binary = await this.bounded(scope, () => this.deps.fingerprint(this.binary, this.remaining(scope)));
    if (!this.binaryBaseline || binary.path !== this.binaryBaseline.path
      || (!closing && binary.identity !== this.binaryBaseline.identity)) throw new Error('Native executable changed');
  }

  private async verify(scope: Scope, closing = false): Promise<boolean> {
    await this.verifyBinary(scope, closing);
    const info = await this.info(scope);
    if (!info) {
      if (closing) return false;
      throw new Error('Original daemon is unavailable; refusing to launch a replacement');
    }
    this.sameDaemon(info.identity);
    if (this.ports) {
      const ports = await this.metadata(scope, info.identity);
      if (ports.port !== this.ports.port || ports.streamPort !== this.ports.streamPort) throw new Error('Native session ports changed');
    }
    if (!closing) {
      if (!info.browserLaunched || !this.cdpUrl || !await this.bounded(scope, () => this.deps.probeBrowser(this.cdpUrl!, this.remaining(scope)))) {
        throw new Error('Original browser endpoint is unavailable or changed');
      }
    }
    return true;
  }

  private async health(scope: Scope, closing = false): Promise<boolean> {
    try { return await this.verify(scope, closing); }
    catch (reason) { if (!(reason instanceof Cancelled)) this.pause(reason); throw reason; }
  }

  private async cdp(scope: Scope, check?: NativeCommandCheck): Promise<string> {
    const result = await this.native(scope, ['--session', this.session.sessionName, '--json', 'get', 'cdp-url'], check);
    const value = envelope(result);
    const url = object(value.data)?.cdpUrl;
    if (!result.ok || value.success !== true || hasStatus(value, 'confirmation_required') || typeof url !== 'string'
      || !/^wss?:\/\//.test(url) || observedBrowserReplacement(result)) throw new Error('Cannot establish original browser endpoint');
    return url;
  }

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = this.schedule(async (scope) => {
      this.binaryBaseline = await this.bounded(scope, () => this.deps.fingerprint(this.binary, this.remaining(scope)));
      const result = await this.native(scope, ['--version']);
      const localVersion = result.ok ? version(result.stdout) : undefined;
      const info = await this.info(scope);
      if (!info) throw new Error('Started daemon is unavailable');
      // Retain coherent daemon ownership even if subsequent Chrome capture fails.
      this.daemon = info.identity;
      if (!localVersion || localVersion !== info.identity.version) throw new Error('Native executable and daemon versions differ');
      this.ports = await this.metadata(scope, info.identity);
      if (!info.browserLaunched) throw new Error('Started browser is unavailable');
      this.cdpUrl = await this.cdp(scope);
      await this.verify(scope);
      await this.verifyBinary(scope);
      this.assert(scope);
      this.initialized = true;
    }, RECOVERY_MS).catch((reason: unknown) => { this.pause(reason); throw reason; });
    return this.initialization;
  }

  enqueue<T>(work: (run: NativeCommandRunner) => T | Promise<T>, timeoutMs?: number): Promise<T> {
    if (!this.initialized || this.message) return Promise.reject(new Error(this.message ?? 'Browser control is not initialized'));
    return this.schedule(async (scope) => {
      let running = false;
      const run: NativeCommandRunner = async (argv, budget = COMMAND_MS, check) => {
        this.assert(scope);
        if (running) throw new Error('Native commands within one work item must be awaited sequentially');
        if (!Number.isFinite(budget) || budget <= 0) throw new Error('Invalid native command timeout');
        const args = [...argv];
        if (args[0] === '--session' || args[0]?.startsWith('--session=')) throw new Error('Native session is owned by browser control');
        running = true;
        const command: Scope = { ...scope, owner: scope, deadline: Math.min(scope.deadline, Date.now() + budget) };
        try { return await this.command(command, args, check); }
        finally { command.active = false; running = false; }
      };
      const result = await work(run);
      this.assert(scope);
      return result;
    }, timeoutMs);
  }

  private async command(scope: Scope, argv: string[], check?: NativeCommandCheck): Promise<RunResult> {
    if (this.message) throw new Error(this.message);
    if (check) await this.bounded(scope, check);
    await this.health(scope);
    const result = await this.native(scope, ['--session', this.session.sessionName, '--json', ...argv], check);
    await this.health(scope);
    if (check) await this.bounded(scope, check);
    this.assert(scope);
    return completedCommandResult(result);
  }

  /** A final main-owned URL handoff may follow cancellation, but never an uncertain outcome. */
  readback(timeoutMs: number): Promise<RunResult> {
    if (!this.initialized || this.message) return Promise.reject(new Error(this.message ?? 'Browser control is not initialized'));
    return this.schedule((scope) => this.command(scope, ['get', 'url']), timeoutMs, 'readback');
  }

  resume(check?: NativeCommandCheck): Promise<void> {
    if (this.disposed || this.retired || this.cancelled) return Promise.reject(new Error('Browser control is unavailable'));
    if (!this.message) return Promise.resolve();
    if (!this.initialized) return Promise.reject(new Error('Original browser baseline is incomplete; start a new session'));
    if (this.recovery) return Promise.reject(new Error('Browser control recovery is already pending'));
    this.invalidate();
    const attempt = this.schedule(async (scope) => {
      if (check) await this.bounded(scope, check);
      await this.health(scope);
      const url = await this.cdp(scope, check);
      if (url !== this.cdpUrl) throw new Error('Native browser endpoint changed');
      await this.health(scope);
      if (check) await this.bounded(scope, check);
      this.assert(scope);
      this.message = undefined;
    }, RECOVERY_MS);
    this.recovery = attempt;
    void attempt.finally(() => { if (this.recovery === attempt) this.recovery = undefined; }).catch(() => {});
    return attempt;
  }

  /** Teardown intent survives queue wait; its budget starts when cleanup executes. */
  close(timeoutMs: number): Promise<RunResult> {
    if (this.closedResult && !this.disposed) return Promise.resolve(this.closedResult);
    if (this.closing) return this.closing;
    this.cancelPending();
    let proven = false;
    const attempt = this.schedule(async (scope) => {
      if (!await this.health(scope, true)) {
        // Inactive session info proves closure without a command that could launch a daemon.
        proven = true;
        return { ok: true, spawnFailed: false, data: null, stdout: '', stderr: '' };
      }
      const result = completedCommandResult(await this.native(scope, ['--session', this.session.sessionName, '--json', 'close']));
      if (!result.ok) return result;
      const info = await this.info(scope);
      if (info) {
        this.sameDaemon(info.identity);
        if (info.browserLaunched) throw new Error('Native close did not establish a closed browser');
      }
      this.assert(scope);
      proven = true;
      return result;
    }, timeoutMs, 'close').then((result) => {
      if (this.disposed) throw new Error('Browser control is unavailable');
      if (proven) {
        this.closedResult = result;
        this.retired = true;
        this.initialized = false;
        this.message = undefined;
      }
      return result;
    });
    this.closing = attempt;
    void attempt.finally(() => { if (this.closing === attempt) this.closing = undefined; }).catch(() => {});
    return attempt;
  }

  cancelPending(): void {
    this.cancelled = true;
    this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }
}
