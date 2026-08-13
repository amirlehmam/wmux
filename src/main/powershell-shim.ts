/**
 * powershell-shim.ts — Decide whether PowerShell can be given a .ps1 shim for
 * `wmux` (issue #154).
 *
 * The bug: wmux prepends its cli-bin dir to PATH, PowerShell resolves `wmux` to
 * `wmux.cmd` there, and a .cmd puts cmd.exe's parser between the caller and the
 * CLI. PowerShell strips the user's quoting when invoking a batch file, so any
 * `>`, `|`, `&` or `<` inside free-form text is re-read as shell syntax —
 * `wmux browser eval "document.title.length>0"` silently redirects its own
 * output into a file named `0`, and `wmux send "npm run build > out.log"` sends
 * different text than the user typed. The redirect is applied to cmd.exe's
 * invocation line BEFORE wmux.cmd runs, so nothing inside the batch file can
 * recover the arguments; only keeping cmd.exe off the path can.
 *
 * The fix is a wmux.ps1, which PowerShell resolves ahead of every PATHEXT entry
 * and which passes `@args` through natively. The catch is that a .ps1 PowerShell
 * refuses to run is a hard error with NO fallback to the .cmd sitting next to
 * it — and two ordinary conditions cause exactly that:
 *
 *   - Execution policy. Restricted is the Windows PowerShell 5.1 default on
 *     client Windows and blocks every script, signed or not.
 *   - Mark of the Web. Files extracted from a downloaded zip carry a
 *     :Zone.Identifier stream, which the (pwsh default) RemoteSigned policy
 *     treats as remote and unsigned. wmux is not code-signed by a trusted CA.
 *
 * Shipping the shim unconditionally would trade a silent wrong result for a
 * `wmux` that does not run at all. So wmux verifies instead of assuming: strip
 * the Mark of the Web where it can, then actually execute a probe script from
 * the shim's own directory in each installed PowerShell host. Only if the probe
 * prints its marker is the dir put on PATH. Anything else and PowerShell keeps
 * resolving wmux.cmd, exactly as before.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

export const SHIM_PROBE_MARKER = 'wmux-shim-ok';

/** PowerShell hosts whose resolution of `wmux` the shim would change. */
export const POWERSHELL_HOSTS = ['powershell.exe', 'pwsh.exe'];

export type ProbeOutcome =
  /** Host is not installed here — it cannot be broken by the shim. */
  | { status: 'missing' }
  /** Host ran and printed something. */
  | { status: 'ran'; stdout: string };

export interface ShimProbeDeps {
  hosts: string[];
  run: (exe: string, script: string) => Promise<ProbeOutcome>;
}

/**
 * May the shim dir go on PATH?
 *
 * Every installed host must run the probe successfully — one that refuses is
 * one where `wmux` would stop working, and a user's panes and their children do
 * not all use the same host. Absent hosts do not vote. No host at all (a machine
 * with no PowerShell, or a probe we could not run) means no, since the shim
 * would then be unverified rather than merely unused.
 */
export async function probePowerShellShim(dir: string, deps: ShimProbeDeps): Promise<boolean> {
  const script = path.join(dir, 'wmux-shim-probe.ps1');
  let confirmed = 0;
  for (const host of deps.hosts) {
    const outcome = await deps.run(host, script);
    if (outcome.status === 'missing') continue;
    if (!outcome.stdout.includes(SHIM_PROBE_MARKER)) return false;
    confirmed++;
  }
  return confirmed > 0;
}

/**
 * Drop the NTFS stream that marks a file as downloaded.
 *
 * Best effort by design: an install dir we cannot write to just means the probe
 * below fails and the shim stays off PATH.
 */
export function stripMarkOfTheWeb(file: string): void {
  try {
    fs.rmSync(`${file}:Zone.Identifier`, { force: true });
  } catch {
    // No stream, no permission, or not NTFS — all equally fine.
  }
}

/**
 * Run the probe script in one host.
 *
 * `-NoProfile` keeps a user profile from printing over the marker.
 * `PSExecutionPolicyPreference` is cleared because wmux itself may have been
 * started from a shell running under `-ExecutionPolicy Bypass` (its own panes
 * are), and inheriting that would make the probe pass for a machine where a
 * fresh PowerShell would refuse the shim.
 */
function runProbe(exe: string, script: string): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.PSExecutionPolicyPreference;
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-File', script],
      { env, timeout: 10000, windowsHide: true },
      (err: any, stdout) => {
        if (err && (err.code === 'ENOENT' || err.code === 127)) { resolve({ status: 'missing' }); return; }
        resolve({ status: 'ran', stdout: String(stdout ?? '') });
      },
    );
  });
}

/** Dir holding wmux.ps1 — packaged next to cli-bin, kept separate so it can be left off PATH. */
export function getPsShimPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) return path.join(process.resourcesPath, 'cli-bin-ps');
  } catch {
    // Not running in Electron.
  }
  return path.join(__dirname, '../../src/cli-bin-ps');
}

let shimDir: string | null = null;
let inFlight: Promise<boolean> | null = null;

/**
 * Verify the shim once per run, then remember the answer.
 *
 * Started as early as possible in main so it resolves before the renderer asks
 * for its first PTY. A pane that wins that race simply gets today's behaviour;
 * the answer is not worth blocking startup for.
 */
export function ensurePowerShellShim(dir = getPsShimPath()): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (!fs.existsSync(path.join(dir, 'wmux.ps1'))) return false;
    for (const file of ['wmux.ps1', 'wmux-shim-probe.ps1']) stripMarkOfTheWeb(path.join(dir, file));
    const ok = await probePowerShellShim(dir, { hosts: POWERSHELL_HOSTS, run: runProbe });
    shimDir = ok ? dir : null;
    console.log(
      ok
        ? `[wmux] PowerShell shim enabled: ${dir}`
        : '[wmux] PowerShell shim disabled (execution policy or Mark of the Web) — falling back to wmux.cmd',
    );
    return ok;
  })();
  return inFlight;
}

/** The dir to prepend to a spawned shell's PATH, or null while unverified/refused. */
export function powerShellShimDir(): string | null {
  return shimDir;
}
