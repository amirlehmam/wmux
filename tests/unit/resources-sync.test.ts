import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Issues #168 / #169: `resources/` carries checked-in copies of things that
 * have a source elsewhere, and nothing kept them in step.
 *
 * `resources/shell-integration/` is a copy of `src/shell-integration/`. All
 * three files had drifted, and the PowerShell one predated the pipe's auth gate
 * (#72) — so it sent V1 lines with no token, the pipe answered `unauthorized`,
 * and a pane running that copy reported no cwd, no branch, no shell state and
 * no PR while having no way to notice.
 *
 * This is the same failure as #137, where a second copy of the app icon went
 * stale for three releases: a duplicate with no enforcement is not a duplicate,
 * it is a time bomb. Resyncing fixes today's drift; only a check fixes
 * tomorrow's.
 *
 * The CLI half of the invariant (`resources/cli/*.js` vs `dist/cli/*.js`) is
 * checked by `npm run verify:resources` rather than here, because it needs a
 * build to exist. This file covers the half that needs nothing, so it runs on
 * every `npm test` — which is what gates a release in CI.
 */
const ROOT = path.join(__dirname, '..', '..');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) out.push(...filesUnder(full).map((f) => path.join(entry, f)));
    else out.push(entry);
  }
  return out.sort();
}

/** Newline-normalised: these are checked in on Windows with core.autocrlf. */
function read(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

describe('resources/shell-integration mirrors src/ (issues #168, #169)', () => {
  const src = path.join(ROOT, 'src', 'shell-integration');
  const copy = path.join(ROOT, 'resources', 'shell-integration');

  it('has exactly the same set of files', () => {
    expect(filesUnder(copy)).toEqual(filesUnder(src));
  });

  it.each(filesUnder(path.join(ROOT, 'src', 'shell-integration')))(
    '%s is byte-identical to its source',
    (file) => {
      expect(read(path.join(copy, file))).toBe(read(path.join(src, file)));
    },
  );

  it('the PowerShell copy authenticates, which is what the drift cost (#72)', () => {
    // Named directly rather than left to the byte comparison above, because
    // this is the property whose absence was invisible: the pipe rejects every
    // V1 command but `ping` without an `auth <token> ` prefix, and the
    // integration has no channel to learn it was rejected. A future edit that
    // drops it would otherwise only fail as "the files differ".
    const ps = read(path.join(copy, 'wmux-powershell-integration.ps1'));
    expect(ps).toMatch(/auth\s+\$/);
  });
});
