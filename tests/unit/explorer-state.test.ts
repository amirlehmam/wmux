import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  joinRel, sortEntries, toggleExpanded, pruneExpanded, flattenVisible, responseKey,
  pathRoot, toAbsolutePath, pickRootSurface, usableSticky,
  treeCacheKey, rememberTree, recallTree, forgetTree, nextRefillPaths,
} from '../../src/renderer/components/Explorer/explorer-state';

const dir = (name: string): any => ({ name, kind: 'dir', size: 0, mtimeMs: 0, viewable: false });
const file = (name: string, viewable = true): any => ({ name, kind: 'file', size: 1, mtimeMs: 0, viewable });

describe('joinRel', () => {
  it('joins with POSIX separators and treats the root as empty', () => {
    expect(joinRel('', 'docs')).toBe('docs');
    expect(joinRel('docs', 'nested')).toBe('docs/nested');
  });
  it('normalizes a backslash parent so keys never disagree', () => {
    expect(joinRel('docs\\nested', 'x')).toBe('docs/nested/x');
  });
});

describe('sortEntries', () => {
  it('puts directories before files, then locale-aware by name', () => {
    const out = sortEntries([file('b.md'), dir('zeta'), file('a.md'), dir('Alpha')]);
    expect(out.map((e: any) => e.name)).toEqual(['Alpha', 'zeta', 'a.md', 'b.md']);
  });
  it('groups symlinks with directories rather than with files', () => {
    const out = sortEntries([file('a.md'), { ...dir('link'), kind: 'symlink' }]);
    expect(out[0].name).toBe('link');
  });
  it('does not mutate its input', () => {
    const input = [file('b.md'), file('a.md')];
    sortEntries(input);
    expect(input.map((e) => e.name)).toEqual(['b.md', 'a.md']);
  });
});

describe('toggleExpanded', () => {
  it('adds and removes', () => {
    expect(toggleExpanded([], 'docs')).toEqual(['docs']);
    expect(toggleExpanded(['docs'], 'docs')).toEqual([]);
  });
  it('collapsing a parent also collapses its descendants', () => {
    expect(toggleExpanded(['docs', 'docs/nested', 'src'], 'docs')).toEqual(['src']);
  });
  it('does not collapse a sibling with a shared name prefix', () => {
    expect(toggleExpanded(['docs', 'docs-old'], 'docs')).toEqual(['docs-old']);
  });
});

describe('pruneExpanded', () => {
  it('keeps the newest maxRoots entries with the touched root last', () => {
    const out = pruneExpanded({ a: [], b: [], c: [] }, 'd', 3);
    expect(Object.keys(out)).toEqual(['b', 'c', 'd']);
  });
  it('re-touching an existing root moves it to the end without dropping it', () => {
    const out = pruneExpanded({ a: ['x'], b: [], c: [] }, 'a', 3);
    expect(Object.keys(out)).toEqual(['b', 'c', 'a']);
    expect(out.a).toEqual(['x']);
  });
});

describe('flattenVisible', () => {
  const tree = {
    '': [dir('docs'), file('README.md')],
    docs: [dir('nested'), file('guide.md')],
    'docs/nested': [file('deep.md')],
  };

  it('yields only the root when nothing is expanded', () => {
    expect(flattenVisible(tree as any, []).map((r) => r.relPath)).toEqual(['docs', 'README.md']);
  });

  it('yields rows in visual order with depth', () => {
    expect(flattenVisible(tree as any, ['docs']).map((r) => [r.relPath, r.depth])).toEqual([
      ['docs', 0], ['docs/nested', 1], ['docs/guide.md', 1], ['README.md', 0],
    ]);
  });

  it('descends into a second expanded level', () => {
    expect(flattenVisible(tree as any, ['docs', 'docs/nested']).map((r) => r.relPath)).toEqual([
      'docs', 'docs/nested', 'docs/nested/deep.md', 'docs/guide.md', 'README.md',
    ]);
  });

  it('yields no children for an expanded directory whose fetch is still in flight', () => {
    const partial = { '': [dir('docs')] };
    expect(flattenVisible(partial as any, ['docs']).map((r) => r.relPath)).toEqual(['docs']);
  });
});

