/**
 * ssh-detect.ts — decide whether a terminal surface is currently sitting inside
 * an interactive ssh session, and to which host.
 *
 * Three sources feed one per-surface cache, in precedence order:
 *
 *   1. Managed  — the surface was created by `wmux ssh user@host`, so its
 *                 `shell` string IS the ssh command line. Authoritative, free.
 *   2. Reported — the shell-integration preexec hook told us the user just ran
 *                 an ssh command. Instant, covers the typed `ssh host` case,
 *                 cleared when the shell returns to its prompt.
 *   3. Probed   — a background `Win32_Process` sweep finds an `ssh.exe`
 *                 descended from the pane's PTY. Windows cannot tell whether
 *                 that process owns the foreground, so this source may only
 *                 corroborate one of the two authoritative sources above.
 *
 * (1) and (3) are the two sources cmux has — its `.workspaceRemote` and its
 * `ps -t <tty>` foreground probe. (2) has no cmux counterpart and exists purely
 * because of a platform difference: on macOS `ps` answers in milliseconds, so
 * cmux can afford to probe at paste time. On Windows the only way to read
 * another process's command line from Node is a PowerShell CIM query costing
 * ~550ms, so (1) and (2) are latency caches over (3).
 */

import { parseSshArgv, splitCommandLine, normalizedExecutableName, type DetectedSsh } from './ssh-argv';
import { queryWin32Processes } from './win32-process';
import * as path from 'path';

export type { DetectedSsh };

/** How often the background probe sweeps while it is running. */
const SWEEP_INTERVAL_MS = 3_000;
/**
 * Generous, for the same reason `pty-ledger.ts` is generous: a cold PowerShell
 * 5.1 pulling in .NET and the CIM assemblies can take a long time on the first
 * call. Timing out means detecting nothing, which is the case this exists for.
 */
const SWEEP_TIMEOUT_MS = 20_000;
/**
 * Consecutive sweeps that find no ssh at all before the probe parks itself.
 *
 * Without this the interval runs for the life of the app once anything triggers
 * it — a ~550ms PowerShell spawn every 3s forever, on a machine where the user
 * may have closed every ssh pane hours ago. `detect()` restarts it, so the cost
 * of parking is at most one stale answer on the next paste, which the managed
 * and reported layers already cover for the panes that matter.
 */
const IDLE_SWEEPS_BEFORE_PARK = 5;

/** One `ssh.exe` seen by the probe. */
export interface SshProcess {
  pid: number;
  ppid: number;
  executablePath?: string;
  commandLine: string;
}

/** A probe sweep's raw output: the ssh processes, and the whole pid -> ppid tree. */
export interface ProcessSnapshot {
  sshProcesses: SshProcess[];
  /** Every pid on the machine, so the ancestry walk can cross non-ssh shells. */
  parents: Map<number, number>;
}

/** What `ssh-detect` needs to know about the surfaces it is tracking. */
export interface SurfaceProcessSource {
  /** Root PTY pid for a surface, or undefined when it has no live shell. */
  getPid(surfaceId: string): number | undefined;
  /** Every surface id with a live PTY. */
  liveSurfaceIds(): string[];
}

/** Parse a command line into an ssh session, or null when it is not one. */
function trustedWindowsCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const trimmed = cwd.trim();
  // Git Bash's `pwd` uses /c/foo. WSL's /mnt/c/foo deliberately does not match.
  const msys = /^\/([A-Za-z])(?:\/(.*))?$/.exec(trimmed);
  if (msys) return `${msys[1].toUpperCase()}:\\${(msys[2] ?? '').replace(/\//g, '\\')}`;
  return /^[A-Za-z]:[\\/]|^\\\\/.test(trimmed) && path.win32.isAbsolute(trimmed)
    ? trimmed
    : undefined;
}

function sshSessionFrom(
  commandLine: string | undefined,
  context: { executable?: string; cwd?: string } = {},
): DetectedSsh | null {
  if (!commandLine) return null;
  const argv = splitCommandLine(commandLine);
  if (argv.length === 0 || normalizedExecutableName(argv[0]) !== 'ssh') return null;
  const session = parseSshArgv(argv);
  if (!session) return null;
  if (context.executable && normalizedExecutableName(context.executable) === 'ssh') {
    session.sshExecutable = context.executable;
  }
  session.workingDirectory = trustedWindowsCwd(context.cwd);
  return session;
}

