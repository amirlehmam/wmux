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
 *                 descended from the pane's PTY. The catch-all: nested shells,
 *                 scripts, panes whose shell integration never loaded.
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
function sshSessionFrom(commandLine: string | undefined): DetectedSsh | null {
  if (!commandLine) return null;
  const argv = splitCommandLine(commandLine);
  if (argv.length === 0 || normalizedExecutableName(argv[0]) !== 'ssh') return null;
  return parseSshArgv(argv);
}

export class SshDetector {
  /** Layer 1: the surface was created with an ssh command as its shell. */
  private managed = new Map<string, DetectedSsh>();
  /** Layer 2: what the shell-integration preexec hook reported. */
  private reported = new Map<string, DetectedSsh>();
  /** Layer 3: what the last probe sweep found. */
  private probed = new Map<string, DetectedSsh>();

  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private idleSweeps = 0;

  constructor(private readonly source: SurfaceProcessSource) {}

  /**
   * Layer 1. Called when a surface's PTY is created, with the shell spec it was
   * requested with (`wmux ssh user@host` stores the whole command there).
   */
  setSurfaceShell(surfaceId: string, shell: string | undefined): void {
    this.record(this.managed, surfaceId, sshSessionFrom(shell));
  }

  /**
   * Layer 2. The shell-integration preexec hook reporting an ssh command line
   * the user just submitted.
   */
  reportCommand(surfaceId: string, commandLine: string): void {
    this.record(this.reported, surfaceId, sshSessionFrom(commandLine));
  }

  /**
   * The shell is back at its prompt, so whatever it was running has exited.
   * Clears layer 2 — but not layer 3, which re-derives itself from live
   * processes and would only have to rediscover a still-running ssh.
   */
  clearReported(surfaceId: string): void {
    this.reported.delete(surfaceId);
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
  }

  /**
   * The current remote session for a surface, or null when it is local.
   *
   * Synchronous and cheap by design — this is called from the paste and drop
   * paths, where any await would be felt as input lag.
   */
  detect(surfaceId: string): DetectedSsh | null {
    return this.managed.get(surfaceId)
      ?? this.reported.get(surfaceId)
      ?? this.probed.get(surfaceId)
      ?? null;
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
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    // Nothing to attribute processes to — skip the ~550ms spawn entirely rather
    // than discover the emptiness after paying for it.
    if (this.source.liveSurfaceIds().length === 0) {
      this.park();
      return;
    }
    this.sweeping = true;
    try {
      const { sshProcesses, parents } = await listSshProcesses();
      this.probed = attributeSshProcesses(sshProcesses, parents, this.source);
      if (this.probed.size === 0) this.park();
      else this.idleSweeps = 0;
    } catch {
      // A failed sweep leaves the previous result standing rather than dropping
      // a pane back to "local" on one bad query.
    } finally {
      this.sweeping = false;
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

    const session = parseSshArgv(splitCommandLine(proc.commandLine));
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
      // Flattened, so one process is always one line.
      "($_.CommandLine -replace '\\r?\\n',' ')",
    ],
    timeoutMs: SWEEP_TIMEOUT_MS,
    // ~500 processes with command lines; the default 1MB is not enough.
    maxBuffer: 8 * 1024 * 1024,
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
    // Split on the first three delimiters only — the command line is last and
    // may contain pipes of its own.
    const first = line.indexOf('|');
    const second = line.indexOf('|', first + 1);
    const third = line.indexOf('|', second + 1);
    if (first === -1 || second === -1 || third === -1) continue;

    const pid = Number.parseInt(line.slice(0, first), 10);
    const ppid = Number.parseInt(line.slice(first + 1, second), 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    parents.set(pid, ppid);

    const name = line.slice(second + 1, third).trim().toLowerCase();
    if (name !== 'ssh.exe') continue;
    const commandLine = line.slice(third + 1).trim();
    if (!commandLine) continue;
    sshProcesses.push({ pid, ppid, commandLine });
  }

  return { sshProcesses, parents };
}
