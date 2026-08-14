import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Guards against runtime-referenced files missing from the packaged app.
 *
 * Every `path.join(process.resourcesPath, 'X', …)` in the main process is a
 * promise that `X` will exist next to app.asar in an installed build. Nothing
 * enforces that promise at build time, and nothing surfaces it at runtime
 * either: each of those call sites is wrapped in an existsSync check that warns
 * to a console no user reads and returns. So the feature simply does not exist
 * in the shipped app while working perfectly in `npm run dev`, where the same
 * function falls back to a repo-relative path.
 *
 * That has now shipped twice:
 *   - #81  (fixed 0.29.1) cli/wmux-hook.js — every Claude Code hook silently
 *          failed, so workspaces stayed pinned on "Running" while Claude idled.
 *   - #149 (fixed here)   opencode-plugin/ — the OpenCode integration was
 *          absent from every release zip since it was introduced.
 *
 * The first fix added two literal assertions to this file. A test that
 * enumerates the failures it already knows about can only ever catch those, and
 * #149 walked straight past it. So the assertion below is *derived* from the
 * source instead: scan main/ for the resource names it asks for, and require
 * each one to be listed in extraResources. Adding a new
 * `process.resourcesPath` reference without packaging it now fails the release
 * build (`npm test` gates the tag — see .github/workflows/release.yml).
 */
describe('electron-builder packaging', () => {
  const repoRoot = path.join(__dirname, '../..');
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'electron-builder.json'), 'utf8'));
  const extraResources: Array<{ from: string; to: string }> = config.extraResources;

  /** First path segment of each `to` — the name that lands directly in resources/. */
  const packaged = new Set(extraResources.map((e) => e.to.split('/')[0]));

  /**
   * Resource names the main process expects at runtime. Matches the literal
   * argument right after `process.resourcesPath`, which is how every one of
   * these is written; a computed path would escape this scan, so keep them
   * literal.
   */
  function referencedResources(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    const mainDir = path.join(repoRoot, 'src/main');
    const re = /process\.resourcesPath\s*,\s*['"]([^'"]+)['"]/g;
    for (const file of fs.readdirSync(mainDir).filter((f) => f.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(mainDir, file), 'utf8');
      for (const match of src.matchAll(re)) {
        const name = match[1].split('/')[0];
        found.set(name, [...(found.get(name) ?? []), file]);
      }
    }
    return found;
  }

  it('packages every resource the main process resolves at runtime', () => {
    const missing = [...referencedResources()]
      .filter(([name]) => !packaged.has(name))
      .map(([name, files]) => `${name} (referenced by ${files.join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('finds the resource references it is meant to be checking', () => {
    // Guards the guard: a refactor that renames process.resourcesPath usage
    // would make the scan above vacuously pass.
    expect(referencedResources().size).toBeGreaterThanOrEqual(6);
  });

  it('ships every extraResources source that exists in-repo', () => {
    // `from` paths under resources/ and src/ are checked in; dist/ ones are
    // build output and only exist after `npm run build:main`.
    const missing = extraResources
      .filter((e) => !e.from.startsWith('dist/'))
      .filter((e) => !fs.existsSync(path.join(repoRoot, e.from)))
      .map((e) => e.from);
    expect(missing).toEqual([]);
  });

  it('ships the CLI entry point outside the asar', () => {
    // Bare `node <path>` cannot read an asar archive, so these two are not just
    // "packaged" but specifically packaged OUTSIDE it (#81).
    expect(extraResources).toContainEqual({ from: 'dist/cli/wmux.js', to: 'cli/wmux.js' });
  });

  it('ships the Claude Code hook helper outside the asar', () => {
    expect(extraResources).toContainEqual({ from: 'dist/cli/wmux-hook.js', to: 'cli/wmux-hook.js' });
  });

  it('ships the OpenCode plugin (#149)', () => {
    expect(extraResources).toContainEqual({ from: 'resources/opencode-plugin', to: 'opencode-plugin' });
  });

  /**
   * The CLI files are packaged one by one, not as a directory, so anything they
   * `require` from beside themselves has to be listed too — and unlike the
   * resource lookups above, a miss here is not a silently-absent feature but a
   * MODULE_NOT_FOUND on the first line of `wmux ping` and of every Claude Code
   * hook. `npm run dev` cannot see it: the module is right there in dist/.
   *
   * Derived rather than enumerated, for the same reason as the scan above — a
   * list of the ones we already know about is what #149 walked past.
   */
  function siblingImports(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length) {
      const name = queue.shift() as string;
      const file = path.join(repoRoot, 'src/cli', `${name}.ts`);
      if (!fs.existsSync(file)) continue;
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/(?:from|require\()\s*['"]\.\/([^'"]+)['"]/g)) {
        if (!seen.has(m[1])) { seen.add(m[1]); queue.push(m[1]); }
      }
    }
    return [...seen];
  }

  it('packages every sibling module the shipped CLI files require', () => {
    const entries = extraResources
      .filter((e) => e.from.startsWith('dist/cli/'))
      .map((e) => path.basename(e.from, '.js'));
    const shipped = new Set(entries);
    const missing: string[] = [];
    for (const entry of entries) {
      for (const dep of siblingImports(entry)) {
        if (!shipped.has(dep)) missing.push(`dist/cli/${dep}.js (required by ${entry}.js)`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('finds the sibling imports it is meant to be checking', () => {
    // Guards the guard: if the CLI stops sharing modules this goes vacuous, and
    // the next one added would slip through unnoticed.
    expect(siblingImports('wmux')).toContain('transport-deadline');
    expect(siblingImports('wmux-hook')).toContain('transport-deadline');
  });
});
