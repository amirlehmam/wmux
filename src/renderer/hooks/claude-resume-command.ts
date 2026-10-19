// ─── Claude resume, renderer side (issue #186) ───────────────────────────────
//
// Split out of useTerminal.ts so it can be tested without standing up xterm,
// a DOM and a PTY bridge. Everything here is pure except the module-level
// guard, which is the one piece that genuinely has to be process-wide.

import { mergeResume, type ResumableAgent } from './agent-launcher';

/** Mirrors CLAUDE_SESSION_ID_RE in src/main/claude-resume.ts. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Surfaces that have already spent their stored resume in this run.
 *
 * Module-level, not a hook ref: the guard has to outlive the component. A pane
 * whose shell exited keeps its `claudeSessionId` in the tree, and remounting it
 * — closing a neighbouring split re-parents the pane, which remounts it — would
 * create a second PTY and resume the same conversation again. `pty.has` covers
 * the common remount by attaching instead of creating, but not the case where
 * the old PTY is genuinely gone, which is exactly when a create happens.
 *
 * Never pruned. An entry is one short string per terminal per run, and the only
 * thing forgetting one could buy is the duplicate resume it exists to prevent.
 */
const resumedSurfaces = new Set<string>();

/** Test seam — the guard is module state, so a test that resumes needs a reset. */
export function resetResumedSurfaces(): void {
  resumedSurfaces.clear();
}

export function hasResumed(surfaceId: string): boolean {
  return resumedSurfaces.has(surfaceId);
}

/**
 * The resume folded into a surface's commands, or `base` untouched.
 *
 * The once-per-surface guard lives here rather than in each provider branch: a
 * surface spends its one resume only when something is actually about to be
 * typed, so a base that ends up unchanged (a different agent's launcher, #302)
 * leaves the handle available for a later create.
 */
function applyResume(
  base: string[] | undefined,
  surfaceId: string,
  agent: ResumableAgent,
  id: string,
): string[] | undefined {
  if (resumedSurfaces.has(surfaceId)) return base;
  const next = mergeResume(base, agent, id);
  if (!next) return base;
  resumedSurfaces.add(surfaceId);
  return next;
}

/**
 * The startup commands a freshly created PTY should run, with the stored resume
 * for whichever provider has a handle on this surface.
 *
 * Where the resume goes depends on the pane's own commands (#302). A
 * quick-launch profile's commands are usually setup for the shell (activate a
 * venv, cd somewhere), and the resume is then appended: `claude --resume` does
 * not return to the prompt — it takes over the terminal — so anything queued
 * after it would be typed into Claude's input box. When one of those commands
 * IS the launcher, the resume is merged into it instead, keeping its name and
 * flags, and when it launches a different agent nothing is added at all. See
 * agent-launcher.ts.
 *
 * Returns `base` unchanged (same reference) whenever it decides not to resume,
 * so a caller can tell "nothing added" from "added" by identity.
 *
 * CALLING THIS CONSUMES THE SURFACE'S ONE RESUME. It is not a predicate — only
 * call it at the point a PTY is actually being created.
 */
export function withClaudeResume(opts: {
  base: string[] | undefined;
  surfaceId: string | undefined;
  claudeSessionId: string | undefined;
  enabled: boolean;
  codexSessionId?: string;
  codexEnabled?: boolean;
  opencodeSessionId?: string;
  opencodeEnabled?: boolean;
  agySessionId?: string;
  agyEnabled?: boolean;
}): string[] | undefined {
  const { base, surfaceId, claudeSessionId, enabled } = opts;
  if (!surfaceId) return base;
  if (opts.agySessionId) {
    // One provider per tab, as for Codex and OpenCode.
    if (claudeSessionId || opts.codexSessionId || opts.opencodeSessionId || !opts.agyEnabled) return base;
    // Mirrors AGY_CONVERSATION_ID_RE in src/main/agy-resume.ts — re-checked
    // because session.json is a file the user can edit.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opts.agySessionId)) return base;
    return applyResume(base, surfaceId, 'agy', opts.agySessionId);
  }
  if (opts.opencodeSessionId) {
    // Same rule as Codex: two providers' handles on one tab is a state nothing
    // wrote on purpose, and guessing would type an agent into another's TUI.
    if (claudeSessionId || opts.codexSessionId || !opts.opencodeEnabled) return base;
    // Mirrors OPENCODE_SESSION_ID_RE in src/main/opencode-resume.ts — re-checked
    // because session.json is a file the user can edit.
    if (!/^ses_[A-Za-z0-9]{8,120}$/.test(opts.opencodeSessionId)) return base;
    return applyResume(base, surfaceId, 'opencode', opts.opencodeSessionId);
  }
  if (opts.codexSessionId) {
    // Mixed provider state is ambiguous: never type a second agent into a TUI.
    if (claudeSessionId || !opts.codexEnabled || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(opts.codexSessionId)) return base;
    return applyResume(base, surfaceId, 'codex', opts.codexSessionId);
  }
  if (!enabled || !claudeSessionId) return base;
  // Re-validated here even though the main process validates on the way in:
  // this value round-tripped through session.json, which is a file on disk the
  // user can edit, and it is about to become a command line.
  if (!SESSION_ID_RE.test(claudeSessionId)) return base;
  return applyResume(base, surfaceId, 'claude', claudeSessionId);
}
