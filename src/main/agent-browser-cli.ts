/**
 * Where is `agent-browser` on this machine, and how do we run it?
 *
 * The same lesson as `node-runtime.ts` (#187): do NOT assume the binary is on
 * PATH. wmux hands its panes a curated environment, and npm's global bin
 * directory is frequently absent from the PATH the Electron process inherited.
 * On Windows the npm global install is a `.cmd` shim, which is also the trap
 * `powershell-shim.ts` documents — so the name we look for is extension-first,
 * and we always spawn by ABSOLUTE path.
 *
 * Resolution is pure (`resolveAgentBrowserBinary`) so it is testable with no
 * filesystem, and memoised at the module boundary because it is read on the
 * pane-render path (#176: `where` cost 2x pty.spawn).
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Candidate basenames, most preferred first. */
export function AGENT_BROWSER_NAMES(platform: string): string[] {
  return platform === 'win32'
    ? ['agent-browser.cmd', 'agent-browser.exe', 'agent-browser']
    : ['agent-browser'];
}

/** Directories to search, most preferred first. */
function searchDirs(env: NodeJS.ProcessEnv, platform: string): string[] {
  const dirs: (string | undefined)[] = platform === 'win32'
    ? [
        env.APPDATA && path.join(env.APPDATA, 'npm'),
        env.ProgramFiles && path.join(env.ProgramFiles, 'nodejs'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'nodejs'),
        env.USERPROFILE && path.join(env.USERPROFILE, '.cargo', 'bin'),
        env.USERPROFILE && path.join(env.USERPROFILE, 'scoop', 'shims'),
      ]
    : [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
        env.HOME && path.join(env.HOME, '.cargo', 'bin'),
        env.HOME && path.join(env.HOME, '.local', 'bin'),
      ];
  const fromPath = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  return [...dirs, ...fromPath].filter((d): d is string => typeof d === 'string' && d.length > 0);
}

export interface ResolveOptions {
  /** An explicit path from wmux settings. Wins outright — but only if it exists. */
  configured?: string;
  env: NodeJS.ProcessEnv;
  platform: string;
  exists: (p: string) => boolean;
}

/**
 * Absolute path to the binary, or null when it is not installed.
 *
 * A configured path that does not exist returns null rather than falling back:
 * the user asked for a specific binary, and silently running a different one is
 * the wrong kind of helpful.
 */
export function resolveAgentBrowserBinary(opts: ResolveOptions): string | null {
  const { configured, env, platform, exists } = opts;
  if (configured) return exists(configured) ? configured : null;
  for (const dir of searchDirs(env, platform)) {
    for (const name of AGENT_BROWSER_NAMES(platform)) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

let cached: string | null | undefined;

/** Memoised resolution against the real machine. Pass `force` after an install. */
export function agentBrowserPath(configured?: string, force = false): string | null {
  if (!force && cached !== undefined) return cached;
  cached = resolveAgentBrowserBinary({
    configured,
    env: process.env,
    platform: process.platform,
    exists: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
  });
  return cached;
}

export interface RunResult {
  ok: boolean;
  /** Parsed JSON when the CLI emitted it, else null. */
  data: any;
  /** Raw stdout, kept for verbs whose payload is not JSON. */
  stdout: string;
  stderr: string;
}

/**
 * Run one agent-browser invocation.
 *
 * Spawned via execFile with an argv ARRAY — never a shell string — so a URL or
 * a snippet of JS passed to `eval` cannot break out into the shell. This is a
 * security boundary: the argv comes from a pipe command an agent controls.
 */
export function runAgentBrowser(binary: string, argv: string[], timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(binary, argv, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      let data: any = null;
      try { data = JSON.parse(stdout); } catch { /* not every verb emits JSON */ }
      resolve({ ok: !err, data, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}
