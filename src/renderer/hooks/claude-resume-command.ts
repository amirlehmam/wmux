// ─── Claude resume, renderer side (issue #186) ───────────────────────────────
//
// Split out of useTerminal.ts so it can be tested without standing up xterm,
// a DOM and a PTY bridge. Everything here is pure except the module-level
// guard, which is the one piece that genuinely has to be process-wide.

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
 * The startup commands a freshly created PTY should run, with the stored Claude
 * resume appended when this surface has one and the user opted in.
 *
 * Appended, not prepended: a quick-launch profile's own commands are setup for
 * the shell (activate a venv, cd somewhere), and `claude --resume` does not
 * return to the prompt — it takes over the terminal. Anything queued after it
 * would be typed into Claude's input box instead of run by the shell. Setup
 * first, resume last, is the only order where both still mean what they say.
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
}): string[] | undefined {
  const { base, surfaceId, claudeSessionId, enabled } = opts;
  if (!enabled || !surfaceId || !claudeSessionId) return base;
  // Re-validated here even though the main process validates on the way in:
  // this value round-tripped through session.json, which is a file on disk the
  // user can edit, and it is about to become a command line.
  if (!SESSION_ID_RE.test(claudeSessionId)) return base;
  if (resumedSurfaces.has(surfaceId)) return base;
  resumedSurfaces.add(surfaceId);
  return [...(base ?? []), `claude --resume ${claudeSessionId}`];
}
