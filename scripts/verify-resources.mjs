#!/usr/bin/env node
/**
 * Fail when a checked-in copy under resources/ has drifted from its source.
 *
 * ## Why this exists
 *
 * `resources/shell-integration/` and `resources/cli/*.js` are duplicates with
 * no enforcement — a copy of `src/shell-integration/` and of the `tsc` output
 * in `dist/cli/` respectively. Nothing kept either in step, and both had
 * silently rotted (#168, #169): the packaged PowerShell integration predated
 * the pipe's auth gate, so it sent V1 lines with no token and every report was
 * rejected into a void, and `resources/cli/wmux.js` was ~1700 diff lines behind
 * a build of its own source.
 *
 * This is the same failure as #137, where a second copy of the app icon went
 * stale for three releases. The lesson there was that a duplicate without
 * enforcement is not a duplicate, it is a time bomb — so rather than resync and
 * hope, the invariant is now checked.
 *
 * ## What it does NOT claim
 *
 * Neither directory is read by a released install. `electron-builder.json` maps
 * `src/shell-integration` and `dist/cli/*.js` into the package, and
 * `getShellIntegrationPath()` falls back to `src/` in dev — so a packaged wmux
 * has always run fresh sources. What reads the copies is dev-mode Claude hook
 * registration (`claude-context.ts`, for `resources/cli/wmux-hook.js`) and
 * anything consuming wmux out of a repo checkout, which is how the drift
 * surfaced in the first place.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const problems = [];

/** Every file under `dir`, relative to it, recursively. */
function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full).map((f) => join(entry, f)));
    else out.push(entry);
  }
  return out.sort();
}

/**
 * Compare two directories file-for-file, by content.
 *
 * `keep` narrows which files participate. The CLI case needs it: `tsc` also
 * emits `.d.ts` (and would emit `.js.map` if configured), none of which the
 * copy carries or the package ships — only the two `.js` entry points matter.
 */
function compareDirs(sourceDir, copyDir, label, keep = () => true) {
  const source = join(root, sourceDir);
  const copy = join(root, copyDir);
  if (!existsSync(source)) return problems.push(`${label}: missing source ${sourceDir}`);
  if (!existsSync(copy)) return problems.push(`${label}: missing copy ${copyDir}`);

  const sourceFiles = filesUnder(source).filter(keep);
  const copyFiles = filesUnder(copy).filter(keep);

  for (const f of sourceFiles) {
    if (!copyFiles.includes(f)) problems.push(`${label}: ${relative(root, join(copy, f))} is missing`);
  }
  for (const f of copyFiles) {
    if (!sourceFiles.includes(f)) problems.push(`${label}: ${relative(root, join(copy, f))} has no source`);
  }
  for (const f of sourceFiles.filter((f) => copyFiles.includes(f))) {
    // Compared as bytes, and newline-normalised first: these files are checked
    // in on Windows with core.autocrlf in play, and a line-ending difference is
    // not drift worth failing a release over.
    const a = readFileSync(join(source, f), 'utf8').replace(/\r\n/g, '\n');
    const b = readFileSync(join(copy, f), 'utf8').replace(/\r\n/g, '\n');
    if (a !== b) problems.push(`${label}: ${relative(root, join(copy, f))} differs from ${sourceDir}/${f}`);
  }
}

compareDirs('src/shell-integration', 'resources/shell-integration', 'shell-integration');

// The CLI copies are build output, so they can only be checked once `dist/`
// exists. Skipping loudly rather than passing quietly — a check that silently
// does nothing is worse than no check, because it reads as coverage.
if (existsSync(join(root, 'dist/cli'))) {
  compareDirs('dist/cli', 'resources/cli', 'cli', (f) => f.endsWith('.js'));
} else {
  console.warn('[verify-resources] dist/cli not built — skipping the CLI artifact check.');
  console.warn('[verify-resources] Run `npm run build:main` first to include it.');
}

if (problems.length) {
  console.error('[verify-resources] checked-in copies have drifted from their sources:\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nRegenerate them:');
  console.error('  cp -r src/shell-integration/* resources/shell-integration/');
  console.error('  npm run build:main && cp dist/cli/wmux.js dist/cli/wmux-hook.js resources/cli/');
  process.exit(1);
}

console.log('[verify-resources] resources/ copies match their sources.');
