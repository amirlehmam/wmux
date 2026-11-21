import * as fs from 'fs';
import * as path from 'path';

/**
 * A stand-in for `wsl.exe -d <distro> [--cd <dir>] --exec <program> <args…>` that
 * counts how many times it is started and how many run at once, for the tests of
 * the local-WSL path (a folder on `\\wsl.localhost\<distro>\…`).
 *
 * It does what wsl.exe does for these tests: changes into `--cd` and runs the
 * program without a shell, in the local file system, so a "WSL folder" in a test is
 * a real directory (`\\wsl.localhost\Ubuntu\tmp\x` stands for `/tmp/x`). It appends
 * `s` when it starts and `e` when it ends to a log, and `p:<program>` for what it
 * ran, so a test can state how many spawns an action costs and whether they overlapped.
 */
export interface WslSpawnCounter {
  /** Path of the fake wsl.exe. */
  exe: string;
  /** Starts since the last reset. */
  spawns(): number;
  /** The most that were running at the same moment since the last reset. */
  peak(): number;
  /** The program each start ran (`git`, `sh`), in order. */
  programs(): string[];
  reset(): void;
}

export function makeWslSpawnCounter(
  dir: string,
  name = 'counting-wsl',
  delayMs = 40,
  /** Exit 125 for a start that runs `sh` (a batch or a worker), so a caller has to take its one-git-per-spawn fallback. */
  refuseSh = false,
): WslSpawnCounter {
  const log = path.join(dir, `${name}.log`);
  const exe = path.join(dir, name);
  fs.writeFileSync(log, '');
  fs.writeFileSync(
    exe,
    `#!/bin/sh
printf 's\\n' >> '${log}'
sleep ${(delayMs / 1000).toFixed(3)}
shift 2
if [ "$1" = "--cd" ]; then cd "$2" || { printf 'e\\n' >> '${log}'; exit 1; }; shift 2; fi
shift
printf 'p:%s\\n' "$1" >> '${log}'
${refuseSh ? `case "$1" in sh) printf 'e\\n' >> '${log}'; exit 125;; esac\n` : ''}"$@"
rc=$?
printf 'e\\n' >> '${log}'
exit $rc
`,
    { mode: 0o755 },
  );
  const events = (): string[] => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    exe,
    spawns: () => events().filter((e) => e === 's').length,
    peak: () => {
      let active = 0;
      let peak = 0;
      for (const e of events()) {
        if (e !== 's' && e !== 'e') continue;
        active += e === 's' ? 1 : -1;
        peak = Math.max(peak, active);
      }
      return peak;
    },
    programs: () => events().filter((e) => e.startsWith('p:')).map((e) => e.slice(2)),
    reset: () => fs.writeFileSync(log, ''),
  };
}
