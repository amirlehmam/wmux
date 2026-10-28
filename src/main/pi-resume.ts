// ─── pi resume, main side (#382) ─────────────────────────────────────────────
//
// The seventh provider, beside Claude (#186), Codex (#261), OpenCode (#290),
// agy, Qwen and omp (#316), behind `workspacePrefs.restorePiSessions` (default
// off). The handle is the session FILE, not an id: pi resumes
// `pi --session <path>` exactly — quoted per shell by `quoteOmpArg`
// (agent-launcher.ts), never `--continue` — and a bare id would have to be
// re-resolved against a per-cwd directory wmux does not own. It comes from
// wmux's own pi extension (resources/pi-extension/wmux.js, reporting since its
// version marker 3), which reports it only once the file exists and is
// non-empty — pi writes it with the first assistant message, so a path known
// at `session_start` may never exist at all. So `session_start` reports only a
// resumed or forked session, and a new one reports at its first
// `turn_end`/`agent_settled`.
//
// Three pi behaviours shape the rest, each checked against pi 1.4.0 by the
// reporter of #382:
//
//   - `session_shutdown` fires for `/reload`, `/new`, `/resume` and `/fork` as
//     well as for a quit. Only `reason: "quit"` sends
//     `pane.release_pi_session`; on a switch the next session reports its own
//     file.
//   - A previous session's messages can land late. Every report and release
//     carries a `--seq` (a timestamp-derived counter in the extension), and
//     the gate below keeps the newest per surface — past `forget()`, which is
//     what lets a report that loses the race to its own quit be dropped
//     instead of re-creating the handle the user just left.
//   - `pi --session <path>` on a missing or EMPTY file silently starts a new
//     empty session in its place. So a handle whose file is gone or empty is
//     dropped at startup (`pruneDeadPiSessions`) rather than typed.
//
// A pi crash keeps the handle (the orphan rule in agent-state.ts).
//
// A pi launcher already in the pane's startup commands keeps its args, with
// `--continue`/`-c`/`--resume`/`-r` (value-less in pi, unlike omp) and any
// `--session` replaced by `--session <path>`; one carrying `--no-session`,
// `--fork` or `--session-id` is left alone (`mergePiResume` in
// agent-launcher.ts).

import fs from 'node:fs';
import path from 'node:path';
import type { SurfaceId } from '../shared/types';
import { mapSurfaces } from './claude-resume';
import { getPiAgentDir } from './pi-context';

/** Where pi keeps every session file: `<agentDir>/sessions/<cwd-slug>/<file>.jsonl`. */
export function piSessionsDir(agentDir = getPiAgentDir()): string {
  return path.win32.join(agentDir, 'sessions');
}

/**
 * Characters the restore command cannot carry safely in ANY shell it may be
 * typed into: control characters (a line break submits a second command) and
 * the double quote, which cmd.exe has no escape for inside a quoted argument
 * and Windows does not allow in a file name anyway. `%` is cmd's problem only
 * and is refused at quoting time, per shell (agent-launcher.ts).
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f"]/;

/**
 * A pi session handle: an absolute drive-letter path to a `.jsonl` file inside
 * pi's sessions directory.
 *
 * This is a security boundary, not tidiness. The value arrives over the named
 * pipe and round-trips through session.json, a file the user can edit, and it
 * ends up on a restored pane's command line — so it is checked at the door
 * (`reportAgentSession`), again when the restored tree is pruned, and its shape
 * once more in the renderer (claude-resume-command.ts) before the command is
 * built. Containment is what
 * stops a reported "session" from being any file on disk pi would then open
 * and append to.
 *
 * Deliberately narrow: a POSIX path (pi inside WSL) or a UNC path is refused,
 * as is a `--session-dir` outside `<agentDir>/sessions` and a
 * `PI_CODING_AGENT_DIR` exported per shell after wmux started (pi-context.ts
 * cannot see it). Each is a pane that is not resumed, never a wrong file.
 */
export function isValidPiSessionFile(file: unknown, sessionsDir = piSessionsDir()): file is string {
  if (typeof file !== 'string' || file.length === 0 || file.length > 4096) return false;
  if (UNSAFE_PATH_CHARS.test(file)) return false;
  if (!/^[a-zA-Z]:[\\/]/.test(file)) return false;
  if (!file.toLowerCase().endsWith('.jsonl')) return false;
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(file)) return false;
  const rel = path.win32.relative(sessionsDir.toLowerCase(), path.win32.normalize(file).toLowerCase());
  return rel !== '' && !rel.startsWith('..') && !path.win32.isAbsolute(rel);
}

