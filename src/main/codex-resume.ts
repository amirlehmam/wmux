// ─── Codex resume, main side (#261) ──────────────────────────────────────────
//
// The persisted half of Codex conversation restore: the thread id the launcher
// (cli/wmux-codex.js, reached through codex-launcher.ts's PATH shim) reports is
// stamped into the copy of the tree that goes into session.json. Of the ways a
// Codex run ends, only a clean exit (code 0) forgets the id — that is when the
// launcher sends `pane.release_codex_session`, which main refuses while wmux
// is quitting — so a crash or a wmux quit keeps it. A restored id Codex says it
// cannot open is dropped separately (`pane.codex_session_missing`).

import { SurfaceId } from '../shared/types';
import { mapSurfaces } from './claude-resume';

/** A session handle is one argument, never an option or shell expression. */
export const CODEX_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
export function isValidCodexSessionId(id: unknown): id is string {
  return typeof id === 'string' && CODEX_SESSION_ID_RE.test(id);
}

export function stampCodexSessionIds<T>(tree: T, lookup: (id: SurfaceId) => string | null | undefined): T {
  return mapSurfaces(tree, surface => {
    if (surface.type !== 'terminal') return surface;
    const found = lookup(surface.id as SurfaceId);
    if (found === undefined) return surface;
    const next = isValidCodexSessionId(found) ? found : undefined;
    if (next === surface.codexSessionId) return surface;
    if (next) return { ...surface, codexSessionId: next };
    const rest = { ...surface };
    delete rest.codexSessionId;
    return rest;
  });
}
