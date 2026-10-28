// ─── Qwen Code resume, main side ─────────────────────────────────────────────
//
// The fifth provider beside Claude (#186), Codex (#261), OpenCode (#290) and
// agy. Qwen Code's hooks are Claude Code's hooks in all but name — same events,
// same snake_case payload, `session_id` on every one — so the handle arrives the
// way Claude's does: wmux-hook.js reads it off the payload and `handleHookEvent`
// records it, tagged `provider: 'qwen'` because qwen-context.ts registers every
// Qwen hook with `--provider qwen`. Restore types `qwen --resume <id>`, behind
// `workspacePrefs.restoreQwenSessions` (default off).
//
// Same shape as claude-resume.ts on purpose, pruning included: Qwen answers a
// resume of a session it no longer has with "No saved session found" and exit
// 1, which is a worse first impression than the plain shell it replaced.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { SurfaceId } from '../shared/types';
import { mapSurfaces } from './claude-resume';

/**
 * Qwen Code session ids are UUIDs, and Qwen itself only accepts the strict
 * v1-5 form from a caller (`cli/src/config/session-id.ts`). Strict here too:
 * the value arrives over the pipe and ends up on a restored pane's command
 * line, and a subagent's internal `<uuid>-agent-<name>` id must never stand in
 * for the session the user is actually in.
 */
export const QWEN_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isValidQwenSessionId(id: unknown): id is string {
  return typeof id === 'string' && QWEN_SESSION_ID_RE.test(id);
}

/**
 * `undefined` from the lookup means "no opinion" and keeps what the persisted
 * copy already had: a restored Qwen that has not reported yet must not lose its
 * handle to the first auto-save.
 */
export function stampQwenSessionIds<T>(tree: T, lookup: (id: SurfaceId) => string | null | undefined): T {
  return mapSurfaces(tree, surface => {
    if (surface.type !== 'terminal') return surface;
    const found = lookup(surface.id as SurfaceId);
    if (found === undefined) return surface;
    const next = isValidQwenSessionId(found) ? found.toLowerCase() : undefined;
    if (next === surface.qwenSessionId) return surface;
    if (next) return { ...surface, qwenSessionId: next };
    const rest = { ...surface };
    delete rest.qwenSessionId;
    return rest;
  });
}

/**
 * Where Qwen keeps its transcripts: `$QWEN_RUNTIME_DIR`, else `$QWEN_HOME`,
 * else ~/.qwen. Read from wmux's own environment, absolute values only — the
 * same rule qwen-context.ts applies to `QWEN_HOME`.
 */
export function getQwenRuntimeDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  for (const key of ['QWEN_RUNTIME_DIR', 'QWEN_HOME'] as const) {
    const value = env[key]?.trim();
    if (value && path.isAbsolute(value)) return path.normalize(value);
  }
  return path.join(home, '.qwen');
}

/**
 * Every session id Qwen still has a transcript for:
 * `<runtimeDir>/projects/<sanitizedCwd>/chats/<id>.jsonl`.
 *
 * Like Claude's, existence anywhere is enough — the project directory name is
 * Qwen's private encoding of the cwd, and matching a pane against it would
 * silently lose a session whose folder moved. Null means "cannot tell" (Qwen
 * never ran here, or the directory is unreadable) and the caller keeps
 * everything.
 */
export function listKnownQwenSessionIds(runtimeDir = getQwenRuntimeDir()): Set<string> | null {
  const root = path.join(runtimeDir, 'projects');
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
      entries = fs.readdirSync(path.join(root, project.name, 'chats'));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith('.jsonl')) ids.add(entry.slice(0, -'.jsonl'.length).toLowerCase());
    }
  }
  return ids;
}

/** Drop stamped ids whose transcript is gone, before any of them reaches a shell. */
export function pruneDeadQwenSessions<T>(tree: T, known: Set<string> | null): { tree: T; dropped: number } {
  if (!known) return { tree, dropped: 0 };
  let dropped = 0;
  const next = mapSurfaces(tree, surface => {
    const id = surface.qwenSessionId;
    if (typeof id !== 'string') return surface;
    if (isValidQwenSessionId(id) && known.has(id.toLowerCase())) return surface;
    dropped++;
    const rest = { ...surface };
    delete rest.qwenSessionId;
    return rest;
  });
  return { tree: next, dropped };
}