function mergeProcessFacts(primary: DetectedSsh, probed: DetectedSsh | undefined): DetectedSsh {
  if (!probed || primary.destination !== probed.destination) return primary;
  return {
    ...primary,
    sshExecutable: primary.sshExecutable ?? probed.sshExecutable,
    workingDirectory: primary.workingDirectory ?? probed.workingDirectory,
  };
}

function sequenceFrom(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const match = /^seq=(\d+)$/.exec(value ?? '');
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export class SshDetector {
  /** Layer 1: the surface was created with an ssh command as its shell. */
  private managed = new Map<string, DetectedSsh>();
  /** Layer 2: what the shell-integration preexec hook reported. */
  private reported = new Map<string, DetectedSsh>();
  /** Layer 3: what the last probe sweep found. */
  private probed = new Map<string, DetectedSsh>();
  private cwd = new Map<string, string>();
  private generations = new Map<string, number>();
  private lastSequence = new Map<string, number>();

  private timer: NodeJS.Timeout | null = null;
  private sweepPromise: Promise<boolean> | null = null;
  private idleSweeps = 0;

  constructor(
    private readonly source: SurfaceProcessSource,
    private readonly processList: () => Promise<ProcessSnapshot> = listSshProcesses,
  ) {}

  private bump(surfaceId: string): number {
    const generation = (this.generations.get(surfaceId) ?? 0) + 1;
    this.generations.set(surfaceId, generation);
    return generation;
  }

  private acceptSequence(surfaceId: string, value: string | number | undefined): boolean {
    const sequence = sequenceFrom(value);
    if (sequence === undefined) return true; // Backward-compatible legacy report.
    const previous = this.lastSequence.get(surfaceId);
    if (previous !== undefined && sequence <= previous) return false;
    this.lastSequence.set(surfaceId, sequence);
    return true;
  }

  /**
   * Layer 1. Called when a surface's PTY is created, with the shell spec it was
   * requested with (`wmux ssh user@host` stores the whole command there).
   */
  setSurfaceShell(
    surfaceId: string,
    shell: string | undefined,
    executable?: string,
    cwd?: string,
  ): void {
    this.lastSequence.delete(surfaceId);
    this.bump(surfaceId);
    this.record(this.managed, surfaceId, sshSessionFrom(shell, { executable, cwd }));
  }

  /** Latest local prompt cwd, used by child scp/ssh for relative connection files. */
  reportCwd(surfaceId: string, cwd: string): void {
    const trusted = trustedWindowsCwd(cwd);
    if (trusted) this.cwd.set(surfaceId, trusted);
    else this.cwd.delete(surfaceId);
  }

  /**
   * Layer 2. The shell-integration preexec hook reporting an ssh command line
   * the user just submitted.
   */
  reportCommand(surfaceId: string, commandLine: string): void {
    const sequenced = /^(seq=\d+)\s+(.*)$/s.exec(commandLine);
    if (sequenced && !this.acceptSequence(surfaceId, sequenced[1])) return;
    const raw = sequenced ? sequenced[2] : commandLine;
    this.bump(surfaceId);
    this.record(this.reported, surfaceId, sshSessionFrom(raw, { cwd: this.cwd.get(surfaceId) }));
  }

  /**
   * The shell is back at its prompt, so whatever it was running has exited.
   * Clears layer 2 — but not layer 3, which re-derives itself from live
   * processes and would only have to rediscover a still-running ssh.
   */
  clearReported(surfaceId: string, sequence?: string | number): void {
    if (!this.acceptSequence(surfaceId, sequence)) return;
    this.bump(surfaceId);
    this.reported.delete(surfaceId);
    this.probed.delete(surfaceId);
  }

  /**
   * Store a layer's answer for a surface, or drop it when there is none.
   *
   * Deleting rather than storing null matters: a stale "was ssh, now isn't"
   * entry would keep offering uploads to a host the pane has left.
   */
  private record(
    layer: Map<string, DetectedSsh>,
    surfaceId: string,
    session: DetectedSsh | null
  ): void {
    if (session) layer.set(surfaceId, session);
    else layer.delete(surfaceId);
  }

  /** A surface went away. */
  forget(surfaceId: string): void {
    this.managed.delete(surfaceId);
    this.reported.delete(surfaceId);
    this.probed.delete(surfaceId);
    this.cwd.delete(surfaceId);
    this.generations.delete(surfaceId);
    this.lastSequence.delete(surfaceId);
  }

  /**
   * The current remote session for a surface, or null when it is local.
   *
   * Synchronous and cheap by design — this is called from the paste and drop
   * paths, where any await would be felt as input lag.
   */
  detect(surfaceId: string): DetectedSsh | null {
    const probe = this.probed.get(surfaceId);
    const managed = this.managed.get(surfaceId);
    const reported = this.reported.get(surfaceId);
    // A report for a different host while a managed outer ssh is active is the
    // observable nested-ssh case. The inner client runs remotely and cannot be
    // reproduced safely from Windows, so block instead of uploading to either.
    if (managed && reported && managed.destination !== reported.destination) return null;
    const primary = reported ?? managed;
    return primary ? mergeProcessFacts(primary, probe) : null;
  }

  /** Destination evidence used to distinguish a local pane from an unsafe remote ambiguity. */
  remoteHint(surfaceId: string): string | null {
    return this.reported.get(surfaceId)?.destination
      ?? this.managed.get(surfaceId)?.destination
      ?? null;
  }

  /** Await one deduplicated fresh process snapshot, then return the current answer. */
  async refresh(surfaceId: string): Promise<DetectedSsh | null> {
    const succeeded = await this.sweep();
    const managed = this.managed.get(surfaceId);
    const reported = this.reported.get(surfaceId);
    const probe = this.probed.get(surfaceId);
    if (!succeeded) {
      const explicit = reported ?? managed;
      return explicit?.sshExecutable ? explicit : null;
    }
    if (managed) return this.detect(surfaceId);
    if (reported) {
      if (probe?.destination === reported.destination) return mergeProcessFacts(reported, probe);
      return reported.sshExecutable ? reported : null;
    }
    // Windows exposes ancestry but no tty foreground process group. A detached
    // `ssh host` remains below the pane's PTY root after the local prompt has
    // returned, so probe-only evidence could upload a file to a background
    // host. It may enrich a reported/managed answer, never establish one.
    return null;
  }

  /**
   * Begin (or resume) the background probe. Idempotent, so calling it whenever
   * a pane might have become remote is fine.
   */
  start(): void {
    this.idleSweeps = 0;
    if (this.timer) return;
    void this.sweep();
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Park the probe. Called on app shutdown and when nothing remote is running. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One probe pass: list every ssh.exe, attribute each to a surface. */
  private sweep(): Promise<boolean> {
    if (this.sweepPromise) return this.sweepPromise;
    this.sweepPromise = this.runSweep().finally(() => {
      this.sweepPromise = null;
    });
    return this.sweepPromise;
  }

  private async runSweep(): Promise<boolean> {
    // Nothing to attribute processes to — skip the ~550ms spawn entirely rather
    // than discover the emptiness after paying for it.
    if (this.source.liveSurfaceIds().length === 0) {
      this.park();
      return true;
    }
    try {
      const surfaceIds = this.source.liveSurfaceIds();
      const generations = new Map(surfaceIds.map((id) => [id, this.generations.get(id) ?? 0]));
      const { sshProcesses, parents } = await this.processList();
      const found = attributeSshProcesses(sshProcesses, parents, this.source);
      for (const surfaceId of surfaceIds) {
        // A prompt/command report that arrived during CIM wins over the stale snapshot.
        if ((this.generations.get(surfaceId) ?? 0) !== generations.get(surfaceId)) continue;
        const session = found.get(surfaceId);
        if (session) this.probed.set(surfaceId, session);
        else this.probed.delete(surfaceId);
      }
      if (this.probed.size === 0) this.park();
      else this.idleSweeps = 0;
      return true;
    } catch {
      // A failed sweep leaves the previous result standing rather than dropping
      // a pane back to "local" on one bad query.
      return false;
    }
  }

  /** Stop sweeping once enough consecutive passes have found nothing. */
  private park(): void {
    this.idleSweeps += 1;
    if (this.idleSweeps >= IDLE_SWEEPS_BEFORE_PARK) this.stop();
  }
}

/**
 * Map each `ssh.exe` onto the surface whose PTY subtree contains it.
 *
 * Windows has no process groups and no `tpgid`, so cmux's "is this the
 * foreground process on the tty" test has no direct equivalent. The substitute
 * is ancestry: an `ssh.exe` descended from a pane's PTY root is that pane's.
 * When a pane somehow has more than one, the deepest wins — that is the
 * innermost session, which is the one the user is typing into.
 */
export function attributeSshProcesses(
  processes: SshProcess[],
  parents: Map<number, number>,
  source: SurfaceProcessSource
): Map<string, DetectedSsh> {
  const result = new Map<string, DetectedSsh>();
  if (processes.length === 0) return result;

  // Reverse index of pid -> surface, for the PTY roots we care about.
  const rootToSurface = new Map<number, string>();
  for (const surfaceId of source.liveSurfaceIds()) {
    const pid = source.getPid(surfaceId);
    if (typeof pid === 'number' && pid > 0) rootToSurface.set(pid, surfaceId);
  }
  if (rootToSurface.size === 0) return result;

  const depthBySurface = new Map<string, number>();

  for (const proc of processes) {
    // Walk up to a PTY root, starting AT the ssh itself.
    //
    // Starting at the parent would miss the commonest managed case: `wmux ssh`
    // spawns ssh as the pane's own shell, so the PTY root pid *is* the ssh pid
    // and it is its own owner at depth 0.
    //
    // `seen` guards against a pid-reuse cycle in a stale table rather than a
    // real one; `depth` doubles as the deepest-wins ranking value.
    let depth = 0;
    let current = proc.pid;
    const seen = new Set<number>();
    let surfaceId: string | undefined;

    while (current > 0 && depth < 64 && !seen.has(current)) {
      seen.add(current);
      const owner = rootToSurface.get(current);
      if (owner) {
        surfaceId = owner;
        break;
      }
      const parent = parents.get(current);
      if (parent === undefined) break;
      current = parent;
      depth += 1;
    }

    if (!surfaceId) continue;
    const previousDepth = depthBySurface.get(surfaceId);
    if (previousDepth !== undefined && previousDepth >= depth) continue;

    const session = sshSessionFrom(proc.commandLine, { executable: proc.executablePath });
    if (!session) continue;
    depthBySurface.set(surfaceId, depth);
    result.set(surfaceId, session);
  }

  return result;
}

/**
 * Enumerate every `ssh.exe` plus a full pid -> ppid table, in one PowerShell
 * round trip. Two queries would double the cold-start cost, which is the entire
 * expense of this probe.
 *
 * Follows the `execFile` + PowerShell shape already established in
 * `pty-ledger.ts`: absolute interpreter path, `-NoProfile -NonInteractive`,
 * `windowsHide`, and every failure resolving to "found nothing" rather than
 * throwing.
 */
export async function listSshProcesses(): Promise<ProcessSnapshot> {
  const stdout = await queryWin32Processes({
    // Every process, not just ssh.exe: the ancestry walk has to cross the
    // shells in between, and a second query for those would double the cost
    // that is the whole expense of this probe.
    fields: [
      '$_.ProcessId',
      '$_.ParentProcessId',
      '$_.Name',
      '$_.ExecutablePath',
      // Flattened, so one process is always one line.
      "($_.CommandLine -replace '\\r?\\n',' ')",
    ],
    timeoutMs: SWEEP_TIMEOUT_MS,
    // ~500 processes with command lines; the default 1MB is not enough.
    maxBuffer: 8 * 1024 * 1024,
    rejectOnFailure: true,
  });
  return parseProcessTable(stdout);
}

/**
 * Parse the probe's output into the ssh list plus the pid -> ppid table.
 *
 * Exported for tests, which is also why the parsing is separated from the
 * spawning. Pure: everything it learns is in its return value.
 */
export function parseProcessTable(stdout: string): ProcessSnapshot {
  const sshProcesses: SshProcess[] = [];
  const parents = new Map<number, number>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Split on the first four delimiters only — the command line is last and
    // may contain pipes of its own.
    const first = line.indexOf('|');
    const second = line.indexOf('|', first + 1);
    const third = line.indexOf('|', second + 1);
    const fourth = line.indexOf('|', third + 1);
    if (first === -1 || second === -1 || third === -1 || fourth === -1) continue;

    const pid = Number.parseInt(line.slice(0, first), 10);
    const ppid = Number.parseInt(line.slice(first + 1, second), 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    parents.set(pid, ppid);

    const name = line.slice(second + 1, third).trim().toLowerCase();
    if (name !== 'ssh.exe') continue;
    const executablePath = line.slice(third + 1, fourth).trim() || undefined;
    const commandLine = line.slice(fourth + 1).trim();
    if (!commandLine) continue;
    sshProcesses.push({ pid, ppid, executablePath, commandLine });
  }

  return { sshProcesses, parents };
}
