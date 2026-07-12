import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync, spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { SurfaceId } from '../shared/types';
import { getPipePath, readPipeToken } from '../shared/instance';

// ─── Shell resolution ──────────────────────────────────────────────────────
// Validates that a shell executable exists before spawning.
// Falls back through: pwsh.exe → powershell.exe → cmd.exe

let cachedDefaultShell: string | null = null;

function isShellAvailable(shell: string): boolean {
  if (!shell) return false;
  if (path.isAbsolute(shell)) {
    return fs.existsSync(shell);
  }
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(cmd, [shell], { windowsHide: true, timeout: 3000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getDefaultShell(): string {
  if (cachedDefaultShell) return cachedDefaultShell;
  const candidates = process.platform === 'win32'
    ? ['pwsh.exe', 'powershell.exe', 'cmd.exe']
    : [process.env.SHELL || '/bin/sh'];
  for (const cmd of candidates) {
    if (isShellAvailable(cmd)) {
      cachedDefaultShell = cmd;
      return cmd;
    }
  }
  // cmd.exe is always available on Windows
  cachedDefaultShell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  return cachedDefaultShell;
}

function resolveShell(shell: string | undefined): string {
  if (shell && isShellAvailable(shell)) {
    return shell;
  }
  if (shell) {
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

// Dir holding the `wmux`/`wmux.cmd` shims (each runs `node $WMUX_CLI`). Prepended
// to PATH in every spawned shell so bare `wmux` resolves in NON-interactive shells
// too (Claude Code's Bash tool, orchestrator hook scripts) — the interactive
// `wmux` shell function only exists in the pane's own interactive shell. The dir
// has no wmux.exe, so there is no PATHEXT collision with the GUI.
function getCliBinPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'cli-bin');
    }
  } catch {
    // Not running in Electron
  }
  return path.join(__dirname, '../../src/cli-bin');
}

function getShellType(shell: string): 'powershell' | 'cmd' | 'wsl' | 'unknown' {
  const lower = shell.toLowerCase();
  if (lower.includes('pwsh') || lower.includes('powershell')) return 'powershell';
  if (lower.includes('cmd')) return 'cmd';
  if (lower.includes('wsl')) return 'wsl';
  return 'unknown';
}

// A POSIX/WSL path (e.g. /home/user/project restored from session.json — issue
// #60). Such a path is NOT a valid working dir for a Win32 process and makes
// pty.spawn fail with error 267 (ERROR_DIRECTORY). Win32 paths are drive-rooted
// (C:\...) or UNC (\\server\...); a leading forward slash means POSIX.
function isPosixPath(p: string): boolean {
  return p.startsWith('/') && !p.startsWith('//');
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
    const wmuxWslEnv =
      'WMUX/u:WMUX_SURFACE_ID/u:WMUX_CLI/up:WMUX_PIPE/u:WMUX_PIPE_TOKEN/u:WMUX_INTEGRATION/u';
    env.WSLENV = env.WSLENV ? `${env.WSLENV}:${wmuxWslEnv}` : wmuxWslEnv;
    // A restored WSL/POSIX cwd (issue #60) can't be a Win32 process cwd (error
    // 267). Open it INSIDE the distro via --cd instead; the Win32-side cwd is
    // sanitized to a valid Windows dir by the caller.
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
    const shell = resolveShell(spec.command);
    const shellExtraArgs = shell === spec.command ? spec.args : [];
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
    const cliBinDir = getCliBinPath();
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = env[pathKey] ? `${cliBinDir}${path.delimiter}${env[pathKey]}` : cliBinDir;

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
      for (const listener of entry.exitListeners) {
        listener(exitCode);
      }
      this.ptys.delete(id);
    });

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
    if (!entry) return;
    // Drop no-op resizes: a same-size resize still makes the shell redraw its
    // prompt (doubled-prompt cause). Only forward genuine size changes.
    if (cols === entry.cols && rows === entry.rows) return;
    entry.cols = cols;
    entry.rows = rows;
    entry.pty.resize(cols, rows);
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
    this.ptys.delete(id);
  }

  killAll(): void {
    for (const id of this.ptys.keys()) {
      this.kill(id);
    }
  }

  has(id: SurfaceId): boolean {
    return this.ptys.has(id);
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
