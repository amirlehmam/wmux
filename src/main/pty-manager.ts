import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { SurfaceId } from '../shared/types';

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
}

export class PtyManager {
  private ptys = new Map<SurfaceId, PtyEntry>();

  create(options: CreateOptions): SurfaceId {
    const id: SurfaceId = options.surfaceId ?? `surf-${uuidv4()}` as SurfaceId;

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
      WMUX_PIPE: '\\\\.\\pipe\\wmux',
      WMUX_CLI: cliPath,
    };

    let args: string[] = [];
    if (shellType === 'powershell') {
      const script = path.join(integrationDir, 'wmux-powershell-integration.ps1');
      args = ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', `. "${script}"`];
    } else if (shellType === 'cmd') {
      const script = path.join(integrationDir, 'wmux-cmd-integration.cmd');
      args = ['/K', script];
    } else if (shellType === 'wsl') {
      env.WMUX_INTEGRATION = '1';
    }

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: options.cwd,
      env,
      useConpty: true,
    });

    const entry: PtyEntry = {
      pty: ptyProcess,
      dataListeners: new Set(),
      exitListeners: new Set(),
    };

    ptyProcess.onData((data) => {
      for (const listener of entry.dataListeners) {
        listener(data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      for (const listener of entry.exitListeners) {
        listener(exitCode);
      }
      this.ptys.delete(id);
    });

    this.ptys.set(id, entry);
    return id;
  }

  write(id: SurfaceId, data: string): void {
    const entry = this.ptys.get(id);
    if (entry) {
      entry.pty.write(data);
    }
  }

  resize(id: SurfaceId, cols: number, rows: number): void {
    const entry = this.ptys.get(id);
    if (entry) {
      entry.pty.resize(cols, rows);
    }
  }

  kill(id: SurfaceId): void {
    const entry = this.ptys.get(id);
    if (entry) {
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
