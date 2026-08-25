/**
 * Where is `agent-browser` on this machine, and how do we run it?
 *
 * The same lesson as `node-runtime.ts` (#187): do NOT assume the binary is on
 * PATH. wmux hands its panes a curated environment, and npm's global bin
 * directory is frequently absent from the PATH the Electron process inherited.
 *
 * A second, sharper lesson, found while wiring this up: `npm i -g agent-browser`
 * puts a `.cmd` shim on Windows, and Node's own `child_process` refuses to
 * spawn a `.bat`/`.cmd` without `shell: true` (the CVE-2024-27980 mitigation) —
 * it throws a synchronous EINVAL, not a callback error. `shell: true` is not an
 * acceptable fix here: argv can carry agent-controlled URLs and `eval` JS, and
 * shelling out would run them through cmd.exe's parser, the exact trap
 * `powershell-shim.ts` documents. The actual fix is that the npm package ships
 * a real per-platform `.exe`/binary under its own `node_modules/agent-browser/bin/`
 * (see `platformBinaryName`), and resolution prefers that over any shim — so
 * the `.cmd` is simply never a candidate (see `AGENT_BROWSER_NAMES`). We always
 * spawn by ABSOLUTE path regardless.
 *
 * Resolution is pure (`resolveAgentBrowserBinary`) so it is testable with no
 * filesystem, and memoised at the module boundary because it is read on the
 * pane-render path (#176: `where` cost 2x pty.spawn).
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Candidate basenames for a bare shim/binary sitting directly in a search dir
 * (PATH or a well-known install location), most preferred first.
 *
 * Deliberately no `.cmd`. Node refuses to spawn `.bat`/`.cmd` without
 * `shell: true` (the CVE-2024-27980 mitigation) and throws a synchronous
 * EINVAL, and `shell: true` would put agent-controlled URLs and `eval`
 * snippets through cmd.exe's parser — the exact trap `powershell-shim.ts`
 * documents. The npm package ships a real `.exe` internally (see
 * `platformBinaryName` below), which `resolveAgentBrowserBinary` searches for
 * FIRST, so the shim path is never needed for an `npm i -g` install and is
 * deliberately not searched here. `agent-browser` (extensionless) stays for
 * posix, where a cargo or Homebrew install puts a real binary at that name.
 */
export function AGENT_BROWSER_NAMES(platform: string): string[] {
  return platform === 'win32' ? ['agent-browser.exe'] : ['agent-browser'];
}

/**
 * The name of the native binary the npm package ships internally, per
 * platform + arch — e.g. `agent-browser-win32-x64.exe`, `agent-browser-darwin-arm64`.
 *
 * `npm i -g agent-browser` installs a real per-platform executable under its
 * own `node_modules/agent-browser/bin/`, and (per the package's own postinstall
 * comment) patches the global shim to invoke it directly. That native binary is
 * never a `.cmd`/`.bat`, so resolving straight to it sidesteps the EINVAL trap
 * `AGENT_BROWSER_NAMES` documents above with no shell and no new dependency.
 */
export function platformBinaryName(platform: string, arch: string): string {
  return `agent-browser-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
}

/**
 * Directories that could be an npm global root, i.e. contain
 * `node_modules/agent-browser/bin/<platformBinaryName>`.
 *
 * On Windows the npm global root and the shim dir are the same folder
 * (`%APPDATA%\npm`). On posix they usually are not — the bin symlinks live in
 * `{prefix}/bin` while packages live in `{prefix}/lib/node_modules` — so this
 * list is intentionally separate from `searchDirs`.
 */
function npmGlobalRootDirs(env: NodeJS.ProcessEnv, platform: string): string[] {
  const dirs: (string | undefined)[] = platform === 'win32'
    ? [env.APPDATA && path.join(env.APPDATA, 'npm')]
    : [
        '/usr/local/lib/node_modules',
        '/usr/lib/node_modules',
        '/opt/homebrew/lib/node_modules',
        env.HOME && path.join(env.HOME, '.npm-global', 'lib', 'node_modules'),
      ];
  return dirs.filter((d): d is string => typeof d === 'string' && d.length > 0);
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
  /** Needed to name the npm package's internal native binary (see `platformBinaryName`). */
  arch: string;
  exists: (p: string) => boolean;
}

/**
 * Absolute path to the binary, or null when it is not installed.
 *
 * A configured path that does not exist returns null rather than falling back:
 * the user asked for a specific binary, and silently running a different one is
 * the wrong kind of helpful.
 *
 * Search order: configured path, then the npm package's own native binary,
 * then a bare shim/binary on PATH or in a well-known install dir. The npm
 * package binary is checked before the generic search because it is never a
 * `.cmd`/`.bat` shim (see `AGENT_BROWSER_NAMES`'s header comment) — an
 * `npm i -g agent-browser` install should never fall through to a form that
 * throws EINVAL when actually spawned.
 */
export function resolveAgentBrowserBinary(opts: ResolveOptions): string | null {
  const { configured, env, platform, arch, exists } = opts;
  if (configured) return exists(configured) ? configured : null;

  const nativeName = platformBinaryName(platform, arch);
  for (const root of npmGlobalRootDirs(env, platform)) {
    const candidate = path.join(root, 'node_modules', 'agent-browser', 'bin', nativeName);
    if (exists(candidate)) return candidate;
  }

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
    arch: process.arch,
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
    // `shell` is deliberately never set. Resolution above only ever returns a
    // real executable (a native `.exe`/extensionless binary, never a
    // `.cmd`/`.bat` shim), so no shell is needed to launch it — and adding
    // `shell: true` here would route argv (which can carry agent-controlled
    // URLs and `eval` JS) through the platform shell's parser, undoing the
    // whole point of resolving past the shim in the first place.
    execFile(binary, argv, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      let data: any = null;
      try { data = JSON.parse(stdout); } catch { /* not every verb emits JSON */ }
      resolve({ ok: !err, data, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}
