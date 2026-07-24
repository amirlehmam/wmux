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

export interface MarkdownReadError {
  error: string;
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
  if (!filePath) return { error: 'No file path provided' };

  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_MD_EXT.has(ext)) {
    return { error: `Unsupported file type: ${ext || '(none)'}` };
  }

  let stat: fs.Stats;
  try {
    // lstat, not stat: a symlink pointing at a non-whitelisted target would
    // otherwise pass the extension check via its own name (`notes.md` →
    // `~/.ssh/id_rsa`). Refusing links entirely is simpler than resolving and
    // re-checking, and nothing legitimate in this flow needs them.
    stat = fs.lstatSync(filePath);
  } catch {
    return { error: 'File not found' };
  }
  if (stat.isSymbolicLink()) return { error: 'Refusing to read a symlink' };
  if (!stat.isFile()) return { error: 'File is not a regular file' };
  if (stat.size > MAX_MD_BYTES) return { error: 'File exceeds the 5MB limit' };

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { filePath, content, mtimeMs: stat.mtimeMs };
  } catch (err: any) {
    return { error: err?.message || 'Failed to read file' };
  }
}
