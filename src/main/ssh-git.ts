/**
 * ssh-git.ts — `git` for a workspace whose session lives on a remote host:
 * the Git view (git-view.ts), the changed-files provider
 * (diff-provider.ts) and the sidebar's branch and dirty marker.
 *
 * Both git modules reach git through ONE function, `gitCommand`. While a
 * request runs inside `runWithSshGit`, that function answers with an `ssh`
 * invocation of the same git arguments instead of a local spawn, so every
 * existing query (status, log, diff, show, worktree list…) is remote without
 * its call site knowing. The context travels in an `AsyncLocalStorage` rather
 * than a parameter because the alternative is a `location` argument threaded
 * through some forty functions in two modules, any one of which, forgotten,
 * would quietly run on the local disk.
 *
 * Rules:
 *
 * - **Read-only.** Nothing here adds a git sub-command; the modules that call
 *   `gitCommand` already run only commands that read.
 * - **No local fallback.** An unreachable remote host (ssh exit 255) is an error the
 *   caller reports, never an empty answer and never a local run. diff-provider's
 *   non-git "snapshot" fallback reads the local disk and is not reachable in
 *   remote mode.
 * - **The checkout comes from the registry, never the request.** A remote
 *   request's `cwd` is ignored: the renderer names a surface, main looks up that
 *   surface's workspace target and uses its path.
 * - **One script, values as arguments.** The remote command is
 *   `sh -c '<GIT_SCRIPT>' sh <cwd> <git args…>`, each quoted by `posixShellQuote`;
 *   the script text is a constant. The only environment forwarded is the pair
 *   below, set with `env` on the remote host.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { remoteFilePath, remoteInvocation } from './ssh-command';
import { isSpawnErrorCode, isWslRouteUnreachable, toolForSession } from './ssh-exec';
import type { SshTarget } from './ssh-targets';

/** What a view shows for an unreachable remote host. Fixed: ssh's own stderr can carry local paths. */
export const SSH_UNREACHABLE_MESSAGE = 'Could not reach the remote host over ssh';

/** `git status` takes `.git/index.lock` unless told not to, and an agent may be committing; no prompts either. */
export const GIT_SCRIPT = 'cwd=$1; shift\nexec env GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 git -C "$cwd" "$@"\n';

export interface SshGitContext {
  target: SshTarget;
  /** The ssh executable. Tests replace it; production resolves it from the session. */
  tool?: (target: SshTarget) => string;
  /** Set when a command in this context could not reach the host; see `markSshUnreachable`. */
  unreachable?: boolean;
}

const store = new AsyncLocalStorage<SshGitContext>();

/** Run `fn` with every `gitCommand` inside it going to the remote host. */
export function runWithSshGit<T>(context: SshGitContext, fn: () => T): T {
  return store.run(context, fn);
}

export function currentSshGit(): SshGitContext | undefined {
  return store.getStore();
}

/** Distinguishes two remote hosts (or checkouts) in a cache key (empty for a local cwd). */
export function sshLocationKey(context: SshGitContext | undefined = currentSshGit()): string {
  return context ? remoteFilePath(context.target, []) : '';
}

export interface SshGitCommand {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  ssh: true;
  /** ssh runs inside WSL (the target has a `wslDistro`). */
  wsl: boolean;
}

/**
 * `git <gitArgs>` run in `cwd` on the remote host. `cwd` is a remote path: the
 * checkout, or a worktree path git itself printed. Anything else is refused
 * rather than handed to `git -C`.
 */
export function sshGitCommand(context: SshGitContext, cwd: string, gitArgs: string[]): SshGitCommand {
  return sshScriptCommand(context, GIT_SCRIPT, cwd, [cwd, ...gitArgs]);
}

/**
 * Any constant script of this module's family as an ssh invocation: `cwd` is
 * the one remote path that is checked here, `args` reach the script as
 * positional arguments. `exec-git-batch.ts` runs its own script through this.
 */
export function sshScriptCommand(context: SshGitContext, script: string, cwd: string, args: string[]): SshGitCommand {
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) {
    throw new Error('Not a path on the remote host');
  }
  const invocation = remoteInvocation(
    context.target,
    script,
    args,
    (target) => (context.tool ? context.tool(target) : toolForSession(target.session, 'ssh')),
  );
  return {
    file: invocation.file,
    args: invocation.args,
    // Only needs to exist: ssh does not use it, and the remote host path is not local.
    cwd: invocation.cwd ?? process.cwd(),
    env: { ...process.env },
    ssh: true,
    wsl: invocation.viaWsl,
  };
}

/**
 * An execFile error that means the remote host was not reached rather than git
 * failing. `viaWsl` adds the statuses wsl.exe itself produces: -1 for a missing
 * distro, and an OS error code (ENOENT...) for a wsl.exe that did not start.
 */
export function isSshUnreachable(err: unknown, viaWsl = false): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code } = err as { code?: unknown };
  if (viaWsl) return (typeof code === 'number' && isWslRouteUnreachable(code, false)) || isSpawnErrorCode(code);
  return code === 255;
}

/** Note on the running context that the host could not be reached, so a swallowed error still surfaces. */
export function markSshUnreachable(): void {
  const context = currentSshGit();
  if (context) context.unreachable = true;
}
