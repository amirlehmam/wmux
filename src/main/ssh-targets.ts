/**
 * ssh-targets.ts — where a workspace's session really lives.
 *
 * `wmux set-ssh-target` / `clear-ssh-target` (V2 `workspace.set_ssh_target`) are
 * called by an external script or integration that started or attached a
 * Claude Code session on a remote host: the pane shows an ssh session, but the files the
 * agent changes are on the remote host. This module owns the one registry that says
 * so, keyed by WORKSPACE id (a surface is mapped to its workspace by asking the
 * renderer, the way `__wmux_locateSurface` does everywhere else).
 *
 * Rules for code that reads the registry:
 *
 * - **In memory only.** Never written to session.json or settings: a target is
 *   set again by the caller on every launch or attach, and a stale one that
 *   survived a restart would point a view at the wrong host.
 * - **Workspace without a target = local behaviour.** A reader that finds
 *   nothing here acts exactly as it does for a local workspace.
 * - **The argv is never run through a shell and never executed as given.** It is
 *   funnelled through `parseSshArgv` (the one funnel for every ssh source), and
 *   only the parsed connection facts are used to build a new ssh command.
 *
 * The RPC, as `workspace-indicator-rpc.ts`: every window is asked in turn (a
 * workspace is not a window) and a miss is an error, never `{ ok: true }`,
 * so a caller outside wmux learns that its call changed nothing.
 */

import { normalizedExecutableName, optionKey, parseSshArgv, type DetectedSsh } from './ssh-argv';
import { releaseExecWorkers } from './exec-worker';
import { isWslDistroName, MAX_WSL_DISTRO_LENGTH } from '../shared/wsl-distro';

/** What a view needs to reach the checkout: how to connect, and where it is. */
export interface SshTarget {
  /** Parsed from the pushed argv; see `parseSshArgv`. */
  session: DetectedSsh;
  /** Absolute, normalised path of the checkout on the remote host (no trailing slash). */
  path: string;
  /**
   * When set, ssh runs INSIDE this WSL distro (`wsl.exe -d <distro> --exec ssh`),
   * because the key and the pinned known_hosts the pushed argv names live there.
   * Absent: the host's own ssh (see `ssh-exec.ts`, `wslSshArgs`).
   */
  wslDistro?: string;
}

export interface SetSshTargetParams {
  workspaceId?: string;
  /** The calling shell's surface, added by the CLI from `WMUX_SURFACE_ID`. */
  caller?: string;
  /** The ssh command as separate arguments. Empty or absent clears the target. */
  argv?: unknown;
  path?: unknown;
  /** Optional WSL distro name to run ssh in; see `SshTarget.wslDistro`. */
  wslDistro?: unknown;
}

const MAX_ARGV_ENTRIES = 64;
const MAX_ARG_LENGTH = 2048;
const MAX_PATH_LENGTH = 4096;

const targets = new Map<string, SshTarget>();

export function getSshTarget(workspaceId: string): SshTarget | undefined {
  return targets.get(workspaceId);
}

/**
 * A target went away (cleared, or replaced by another): the persistent worker
 * that served its host (exec-worker.ts) goes with it, unless another workspace
 * still has a target on the same host. The next request starts a new one.
 */
function releaseWorkersOf(gone: SshTarget | undefined): void {
  if (!gone || gone.wslDistro === undefined) return;
  const { wslDistro } = gone;
  const { destination } = gone.session;
  const stillUsed = [...targets.values()].some((t) => t.wslDistro === wslDistro && t.session.destination === destination);
  if (!stillUsed) releaseExecWorkers(wslDistro, destination);
}

export function setSshTarget(workspaceId: string, target: SshTarget): void {
  const previous = targets.get(workspaceId);
  targets.set(workspaceId, target);
  releaseWorkersOf(previous);
}

/** True when a target was present. */
export function clearSshTarget(workspaceId: string): boolean {
  const previous = targets.get(workspaceId);
  const removed = targets.delete(workspaceId);
  owners.delete(workspaceId);
  releaseWorkersOf(previous);
  return removed;
}

/**
 * A window closed a workspace: its target goes with it, so a closed workspace cannot keep a host's
 * worker alive. Anything but a workspace id is ignored. True when a target was dropped.
 */
export function forgetClosedWorkspace(workspaceId: unknown): boolean {
  return typeof workspaceId === 'string' && workspaceId !== '' && clearSshTarget(workspaceId);
}

/** Every registered target; the markdown save resolves an ssh:// identity against these. */
export function listSshTargets(): SshTarget[] {
  return [...targets.values()];
}

/** Tests only: the registry is module state. */
export function resetSshTargets(): void {
  targets.clear();
  owners.clear();
}

