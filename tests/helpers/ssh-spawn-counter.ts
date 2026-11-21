import * as fs from 'fs';
import * as path from 'path';

/**
 * A fake "ssh" that counts how many times it is started and how many run at once.
 *
 * It does what the real ssh does for these tests (runs the one command string in a local
 * `sh -c`), and appends `s` when it starts and `e` when it ends to a log file, so a
 * test can state how many remote spawns an action costs and whether they overlapped.
 * `delayMs` keeps each call alive long enough for concurrent calls to overlap.
 */
export interface SpawnCounter {
  /** Path of the fake ssh executable. */
  tool: string;
  /** Spawns since the last reset. */
  spawns(): number;
  /** The most calls that were running at the same moment since the last reset. */
  peak(): number;
  reset(): void;
}

export function makeSpawnCounter(
  dir: string,
  name = 'counting-ssh',
  delayMs = 40,
  /** Exit 125 for the git batch script, so a caller has to take its one-spawn-per-command fallback. */
  refuseBatch = false,
): SpawnCounter {
  const log = path.join(dir, `${name}.log`);
  const tool = path.join(dir, name);
  fs.writeFileSync(log, '');
  fs.writeFileSync(
    tool,
    `#!/bin/sh\nprintf 's\\n' >> '${log}'\nfor last; do :; done\nsleep ${(delayMs / 1000).toFixed(3)}\n${refuseBatch ? "case $last in *nonce=\\$2*) printf 'e\\n' >> '" + log + "'; exit 125;; esac\n" : ''}sh -c "$last"\nrc=$?\nprintf 'e\\n' >> '${log}'\nexit $rc\n`,
    { mode: 0o755 },
  );
  const events = (): string[] => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    tool,
    spawns: () => events().filter((e) => e === 's').length,
    peak: () => {
      let active = 0;
      let peak = 0;
      for (const e of events()) {
        active += e === 's' ? 1 : -1;
        peak = Math.max(peak, active);
      }
      return peak;
    },
    reset: () => fs.writeFileSync(log, ''),
  };
}