describe('responseKey', () => {
  it('changes when any of surfaceId, root or relPath changes', () => {
    const base = responseKey('surf-1', 'C:\\repo', 'docs');
    expect(responseKey('surf-2', 'C:\\repo', 'docs')).not.toBe(base);
    expect(responseKey('surf-1', 'C:\\other', 'docs')).not.toBe(base);
    expect(responseKey('surf-1', 'C:\\repo', 'src')).not.toBe(base);
    expect(responseKey('surf-1', 'C:\\repo', 'docs')).toBe(base);
  });
});

// ─── Absolute path construction (the Git Bash / junction seam) ───────────────
// The renderer sends main a surfaceId and a rel-path, and main answers with the
// entries PLUS the absolute root it resolved. Building paths from the REPORTED
// cwd instead fails silently: enumeration still works (main normalizes on the
// way in), and only the clicks — open, reveal, open-in-default-app, copy path —
// die. String.raw throughout, so what is written is what is compared.

describe('pathRoot', () => {
  // The whole bug in one assertion. The bash integration reports `$(pwd)`.
  it('prefers the RESOLVED root over a Git Bash reported cwd', () => {
    const reported = '/c/Users/x/repo';
    const resolved = String.raw`C:\Users\x\repo`;
    expect(pathRoot(resolved, reported)).toBe(resolved);
    expect(toAbsolutePath(pathRoot(resolved, reported), 'docs/README.md'))
      .toBe(String.raw`C:\Users\x\repo\docs\README.md`);
  });

  it('does not produce the mixed-separator path the reported cwd would', () => {
    const fromReported = toAbsolutePath('/c/Users/x/repo', 'README.md');
    const fromResolved = toAbsolutePath(
      pathRoot(String.raw`C:\Users\x\repo`, '/c/Users/x/repo'), 'README.md',
    );
    // What shipped: a string no Windows API accepts.
    expect(fromReported).toBe(String.raw`/c/Users/x/repo\README.md`);
    expect(fromResolved).not.toBe(fromReported);
    expect(fromResolved.startsWith('C:')).toBe(true);
  });

  // The subtler PowerShell half: a junction, an 8.3 short name, or different
  // casing. Main returns the realpath; keeping the alias means the path saved
  // and revealed is not the path listed.
  it('prefers the realpath over an aliased Windows cwd', () => {
    expect(pathRoot(String.raw`C:\Users\x\repo`, String.raw`C:\junction\repo`))
      .toBe(String.raw`C:\Users\x\repo`);
    expect(pathRoot(String.raw`C:\Users\Derek Neely\repo`, String.raw`C:\Users\DEREKN~1\repo`))
      .toBe(String.raw`C:\Users\Derek Neely\repo`);
  });

  // Only until the first root reply lands — in that window it is the reported
  // cwd or nothing at all.
  it('falls back to the reported cwd before any root reply has arrived', () => {
    const reported = String.raw`C:\Users\x\repo`;
    expect(pathRoot(null, reported)).toBe(reported);
    expect(pathRoot(undefined, reported)).toBe(reported);
    // An empty resolved root is not a root either.
    expect(pathRoot('', reported)).toBe(reported);
  });
});

describe('toAbsolutePath', () => {
  it('converts POSIX rel-paths to backslashes and strips a trailing root separator', () => {
    expect(toAbsolutePath(String.raw`C:\repo`, 'a/b/c.md')).toBe(String.raw`C:\repo\a\b\c.md`);
    // Not String.raw here: a raw template may not END in a backslash.
    expect(toAbsolutePath('C:\\repo\\', 'a.md')).toBe(String.raw`C:\repo\a.md`);
    expect(toAbsolutePath(String.raw`C:\repo//`, 'a.md')).toBe(String.raw`C:\repo\a.md`);
  });

  it('returns the root itself for an empty rel-path, with no dangling separator', () => {
    expect(toAbsolutePath(String.raw`C:\repo`, '')).toBe(String.raw`C:\repo`);
  });
});