/** True for an argv that asks to clear: absent, or an empty array. */
function isClear(argv: unknown): boolean {
  return argv === undefined || argv === null || (Array.isArray(argv) && argv.length === 0);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * The remote checkout path: absolute, no control characters, no `..` segment.
 * Repeated and trailing slashes are folded. The filesystem root is refused: a
 * view jailed at `/` is no jail.
 */
export function normalizeRemotePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) return null;
  if (!value.startsWith('/') || CONTROL_CHARS.test(value)) return null;
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.length === 0 ? null : `/${segments.join('/')}`;
}

/**
 * The -32602 message for a bad `wslDistro`, or null. A distro name is handed to
 * `wsl.exe -d`, so it must not be able to read as an option (no leading `-`) or
 * carry whitespace or control characters.
 */
export function validateWslDistro(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_WSL_DISTRO_LENGTH
    || !isWslDistroName(value)) {
    return `wslDistro must be 1-${MAX_WSL_DISTRO_LENGTH} characters: letters, digits, "." "_" "-", not starting with "-"`;
  }
  return null;
}

/**
 * `-o` keys refused in a pushed argv: `LocalCommand` (with `PermitLocalCommand`) runs a command
 * on THIS machine after every connection, and a view opens connections on its own, on timers, with
 * nobody having typed that command in a pane.
 *
 * `ProxyCommand` is accepted on purpose, although it also runs a local program: it is how a pane
 * reaches hosts behind a jump host, and the caller that pushed this argv is the local pipe client,
 * already authenticated with the pipe token and already able to run anything as this user. Refusing
 * it would stop real setups and protect nothing.
 */
const LOCAL_EXEC_OPTIONS = new Set(['localcommand', 'permitlocalcommand']);

/**
 * Validate an ssh target's argv and path. Returns the target, or the message
 * for a -32602. Pure.
 */
export function parseSshTarget(argv: unknown, path: unknown, wslDistro?: unknown): SshTarget | { error: string } {
  if (!Array.isArray(argv) || argv.length > MAX_ARGV_ENTRIES
    || !argv.every((a) => typeof a === 'string' && a.length <= MAX_ARG_LENGTH && !a.includes('\0'))) {
    return { error: `argv must be an array of at most ${MAX_ARGV_ENTRIES} strings` };
  }
  const args = argv as string[];
  // The first element is the program the caller meant, and only an ssh is one.
  // (`parseSshArgv` would read anything else as an option or the destination.)
  if (normalizedExecutableName(args[0]) !== 'ssh') return { error: 'argv[0] must be ssh' };
  const session = parseSshArgv(args);
  if (!session) {
    return { error: 'argv is not an interactive ssh command wmux can reconnect to (expected: ssh [options] <destination>)' };
  }
  // `scp`-style option injection: a destination after `--` may start with a dash.
  if (session.destination.startsWith('-') || /\s/.test(session.destination) || CONTROL_CHARS.test(session.destination)) {
    return { error: 'argv has an unusable ssh destination' };
  }
  for (const option of session.sshOptions) {
    const key = optionKey(option);
    if (key && LOCAL_EXEC_OPTIONS.has(key)) return { error: `argv sets -o ${key}, which a view will not run` };
  }
  const normalized = normalizeRemotePath(path);
  if (!normalized) return { error: 'path must be an absolute path on the remote host, below /, with no ".." segment' };
  if (wslDistro !== undefined) {
    const invalid = validateWslDistro(wslDistro);
    if (invalid) return { error: invalid };
    return { session, path: normalized, wslDistro: wslDistro as string };
  }
  return { session, path: normalized };
}

/** The -32602 message for bad params, or null. Runs before any window is asked. */
export function validateSetSshTargetParams(params: unknown): string | null {
  if (!params || typeof params !== 'object') return 'params must be an object';
  const p = params as Record<string, unknown>;
  for (const key of ['workspaceId', 'caller'] as const) {
    if (p[key] !== undefined && typeof p[key] !== 'string') return `${key} must be a string`;
  }
  if (!p.workspaceId && !p.caller) {
    return 'No workspace given: pass --workspace <id>, or run it inside a wmux pane';
  }
  if (isClear(p.argv)) return null;
  const parsed = parseSshTarget(p.argv, p.path, p.wslDistro);
  return 'error' in parsed ? parsed.error : null;
}

/** The renderer expression. Every value is JSON-encoded: it reaches `executeJavaScript` as source. */
export function resolveWorkspaceJs(workspaceId: string | undefined, caller: string | undefined): string {
  const S = JSON.stringify;
  return `window.__wmux_resolveWorkspace?.(${S(workspaceId ?? '')}, ${S(caller ?? '')}) ?? null`;
}

