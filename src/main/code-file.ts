// ─── Code viewer: which files are text, and how they are read ────────────────
// Sibling to markdown-file.ts. It deliberately does NOT import from it and does
// not change it: markdown's extension whitelist stays exactly as narrow as it
// is, for exactly the callers it already has.
//
// Threat model, stated plainly because it INVERTS markdown's. markdown-file.ts
// names its extension whitelist as the thing stopping a renderer bug from
// reading ~/.ssh/id_rsa into a visible pane. This module has no whitelist — the
// whole point is to read files that whitelist rejects. What replaces it is the
// PATH JAIL in explorer-fs.ts's resolveInRoot, applied by the code:read-file
// handler before anything here is called. The deny-list and sniff below are a
// UX filter: they keep .png out of the tree and mojibake out of the pane. They
// are NOT the security boundary, and a future reader who treats them as one
// will draw the wrong conclusion about what may be relaxed.

import * as fs from 'fs';
import * as path from 'path';
import type { ExplorerListError } from '../shared/types';

/** Hard cap. Lower than markdown's 5 MB on purpose: this is the ceiling
 *  syntax highlighting will have to run under when it lands. */
export const MAX_CODE_BYTES = 2 * 1024 * 1024;

/** How much of the file the content sniff looks at. */
export const SNIFF_BYTES = 8192;

/**
 * Extensions never offered as text. A UX filter, not the boundary — see the
 * header. Kept broad rather than exhaustive: anything missed here is caught by
 * the content sniff, which is why this list not being perfect is survivable.
 */
export const BINARY_EXT: ReadonlySet<string> = new Set([
  // executables, libraries, build output
  '.exe', '.dll', '.so', '.dylib', '.node', '.class', '.pyc', '.pyd',
  '.o', '.a', '.lib', '.obj', '.pdb', '.bin', '.dat', '.asar', '.msi',
  // archives
  '.zip', '.7z', '.gz', '.tar', '.bz2', '.xz', '.rar', '.jar', '.whl', '.tgz',
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.avif', '.heic',
  // media
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.flac', '.ogg', '.webm',
  // fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // documents
  '.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt',
  // databases
  '.db', '.sqlite', '.sqlite3', '.mdb',
]);

export interface CodeReadOk {
  filePath: string;
  content: string;
  /** mtime at read time, so a later reload can detect an out-of-band rewrite. */
  mtimeMs: number;
}

function fail(message: string, code: ExplorerListError['code']): ExplorerListError {
  return { error: message, code };
}

/**
 * True when the NAME alone disqualifies a file. Note `path.extname` returns ''
 * for `Makefile` and for `.gitignore` (a leading dot is not an extension), so
 * both correctly fall through as text — which is the behaviour that makes an
 * extension-less repo file viewable.
 */
export function isBinaryPath(name: string): boolean {
  if (!name) return false;
  return BINARY_EXT.has(path.extname(name).toLowerCase());
}

/**
 * True when the first bytes of a file do not look like text.
 *
 * A NUL byte is decisive — no text encoding this viewer supports produces one,
 * and it is what catches a PNG or an ELF hiding behind a .txt. Past that it is
 * a density judgement: real text has almost no C0 control characters outside
 * tab/newline/CR/form-feed, and binary formats are dense with them.
 *
 * UTF-16LE is recognised by its BOM and accepted, because Windows tooling
 * emits it and it is otherwise half NUL bytes. UTF-16BE is NOT recognised and
 * will read as binary — a known, accepted limitation rather than an oversight:
 * it is vanishingly rare on this platform and supporting it means a manual
 * byte-swap for a case no one has hit.
 */
export function looksBinary(head: Buffer): boolean {
  if (head.length === 0) return false;
  if (head.length >= 2 && head[0] === 0xFF && head[1] === 0xFE) return false; // UTF-16LE

  const start = (head.length >= 3 && head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF)
    ? 3   // UTF-8 BOM
    : 0;
  const len = head.length - start;
  if (len <= 0) return false;

  let control = 0;
  for (let i = start; i < head.length; i++) {
    const b = head[i];
    if (b === 0x00) return true;
    // C0 controls except \t (0x09) \n (0x0A) \v (0x0B) \f (0x0C) \r (0x0D), plus DEL.
    if (b < 0x09 || (b > 0x0D && b < 0x20) || b === 0x7F) control++;
  }
  return control / len > 0.1;
}

function decode(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.subarray(3).toString('utf-8');
  }
  return buf.toString('utf-8');
}

/**
 * Read a file as text, applying every guard. Never throws — failures come back
 * as `{ error, code }` in ExplorerListError's shape, so the handler can forward
 * them straight to the renderer, which already translates every one of those
 * codes.
 *
 * `absPath` MUST already have been through resolveInRoot. This function does
 * not know what a root is and cannot check one.
 */
export function readCodeFile(absPath: string): CodeReadOk | ExplorerListError {
  if (isBinaryPath(absPath)) return fail('Not a text file', 'binary');

  let stat: fs.Stats;
  try {
    // lstat, not stat — same reasoning markdown-file.ts documents. resolveInRoot
    // has already refused every symlink on the path, so this is belt-and-braces
    // for a caller that reaches here another way.
    stat = fs.lstatSync(absPath);
  } catch {
    return fail('File not found', 'not_found');
  }
  if (stat.isSymbolicLink()) return fail('Refusing to read a symlink', 'invalid_path');
  if (!stat.isFile()) return fail('Not a regular file', 'invalid_path');
  if (stat.size > MAX_CODE_BYTES) return fail('File exceeds the 2MB limit', 'too_large');

  let fd: number | null = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const head = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size));
    if (head.length > 0) fs.readSync(fd, head, 0, head.length, 0);
    if (looksBinary(head)) return fail('Not a text file', 'binary');

    const buf = Buffer.alloc(stat.size);
    if (stat.size > 0) fs.readSync(fd, buf, 0, stat.size, 0);
    return { filePath: absPath, content: decode(buf), mtimeMs: stat.mtimeMs };
  } catch (err: any) {
    // Path-free on the wire, deliberately: a Node fs error message embeds the
    // absolute path, which on Windows carries the user's account name. Same
    // rule explorer-fs.ts's mapErrno states — log the real thing main-side,
    // hand the renderer a fixed string.
    console.error('[code-file] read failed:', err?.message ?? err);
    return fail('Failed to read file', 'read_failed');
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* best effort */ } }
  }
}