describe('pickRootSurface', () => {
  const term = (id: string) => ({ id, type: 'terminal' });
  const md = (id: string) => ({ id, type: 'markdown' });

  it('uses the active surface when it is a terminal', () => {
    const surfaces = [term('a'), term('b')];
    expect(pickRootSurface(surfaces, 1, 'a')?.id).toBe('b');
  });

  it('falls back to the last active terminal when a markdown preview is active', () => {
    // The exact regression: clicking a file in the tree opens a markdown tab in
    // the same pane, and the tree must stay on the terminal's directory.
    const surfaces = [term('a'), term('b'), md('p')];
    expect(pickRootSurface(surfaces, 2, 'b')?.id).toBe('b');
  });

  it('falls back to the first terminal when the remembered one has closed', () => {
    const surfaces = [term('a'), md('p')];
    expect(pickRootSurface(surfaces, 1, 'gone')?.id).toBe('a');
  });

  it('ignores a remembered id that is no longer a terminal', () => {
    const surfaces = [term('a'), md('b')];
    expect(pickRootSurface(surfaces, 1, 'b')?.id).toBe('a');
  });

  it('returns null for a pane with no terminal at all', () => {
    expect(pickRootSurface([md('p')], 0, null)).toBeNull();
  });
});

// ─── Wiring pin ──────────────────────────────────────────────────────────────
// The helpers above are only worth anything if the panel actually uses them.
// The failure mode is invisible at runtime (the tree paints; only the clicks
// die) and this project has no DOM test harness, so pin it at the source —
// the same tactic the opencode-plugin export-count test uses.
describe('ExplorerPanel wiring', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/renderer/components/Explorer/ExplorerPanel.tsx'),
    'utf-8',
  );

  it('stores the resolved root from the root reply', () => {
    expect(src).toContain('setResolvedRoot(result.root)');
  });

  it('builds absolute paths from the resolved root, never the reported cwd', () => {
    expect(src).toContain('pathRoot(resolvedRoot, root)');
    expect(src).toContain('toAbsolutePath(absRoot, relPath)');
    // No hand-rolled concatenation onto the reported cwd left anywhere.
    expect(src).not.toMatch(/\$\{root\.replace/);
  });

  it('keys the expansion map off the resolved root', () => {
    expect(src).toContain('[absRoot]: next');
    expect(src).toContain('expandedByRoot[absRoot]');
  });

  // The pane switch seeds from the cache instead of blanking, and Refresh drops
  // the entry first so it cannot serve the tree it is being asked to re-read.
  it('seeds the tree from the per-root cache on a re-root', () => {
    expect(src).toContain('recallTree(cacheRef.current, cacheKey)');
    expect(src).toContain('forgetTree(cacheRef.current, cacheKey)');
  });

  it('writes the cache under the key the fetch was made for', () => {
    expect(src).toContain('const callCacheKey = treeCacheKey(root, showHidden)');
    expect(src).toContain('rememberTree(cacheRef.current, callCacheKey');
  });

  // A dropped child listing used to stay marked forever, which is what left an
  // expanded folder showing an open chevron over nothing until it was collapsed
  // and reopened by hand.
  //
  // THREE sites need the unmark: the stale-reply path, the stale-REJECTION path
  // beside it, and the collapse. A rejection reaches the catch instead of the
  // reply branch, so it needs its own unmark or it strands the folder in exactly
  // the way the other two exist to prevent.
  //
  // The first two now share one helper rather than two copies of six lines, so
  // counting the delete no longer expresses this — it would pass at 2 whether
  // the catch path called the helper or silently didn't. Assert what actually
  // has to be true instead: the helper exists, and BOTH paths in fetchDir go
  // through it. The collapse keeps its own direct unmark (different guard, not
  // a stale reply), so the literal still appears there.
  it('unmarks a superseded child listing so the refill can ask again', () => {
    expect(src).toContain('requestedRef.current.key === key');
    expect(src).toContain('const dropIfStale = useCallback');
    // Once in the success path, once in the catch. Not one, not three.
    expect(src.match(/if \(dropIfStale\(relPath, key\)\) return;/g)).toHaveLength(2);
    // And the collapse still unmarks on its own.
    expect(src.match(/requestedRef\.current\.paths\.delete\(relPath\)/g)).toHaveLength(2);
  });

  // The catch is the half that is easy to lose in a refactor: a reader checking
  // "does the stale case unmark?" finds the success path, sees it handled, and
  // stops. Pin the rejection path by name.
  it('unmarks on a REJECTED listing, not only a superseded reply', () => {
    const catchBlock = src.slice(src.indexOf('} catch {', src.indexOf('const fetchDir')));
    expect(catchBlock).toContain('dropIfStale(relPath, key)');
  });
});

