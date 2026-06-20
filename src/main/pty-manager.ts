import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
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
  const lower = shell.toLowerCase();
  if (lower.includes('pwsh') || lower.includes('powershell')) return 'powershell';
  if (lower.includes('cmd')) return 'cmd';
  if (lower.includes('wsl')) return 'wsl';
  return 'unknown';
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

    const shell = resolveShell(options.shell);
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

    let args: string[] = [];
    if (shellType === 'powershell') {
      const script = path.join(integrationDir, 'wmux-powershell-integration.ps1');
      if (fs.existsSync(script)) {
        env.WMUX_PS1_SCRIPT = script;
        args = ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', '. $env:WMUX_PS1_SCRIPT'];
      } else {
        console.warn(`[wmux] shell-integration not found at: ${script} — starting PowerShell without integration`);
        args = ['-NoLogo'];
      }
    } else if (shellType === 'cmd') {
      const script = path.join(integrationDir, 'wmux-cmd-integration.cmd');
      args = ['/K', script];
    } else if (shellType === 'wsl') {
      env.WMUX_INTEGRATION = '1';
    }

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

    const spawnOptions: pty.IWindowsPtyForkOptions = {
      name: 'xterm-256color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: options.cwd,
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
    if (entry) {
      entry.alive = false; // signals any in-flight chunked write to stop
      try {
        entry.pty.kill();
      } catch {
        // Process may already be dead
      }
      this.ptys.delete(id);
    }
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
