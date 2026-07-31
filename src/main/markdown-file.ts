// ─── Markdown file guards (issue #116) ───────────────────────────────────────
// Single home for the read guards that back every markdown entry point. These
// rules used to be copy-pasted in two places (the `markdown.load_file` pipe
// handler in ./index.ts and the MARKDOWN_OPEN_FILE dialog handler in
// ./ipc-handlers.ts); F0 adds reload / reveal / open-in-default-app, which would
// have made four copies. Extracting them keeps the reachable file set defined in
// exactly one spot.
//
// Threat model: markdown content is explicitly untrusted (it arrives from CLI
// callers, agents and files — see the comment in MarkdownPane.tsx), and the
// renderer that asks for these reads has preload/IPC access. So even though the
// caller is "our own" renderer, a path it supplies is treated as attacker-
// controlled: the extension whitelist is what stops a renderer-side bug from
// turning into "read ~/.ssh/id_rsa into a visible pane", and the regular-file
// check stops device/FIFO paths from hanging the read.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Extensions the markdown surface will read. Kept deliberately narrow. */
export const ALLOWED_MD_EXT = new Set(['.md', '.markdown', '.mdx', '.txt', '.text', '.rst']);

/** Hard cap on file size — the source view renders every line as a DOM node. */
export const MAX_MD_BYTES = 5 * 1024 * 1024;

/** Dialog filter list, derived from ALLOWED_MD_EXT so the two can't drift. */
export const MD_DIALOG_EXTENSIONS = [...ALLOWED_MD_EXT].map((e) => e.slice(1));

export interface MarkdownReadOk {
  filePath: string;
  content: string;
  /** mtime at read time — lets the renderer detect out-of-band rewrites later. */
  mtimeMs: number;
}

/**
 * Stable, language-independent reason for a failure. `error` stays the
 * English message (CLI/pipe callers print it verbatim — see index.ts's
 * `markdown.load_file` handler); `code` is what the renderer maps to a
 * `t('markdown.error.*', ...)` key, since the main process has no access to
 * the renderer's i18n system (issue: main-process errors were winning over
 * the renderer's translated fallback because `error` was always truthy).
 */
export type MarkdownErrorCode =
  | 'no_path'
  | 'unsupported_type'
  | 'not_found'
  | 'symlink'
  | 'not_regular_file'
  | 'too_large'
  | 'no_content'
  | 'read_failed'
  | 'write_failed';

export interface MarkdownReadError {
  error: string;
  code: MarkdownErrorCode;
}

export type MarkdownReadResult = MarkdownReadOk | MarkdownReadError;

/**
 * True when `filePath` has an extension the markdown surface is allowed to touch.
 * Used on its own by the shell actions (reveal / open in default app), where the
 * point is to stop a renderer-supplied path from launching an arbitrary `.exe`.
 */
export function isAllowedMarkdownPath(filePath: string): boolean {
  if (!filePath) return false;
  return ALLOWED_MD_EXT.has(path.extname(filePath).toLowerCase());
}

/**
 * Read a markdown file applying every guard: extension whitelist, regular-file
 * check and the 5 MB cap. Never throws — failures come back as `{ error }` so
 * callers can forward them to a pipe response or an IPC return value verbatim.
 */
export function readMarkdownFile(filePath: string): MarkdownReadResult {
  if (!filePath) return { error: 'No file path provided', code: 'no_path' };

  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_MD_EXT.has(ext)) {
    return { error: `Unsupported file type: ${ext || '(none)'}`, code: 'unsupported_type' };
  }

  let stat: fs.Stats;
  try {
    // lstat, not stat: a symlink pointing at a non-whitelisted target would
    // otherwise pass the extension check via its own name (`notes.md` →
    // `~/.ssh/id_rsa`). Refusing links entirely is simpler than resolving and
    // re-checking, and nothing legitimate in this flow needs them.
    stat = fs.lstatSync(filePath);
  } catch {
    return { error: 'File not found', code: 'not_found' };
  }
  if (stat.isSymbolicLink()) return { error: 'Refusing to read a symlink', code: 'symlink' };
  if (!stat.isFile()) return { error: 'File is not a regular file', code: 'not_regular_file' };
  if (stat.size > MAX_MD_BYTES) return { error: 'File exceeds the 5MB limit', code: 'too_large' };

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { filePath, content, mtimeMs: stat.mtimeMs };
  } catch (err: any) {
    return { error: err?.message || 'Failed to read file', code: 'read_failed' };
  }
}

