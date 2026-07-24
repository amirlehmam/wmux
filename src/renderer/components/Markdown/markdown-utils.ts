// ─── Markdown pane helpers (issue #116) ──────────────────────────────────────
// Pure functions only — no React, no store, no `window`. Kept out of the
// component so the path-display rules (the fiddly part) are unit-testable
// without mounting a pane.

/**
 * Above this many lines the source view drops the per-line gutter and renders a
 * single <pre>. The 5 MB read cap allows ~100k lines, and one <div> per line at
 * that size janks badly — but pulling in a virtualization dependency for a
 * pathological case is worse in a project that keeps its dep list this short.
 */
export const SOURCE_VIRTUALIZE_THRESHOLD = 5000;

/**
 * Compare-normalized form of a path: forward slashes, no trailing separator,
 * lowercased. Windows paths are case-insensitive and wmux accepts either
 * separator, so `C:\Users\me` and `c:/users/me/` must compare equal.
 *
 * Length-preserving apart from the trailing-separator strip, which is what lets
 * callers slice the *original* string using an offset computed from this one
 * (and so keep the caller's separators in the output).
 */
function normalizeForCompare(p: string): string {
  const slashed = p.replace(/\\/g, '/').toLowerCase();
  // Trailing separators are trimmed with a loop rather than /\/+$/, which
  // backtracks super-linearly on a long run of slashes.
  let end = slashed.length;
  while (end > 1 && slashed[end - 1] === '/') end--;
  return slashed.slice(0, end);
}

/** The separator a path is written with, so generated output matches its style. */
function separatorOf(p: string): string {
  return p.includes('\\') ? '\\' : '/';
}

/**
 * `filePath` expressed relative to `baseDir`, or null when it isn't inside it.
 * Separators from the original string are preserved — on Windows the copied
 * path has to stay backslash-form so `cmd.exe` consumers accept it.
 */
export function toRelativePath(filePath: string, baseDir?: string): string | null {
  if (!filePath || !baseDir) return null;
  const nf = normalizeForCompare(filePath);
  const nb = normalizeForCompare(baseDir);
  if (!nb || nf === nb) return null;
  if (!nf.startsWith(nb + '/')) return null;
  return filePath.slice(nb.length + 1);
}

/**
 * How a backing path is shown in the toolbar chip:
 *   - inside the workspace cwd  → relative (`docs/PLAN.md`) — the common case
 *   - inside the home directory → `~`-shortened
 *   - anywhere else             → unchanged, absolute
 *
 * Deliberately does NOT ellipsize; that's a separate width concern so the same
 * value can be reused for the `title` tooltip at full length.
 */
export function toDisplayPath(
  filePath: string,
  options: { cwd?: string; homeDir?: string } = {},
): string {
  if (!filePath) return '';

  const relToCwd = toRelativePath(filePath, options.cwd);
  if (relToCwd) return relToCwd;

  const relToHome = toRelativePath(filePath, options.homeDir);
  if (relToHome) return `~${separatorOf(filePath)}${relToHome}`;

  return filePath;
}

/**
 * Shorten to fit a narrow pane by eating the middle, never the basename — the
 * filename is the one part the user is actually identifying the pane by.
 */
export function middleEllipsize(text: string, max: number): string {
  if (!text || max <= 1 || text.length <= max) return text;

  const sepIdx = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  // Includes the leading separator, so the result reads `…/PLAN.md` rather than
  // `…PLAN.md` (which looks like a truncated filename).
  const base = sepIdx >= 0 ? text.slice(sepIdx) : text;

  // The basename alone already overflows: trim from the left instead, so the
  // result still honours `max` rather than growing past it.
  if (base.length + 1 >= max) return `…${text.slice(text.length - (max - 1))}`;

  return `${text.slice(0, max - base.length - 1)}…${base}`;
}