// ─── Wiring pin: the code viewer ─────────────────────────────────────────────
// Same tactic, same reason as the block above — a click that routes to the
// wrong surface type, or a MARKDOWN_EXT list that has drifted from main's
// ALLOWED_MD_EXT, fails silently at runtime.
describe('code viewer wiring', () => {
  it('open-preview routes non-markdown files to a code surface', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/renderer/components/Explorer/open-preview.ts'), 'utf-8',
    );
    expect(src).toContain('targetTypeFor');
    expect(src).toContain('window.wmux.code.readFile');
  });

  it('the renderer MARKDOWN_EXT list matches main ALLOWED_MD_EXT exactly', () => {
    // Two lists that must agree across a boundary the renderer may not import
    // across. Drift here silently sends .md files to the code viewer.
    const renderer = readFileSync(
      resolve(__dirname, '../../src/renderer/components/Explorer/open-preview.ts'), 'utf-8',
    );
    const main = readFileSync(resolve(__dirname, '../../src/main/markdown-file.ts'), 'utf-8');
    const exts = (s: string, marker: string): string[] => {
      const at = s.indexOf(marker);
      expect(at).toBeGreaterThanOrEqual(0);
      const body = s.slice(at, s.indexOf(']', at));
      return [...body.matchAll(/'(\.[a-z]+)'/g)].map((m) => m[1]).sort();
    };
    const rendererExts = exts(renderer, 'MARKDOWN_EXT = new Set');
    expect(rendererExts.length).toBeGreaterThan(0);
    expect(rendererExts).toEqual(exts(main, 'ALLOWED_MD_EXT = new Set'));
  });

  it('the panel passes surfaceId and relPath to openInPreviewTab', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/renderer/components/Explorer/ExplorerPanel.tsx'), 'utf-8',
    );
    expect(src).toContain('relPath: row.relPath');
  });
});

// The sticky root exists so a detour into a terminal-less pane does not blank
// the panel. A workspace switch is not a detour: held across one, the panel
// lists and reveals a folder from a workspace the user has left, and a file
// clicked there records THAT workspace's terminal as its code root.
describe('usableSticky', () => {
  const sticky = { workspaceId: 'ws-a', surfaceId: 'surf-1', root: 'C:\\repo' };

  it('keeps a root captured in the workspace still being viewed', () => {
    expect(usableSticky(sticky, 'ws-a')).toBe(sticky);
  });

  it('refuses a root captured in a different workspace', () => {
    expect(usableSticky(sticky, 'ws-b')).toBeNull();
  });

  it('refuses when there is no sticky root or no active workspace', () => {
    expect(usableSticky(null, 'ws-a')).toBeNull();
    expect(usableSticky(sticky, null)).toBeNull();
    expect(usableSticky(sticky, undefined)).toBeNull();
  });
});

