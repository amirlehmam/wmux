// ─── Explorer: pure state helpers ────────────────────────────────────────────
// Kept apart from the components because this is where the unit tests point —
// same split as split-utils.ts and markdown-utils.ts. Nothing here touches
// React, the store or IPC.

import type { ExplorerEntry } from '../../../shared/types';

/** Loaded children, keyed by POSIX rel-path; '' is the root. */
export type ExplorerTreeState = Record<string, ExplorerEntry[]>;

export interface ExplorerRow {
  entry: ExplorerEntry;
  /** POSIX rel-path of this entry from the root. */
  relPath: string;
  /** Indent level; the root's own children are 0. */
  depth: number;
  expanded: boolean;
}

/** POSIX separators everywhere on the renderer side, so a key built from a
 *  main-process reply and one built locally can never disagree. */
export function joinRel(parent: string, name: string): string {
  const base = parent.replace(/\\/g, '/').replace(/\/+$/, '');
  return base ? `${base}/${name}` : name;
}

function isDirLike(entry: ExplorerEntry): boolean {
  return entry.kind !== 'file';
}

/** Directories first, then locale-aware by name. Returns a new array. */
export function sortEntries(entries: ExplorerEntry[]): ExplorerEntry[] {
  return [...entries].sort((a, b) => {
    if (isDirLike(a) !== isDirLike(b)) return isDirLike(a) ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
}

/**
 * Expand or collapse one directory.
 *
 * Collapsing takes its descendants with it — otherwise re-expanding a parent
 * would explode back to whatever was open three levels down, which is not what
 * a collapse looked like it did. The `+ '/'` guard is what keeps a sibling
 * sharing a name prefix ('docs-old' under 'docs') from being swept up.
 */
export function toggleExpanded(expanded: string[], relPath: string): string[] {
  if (expanded.includes(relPath)) {
    const prefix = `${relPath}/`;
    return expanded.filter((p) => p !== relPath && !p.startsWith(prefix));
  }
  return [...expanded, relPath];
}

/**
 * LRU-cap the per-root expansion map. Insertion order IS the recency order —
 * the touched root is deleted and re-inserted so it lands at the end.
 */
export function pruneExpanded(
  map: Record<string, string[]>,
  root: string,
  maxRoots: number,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(map)) {
    if (key !== root) next[key] = value;
  }
  next[root] = map[root] ?? [];
  const keys = Object.keys(next);
  if (keys.length <= maxRoots) return next;
  const pruned: Record<string, string[]> = {};
  for (const key of keys.slice(keys.length - maxRoots)) pruned[key] = next[key];
  return pruned;
}

/**
 * Depth-first walk of what is currently on screen, in visual order. Backs
 * arrow-key navigation, which needs "the row below this one" and cannot get it
 * from a recursive component tree.
 *
 * An expanded directory with no loaded children simply yields no children —
 * the fetch is in flight, and the rows re-render when it lands.
 */
export function flattenVisible(
  tree: ExplorerTreeState,
  expanded: string[],
): ExplorerRow[] {
  const open = new Set(expanded);
  const rows: ExplorerRow[] = [];

  const walk = (relPath: string, depth: number): void => {
    for (const entry of sortEntries(tree[relPath] ?? [])) {
      const childPath = joinRel(relPath, entry.name);
      // A symlink is never expandable — the jail refuses to traverse it, so an
      // expander arrow would be an affordance for a guaranteed error.
      const canExpand = entry.kind === 'dir';
      const isOpen = canExpand && open.has(childPath);
      rows.push({ entry, relPath: childPath, depth, expanded: isOpen });
      if (isOpen) walk(childPath, depth + 1);
    }
  };

  walk('', 0);
  return rows;
}

/**
 * Identity of an in-flight listDir. Rapid pane switching would otherwise paint
 * one pane's children under another pane's tree, so a reply whose key no longer
 * matches the current one is dropped rather than applied.
 *
 * `|` is the separator (not the NUL a prior version used, which made the file
 * register as binary to git). `|` is safe: `surfaceId` is a branded
 * `surf-{uuid}` and cannot contain it; the `variant` values are POSIX
 * rel-paths (normalized by joinRel, never carrying one) or a boolean's
 * spelling; `root` is an absolute Windows path, and `|` is a reserved
 * character Windows paths can never contain.
 *
 * `variant` is deliberately untyped beyond `string`: the key only has to be an
 * identity, and call sites pass whatever else distinguishes one in-flight
 * request from another (a rel-path, or `String(showHidden)`).
 */
export function responseKey(surfaceId: string, root: string, variant: string): string {
  return `${surfaceId}|${root}|${variant}`;
}

// ─── Absolute paths ──────────────────────────────────────────────────────────
// Enumeration only ever needs a surfaceId and a rel-path — main owns the root.
// But every ACTION on a listed entry (open, reveal, open-in-default-app, copy
// path) needs a real absolute Windows path, and the renderer is what builds it.
// These two helpers are the whole of that construction, kept pure and here
// rather than inline in the panel because getting the root wrong is silent:
// the tree still paints, and only the clicks fail.

/**
 * Which root absolute paths are built from.
 *
 * `resolvedRoot` is `ExplorerListOk.root` — the absolute, realpath'd Windows
 * path main itself listed. `reportedCwd` is the verbatim `report_pwd`
 * argument, which is a Windows path only by luck: the bash integration reports
 * `$(pwd)`, i.e. `/c/Users/...`, and a pwsh cwd can be a junction, an 8.3
 * short name, or cased differently from the real directory. Main normalizes
 * all of those for ENUMERATION, so a tree built on the reported cwd looks
 * perfectly healthy while every path built from it is unopenable.
 *
 * So the resolved root always wins. The reported cwd is a fallback for exactly
 * one window — before the first root reply has landed — where it is that or
 * nothing.
 */
export function pathRoot(resolvedRoot: string | null | undefined, reportedCwd: string): string {
  return resolvedRoot || reportedCwd;
}

/** Join a POSIX rel-path onto an absolute Windows root. */
export function toAbsolutePath(root: string, relPath: string): string {
  const base = root.replace(/[\\/]+$/, '');
  const tail = relPath.replace(/\//g, '\\');
  return tail ? `${base}\\${tail}` : base;
}

/**
 * Which surface in the focused pane the tree should be rooted at.
 *
 * NOT simply the active one. Clicking a file in the tree opens a markdown
 * preview tab in that same pane, which makes the markdown surface active — and
 * a markdown surface has no reported cwd, so main answers `no_root` and the
 * tree the user just clicked in blanks out. The explorer follows the pane's
 * TERMINAL, so browsing a file cannot pull the ground out from under the
 * browse.
 *
 * Order: the active surface when it is a terminal (the normal case, and the
 * only one that can change roots); otherwise the terminal that was last active
 * in this pane, if it is still open; otherwise the pane's first terminal.
 * Null when the pane has no terminal at all — the caller keeps whatever root
 * was last good rather than blanking.
 */
export function pickRootSurface<T extends { id: string; type: string }>(
  surfaces: readonly T[],
  activeIndex: number,
  lastTerminalId: string | null,
): T | null {
  const active = surfaces[activeIndex];
  if (active?.type === 'terminal') return active;
  const remembered = lastTerminalId
    ? surfaces.find((s) => s.id === lastTerminalId && s.type === 'terminal')
    : undefined;
  return remembered ?? surfaces.find((s) => s.type === 'terminal') ?? null;
}

/** A root held over from a pane that had one, and the workspace it belongs to. */
export interface StickyRoot {
  workspaceId: string;
  surfaceId: string;
  root: string;
}

/**
 * The held-over root, but only where holding it is still honest.
 *
 * pickRootSurface answers null for a pane with no terminal, and the panel keeps
 * the last good root rather than blanking — a detour into a markdown-only pane
 * should not cost the user their browsing context.
 *
 * A WORKSPACE switch is not that detour. Held across one, the panel lists, and
 * reveals, a folder belonging to a workspace the user is no longer looking at;
 * worse, a file clicked there opens in the NEW workspace while
 * `codeRootSurfaceId` records the OLD workspace's terminal, writing a
 * cross-workspace pointer into a layout that then restores blank. So the sticky
 * root carries the workspace it was captured in, and is refused outside it.
 */
export function usableSticky(
  sticky: StickyRoot | null,
  activeWorkspaceId: string | null | undefined,
): StickyRoot | null {
  if (!sticky || !activeWorkspaceId) return null;
  return sticky.workspaceId === activeWorkspaceId ? sticky : null;
}

// ─── The loaded tree, cached per root ────────────────────────────────────────
// `expanded` is persisted per root; `tree` — the children those expansions
// point at — was not, so every pane switch tore it down and refetched it. That
// refetch is where the expansion was actually lost: a child listing dropped as
// stale (or failing once) left its path marked in the panel's attempt record
// and was never retried, leaving an open chevron with nothing under it. The
// only recovery was collapsing and reopening the folder by hand, which is the
// one path that clears the mark.
//
// So the tree is cached too, and the two states travel together. A pane switch
// to a directory already visited — including the very common case of two panes
// in the SAME directory — then does no child fetching at all, and a fetch that
// never happens cannot be dropped.
//
// Keyed on the REPORTED cwd, deliberately unlike `expanded`, which is keyed on
// the resolved root. Expansion needs the canonical key or two spellings of one
// directory fragment into two persisted entries; a cache only needs to be hit
// by the same pane asking the same question again, and a pane's spelling of its
// own cwd does not change. The resolved root rides along in the entry so a hit
// restores it in the same commit — otherwise the first render after a switch
// reads `expanded` under the reported spelling and finds nothing.

export interface CachedTree {
  tree: ExplorerTreeState;
  /** The resolved root that came back with this tree, so a hit restores both. */
  resolvedRoot: string | null;
}

export type ExplorerTreeCache = Record<string, CachedTree>;

/** `showHidden` is part of the identity: a filtered tree must never be served
 *  to the unfiltered view, or half the entries silently go missing. */
export function treeCacheKey(root: string, showHidden: boolean): string {
  return `${root}|${showHidden}`;
}

/** LRU-insert, same insertion-order-is-recency trick as pruneExpanded. */
export function rememberTree(
  cache: ExplorerTreeCache,
  key: string,
  entry: CachedTree,
  maxRoots: number,
): ExplorerTreeCache {
  const next: ExplorerTreeCache = {};
  for (const [k, v] of Object.entries(cache)) {
    if (k !== key) next[k] = v;
  }
  next[key] = entry;
  const keys = Object.keys(next);
  if (keys.length <= maxRoots) return next;
  const pruned: ExplorerTreeCache = {};
  for (const k of keys.slice(keys.length - maxRoots)) pruned[k] = next[k];
  return pruned;
}

export function recallTree(cache: ExplorerTreeCache, key: string): CachedTree | null {
  return cache[key] ?? null;
}

/** Drop one entry. Refresh means "go and look again", so it must not be able to
 *  serve the very tree the user is asking to have re-read. */
export function forgetTree(cache: ExplorerTreeCache, key: string): ExplorerTreeCache {
  const next: ExplorerTreeCache = {};
  for (const [k, v] of Object.entries(cache)) {
    if (k !== key) next[k] = v;
  }
  return next;
}

/**
 * The gap between what is expanded and what is loaded — i.e. what still has to
 * be fetched. Pure so the rule is stated once and testable without a React
 * tree; the panel's effect is only the plumbing around it.
 *
 * Nothing is asked for until the ROOT has listed: a child that succeeded while
 * the root failed would write entries under a tree that has no root, replacing
 * a real root failure on screen with an empty tree that explains nothing.
 */
export function nextRefillPaths(
  tree: ExplorerTreeState,
  expanded: readonly string[],
  requested: ReadonlySet<string>,
): string[] {
  if (!tree['']) return [];
  return expanded.filter((relPath) => !tree[relPath] && !requested.has(relPath));
}
