/**
 * Which binary on this machine can run a `.js` file (issue #187).
 *
 * Every wmux integration point that is "a JS file plus something to run it"
 * — the `wmux`/`wmux.cmd` CLI shims, the Claude Code hook, the OpenCode plugin
 * — has so far assumed `node` is on PATH, or that the host process is itself a
 * JS runtime. Neither holds in general:
 *
 *   - Claude Code's `process.execPath` IS node.exe, so the OpenCode plugin's
 *     `execFile(process.execPath, [cli, ...])` worked and nobody noticed.
 *   - OpenCode ships as one compiled Bun binary, so the same line becomes
 *     `opencode.exe wmux.js agent-activity ...`, which prints OpenCode's help
 *     page and exits — silently, because the callback discarded the error.
 *   - Node can be installed and still be absent from PATH inside a given
 *     process, which is exactly what #187 reported.
 *
 * So wmux answers the question once, in the process that has the best view of
 * the machine, and hands the answer down as `WMUX_NODE`. The last resort is
 * wmux's own Electron binary, which runs plain Node when spawned with
 * `ELECTRON_RUN_AS_NODE=1` — meaning the chain never dead-ends, even on a
 * machine with no Node installed at all.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface NodeRuntime {
  /** Absolute path to the binary (or the bare name `node` as a last resort). */
  path: string;
  /** True when `path` is Electron and needs `ELECTRON_RUN_AS_NODE=1` to behave as Node. */
  electron: boolean;
}

/** Basenames we accept as a JS runtime, with or without the Windows extension. */
const JS_RUNTIME_RE = /^(node|bun)(\.exe)?$/i;

/** Candidate binary names to look for, most preferred first. */
function runtimeNames(platform: string): string[] {
  return platform === 'win32' ? ['node.exe', 'bun.exe'] : ['node', 'bun'];
}

/**
 * Default install locations, tried after PATH.
 *
 * PATH is the right answer when it has one, but the reporting case for #187 was
 * a machine where node lives at `%LOCALAPPDATA%\Programs\nodejs\node.exe` and
 * simply is not on the PATH the agent process inherited.
 */
function wellKnownDirs(env: NodeJS.ProcessEnv, platform: string): string[] {
  if (platform === 'win32') {
    return [
      env.ProgramFiles && path.join(env.ProgramFiles, 'nodejs'),
      env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)']!, 'nodejs'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'nodejs'),
      env.APPDATA && path.join(env.APPDATA, 'npm'),
      env.USERPROFILE && path.join(env.USERPROFILE, '.bun', 'bin'),
      env.USERPROFILE && path.join(env.USERPROFILE, 'scoop', 'shims'),
    ].filter((d): d is string => typeof d === 'string');
  }
  return [
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin',
    env.HOME ? path.join(env.HOME, '.bun', 'bin') : '',
    env.HOME ? path.join(env.HOME, '.local', 'bin') : '',
  ].filter((d) => d !== '');
}

/** The PATH entries of `env`, under whichever casing this platform used. */
function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const raw = key ? env[key] : undefined;
  return raw ? raw.split(path.delimiter).filter((d) => d !== '') : [];
}

/**
 * Pure core, so the search order is testable without a machine to search.
 *
 * `execPath` is checked FIRST when it is already a JS runtime: a wmux embedded
 * in a Node host should use that host rather than go hunting, and it also keeps
 * the dev-vs-packaged answer stable.
 */
export function findNodeRuntime(
  env: NodeJS.ProcessEnv,
  execPath: string,
  platform: string,
  exists: (p: string) => boolean,
): NodeRuntime | null {
  const names = runtimeNames(platform);
  if (JS_RUNTIME_RE.test(path.basename(execPath))) return { path: execPath, electron: false };
  for (const dir of [...pathDirs(env), ...wellKnownDirs(env, platform)]) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return { path: candidate, electron: false };
    }
  }
  return null;
}

let cached: NodeRuntime | null = null;

/**
 * The JS runtime this install hands to agents, memoised.
 *
 * Memoised because `getNodeRuntime()` is read on the pane-create path, which is
 * synchronous on the main loop — #176 was exactly this: a per-pane `where`
 * lookup costing twice what spawning the PTY did. The answer cannot change
 * while wmux is running, so one filesystem walk per launch is the right budget.
 */
export function getNodeRuntime(): NodeRuntime {
  if (cached) return cached;
  const found = findNodeRuntime(process.env, process.execPath, process.platform, (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  // No Node anywhere: fall back to wmux's own Electron binary, which is Node
  // when ELECTRON_RUN_AS_NODE is set. Consumers must honour `electron` — the
  // same exe launched WITHOUT that variable opens a second wmux window.
  cached = found ?? { path: process.execPath, electron: true };
  return cached;
}

/** Test seam: drop the memoised answer. */
export function resetNodeRuntimeCache(): void {
  cached = null;
}
