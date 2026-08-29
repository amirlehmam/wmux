// ─── Explorer: change counts, rolled up the tree ─────────────────────────────
// Pure. No fs, no git, no DOM — kept out of the component for the same reason
// explorer-state.ts and explorer-keynav.ts are, and testable with none of the
// three.
//
// The numbers themselves come from main/diff-provider.ts, which wmux already
// had. Nothing here computes a diff; it only decides where the numbers belong
// in a tree and which of them the user is looking at.

import type { ExplorerDiffEntry } from '../../../shared/types';

/** What one row displays. Folders carry the sum of everything beneath them. */
export interface DiffStat {
  additions: number;
  deletions: number;
  /** Changed files at or below this path. A folder row uses it; a file's is 1. */
  files: number;
}

export type DiffStatMap = ReadonlyMap<string, DiffStat>;

/**
 * PATH SPELLING — the one invariant every function here depends on.
 *
 * Keys are POSIX-separated and relative to the root, with no leading or
 * trailing slash. That is already what both ends produce: git prints POSIX,
 * diff-provider's snapshot walk normalizes to it explicitly, and listDir puts
 * `toPosix(rel)` on the wire. So the rollup never sees a `path.sep` and never
 * calls anything from `path` — which is also what lets it run in the renderer,
 * where there is no `path` module worth the bundle.
 *
 * The root itself is the empty string, matching `listDir`'s own `relPath` for a
 * root listing. It is deliberately NOT given a rolled-up entry: a total for
 * "everything" belongs in the panel header, not on an invisible row, and
 * emitting it would make `statFor('')` answer for a row that does not exist.
 */
function normalizeKey(p: string): string {
  // Index scanning rather than /^\/+|\/+$/g: an anchored `+` quantifier over a
  // repeated separator is the shape that backtracks super-linearly, and these
  // strings come off a wire an agent's hook payload can influence. Two while
  // loops are also simply faster, and this runs once per row per render.
  const slashed = p.split('\\').join('/');
  let start = 0;
  let end = slashed.length;
  while (start < end && slashed[start] === '/') start++;
  while (end > start && slashed[end - 1] === '/') end--;
  return slashed.slice(start, end);
}

/** Every ancestor of `relPath`, nearest first, excluding the root. */
export function ancestorsOf(relPath: string): string[] {
  const key = normalizeKey(relPath);
  if (!key) return [];
  const parts = key.split('/');
  const out: string[] = [];
  for (let i = parts.length - 1; i > 0; i--) {
    out.push(parts.slice(0, i).join('/'));
  }
  return out;
}

function add(into: Map<string, DiffStat>, key: string, entry: ExplorerDiffEntry): void {
  const existing = into.get(key);
  if (existing) {
    existing.additions += entry.additions;
    existing.deletions += entry.deletions;
    existing.files += 1;
    return;
  }
  into.set(key, { additions: entry.additions, deletions: entry.deletions, files: 1 });
}

/**
 * Build the lookup the tree renders from.
 *
 * Every changed file gets an entry, and so does every directory above it, so a
 * collapsed `src/` shows the sum of everything underneath without the panel
 * having to have loaded any of it. That is the whole point of rolling up in a
 * flat map rather than walking the loaded tree: the explorer lists directories
 * lazily, so at any moment most of the tree is not in memory, and a rollup that
 * could only see loaded rows would report `src/ +12/-3` purely because that is
 * the part the user happened to have expanded.
 *
 * A file appearing twice in `files` is summed rather than deduplicated. The
 * provider does not emit duplicates today; if it ever does, a doubled count is
 * a visibly wrong number, whereas silently dropping one is a wrong number that
 * looks right.
 */
export function buildDiffStats(files: readonly ExplorerDiffEntry[]): DiffStatMap {
  const map = new Map<string, DiffStat>();
  for (const entry of files) {
    const key = normalizeKey(entry.path);
    if (!key) continue;   // a change AT the root is not a row; see normalizeKey
    add(map, key, entry);
    for (const ancestor of ancestorsOf(key)) add(map, ancestor, entry);
  }
  return map;
}

