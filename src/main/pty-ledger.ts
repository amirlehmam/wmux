/**
 * Orphan reaping across an abnormal wmux death (issue #139).
 *
 * `PtyManager.kill()` already tree-kills a pane's whole subtree with
 * `taskkill /T /F` (issue #65) — Claude Code's backend and the MCP servers it
 * spawns are grandchildren that do not share the pseudoconsole's lifetime, so
 * nothing else reaps them. But every caller of that path requires wmux to be
 * alive and cooperating: closing a pane, or `killAll()` on `will-quit`.
 *
 * A native crash reaches none of them, and Windows does not tear down a process
 * tree when the root dies — descendants are reparented and keep running. So a
 * crashed wmux leaves every pane's shell, its agent, and each of that agent's
 * MCP servers resident. Restarting restores the session and spawns a fresh set
 * beside them; a crash-loop multiplies rather than replaces (the reporter saw
 * 251 processes / 3.3 GB across six crash cycles).
 *
 * The fix is a ledger of spawned PIDs on disk. The next launch takes it over,
 * and anything the dead instance left behind is tree-killed.
 *
 * ── On not killing the wrong process ──────────────────────────────────────
 * Windows recycles PIDs, and this runs `taskkill /T /F`, so a stale ledger
 * entry whose PID has since been reused would kill an unrelated process *and
 * its children*. A recorded PID being alive is therefore NOT sufficient
 * evidence that it is ours. Before killing anything we re-query the live
 * process and require its image name and creation time to match what we
 * recorded. Every failure — no PowerShell, a query error, unparseable output —
 * reaps nothing. Leaking a process is recoverable; killing the user's editor
 * is not.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** One spawned PTY root, as recorded at spawn time. */
export interface LedgerEntry {
  pid: number;
  /** Image file name (`pwsh.exe`), re-checked before killing. */
  image: string;
  /** Epoch ms, stamped immediately after `pty.spawn` returned. */
  startedAt: number;
}

interface LedgerFile {
  ownerPid: number;
  entries: LedgerEntry[];
}

/** A live process as reported by Win32_Process. */
export interface LiveProcess {
  pid: number;
  image: string;
  /** Epoch ms of the real process creation time. */
  startedAt: number;
}

/**
 * How far a live process's creation time may sit from the recorded `startedAt`
 * and still count as the same process.
 *
 * `startedAt` is stamped microseconds after `pty.spawn` returns, so a genuine
 * match is near-exact and this window only absorbs clock skew. It is not a
 * fuzzy match: a recycled PID would have to be reborn under the same image
 * name within a minute of the original to slip through both checks.
 */
export const REUSE_TOLERANCE_MS = 60_000;

/** Ledger entries beyond this are dropped — a file this large is corrupt, not real. */
const MAX_ENTRIES = 512;

/**
 * The PIDs from `entries` that are still alive AND still the process we
 * recorded. Pure, because this is the decision that force-kills process trees:
 * everything it needs is passed in, so the safety rules are testable without
 * spawning anything.
 */
export function selectOrphans(entries: LedgerEntry[], live: LiveProcess[]): number[] {
  const byPid = new Map(live.map((p) => [p.pid, p]));
  const orphans: number[] = [];
  for (const entry of entries) {
    const found = byPid.get(entry.pid);
    if (!found) continue; // already gone — the common case
    // A recycled PID. Either check failing is enough to disqualify it.
    if (found.image.toLowerCase() !== entry.image.toLowerCase()) continue;
    if (Math.abs(found.startedAt - entry.startedAt) > REUSE_TOLERANCE_MS) continue;
    orphans.push(entry.pid);
  }
  return orphans;
}

/** Drop anything that isn't a well-formed entry — the file is user-writable. */
export function parseEntries(raw: unknown): LedgerEntry[] {
  const entries = (raw as LedgerFile | null)?.entries;
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(
      (e): e is LedgerEntry =>
        !!e &&
        typeof e.pid === 'number' &&
        Number.isInteger(e.pid) &&
        e.pid > 0 &&
        typeof e.image === 'string' &&
        e.image.length > 0 &&
        typeof e.startedAt === 'number' &&
        Number.isFinite(e.startedAt),
    )
    .slice(0, MAX_ENTRIES);
}

function systemRoot(): string {
  return process.env.SystemRoot || process.env.windir || 'C:\\Windows';
}

/**
 * Creation time + image name for the given PIDs.
 *
 * PowerShell rather than `wmic`, which is being removed from Windows, and
 * resolved by absolute path rather than through PATH for the same reason
 * `PtyManager.kill()` resolves taskkill that way — a writeable directory on
 * PATH must not be able to shadow it. The command deliberately contains no
 * double quotes so nothing depends on how execFile escapes the argument.
 *
 * Returns [] on any failure, which reaps nothing.
 */
export const PROBE_TIMEOUT_MS = 60_000;

