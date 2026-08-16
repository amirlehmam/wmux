import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync, spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { SurfaceId } from '../shared/types';
import { getPipePath, readPipeToken } from '../shared/instance';
import { isPosixPath } from '../shared/paths';
import { PtyLedger } from './pty-ledger';
import { attachErrorSink, installPtyCrashGuard } from './pty-crash-guard';
import { powerShellShimDir } from './powershell-shim';
import { getCliBinPath } from './cli-paths';

// Applied once, at load, before any PTY can exist — the exit callback it guards
// is registered by node-pty inside pty.spawn(), so a later install would leave
// every already-spawned pane on the unguarded path (issue #150).
//
// The result is kept rather than discarded so it can be RECORDED. "Installed at
// module load" was a design claim nobody could check against a process that had
// already died, which is exactly the question #150 got stuck on.
const ptyCrashGuardInstalled = installPtyCrashGuard();

/** Whether the #150 crash guard actually attached in this process. */
export function isPtyCrashGuardInstalled(): boolean {
  return ptyCrashGuardInstalled;
}

// ─── Shell resolution ──────────────────────────────────────────────────────
// Validates that a shell executable exists as a real file before spawning.
// node-pty's Windows SearchPath concatenates PATH + the bare name and then
// GetFileAttributes — App Execution Aliases (0-byte WindowsApps reparse
// points) fail that check, so spawn('pwsh-preview') throws "File not found: "
// with an empty path. `where` finds those aliases; fs.existsSync does not.
// Fall back through: requested shell → pwsh.exe → powershell.exe → cmd.exe

let cachedDefaultShell: string | null = null;

/** First `where`/`which` hit that is a real file (skips WindowsApps aliases). */
function firstExistingOnPath(name: string): string | undefined {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    // stderr is discarded rather than inherited: `where` prints a localised
    // "could not find files for the given pattern" on every miss, and a miss is
    // the normal case here (we probe pwsh before falling back). Inheriting it
    // put OS-language noise in the user's terminal and in main.log.
    const hits = execFileSync(cmd, [name], {
      windowsHide: true,
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return hits.find((p) => fs.existsSync(p));
  } catch {
    return undefined;
  }
}

/**
 * Newest-first ordering of WindowsApps package directory names.
 *
 * Exported for tests: the failure it prevents only appears once a version
 * number carries a two-digit component, so nothing on disk today would catch a
 * regression back to a plain `.sort().reverse()`.
 */
export function comparePackageVersion(a: string, b: string): number {
  const parts = (d: string) => (d.split('_')[1] ?? '').split('.').map((n) => Number(n) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Store-installed PowerShell: WindowsApps\<pkg>\pwsh.exe.
 *
 * Both the stable and the preview package are reachable only through an App
 * Execution Alias on PATH, which is exactly what node-pty cannot spawn — so a
 * Store-only install of *either* needs the real exe underneath. The prefixes
 * are disjoint because stable carries the underscore: `Microsoft.PowerShell_`
 * does not match `Microsoft.PowerShellPreview_`.
 */
function findStorePwsh(preview: boolean): string | undefined {
  const root = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps');
  const prefix = preview ? 'Microsoft.PowerShellPreview_' : 'Microsoft.PowerShell_';
  try {
    const dirs = fs.readdirSync(root)
      .filter((d) => d.startsWith(prefix))
      .sort(comparePackageVersion);
    for (const d of dirs) {
      const exe = path.join(root, d, 'pwsh.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    // ACL-denied listing is fine — caller falls back.
  }
  return undefined;
}

/** Absolute path of a real file node-pty can spawn, or undefined. */
export function resolveExistingShellPath(shell: string): string | undefined {
  if (!shell) return undefined;
  if (path.isAbsolute(shell) && fs.existsSync(shell)) return shell;
  const onPath = firstExistingOnPath(shell);
  if (onPath) return onPath;
  // Bare alias with no real PATH hit. A Store-only PowerShell — stable or
  // preview — is reachable only as an App Execution Alias, so `where` finds it
  // and existsSync refuses it. Without this the stable case silently fell all
  // the way back to Windows PowerShell 5.1.
  if (process.platform === 'win32') {
    const base = path.basename(shell).toLowerCase().replace(/\.exe$/, '');
    if (base === 'pwsh-preview') return findStorePwsh(true);
    if (base === 'pwsh') return findStorePwsh(false);
  }
  return undefined;
}

function getDefaultShell(): string {
  if (cachedDefaultShell) return cachedDefaultShell;
  const candidates = process.platform === 'win32'
    ? ['pwsh.exe', 'powershell.exe', 'cmd.exe']
    : [process.env.SHELL || '/bin/sh'];
  for (const cmd of candidates) {
    const resolved = resolveExistingShellPath(cmd);
    if (resolved) {
      cachedDefaultShell = resolved;
      return resolved;
    }
  }
  cachedDefaultShell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  return cachedDefaultShell;
}

export function resolveShell(shell: string | undefined): string {
  if (shell) {
    const resolved = resolveExistingShellPath(shell);
    if (resolved) return resolved;
    console.warn(`[wmux] Shell not found: "${shell}", falling back to ${getDefaultShell()}`);
  }
  return getDefaultShell();
}

// A shell spec may be a bare executable ("pwsh.exe", an absolute path that can
// contain spaces) or a command line with arguments ("ssh user@host",
// '"C:\Tools\my shell.exe" --flag') — issue #78 remote terminals ride on the
// latter. An existing absolute path is always treated as a bare executable so
// legacy specs like "C:\Program Files\PowerShell\7\pwsh.exe" never get split.
export function parseShellSpec(spec: string | undefined): { command: string; args: string[] } {
  const trimmed = (spec || '').trim();
  if (!trimmed) return { command: '', args: [] };
  if (path.isAbsolute(trimmed) && fs.existsSync(trimmed)) {
    return { command: trimmed, args: [] };
  }
  if (!/\s/.test(trimmed)) return { command: trimmed, args: [] };
  const tokens = (trimmed.match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, ''));
  const [command = '', ...args] = tokens;
  return { command, args };
}

function getShellIntegrationPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'shell-integration');
    }
  } catch {
    // Not running in Electron (e.g., during tests)
  }
  return path.join(__dirname, '../../src/shell-integration');
}

function getCliPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'cli', 'wmux.js');
    }
  } catch {
    // Not running in Electron
  }
  return path.join(__dirname, '../cli/wmux.js');
}


function getShellType(shell: string): 'powershell' | 'cmd' | 'wsl' | 'unknown' {
  // The basename, not the whole path. resolveShell used to hand back the bare
  // name it was given; since #172 it returns the resolved absolute path, so any
  // directory on the way to the exe would otherwise vote — and real ones do:
  // C:\tools\cmder\bin\bash.exe would classify as cmd, and get cmd's shell
  // integration injected into a bash session.
  const lower = path.basename(shell).toLowerCase();
  if (lower.includes('pwsh') || lower.includes('powershell')) return 'powershell';
  if (lower.includes('cmd')) return 'cmd';
  if (lower.includes('wsl')) return 'wsl';
  return 'unknown';
}

// The two environment facts resolveShellForCwd depends on, behind an object so
// a test can substitute them without pretending to be Windows. `hasWsl` is
// cached because it shells out to `where`, and this runs on every pane create.
let cachedWsl: boolean | null = null;
export const shellEnv = {
  isWindows: (): boolean => process.platform === 'win32',
  hasWsl: (): boolean => {
    if (cachedWsl === null) cachedWsl = firstExistingOnPath('wsl.exe') !== undefined;
    return cachedWsl;
  },
};

// A pane whose cwd is a POSIX/WSL path (the common case once a WSL or
// devcontainer shell has reported its directory via report_pwd) cannot be
// served by a Win32 shell: resolveSpawnCwd() below has no choice but to hand
// pwsh/cmd %USERPROFILE%, so a new tab or split silently lands in the Windows
// home folder instead of the project. Translating to \\wsl.localhost\... is not
// an option either — CreateProcess rejects a UNC working directory.
//
// wsl.exe is the one shell that CAN open that path (buildShellArgs passes it as
// --cd), so substitute it. Only the two shells that are physically incapable of
// the directory are replaced: an 'unknown' spec is left alone because it may be
// a deliberate remote command line such as `ssh user@host` (issue #78).
export function resolveShellForCwd(shell: string, cwd: string | undefined): string {
  if (!shellEnv.isWindows()) return shell;
  if (!cwd || !isPosixPath(cwd)) return shell;
  const shellType = getShellType(shell);
  if (shellType !== 'powershell' && shellType !== 'cmd') return shell;
  if (!shellEnv.hasWsl()) return shell;
  console.warn(`[wmux] cwd is a POSIX path, using wsl.exe instead of ${shell}: ${cwd}`);
  return 'wsl.exe';
}

