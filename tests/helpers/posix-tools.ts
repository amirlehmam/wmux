import { spawnSync } from 'child_process';

/**
 * Whether a suite that runs `#!/bin/sh` fakes or POSIX tools can run here.
 *
 * The fake ssh and wsl.exe of these tests are shell scripts, and the remote
 * scripts they run need GNU find, `stat -c`, awk and the rest. None of that is
 * on a stock Windows runner, so every such suite asks this one function and is
 * SKIPPED there rather than failing: `describe.skipIf(!hasPosixTools([...]))`.
 * Tests of pure logic (parsers, validators, argv builders, gates with injected
 * fakes) never ask, and run everywhere.
 *
 * False on `win32` whatever the probes would say (Git for Windows ships an `sh`
 * that passes some of them and still is not the environment these fakes assume),
 * and false when a probe fails. A probe runs once per process.
 *
 * The release is built on a Windows runner, so a skip there means the suite gates
 * nothing. The Linux job of release.yml runs these suites (`npm run test:posix`) with
 * `WMUX_REQUIRE_POSIX=1`, and then a missing tool THROWS: a runner that cannot run
 * them fails the release instead of passing with nothing run.
 */
export type PosixTool = 'git' | 'gnu-find' | 'stat-c' | 'awk' | 'base64' | 'mktemp' | 'head' | 'wc' | 'sed' | 'sha1sum';

const SH_PROBES: Record<Exclude<PosixTool, 'git'>, string> = {
  'gnu-find': 'find . -maxdepth 0 -printf x',
  'stat-c': 'stat -c %a . >/dev/null',
  awk: 'awk "BEGIN{}"',
  base64: 'echo eA== | base64 -d >/dev/null',
  mktemp: 'mktemp -u >/dev/null',
  head: 'head -c 1 /dev/null',
  wc: 'wc -c </dev/null >/dev/null',
  sed: 'sed p </dev/null',
  sha1sum: 'sha1sum </dev/null >/dev/null',
};

const memo = new Map<string, boolean>();

function probe(key: string, run: () => boolean): boolean {
  let known = memo.get(key);
  if (known === undefined) {
    try { known = run(); } catch { known = false; }
    memo.set(key, known);
  }
  return known;
}

/** `sh` is always required; `needs` adds the tools a suite actually uses. */
export function hasPosixTools(needs: readonly PosixTool[] = [], platform: NodeJS.Platform = process.platform): boolean {
  const missing = missingPosixTools(needs, platform);
  if (missing.length > 0 && process.env.WMUX_REQUIRE_POSIX === '1') {
    throw new Error(`WMUX_REQUIRE_POSIX=1 but this suite cannot run here: missing ${missing.join(', ')}`);
  }
  return missing.length === 0;
}

/** What `needs` asks for and this machine lacks; `sh` first, and alone when it is the one missing. */
function missingPosixTools(needs: readonly PosixTool[], platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return ['a POSIX platform'];
  if (!probe('sh', () => spawnSync('sh', ['-c', 'true']).status === 0)) return ['sh'];
  return needs.filter((tool) => !probe(tool, () => (tool === 'git'
    ? spawnSync('git', ['--version']).status === 0
    : spawnSync('sh', ['-c', SH_PROBES[tool]]).status === 0)));
}
