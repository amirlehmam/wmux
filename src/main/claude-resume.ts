import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SurfaceId } from '../shared/types';

// ─── Restore Claude Code sessions on workspace restore (issue #186) ──────────
//
// wmux restored workspaces, tabs, per-tab shell and per-tab cwd, and then
// respawned every terminal as a bare shell — so the one piece of state that
// matters for a tool whose premise is "a pane per agent" was the piece that did
// not come back. The user re-ran `claude --resume` in each pane and picked the
// right conversation out of the picker.
//
// Almost all the machinery already existed; this module is the missing middle:
//
//   * `AgentStateRecord.sessionId` already had the slot, already documented as
//     "a resumable handle, not a PID". Nothing ever wrote it, because
//     wmux-hook.ts parsed the Claude payload and dropped `session_id`.
//   * `SurfaceRef.startupCommands` already runs a command once after a restored
//     PTY spawns, env-baked for PowerShell and keystroke-injected elsewhere.
//   * `freezeSurfaceCwds()` already showed the pattern for baking a live value
//     into the persisted copy of the tree at save time (issue #134).
//
// The id is stamped in the MAIN process rather than the renderer, even though
// #134's cwd freeze is renderer-side: the id lives in `agent-state.ts`'s record
// map, which main owns and the renderer has never seen. Routing it through IPC
// into the store purely so the store could write it back out would add a
// synchronised copy of main-process state for no reader.
//
// SECURITY: the id arrives over the named pipe — from a hook wmux registered,
// but the pipe is a public interface — and ends up on a command line. Anything
// that is not a bare session handle is refused at the door, so a crafted
// `report-session` cannot smuggle `; rm -rf` into a pane's startup.

/**
 * Claude Code session ids are UUIDs today. The pattern is deliberately wider
 * than a UUID (any id Claude might mint stays supported) and still narrow
 * enough that the result cannot be anything but a single shell token: no
 * spaces, no quotes, no `;` `&` `|` `$` backtick, no path separators.
 */
export const CLAUDE_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidClaudeSessionId(id: unknown): id is string {
  return typeof id === 'string' && CLAUDE_SESSION_ID_RE.test(id);
}

/** The command a restored pane runs to pick its conversation back up. */
export function buildResumeCommand(sessionId: string): string {
  // Not quoted on purpose: the regex above already guarantees a bare token, and
  // quoting styles differ across the four shells wmux spawns (pwsh, cmd, bash,
  // WSL). A value that would NEED quoting never gets this far.
  return `claude --resume ${sessionId}`;
}

// ─── Tree walk ───────────────────────────────────────────────────────────────

/** A persisted terminal surface, as far as this module needs to care. */
type SurfaceLike = Record<string, unknown> & { id?: unknown; type?: unknown; claudeSessionId?: unknown };

/**
 * Map every surface in a serialized split tree, structurally sharing anything
 * that did not change.
 *
 * Generic over the tree type because both callers work on the *persisted* copy
 * (`session.json`'s `splitTree`, typed `any` in SessionData) rather than the
 * live `SplitNode` — and because stamping and pruning are the same walk with a
 * different per-surface decision. Writing that walk twice is what produced the
 * first, broken version of this file.
 */
function mapSurfaces<T>(tree: T, fn: (surface: SurfaceLike) => SurfaceLike): T {
  const node = tree as unknown as { type?: string; surfaces?: SurfaceLike[]; children?: unknown[] };
  if (!node || typeof node !== 'object') return tree;

  if (node.type === 'leaf') {
    if (!Array.isArray(node.surfaces)) return tree;
    let changed = false;
    const surfaces = node.surfaces.map((s) => {
      if (!s || typeof s !== 'object') return s;
      const next = fn(s);
      if (next !== s) changed = true;
      return next;
    });
    return changed ? ({ ...node, surfaces } as unknown as T) : tree;
  }

  if (!Array.isArray(node.children) || node.children.length !== 2) return tree;
  const left = mapSurfaces(node.children[0], fn);
  const right = mapSurfaces(node.children[1], fn);
  if (left === node.children[0] && right === node.children[1]) return tree;
  return { ...node, children: [left, right] } as unknown as T;
}

