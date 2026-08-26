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
import { spawn } from 'child_process';
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

/** Hard cap on captured output, mirroring the `maxBuffer` execFile used to apply. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * How long to keep reading stdout after the child has already exited.
 *
 * See `runAgentBrowser`: we resolve on `'exit'` rather than `'close'`, and
 * `'exit'` makes no promise that everything the child wrote has been delivered
 * to us yet. In practice it has — but a truncated snapshot would be a silent,
 * data-dependent corruption, so we give the pipe a moment to drain. If the
 * stream closes on its own first (nothing is holding it open) we finish
 * immediately and pay nothing, so this is only ever spent on the daemon-
 * spawning commands that cannot close their pipe at all.
 */
const STDIO_DRAIN_MS = 50;

/**
 * Run one agent-browser invocation.
 *
 * ── Why `spawn`, and why `'exit'` rather than `'close'` ────────────────────
 * This used `execFile`, and it hung forever on the commands that matter most.
 * Measured against agent-browser 0.35.0, `open`ing a session cold:
 *
 *     execFile → callback never fires (killed at 3 min)
 *     spawn    → 'exit' at 787 ms, code 0, full stdout captured
 *
 * `execFile`'s callback fires on stdio CLOSE, not on process exit. Any
 * agent-browser command that starts a long-lived background process — the
 * first `open` of a session (starts the daemon), `dashboard start` — leaves
 * that daemon holding the inherited stdout pipe open for as long as it lives.
 * The child exits; the pipe does not close; the callback never runs. The verb
 * would burn its whole timeout and then be reported as a FAILURE despite
 * having succeeded, which is the worst of both outcomes.
 *
 * So: `spawn`, and resolve on `'exit'` — the event that actually means "this
 * process is done". `'error'` is where a spawn-level failure surfaces under
 * `spawn` (there is no callback `err` to inspect), which is what now drives
 * `spawnFailed`. The timeout is reimplemented here because `spawn` has no
 * `timeout` option with `execFile`'s semantics.
 *
 * Argv stays an ARRAY and `shell` is deliberately never set. Resolution above
 * only ever returns a real executable (a native `.exe`/extensionless binary,
 * never a `.cmd`/`.bat` shim), so no shell is needed — and `shell: true` would
 * route argv (which can carry agent-controlled URLs and `eval` JS) through the
 * platform shell's parser, undoing the whole point of resolving past the shim.
 *
 * `env` is merged over `process.env` rather than replacing it: the child still
 * needs PATH, APPDATA and the rest to find its own runtime. It exists for
 * `AGENT_BROWSER_STREAM_PORT`, which is the only supported way to pin a
 * session's stream port (see `enableAgentBrowser`).
 */
export function runAgentBrowser(
  binary: string,
  argv: string[],
  timeoutMs = 60_000,
  env?: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;

    const child = spawn(binary, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    });

    const finish = (result: Omit<RunResult, 'data'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      let data: unknown = null;
      try { data = JSON.parse(result.stdout); } catch { /* not every verb emits JSON */ }
      resolve({ ...result, data });
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({
        ok: false,
        spawnFailed: false,
        stdout,
        stderr: stderr || `agent-browser timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    const capture = (stream: NodeJS.ReadableStream | null, onChunk: (s: string) => void): void => {
      stream?.on('data', (chunk: Buffer) => onChunk(chunk.toString()));
    };
    capture(child.stdout, (s) => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += s; });
    capture(child.stderr, (s) => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += s; });

    // A spawn-level failure (ENOENT on a stale path, EACCES, the .cmd EINVAL
    // trap this file exists to avoid) arrives here and nowhere else.
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ ok: false, spawnFailed: true, stdout, stderr: stderr || err.message });
    });

    child.on('exit', (code) => {
      const done = (): void => finish({ ok: code === 0, spawnFailed: false, stdout, stderr });
      // If nothing is holding the pipe open, 'close' lands right behind 'exit'
      // and we finish with no delay at all.
      child.once('close', done);
      drainTimer = setTimeout(done, STDIO_DRAIN_MS);
    });
  });
}

/**
 * The payload out of an agent-browser result, with its envelope removed.
 *
 * `--json` wraps every verb's payload in `{success, data, error}` — verified
 * against 0.35.0 for snapshot, screenshot, eval, read, get url and get text,
 * including the failure form `{success:false, data:null, error:"Unknown ref: e1"}`.
 * Without `--json` the same verbs print bare text and there is no envelope at
 * all. Both forms reach us depending on the verb, so unwrapping happens in ONE
 * place and every consumer reads the inner payload without caring which it got.
 */
export function unwrapAgentData(res: Pick<RunResult, 'data'>): unknown {
  const d = res.data;
  if (d && typeof d === 'object' && 'success' in d && 'data' in d) {
    return (d as { data: unknown }).data;
  }
  return d;
}