// Resolve the working dir handed to pty.spawn, guaranteeing it is a directory
// that exists — otherwise CreateProcess fails with error 267 (ERROR_DIRECTORY)
// and the pane dies with an opaque "Cannot create process, error code: 267".
// Returns undefined (node-pty's own default) when there is nothing usable.
export function resolveSpawnCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;

  const fallback = process.env.USERPROFILE || 'C:\\';

  // POSIX/WSL cwd: not a valid Win32 working dir at all (issue #60).
  if (isPosixPath(cwd)) return fallback;

  // Win32 cwd that no longer exists (deleted git worktree) or does not exist
  // yet (spawn ordered before `git worktree add` finished). Also rejects a path
  // that exists but is a FILE — CreateProcess wants a directory.
  try {
    if (fs.statSync(cwd).isDirectory()) return cwd;
    console.warn(`[wmux] cwd is not a directory, falling back to ${fallback}: ${cwd}`);
  } catch {
    console.warn(`[wmux] cwd does not exist, falling back to ${fallback}: ${cwd}`);
  }
  return fallback;
}

// Build the launch args for a shell and mutate `env` with shell-specific vars.
// Kept out of create() so that hot path stays under the cognitive-complexity
// budget. `env` is mutated in place (integration script paths, WSLENV, etc.).
function buildShellArgs(
  shellType: ReturnType<typeof getShellType>,
  env: { [key: string]: string },
  integrationDir: string,
  cwd: string | undefined,
): string[] {
  if (shellType === 'powershell') {
    const script = path.join(integrationDir, 'wmux-powershell-integration.ps1');
    if (fs.existsSync(script)) {
      env.WMUX_PS1_SCRIPT = script;
      return ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', '. $env:WMUX_PS1_SCRIPT'];
    }
    console.warn(`[wmux] shell-integration not found at: ${script} — starting PowerShell without integration`);
    return ['-NoLogo'];
  }
  if (shellType === 'cmd') {
    return ['/K', path.join(integrationDir, 'wmux-cmd-integration.cmd')];
  }
  if (shellType === 'wsl') {
    env.WMUX_INTEGRATION = '1';
    // Propagate WMUX_* vars into the WSL distro (issue #60). Without WSLENV, WSL
    // strips every Windows env var, so the notification framework, sidebar and
    // `wmux` CLI inside WSL can't reach the host. /u = pass through, /up = pass
    // through AND translate the Windows path to a WSL mount (/mnt/c/...).
    // WMUX_REMOTE / WMUX_REMOTE_TOKEN ride along so a devcontainer launched from
    // this WSL shell inherits them and its CLI can reach wmux over the bridge
    // (issue #19). Harmless when unset — WSLENV skips a variable with no value.
    const wmuxWslEnv =
      'WMUX/u:WMUX_SURFACE_ID/u:WMUX_CLI/up:WMUX_PIPE/u:WMUX_PIPE_TOKEN/u:WMUX_INTEGRATION/u'
      + ':WMUX_REMOTE/u:WMUX_REMOTE_TOKEN/u';
    env.WSLENV = env.WSLENV ? `${env.WSLENV}:${wmuxWslEnv}` : wmuxWslEnv;
    // A restored WSL/POSIX cwd (issue #60) can't be a Win32 process cwd (error
    // 267). Open it INSIDE the distro via --cd instead; the Win32-side cwd is
    // sanitized to a valid Windows dir by the caller.
    //
    // --cd is BEST-EFFORT: WSL applies it before the interactive login shell
    // reads its rc, so a distro whose /etc/profile or ~/.profile cds to $HOME
    // discards it and the pane opens at home. See docs/config.md.
    const posixCwd = cwd && isPosixPath(cwd) ? cwd : null;
    return ['--cd', posixCwd ?? '~'];
  }
  return [];
}

