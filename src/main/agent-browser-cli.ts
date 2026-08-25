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
 * `powershell-shim.ts` documents (#154). The actual fix is that the npm package ships
 * a real per-platform `.exe`/binary under its own `node_modules/agent-browser/bin/`
 * (see `platformBinaryName`), and resolution prefers that over any shim — so
 * the `.cmd` is simply never a candidate (see `AGENT_BROWSER_NAMES`). We always
 * spawn by ABSOLUTE path regardless.
 *
 * Resolution is pure (`resolveAgentBrowserBinary`) so it is testable with no
 * filesystem, and memoised at the module boundary because it is read on the
 * pane-render path (#176: `where` cost 2x pty.spawn).
 */
import { execFile, ExecException } from 'child_process';
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
 * documents (#154). The npm package ships a real `.exe` internally (see
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

/**
 * The PATH entries of `env`, under whichever casing this platform used.
 *
 * Mirrors `node-runtime.ts`'s `pathDirs()`: Windows env vars are
 * case-insensitive, but a plain JS object is not, so `env.PATH` alone misses a
 * `Path` (the actual Windows spelling) or a `path`.
 */
function pathDirs(env: NodeJS.ProcessEnv, platform: string): string[] {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const raw = key ? env[key] : undefined;
  if (!raw) return [];
  const delimiter = platform === 'win32' ? ';' : ':';
  return raw.split(delimiter).filter(Boolean);
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
  return [...dirs, ...pathDirs(env, platform)].filter((d): d is string => typeof d === 'string' && d.length > 0);
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

/** Real-filesystem probe used by every caller except tests. */
function statExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// `cachedFor` records the `configured` value the cached answer was resolved
// against. `cachedPath === undefined` means "never resolved yet" (distinct
// from a resolved-to-null "not installed"), matching `cachedFor` being
// meaningless until then.
let cachedFor: string | undefined;
let cachedPath: string | null | undefined;

export interface AgentBrowserPathDeps {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  exists?: (p: string) => boolean;
}

/**
 * Memoised resolution against the real machine.
 *
 * Two distinct triggers invalidate the cache, and they are not the same thing:
 *   - `configured` changing (e.g. the user edits the agent-browser path in
 *     Settings) is a CACHE KEY change — the old answer was correct for the old
 *     key and is simply the wrong answer to today's question, so this is
 *     handled unconditionally, with no flag needed from the caller.
 *   - `force` is for the same key producing a new answer at the same location
 *     (a binary just got installed, or `npm i -g agent-browser` ran) — that is
 *     a fresh probe of unchanged inputs, which only an explicit caller request
 *     should trigger.
 * Correctness of the first case must not rest on every caller remembering to
 * pass `force`; only the second case is optional.
 *
 * `deps` is a test seam (mirrors passing `exists`/`env`/`platform` into
 * `resolveAgentBrowserBinary` directly) — real callers omit it and get
 * `process.env`/`process.platform`/`process.arch`/a real `fs.statSync` probe.
 */
export function agentBrowserPath(configured?: string, force = false, deps: AgentBrowserPathDeps = {}): string | null {
  if (!force && cachedPath !== undefined && cachedFor === configured) return cachedPath;
  cachedFor = configured;
  cachedPath = resolveAgentBrowserBinary({
    configured,
    env: deps.env ?? process.env,
    platform: deps.platform ?? process.platform,
    arch: deps.arch ?? process.arch,
    exists: deps.exists ?? statExists,
  });
  return cachedPath;
}

/** Test seam: drop the memoised answer (mirrors `node-runtime.ts`'s `resetNodeRuntimeCache`). */
export function resetAgentBrowserCache(): void {
  cachedFor = undefined;
  cachedPath = undefined;
}

export interface RunResult {
  /** True only when the process ran to completion with exit code 0. */
  ok: boolean;
  /**
   * True when the process never started at all — a spawn-level failure such
   * as `ENOENT` (the resolved path went stale), `EACCES`, or the `.cmd` EINVAL
   * trap this file exists to avoid. False whenever the process DID start,
   * including a non-zero exit: that is a normal CLI-reported failure, and its
   * `stderr` is what should reach the agent, not a re-resolve.
   *
   * These are opposite reactions to the same `!ok` and must not be conflated:
   * a caller that sees `spawnFailed` should re-resolve the binary (the cached
   * path is probably wrong); a caller that sees `!spawnFailed` should show the
   * agent `stderr` (the CLI ran and has something to say).
   */
  spawnFailed: boolean;
  /** Parsed JSON when the CLI emitted it, else null. Callers must narrow before use. */
  data: unknown;
  /** Raw stdout, kept for verbs whose payload is not JSON. */
  stdout: string;
  stderr: string;
}

/** A spawn-level failure sets `err.code` to an errno STRING (e.g. `ENOENT`); a
 *  non-zero exit sets it to the exit code NUMBER instead — that is how Node's
 *  own `child_process` docs distinguish the two, and the only reliable seam. */
function isSpawnFailure(err: ExecException | null): boolean {
  return !!err && typeof err.code === 'string';
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
      let data: unknown = null;
      try { data = JSON.parse(stdout); } catch { /* not every verb emits JSON */ }
      resolve({ ok: !err, spawnFailed: isSpawnFailure(err), data, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}
