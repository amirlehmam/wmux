/**
 * Windows path → a path the `bash` on PATH can actually open.
 *
 * `path.resolve()` on native Windows yields `C:\dev\wmux\…`. Handing that to
 * bash loses the separators (bash reads `\d` as an escape), so the script
 * arrives as `C:devwmux…` and is never found — which is why the orchestrator
 * suites could not run on the platform wmux ships for.
 *
 * There is no single right answer: Git Bash mounts the drive at `/c`, WSL at
 * `/mnt/c`, Cygwin at `/cygdrive/c`. Rather than guess which bash is installed,
 * we generate every spelling and let the caller probe with the bash that is
 * actually on PATH (`bashExists` below).
 */
import { spawnSync } from 'node:child_process';

/** Every spelling of `p` a bash flavour might mount, most likely first. */
export function bashPathCandidates(p: string): string[] {
  const slashed = p.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(slashed);
  if (!drive) return [slashed];
  const letter = drive[1].toLowerCase();
  const rest = drive[2];
  return [`/${letter}/${rest}`, `/mnt/${letter}/${rest}`, `/cygdrive/${letter}/${rest}`];
}

/**
 * First candidate spelling `exists` accepts, else the first candidate.
 *
 * Order matters beyond mere likelihood: Git Bash (`/c`) is preferred because it
 * runs in the Windows process tree and can execute the `node` the scripts call,
 * whereas WSL bash would need a second toolchain installed inside the distro.
 */
export function toBashPath(p: string, exists: (candidate: string) => boolean): string {
  const candidates = bashPathCandidates(p);
  if (candidates.length === 1) return candidates[0];
  return candidates.find(exists) ?? candidates[0];
}

/** True when `candidate` names an existing path to the bash on PATH. */
export function bashExists(candidate: string): boolean {
  const probe = spawnSync('bash', ['-c', 'test -e "$1"', 'bash', candidate], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

/** True when a usable bash is on PATH at all (Windows boxes without Git for Windows have none). */
export function hasBash(): boolean {
  const probe = spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

/** Convenience: `toBashPath` bound to the real bash probe. */
export function forBash(p: string): string {
  return toBashPath(p, bashExists);
}