interface PtyEntry {
  pty: pty.IPty;
  dataListeners: Set<(data: string) => void>;
  exitListeners: Set<(code: number) => void>;
  // Serial queue: long writes are split into ConPTY-friendly chunks and
  // appended here so concurrent calls cannot interleave inside a single paste.
  writeChain: Promise<void>;
  pendingChunks: number;
  alive: boolean;
  // Last applied size. Used to drop redundant same-size resizes, which would
  // otherwise make the shell (PSReadLine/oh-my-posh) redraw the prompt for no
  // reason — a cause of the doubled prompt on startup.
  cols: number;
  rows: number;
  // Resolved shell + whether startup commands were baked in — returned verbatim
  // when create() is called again for the same surfaceId (idempotent reuse).
  shell: string;
  startupConsumed: boolean;
}

export interface CreateOptions {
  shell: string;
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  /** When provided, use this as the PTY key instead of generating a new one.
   *  This keeps Surface IDs and PTY IDs in sync for reliable re-attachment. */
  surfaceId?: SurfaceId;
  /** Quick-launch profile commands (issue #32). When the shell type supports it
   *  they are baked into the shell's own startup (see `startupCommandsConsumed`
   *  in the return value) rather than injected later as keystrokes. */
  startupCommands?: string[];
}