/**
 * `undefined` from the lookup means "no opinion" and keeps what the persisted
 * copy already had: a restored pi pane that has not reported yet must not lose
 * its handle to the first auto-save.
 */
export function stampPiSessionFiles<T>(tree: T, lookup: (id: SurfaceId) => string | null | undefined): T {
  return mapSurfaces(tree, surface => {
    if (surface.type !== 'terminal') return surface;
    const found = lookup(surface.id as SurfaceId);
    if (found === undefined) return surface;
    const next = isValidPiSessionFile(found) ? found : undefined;
    if (next === surface.piSessionFile) return surface;
    if (next) return { ...surface, piSessionFile: next };
    const rest = { ...surface };
    delete rest.piSessionFile;
    return rest;
  });
}

/** Size of a file, or null when it is not a readable regular file. */
function fileSize(file: string): number | null {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/**
 * Drop saved pi handles that would resume nothing, before restore types them:
 * invalid (session.json is editable), gone, or empty — the two cases
 * `pi --session` silently turns into a brand-new session.
 */
export function pruneDeadPiSessions<T>(
  tree: T,
  sizeOf: (file: string) => number | null = fileSize,
  sessionsDir = piSessionsDir(),
): { tree: T; dropped: number } {
  let dropped = 0;
  const pruned = mapSurfaces(tree, surface => {
    if (surface.type !== 'terminal' || surface.piSessionFile === undefined) return surface;
    const file = surface.piSessionFile;
    if (isValidPiSessionFile(file, sessionsDir) && (sizeOf(file) ?? 0) > 0) return surface;
    dropped++;
    const rest = { ...surface };
    delete rest.piSessionFile;
    return rest;
  });
  return { tree: pruned, dropped };
}

/** Guards against a hostile or buggy reporter growing the map without bound. */
const MAX_TRACKED_SURFACES = 256;

/**
 * The newest pi `seq` seen per surface, for session reports AND quits.
 *
 * Separate from the agent record's own `lastSeq` because it must outlive the
 * record: a quit `forget()`s the record, and the report that raced it — sent
 * earlier, delivered later — would otherwise land on a blank record and
 * re-create the handle the user just quit. The extension's seqs are derived
 * from the clock, so a fresh pi in the same pane starts above every older one
 * and nothing here needs resetting.
 */
export class PiSeqGate {
  private readonly seen = new Map<SurfaceId, number>();

  /** True when `seq` is newer than anything seen for the surface; records it. A missing seq opts out. */
  accept(surfaceId: SurfaceId, seq: unknown): boolean {
    if (seq === undefined || seq === null) return true;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq)) return false;
    const last = this.seen.get(surfaceId);
    if (last !== undefined && seq <= last) return false;
    if (last === undefined && this.seen.size >= MAX_TRACKED_SURFACES) {
      this.seen.delete(this.seen.keys().next().value!);
    }
    this.seen.delete(surfaceId);
    this.seen.set(surfaceId, seq);
    return true;
  }

  /** Test seam. */
  clear(): void {
    this.seen.clear();
  }
}

export const piSessionSeqs = new PiSeqGate();

/**
 * Is this `session_shutdown` reason a quit? An unknown reason counts as one:
 * pi before the field existed released on every shutdown, and a status bridge
 * that never releases pins the pane on its last state.
 */
export function isPiQuitReason(reason: unknown): boolean {
  return reason === undefined || reason === null || reason === 'quit';
}

/**
 * What a pi `session_shutdown` does to the pane's record.
 *
 *   keep      a session switch: the next session reports its own file
 *   stale     older than a report already accepted for this pane
 *   foreign   the pane's handle belongs to another provider
 *   other     the pane already holds a DIFFERENT pi file — a late quit from a
 *             previous session must not take the current one with it
 *   release   forget the record: the user quit pi
 *
 * The caller refuses all of this while wmux quits (index.ts), because a pi
 * killed by wmux's own exit did not choose to end its session.
 */
export function decidePiShutdown(input: {
  reason: unknown;
  seqAccepted: boolean;
  named: string | null;
  current: { provider: string | undefined; sessionId: string | null } | null;
}): 'keep' | 'stale' | 'foreign' | 'other' | 'release' {
  if (!isPiQuitReason(input.reason)) return 'keep';
  if (!input.seqAccepted) return 'stale';
  const held = input.current?.sessionId;
  if (held && input.current?.provider !== 'pi') return 'foreign';
  if (held && input.named && input.named !== held) return 'other';
  return 'release';
}