/** The stat for one row, or null when nothing under it changed. */
export function statFor(stats: DiffStatMap, relPath: string): DiffStat | null {
  const key = normalizeKey(relPath);
  if (!key) return null;
  return stats.get(key) ?? null;
}

/** Whole-root totals, for the panel header. */
export function totalStat(files: readonly ExplorerDiffEntry[]): DiffStat {
  const total: DiffStat = { additions: 0, deletions: 0, files: 0 };
  for (const entry of files) {
    total.additions += entry.additions;
    total.deletions += entry.deletions;
    total.files += 1;
  }
  return total;
}

// ─── Agent attribution ───────────────────────────────────────────────────────
// Which rows an agent touched, as opposed to which rows differ from the
// baseline. Two different questions: a file you edited by hand and a file
// Claude rewrote both show numbers, and only the second gets a dot.
//
// The source is the Claude Code hook stream wmux already receives — PostToolUse
// carries `tool_input.file_path`, which wmux-hook.js already extracts. Nothing
// new is installed, sent or parsed, and with no hooks (or no agent) there are
// simply no dots while every number still works. Same rule the prompt log
// follows: wmux does not guess at agent state, it reports what was declared or
// nothing at all.

/** Tools whose completion means a file on disk changed. */
export const EDITING_TOOLS: ReadonlySet<string> = new Set([
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Update',
]);

/**
 * Bound on remembered paths, per root. A long agent run touching thousands of
 * files should cost a bounded amount of renderer memory, and the dots that fall
 * off the end are the oldest — which are also the ones furthest from what the
 * user is currently watching.
 */
export const MAX_TOUCHED = 512;

export function isEditingTool(tool: unknown): boolean {
  return typeof tool === 'string' && EDITING_TOOLS.has(tool);
}

/**
 * Turn an absolute path from a hook payload into a key the tree can match.
 *
 * Returns null when the file is outside the root, which is the common case:
 * hooks fire for every pane, and most panes are not rooted where this one is.
 *
 * Comparison is case-insensitive because this is Windows and the agent's
 * spelling of a path is not guaranteed to match the shell's — but only the
 * COMPARISON is; the key returned is sliced out of the original so the tree
 * still matches on the spelling `listDir` produced.
 */
export function relativizeTouched(root: string, absPath: string): string | null {
  if (!root || !absPath) return null;
  const nRoot = normalizeKey(root).toLowerCase();
  const nAbs = normalizeKey(absPath);
  const cmp = nAbs.toLowerCase();
  if (!nRoot) return null;
  if (cmp === nRoot) return null;
  if (!cmp.startsWith(nRoot + '/')) return null;
  return nAbs.slice(nRoot.length + 1);
}

/**
 * Add a touched path to the bounded set, evicting oldest-first.
 *
 * A `Set` preserves insertion order, so re-adding a path that is already
 * present would leave it in its ORIGINAL position and let a file the agent is
 * actively rewriting age out ahead of one it touched once. Delete before
 * inserting so a repeat touch moves it to the back.
 */
export function noteTouched(touched: Set<string>, key: string): Set<string> {
  if (!key) return touched;
  const next = new Set(touched);
  next.delete(key);
  next.add(key);
  while (next.size > MAX_TOUCHED) {
    const oldest = next.values().next();
    if (oldest.done) break;
    next.delete(oldest.value);
  }
  return next;
}

/**
 * Whether a row should carry the dot: the file itself was touched, or anything
 * beneath it was. Ancestors are derived at query time rather than stored,
 * because the set is small and bounded while the tree is not.
 */
export function isTouched(touched: ReadonlySet<string>, relPath: string): boolean {
  const key = normalizeKey(relPath);
  if (!key) return false;
  if (touched.has(key)) return true;
  const prefix = key + '/';
  for (const t of touched) {
    if (t.startsWith(prefix)) return true;
  }
  return false;
}