export function queryProcesses(pids: number[]): Promise<LiveProcess[]> {
  if (pids.length === 0) return Promise.resolve([]);
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(' or ');
  const script =
    `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { ` +
    `Write-Output ('{0}|{1}|{2}' -f $_.ProcessId,$_.Name,` +
    `[int64]($_.CreationDate.ToUniversalTime()-[datetime]'1970-01-01').TotalMilliseconds) }`;
  const shell = path.join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  return new Promise((resolve) => {
    execFile(
      shell,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      // Generous, because this runs once at startup and off the critical path.
      // The moment it matters most — the first scan after a crash-loop — is
      // also the coldest the machine will be, and a cold PowerShell 5.1 pulling
      // in .NET and the CIM assemblies can take well past 15s. Timing out there
      // means reaping nothing, which is precisely the case this exists for.
      { windowsHide: true, timeout: PROBE_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          const cause = (err as NodeJS.ErrnoException & { killed?: boolean }).killed
            ? `timed out after ${PROBE_TIMEOUT_MS}ms`
            : (stderr || '').trim() || err.message;
          console.warn('[wmux] orphan scan failed, reaping nothing:', cause);
          resolve([]);
          return;
        }
        resolve(parseProcessLines(stdout));
      },
    );
  });
}

/** Parse the `pid|image|epochMs` lines emitted by queryProcesses. */
export function parseProcessLines(stdout: string): LiveProcess[] {
  const live: LiveProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split('|');
    if (parts.length !== 3) continue;
    const pid = Number(parts[0]);
    const startedAt = Number(parts[2]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(startedAt) || !parts[1]) continue;
    live.push({ pid, image: parts[1], startedAt });
  }
  return live;
}

/** Force-kill a PID and everything below it. Same invocation as PtyManager.kill(). */
function treeKill(pid: number): void {
  try {
    const taskkill = path.join(systemRoot(), 'System32', 'taskkill.exe');
    const killer = execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    killer.on('error', () => {
      /* taskkill missing, or the tree died between the scan and now */
    });
  } catch {
    /* spawn failed — nothing further to try */
  }
}

/**
 * The on-disk record of what this instance has spawned.
 *
 * Writes are synchronous and whole-file: the list is at most a few dozen
 * entries, and the write has to have landed before the process can crash for
 * the ledger to be worth anything.
 */
export class PtyLedger {
  private entries: LedgerEntry[] = [];
  private enabled = true;

  constructor(private readonly filePath: string) {}

  /**
   * Claim the ledger for this process and return what the previous owner left
   * behind — candidates only; `selectOrphans` still has to clear them.
   *
   * Returns [] when the recorded owner is still running: those processes have
   * a live parent and are not orphans at all. The single-instance lock makes
   * that near-impossible, but "kill the other instance's terminals" is a bad
   * enough outcome to check for explicitly.
   */
  takeOver(): LedgerEntry[] {
    let previous: LedgerEntry[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      const ownerPid = Number(raw?.ownerPid);
      previous = ownerPid && ownerPid !== process.pid && isAlive(ownerPid) ? [] : parseEntries(raw);
    } catch {
      // No ledger, or an unreadable one. Either way there is nothing to reap.
    }
    this.flush();
    return previous;
  }

  add(pid: number, image: string): void {
    if (!this.enabled) return;
    this.entries.push({ pid, image, startedAt: Date.now() });
    this.flush();
  }

  remove(pid: number): void {
    if (!this.enabled) return;
    const next = this.entries.filter((e) => e.pid !== pid);
    if (next.length === this.entries.length) return; // not ours / already gone
    this.entries = next;
    this.flush();
  }

  /** Everything was just killed — one write instead of one per PID. */
  clear(): void {
    if (!this.enabled || this.entries.length === 0) return;
    this.entries = [];
    this.flush();
  }

  private flush(): void {
    const payload: LedgerFile = { ownerPid: process.pid, entries: this.entries };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(payload), 'utf-8');
    } catch (err) {
      // A ledger we cannot write is a ledger we must not read next launch, or
      // we would reap against a stale list. Go inert rather than half-correct.
      this.enabled = false;
      console.warn('[wmux] PTY ledger disabled (write failed):', (err as Error).message);
    }
  }
}

/** Whether a PID is currently running. Signal 0 tests without delivering. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Reap what a previously crashed instance left running.
 *
 * Best-effort and fire-and-forget: the orphans are unrelated to the PTYs this
 * launch is about to spawn, so nothing needs to wait on it, and startup must
 * not block on a PowerShell round-trip.
 */
export async function reapOrphans(candidates: LedgerEntry[]): Promise<number[]> {
  if (process.platform !== 'win32' || candidates.length === 0) return [];
  const live = await queryProcesses(candidates.map((e) => e.pid));
  const orphans = selectOrphans(candidates, live);
  if (orphans.length === 0) return [];
  console.warn(`[wmux] reaping ${orphans.length} process tree(s) orphaned by a previous crash (issue #139)`);
  for (const pid of orphans) treeKill(pid);
  return orphans;
}