/** Current mtime of a file, or null if it is gone / unreadable. Backs the
 *  on-focus "changed on disk?" check, which needs no content. */
export function statMarkdownFile(filePath: string): { mtimeMs: number } | MarkdownReadError {
  if (!isAllowedMarkdownPath(filePath)) return { error: 'Unsupported file type', code: 'unsupported_type' };
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) return { error: 'File is not a regular file', code: 'not_regular_file' };
    return { mtimeMs: stat.mtimeMs };
  } catch {
    return { error: 'File not found', code: 'not_found' };
  }
}

// ─── Writing (F3) ────────────────────────────────────────────────────────────

export type MarkdownWriteResult =
  | { ok: true; mtimeMs: number }
  /** The file moved under us — the buffer is stale, so nothing was written. */
  | { conflict: true; currentMtimeMs: number }
  | MarkdownReadError;

/**
 * Write a markdown buffer back to disk with every guard the read path has,
 * plus two the write path needs on its own.
 *
 * - **Extension whitelist on write too.** Otherwise a grant could be laundered
 *   into writing `.ps1` / `.cmd` / `.bat` — the reachable set has to be the
 *   same going out as coming in.
 * - **Symlink refusal**, so a save can't be redirected through a link planted
 *   by whatever produced the markdown.
 * - **Optimistic concurrency.** Agents rewrite files under the pane constantly;
 *   if `expectedMtimeMs` no longer matches, refuse and report, rather than
 *   silently overwriting the agent's work (or the user's, depending who lost).
 * - **Atomic rename.** A half-written spec is worse than an unsaved one, and an
 *   interrupted write is exactly what happens when the app is quitting.
 */
/** Everything that can refuse a write before a single byte is produced. */
function checkWritable(
  filePath: string,
  content: string,
  expectedMtimeMs?: number,
): MarkdownWriteResult | null {
  if (!filePath) return { error: 'No file path provided', code: 'no_path' };
  if (typeof content !== 'string') return { error: 'No content to write', code: 'no_content' };
  if (!isAllowedMarkdownPath(filePath)) {
    return { error: `Unsupported file type: ${path.extname(filePath) || '(none)'}`, code: 'unsupported_type' };
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_MD_BYTES) {
    return { error: 'Content exceeds the 5MB limit', code: 'too_large' };
  }

  let existing: fs.Stats;
  try {
    existing = fs.lstatSync(filePath);
  } catch {
    // Missing is fine — this is Save As, or a file deleted since it was opened.
    return null;
  }
  if (existing.isSymbolicLink()) return { error: 'Refusing to write through a symlink', code: 'symlink' };
  if (!existing.isFile()) return { error: 'File is not a regular file', code: 'not_regular_file' };
  if (expectedMtimeMs !== undefined && existing.mtimeMs !== expectedMtimeMs) {
    return { conflict: true, currentMtimeMs: existing.mtimeMs };
  }
  return null;
}

export function writeMarkdownFile(
  filePath: string,
  content: string,
  expectedMtimeMs?: number,
): MarkdownWriteResult {
  const refusal = checkWritable(filePath, content, expectedMtimeMs);
  if (refusal) return refusal;

  // Same directory as the target so the rename stays on one filesystem, which
  // is what makes it atomic.
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.wmux-tmp-${crypto.randomBytes(6).toString('hex')}`,
  );
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err: any) {
    try { fs.unlinkSync(tmpPath); } catch { /* nothing to clean up */ }
    return { error: err?.message || 'Failed to write file', code: 'write_failed' };
  }

  try {
    return { ok: true, mtimeMs: fs.statSync(filePath).mtimeMs };
  } catch {
    // Written, but we can't read the new mtime — report success without one so
    // the pane clears its dirty flag; the next focus check re-stats anyway.
    return { ok: true, mtimeMs: 0 };
  }
}