// ─── The per-root tree cache ─────────────────────────────────────────────────
// `expanded` was already persisted per root, but `tree` — the loaded children —
// was thrown away on every pane switch and refetched. That refetch is where the
// expansion was being lost: a child listing dropped as stale left its path
// marked in the panel's attempt record and never retried, so the folder kept an
// open chevron with nothing under it until the user collapsed and reopened it
// by hand. Caching the tree means the common paths — switching to a pane in the
// same directory, and switching back to one visited before — do no fetching at
// all, so there is nothing left to drop.
describe('tree cache', () => {
  const tree = { '': [dir('docs')], docs: [file('a.md')] };

  it('hands back the tree a previous visit to the same root stored', () => {
    const key = treeCacheKey('C:\repo', false);
    const cache = rememberTree({}, key, { tree, resolvedRoot: 'C:\repo' }, 8);
    expect(recallTree(cache, key)?.tree).toEqual(tree);
    expect(recallTree(cache, key)?.resolvedRoot).toBe('C:\repo');
  });

  it('misses for a root never visited', () => {
    expect(recallTree({}, treeCacheKey('C:\repo', false))).toBeNull();
  });

  it('keys the hidden-file view separately, so it cannot serve a filtered tree', () => {
    const key = treeCacheKey('C:\repo', false);
    const cache = rememberTree({}, key, { tree, resolvedRoot: 'C:\repo' }, 8);
    expect(recallTree(cache, treeCacheKey('C:\repo', true))).toBeNull();
  });

  it('evicts the least recently written root once the cap is reached', () => {
    let cache = {};
    for (const root of ['a', 'b', 'c']) {
      cache = rememberTree(cache, treeCacheKey(root, false), { tree: {}, resolvedRoot: root }, 2);
    }
    expect(recallTree(cache, treeCacheKey('a', false))).toBeNull();
    expect(recallTree(cache, treeCacheKey('c', false))).not.toBeNull();
  });

  it('re-writing a root makes it the most recent, so it survives the next eviction', () => {
    let cache = {};
    cache = rememberTree(cache, treeCacheKey('a', false), { tree: {}, resolvedRoot: 'a' }, 2);
    cache = rememberTree(cache, treeCacheKey('b', false), { tree: {}, resolvedRoot: 'b' }, 2);
    cache = rememberTree(cache, treeCacheKey('a', false), { tree: {}, resolvedRoot: 'a' }, 2);
    cache = rememberTree(cache, treeCacheKey('c', false), { tree: {}, resolvedRoot: 'c' }, 2);
    expect(recallTree(cache, treeCacheKey('a', false))).not.toBeNull();
    expect(recallTree(cache, treeCacheKey('b', false))).toBeNull();
  });

  it('forgets one root, which is what Refresh needs', () => {
    const key = treeCacheKey('C:\repo', false);
    const cache = rememberTree({}, key, { tree, resolvedRoot: 'C:\repo' }, 8);
    expect(recallTree(forgetTree(cache, key), key)).toBeNull();
  });
});

// The gap between `expanded` (persisted) and `tree` (not) is what the panel
// closes by fetching. Pulled out of the effect so the rule is stated once and
// can be tested without a React tree.
describe('nextRefillPaths', () => {
  it('asks only for expanded folders whose children are not loaded', () => {
    const tree = { '': [dir('docs'), dir('src')], docs: [file('a.md')] };
    expect(nextRefillPaths(tree, ['docs', 'src'], new Set())).toEqual(['src']);
  });

  it('does not re-ask for a folder already in flight or already tried', () => {
    expect(nextRefillPaths({ '': [] }, ['src'], new Set(['src']))).toEqual([]);
  });

  it('asks for nothing until the root itself has listed', () => {
    expect(nextRefillPaths({}, ['src'], new Set())).toEqual([]);
  });
});

// ─── Wiring pin: the command palette ────────────────────────────────────
// The palette builds its Actions category by iterating every ShortcutAction, so
// adding `toggleExplorer` to DEFAULT_SHORTCUTS also puts it in the palette —
// where it reaches App.tsx's `onAction`. That handler dispatches on the action
// name and hands anything it does not recognise to a console.log, so an entry
// with no case is selectable and does nothing. Exactly the failure the
// prompt-log actions are called out for in CLAUDE.md; this pins ours beside
// them. There is deliberately only ONE explorer entry: routing it through the
// shared handler is what lets the palette show its Ctrl+Shift+X binding.
describe('command palette wiring', () => {
  const app = readFileSync(resolve(__dirname, '../../src/renderer/App.tsx'), 'utf-8');
  const palette = readFileSync(
    resolve(__dirname, '../../src/renderer/components/CommandPalette/CommandPalette.tsx'), 'utf-8',
  );

  it('handles the toggleExplorer action rather than falling through to the log', () => {
    expect(app).toContain("action === 'toggleExplorer'");
  });

  it('does not also carry a second, self-executing explorer item', () => {
    expect(palette).not.toContain('command:toggle-explorer');
    expect(palette).not.toContain('onToggleExplorer');
  });
});
