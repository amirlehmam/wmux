#!/usr/bin/env node
/**
 * test-posix.mjs — run the suites that need a POSIX shell, and refuse to skip any.
 *
 * The ssh-workspace suites (the explorer jail, the git batch script, the worker, the
 * `diff --no-index` symlink check...) run real `sh` and `git` in place of ssh and
 * wsl.exe. On Windows they are skipped (tests/helpers/posix-tools.ts), and the release
 * is built on a Windows runner, so `npm test` there gates none of them. This is what
 * the Linux job of release.yml runs instead:
 *
 *   - the files are found, not listed: every test file that imports the posix-tools
 *     helper, so a new suite is covered the day it is written;
 *   - WMUX_REQUIRE_POSIX=1 turns the helper's "skip" into a failure, so a runner that
 *     lost `sha1sum` or GNU find fails the release instead of passing with nothing run.
 *
 * Usage: node scripts/test-posix.mjs [extra vitest args]
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function testFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(full));
    else if (entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

const files = testFiles(join(root, 'tests'))
  .filter((file) => /helpers\/posix-tools['"]/.test(readFileSync(file, 'utf8')))
  .map((file) => relative(root, file).split('\\').join('/'))
  .sort();

if (files.length === 0) {
  console.error('test-posix: no suite imports tests/helpers/posix-tools. The filter is wrong, or the suites are gone.');
  process.exit(1);
}
if (process.platform === 'win32') {
  console.error('test-posix: these suites need a POSIX sh and are skipped on Windows. Run this on Linux or in WSL.');
  process.exit(1);
}

console.log(`test-posix: ${files.length} files`);
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const ran = spawnSync(process.execPath, [vitest, 'run', ...files, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, WMUX_REQUIRE_POSIX: '1' },
});
process.exit(ran.status ?? 1);