/** The renderer expression for a surface's workspace id. */
export function workspaceOfSurfaceJs(surfaceId: string): string {
  return `window.__wmux_locateSurface?.(${JSON.stringify(surfaceId)})?.workspaceId ?? null`;
}

export interface SshTargetWindow {
  isDestroyed(): boolean;
  webContents: { executeJavaScript(code: string): Promise<unknown> };
  /** A BrowserWindow has it; without it a target is only dropped when its workspace is closed. */
  once?(event: 'closed', listener: () => void): unknown;
}

/** The window each workspace's target was set from, while that window can still be closed under it. */
const owners = new Map<string, SshTargetWindow>();

/**
 * A window that is closed takes its workspaces with it without closing them one by one, so their
 * targets would stay, and with them a host's worker and a stale `ssh://` identity. Drop the target when
 * the window that set it closes, unless another window has set one for that workspace id since.
 */
function dropTargetWithWindow(win: SshTargetWindow, workspaceId: string): void {
  const alreadyWatched = owners.get(workspaceId) === win;
  owners.set(workspaceId, win);
  if (alreadyWatched || !win.once) return;
  win.once('closed', () => {
    if (owners.get(workspaceId) !== win) return;
    clearSshTarget(workspaceId);
  });
}

/**
 * The workspace a surface is in, from the first window that holds it, or null.
 * A reloading or destroyed window means "this window doesn't have it".
 */
export async function workspaceIdForSurface(
  surfaceId: string,
  windows: readonly SshTargetWindow[],
): Promise<string | null> {
  if (!surfaceId) return null;
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    try {
      const found = await win.webContents.executeJavaScript(workspaceOfSurfaceJs(surfaceId));
      if (typeof found === 'string' && found) return found;
    } catch {
      continue;
    }
  }
  return null;
}

/** The workspace a surface is in AND its ssh target, when that workspace has one. */
export async function sshLocationForSurface(
  surfaceId: string | undefined,
  windows: readonly SshTargetWindow[],
): Promise<{ workspaceId: string; target: SshTarget } | undefined> {
  if (!surfaceId || targets.size === 0) return undefined;
  const workspaceId = await workspaceIdForSurface(surfaceId, windows);
  const target = workspaceId ? targets.get(workspaceId) : undefined;
  return workspaceId && target ? { workspaceId, target } : undefined;
}

/** The ssh target of the workspace a surface is in, if that workspace has one. */
export async function sshTargetForSurface(
  surfaceId: string | undefined,
  windows: readonly SshTargetWindow[],
): Promise<SshTarget | undefined> {
  return (await sshLocationForSurface(surfaceId, windows))?.target;
}

export async function handleSetSshTarget(
  params: unknown,
  windows: readonly SshTargetWindow[],
  respond: (result: unknown) => void,
  respondError: (code: number, message: string) => void,
  /** Called after a target was SET (never on a clear), for work that follows it. Its failure is its own. */
  onTargetSet?: (workspaceId: string, target: SshTarget) => void | Promise<void>,
): Promise<void> {
  const invalid = validateSetSshTargetParams(params);
  if (invalid) {
    respondError(-32602, invalid);
    return;
  }
  const p = params as SetSshTargetParams;
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    let result: unknown;
    try {
      result = await win.webContents.executeJavaScript(resolveWorkspaceJs(p.workspaceId, p.caller));
    } catch {
      continue; // reloading or torn down: this window doesn't have it
    }
    const workspaceId = (result as { workspaceId?: unknown } | null)?.workspaceId;
    if (typeof workspaceId !== 'string' || !workspaceId) continue;

    if (isClear(p.argv)) {
      respond({ workspaceId, target: null, cleared: clearSshTarget(workspaceId) });
      return;
    }
    // Validated above, so this cannot be an error.
    const target = parseSshTarget(p.argv, p.path, p.wslDistro) as SshTarget;
    setSshTarget(workspaceId, target);
    dropTargetWithWindow(win, workspaceId);
    respond({
      workspaceId,
      target: {
        destination: target.session.destination,
        ...(target.session.port !== undefined ? { port: target.session.port } : {}),
        path: target.path,
        ...(target.wslDistro !== undefined ? { wslDistro: target.wslDistro } : {}),
      },
    });
    try {
      void Promise.resolve(onTargetSet?.(workspaceId, target)).catch(() => undefined);
    } catch {
      // The target is set and answered; a follow-up that throws changes neither.
    }
    return;
  }
  respondError(-32000, p.workspaceId
    ? `Workspace not found: ${p.workspaceId}`
    : 'The calling pane is not in any workspace (stale WMUX_SURFACE_ID?)');
}
