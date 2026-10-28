// ─── OpenCode resume, main side (#290) ───────────────────────────────────────
//
// The third provider beside Claude (#186) and Codex (#261). The handle comes
// from wmux's own OpenCode plugin, which sees every session event and calls
// `wmux report-session <id> --provider opencode`; restore types
// `opencode -s <id>`. Same shape as codex-resume.ts on purpose — one stamp per
// provider, mutually exclusive through agent-session-persistence.ts. Behind
// `workspacePrefs.restoreOpencodeSessions` (default off).
//
// Two things the plugin (resources/opencode-plugin/wmux.js) never reports:
//
//   - a subagent session — one born with a parent: `info.parentID` on v1,
//     `data.parentID` on v2. (`parentID` on `message.updated` is a MESSAGE id,
//     not a session parent.)
//   - anything from OpenCode 2's shared `serve --service` server, whose
//     `WMUX_SURFACE_ID` is only the pane that started it. v2 is captured under
//     `--standalone` only.
//
// Quitting OpenCode releases the handle via `pane.release_opencode_session`,
// which main refuses while wmux is quitting (the Codex rule).

import { SurfaceId } from '../shared/types';
import { mapSurfaces } from './claude-resume';

/**
 * OpenCode session ids are `ses_` + base62. Strict on purpose: the value
 * arrives over the pipe and ends up on a restored pane's command line, and
 * Claude's looser validator would accept one too — the prefix is what keeps
 * an OpenCode id from ever being typed after `claude --resume`. The looser
 * Claude validator is also why agent-session-persistence.ts stamps Claude only
 * for a Claude (or provider-less) record.
 */
export const OPENCODE_SESSION_ID_RE = /^ses_[A-Za-z0-9]{8,120}$/;
export function isValidOpencodeSessionId(id: unknown): id is string {
  return typeof id === 'string' && OPENCODE_SESSION_ID_RE.test(id);
}

/**
 * `undefined` from the lookup means "no opinion" and keeps what the persisted
 * copy already had: a restored OpenCode that has not reported yet must not
 * lose its handle to the first auto-save.
 */
export function stampOpencodeSessionIds<T>(tree: T, lookup: (id: SurfaceId) => string | null | undefined): T {
  return mapSurfaces(tree, surface => {
    if (surface.type !== 'terminal') return surface;
    const found = lookup(surface.id as SurfaceId);
    if (found === undefined) return surface;
    const next = isValidOpencodeSessionId(found) ? found : undefined;
    if (next === surface.opencodeSessionId) return surface;
    if (next) return { ...surface, opencodeSessionId: next };
    const rest = { ...surface };
    delete rest.opencodeSessionId;
    return rest;
  });
}