/** Copy without the stamped id. */
function withoutSessionId(surface: SurfaceLike): SurfaceLike {
  const rest = { ...surface };
  delete rest.claudeSessionId;
  return rest;
}

// ─── Stamping (save time) ────────────────────────────────────────────────────

type SessionIdLookup = (surfaceId: SurfaceId) => string | null | undefined;

/**
 * Rewrite a split tree so every terminal surface that currently hosts a Claude
 * session carries that session's id, for the copy that goes into session.json.
 *
 * Mirrors `freezeSurfaceCwds`: pure, immutable, and applied to the persisted
 * copy only — the live tree keeps no `claudeSessionId`, so nothing about a
 * running pane changes and the field cannot go stale in memory.
 *
 * A surface whose agent was released (Claude exited cleanly — `SessionEnd`
 * calls `releaseAgent`) looks up to nothing and has any previously stamped id
 * REMOVED rather than left behind. That is what makes "exit Claude, restart
 * wmux, get a plain shell" work, and it is why the delete branch is not an
 * optimisation that can be skipped.
 */
export function stampClaudeSessionIds<T>(tree: T, lookup: SessionIdLookup): T {
  return mapSurfaces(tree, (s) => {
    if (s.type !== 'terminal') return s;
    const found = lookup(s.id as SurfaceId);
    const next = isValidClaudeSessionId(found) ? found : undefined;
    const prev = typeof s.claudeSessionId === 'string' ? s.claudeSessionId : undefined;
    if (next === prev) return s;
    return next ? { ...s, claudeSessionId: next } : withoutSessionId(s);
  });
}

// ─── Pruning (load time) ─────────────────────────────────────────────────────

/**
 * Every session id Claude Code still has a transcript for.
 *
 * Claude stores one `<session-id>.jsonl` per conversation under
 * `~/.claude/projects/<encoded-cwd>/`. The directory name encodes the project
 * path, but we deliberately do NOT try to match a pane's cwd to an encoded
 * directory: the encoding is Claude's private detail, and a pane whose folder
 * moved would then silently lose a resumable session. Existence anywhere is
 * enough — `--resume` resolves the id itself.
 *
 * Returns null when the projects directory cannot be read at all (Claude not
 * installed, no permission). Null means "cannot tell", which the caller must
 * treat as "keep everything" — pruning on an unreadable directory would throw
 * away every id the first time wmux ran without Claude present.
 */
export function listKnownTranscriptIds(home = os.homedir()): Set<string> | null {
  const root = path.join(home, '.claude', 'projects');
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const ids = new Set<string>();
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(root, project.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith('.jsonl')) ids.add(entry.slice(0, -'.jsonl'.length));
    }
  }
  return ids;
}

/**
 * Drop stamped ids whose transcript is gone, before any of them reaches a
 * shell. Without this, deleting a conversation (or carrying a session.json to
 * a new machine) makes every restored pane open Claude and immediately error
 * out — a worse first impression than the plain shell this replaced.
 *
 * Reports how many were dropped so startup can log it rather than silently
 * changing what the user gets back.
 */
export function pruneDeadClaudeSessions<T>(
  tree: T,
  known: Set<string> | null,
): { tree: T; dropped: number } {
  if (!known) return { tree, dropped: 0 };
  let dropped = 0;
  const next = mapSurfaces(tree, (s) => {
    const id = s.claudeSessionId;
    if (typeof id !== 'string') return s;
    if (isValidClaudeSessionId(id) && known.has(id)) return s;
    dropped++;
    return withoutSessionId(s);
  });
  return { tree: next, dropped };
}