// Primary Device Attributes (DA1). oh-my-posh / PSReadLine probe the terminal
// with a DA1 query and block briefly for the reply before drawing the prompt.
//
// xterm answers DA1 too, but its reply travels a slow multi-process round-trip
// (main → renderer → xterm → renderer → main → pty). That latency is the cause
// of three symptoms users saw: the reply arriving after the prompt was drawn and
// leaking onto the command line as `\x1b[?62;4;9;22c`; and, once xterm's reply
// was suppressed to stop that leak, the probe getting no reply at all — so the
// prompt stalled ~3-5s on the probe's timeout and re-rendered (a doubled prompt).
//
// Answering here, in the same process as the PTY, is effectively instant, so the
// probe is satisfied before the prompt draws: one clean prompt, no junk, no
// stall. xterm's own DA1 reply is suppressed in useTerminal so this is the only
// one. The query is `\x1b[c` or `\x1b[<n>c` (no `?`/`>`/`=` prefix — those are
// the reply / DA2 / DA3 forms, which this deliberately does not match). The
// reply advertises the same attributes xterm-with-image did (62=VT220, 4=Sixel,
// 9, 22=ANSI color) so image-capable apps still detect support.
// eslint-disable-next-line no-control-regex -- ESC is intentional: this matches the DA1 query byte-for-byte
const DA1_QUERY = /\x1b\[\d*c/;
const DA1_REPLY = '\x1b[?62;4;9;22c';

export class PtyManager {
  private ptys = new Map<SurfaceId, PtyEntry>();

  /**
   * Optional on-disk record of every PID spawned here, so the next launch can
   * tree-kill whatever this process left running if it dies without reaching
   * `killAll()` (issue #139). Optional rather than constructed internally
   * because tests spawn real PTYs: without an explicit ledger they must not
   * touch — let alone overwrite — the ledger of the wmux instance the user has
   * running on the same machine.
   */
  constructor(private readonly ledger: PtyLedger | null = null) {}

  // ConPTY's input pipe silently drops bytes when a single write outruns the
  // foreground process. Splitting at ~1 KB keeps every chunk well under the
  // pipe buffer; setImmediate between chunks lets ConPTY drain without adding
  // perceptible latency.
  private static readonly CHUNK_THRESHOLD = 1024;
  private static readonly CHUNK_SIZE = 1024;

  create(options: CreateOptions): { id: SurfaceId; shell: string; startupCommandsConsumed: boolean; reused: boolean } {
    const id: SurfaceId = options.surfaceId ?? `surf-${uuidv4()}` as SurfaceId;

    // Idempotent per surfaceId. React StrictMode (dev) double-mounts the terminal
    // component, and the renderer's `pty.has()` check is async — so create() can
    // fire twice for the same surface before the first spawn registers. Without
    // this guard the second call spawns a SECOND PowerShell process under the
    // same id: both stream to the renderer (doubled prompt + every keystroke
    // echoed twice) and the first leaks as an orphan. Reuse the live PTY instead.
    if (options.surfaceId) {
      const existing = this.ptys.get(options.surfaceId);
      if (existing && existing.alive) {
        return {
          id: options.surfaceId,
          shell: existing.shell,
          startupCommandsConsumed: existing.startupConsumed,
          reused: true,
        };
      }
    }

    // Split "ssh user@host"-style specs into executable + args (issue #78).
    // Extra args only apply when the REQUESTED executable resolved — if we fell
    // back to the default shell, its command line must not inherit ssh's args.
    const spec = parseShellSpec(options.shell);
    // A POSIX cwd forces wsl.exe — pwsh/cmd cannot open that directory at all
    // and would silently start in %USERPROFILE% instead of the project.
    const requested = resolveExistingShellPath(spec.command);
    const shell = resolveShellForCwd(requested ?? resolveShell(spec.command), options.cwd);
    const shellExtraArgs = requested ? spec.args : [];
    const shellType = getShellType(shell);
    const integrationDir = getShellIntegrationPath();
    const cliPath = getCliPath();
    // Filter out undefined values from process.env before merging
    const processEnvClean = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    const env: { [key: string]: string } = {
      ...processEnvClean,
      ...options.env,
      WMUX: '1',
      WMUX_SURFACE_ID: id,
      WMUX_PIPE: getPipePath(),
      WMUX_PIPE_TOKEN: readPipeToken(),
      WMUX_CLI: cliPath,
    };

    // Make bare `wmux` resolvable in every spawned shell AND all its children
    // (Claude Code's Bash tool, hook scripts, the orchestrator coordinator) by
    // prepending the cli-bin shim dir to PATH. PATH inherits down the process
    // tree regardless of shell/login/interactive state — which is exactly what
    // the interactive `wmux` shell function cannot reach. Prepend (not append)
    // so this instance's shim wins; it is instance-scoped via $WMUX_CLI/$WMUX_PIPE
    // anyway. The Windows env key is `Path`, so match case-insensitively.
    // The .ps1 shim dir goes AHEAD of cli-bin when — and only when — wmux has
    // verified PowerShell will run it (issue #154). PowerShell prefers a .ps1
    // over every PATHEXT entry, so this is what takes cmd.exe's argument parser
    // out of the PowerShell path; unverified, it is left off entirely rather
    // than risk a `wmux` that errors instead of merely mis-quoting. Order does
    // not matter to any other shell: bash and cmd.exe ignore .ps1 files.
    const cliBinDir = getCliBinPath();
    const shimDirs = [powerShellShimDir(), cliBinDir].filter((d): d is string => d !== null);
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    const prefix = shimDirs.join(path.delimiter);
    env[pathKey] = env[pathKey] ? `${prefix}${path.delimiter}${env[pathKey]}` : prefix;

    const args = [...buildShellArgs(shellType, env, integrationDir, options.cwd), ...shellExtraArgs];

    // Quick-launch startup commands (issue #32). Run them as part of the shell's
    // own initialization — BEFORE the first interactive prompt — instead of
    // injecting them later as keystrokes (`pty.write('<cmd>\r')`).
    //
    // The keystroke approach raced the shell's init-time terminal queries: with
    // oh-my-posh/PSReadLine, ConPTY answers a Device Attributes query (DA1) by
    // writing `\x1b[?62;4;9;22c` onto the shell's stdin. If that response landed
    // on the prompt the same instant our injected `<cmd>\r` arrived, PSReadLine
    // merged them into one bogus executed line (e.g. `62;4;9;22ccls`). Baking the
    // commands into the integration script (via WMUX_STARTUP_COMMANDS) removes
    // the race: they run during init and the first prompt render — the only one
    // that triggers the leaky query — happens afterward, exactly as it does for a
    // plain terminal that shows no junk.
    const startupCommands = (options.startupCommands ?? []).filter(
      (cmd): cmd is string => typeof cmd === 'string' && cmd.trim().length > 0,
    );
    let startupCommandsConsumed = false;
    if (startupCommands.length > 0 && shellType === 'powershell' && env.WMUX_PS1_SCRIPT) {
      // Newlines survive the env block; the integration script trims each line
      // (so a stray CR is harmless) and runs it via Invoke-Expression.
      env.WMUX_STARTUP_COMMANDS = startupCommands.join('\n');
      startupCommandsConsumed = true;
    }

    // CreateProcess fails with error 267 (ERROR_DIRECTORY) when the working dir
    // isn't a real directory, and node-pty surfaces that as an opaque "Cannot
    // create process, error code: 267" — the pane just dies. Two ways to get
    // there, both fixed by falling back to a directory that exists:
    //
    //  - a POSIX/WSL cwd restored from session.json (issue #60) is never a valid
    //    Win32 working dir. WSL itself still reaches the POSIX path via --cd above.
    //  - a Win32 cwd that has since been deleted, or has not been created yet:
    //    an agent spawned into a git worktree that was removed after its wave, or
    //    ordered before `git worktree add` finished. The cwd comes from session
    //    state / CLI args, so it must not be trusted to still exist at spawn time.
    const spawnCwd = resolveSpawnCwd(options.cwd);

    const spawnOptions: pty.IWindowsPtyForkOptions = {
      name: 'xterm-256color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: spawnCwd,
      env,
      useConpty: true,
      // The OS-inbox ConPTY garbles fast TUI repaints (stray inverse cells at
      // the app's cursor position — issues #23/#30). Use node-pty's bundled
      // modern conpty.dll instead; it resolves relative to the loaded
      // conpty.node, so prebuilds/win32-x64/conpty/ must ship in the package.
      useConptyDll: true,
    };
    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(shell, args, spawnOptions);
    } catch (err) {
      console.warn('[wmux] spawn with bundled conpty.dll failed, retrying with inbox ConPTY:', err);
      ptyProcess = pty.spawn(shell, args, { ...spawnOptions, useConptyDll: false });
    }

    // node-pty re-throws unrecognised socket errors out of a libuv callback
    // unless the terminal already carries error listeners, and it registers
    // none of its own — so an error on this pane's pipe crashes the main
    // process and every other pane with it (issue #150). Claim the error here
    // and let the pane die alone.
    attachErrorSink(ptyProcess as unknown as Parameters<typeof attachErrorSink>[0], (err) => {
      console.warn(`[wmux] pty ${id} socket error (contained):`, err);
    });

    const entry: PtyEntry = {
      pty: ptyProcess,
      dataListeners: new Set(),
      exitListeners: new Set(),
      writeChain: Promise.resolve(),
      pendingChunks: 0,
      alive: true,
      cols: spawnOptions.cols ?? 80,
      rows: spawnOptions.rows ?? 24,
      shell,
      startupConsumed: startupCommandsConsumed,
    };

    ptyProcess.onData((data) => {
      // Answer DA1 probes in-process so the prompt never stalls or leaks the
      // reply (see DA1_QUERY note above). Only the escape character is common
      // enough to warrant the cheap guard before the regex scan.
      if (entry.alive && data.indexOf('\x1b[') !== -1 && DA1_QUERY.test(data)) {
        try { ptyProcess.write(DA1_REPLY); } catch { /* pty disposed between events */ }
      }
      for (const listener of entry.dataListeners) {
        listener(data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      entry.alive = false; // stops any in-flight chunked write
      if (typeof ptyProcess.pid === 'number') this.ledger?.remove(ptyProcess.pid);
      for (const listener of entry.exitListeners) {
        listener(exitCode);
      }
      this.ptys.delete(id);
    });

    // Recorded after the listeners are attached but before returning, so a
    // crash between here and the first user keystroke still leaves a trail.
    if (typeof ptyProcess.pid === 'number' && ptyProcess.pid > 0) {
      this.ledger?.add(ptyProcess.pid, path.basename(shell));
    }

    this.ptys.set(id, entry);
    return { id, shell, startupCommandsConsumed, reused: false };
  }

  write(id: SurfaceId, data: string): void {
    const entry = this.ptys.get(id);
    if (!entry || !entry.alive || data.length === 0) return;

    // Fast path: single keystrokes, control sequences, short responses bypass
    // the queue entirely so typing latency is unchanged.
    if (data.length <= PtyManager.CHUNK_THRESHOLD && entry.pendingChunks === 0) {
      try {
        entry.pty.write(data);
      } catch {
        // pty was killed between get() and write()
      }
      return;
    }

    // Slow path: long paste — enqueue behind any in-flight chunked writes so
    // their bytes can't interleave.
    entry.pendingChunks++;
    entry.writeChain = entry.writeChain
      .then(() => this.writeChunked(entry, data))
      .finally(() => {
        entry.pendingChunks = Math.max(0, entry.pendingChunks - 1);
      });
  }

  private writeChunked(entry: PtyEntry, data: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let offset = 0;
      const writeNext = () => {
        if (!entry.alive || offset >= data.length) {
          resolve();
          return;
        }
        const end = Math.min(offset + PtyManager.CHUNK_SIZE, data.length);
        try {
          entry.pty.write(data.slice(offset, end));
        } catch {
          // pty disposed mid-paste — abandon the rest silently
          resolve();
          return;
        }
        offset = end;
        setImmediate(writeNext);
      };
      writeNext();
    });
  }

  resize(id: SurfaceId, cols: number, rows: number): void {
    const entry = this.ptys.get(id);
    // `alive`, not just presence: the exit handler clears the flag before the
    // entry leaves the map, and node-pty throws "Cannot resize a pty that has
    // already exited" for anything in that window. A pane reflowing while its
    // shell exits hits it, and this runs in the main process, where an
    // unhandled throw is a crash rather than a warning. write() has guarded
    // this way for a while; resize() was the one PTY entry point that didn't.
    if (!entry || !entry.alive) return;
    // Drop no-op resizes: a same-size resize still makes the shell redraw its
    // prompt (doubled-prompt cause). Only forward genuine size changes.
    if (cols === entry.cols && rows === entry.rows) return;
    entry.cols = cols;
    entry.rows = rows;
    try {
      entry.pty.resize(cols, rows);
    } catch {
      // Exited between the liveness check and the call — nothing to resize.
    }
  }

  kill(id: SurfaceId): void {
    const entry = this.ptys.get(id);
    if (!entry) return;

    entry.alive = false; // signals any in-flight chunked write to stop
    const pid = entry.pty.pid;

    // Tree-kill the shell's whole process subtree BEFORE closing the pseudoconsole
    // (issue #65). With `useConptyDll: true`, node-pty's DLL kill path only calls
    // ClosePseudoConsole — it terminates the directly-attached wrapper shell but
    // NOT grandchildren that don't share the console lifetime, notably Claude
    // Code's persistent `-s` backend (`powershell … -s …`), which then orphans.
    // `taskkill /T /F` walks the parent→child snapshot and force-kills the entire
    // tree while it's still intact. Spawned detached + unref'd so it's non-blocking
    // and survives even when this runs from killAll() on app quit.
    if (process.platform === 'win32' && typeof pid === 'number' && pid > 0) {
      try {
        // Resolve taskkill by absolute path from %SystemRoot%\System32 rather than
        // relying on PATH — PATH could contain a writeable dir shadowing taskkill.
        const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
        const taskkillPath = path.join(systemRoot, 'System32', 'taskkill.exe');
        const killer = spawn(taskkillPath, ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          detached: true,
          stdio: 'ignore',
        });
        killer.on('error', () => { /* taskkill missing / already gone */ });
        killer.unref();
      } catch {
        // spawn failed (e.g. taskkill unavailable) — fall back to pty.kill below
      }
    }

    try {
      entry.pty.kill();
    } catch {
      // Process may already be dead
    }
    if (typeof pid === 'number') this.ledger?.remove(pid);
    this.ptys.delete(id);
  }

  killAll(): void {
    for (const id of this.ptys.keys()) {
      this.kill(id);
    }
    // Belt and braces: kill() already dropped each PID, but killAll() is the
    // shutdown path and the ledger must not outlive it under any partial failure.
    this.ledger?.clear();
  }

  has(id: SurfaceId): boolean {
    return this.ptys.has(id);
  }

  /**
   * How many PTYs this manager is holding.
   *
   * Recorded at teardown for #150: each live PTY is one node-pty
   * ThreadSafeFunction whose exit callback will fire on the main thread, so
   * "how many were outstanding when the session ended" is the number that says
   * how wide the teardown race was.
   */
  count(): number {
    return this.ptys.size;
  }

  onData(id: SurfaceId, callback: (data: string) => void): () => void {
    const entry = this.ptys.get(id);
    if (!entry) {
      return () => {};
    }
    entry.dataListeners.add(callback);
    return () => entry.dataListeners.delete(callback);
  }

  onExit(id: SurfaceId, callback: (code: number) => void): () => void {
    const entry = this.ptys.get(id);
    if (!entry) {
      return () => {};
    }
    entry.exitListeners.add(callback);
    return () => entry.exitListeners.delete(callback);
  }

  getPid(id: SurfaceId): number | undefined {
    const entry = this.ptys.get(id);
    return entry?.pty.pid;
  }
}
