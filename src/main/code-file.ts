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

/** How a file was stored, so a save can put it back the same way. */
export type CodeEncoding = 'utf8' | 'utf8-bom' | 'utf16le';

export function detectEncoding(head: Buffer): CodeEncoding {
  if (head.length >= 2 && head[0] === 0xFF && head[1] === 0xFE) return 'utf16le';
  if (head.length >= 3 && head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF) return 'utf8-bom';
  return 'utf8';
}

function encode(text: string, encoding: CodeEncoding): Buffer {
  if (encoding === 'utf16le') {
    return Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]);
  }
  if (encoding === 'utf8-bom') {
    return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf-8')]);
  }
  return Buffer.from(text, 'utf-8');
}

/**
 * Whether a file's existing newlines are CRLF, judged on the majority.
 *
 * This is not a nicety. A `<textarea>` normalizes its value to LF — that is the
 * HTML spec's API value, not a quirk we can opt out of — so a CRLF file typed
 * into and saved verbatim comes back entirely LF. Every line then reads as
 * modified, which on this platform means a one-character edit shows up as a
 * whole-file rewrite in the +N/-N column this same release adds, and in the
 * user's next commit. Detect what was there and put it back.
 *
 * Majority rather than "any CRLF present": a mixed file has to land somewhere,
 * and matching the dominant style changes the fewest lines.
 */
export function usesCrlf(text: string): boolean {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n') continue;
    if (i > 0 && text[i - 1] === '\r') crlf++;
    else lf++;
  }
  return crlf > lf;
}

/** LF → CRLF, without doubling the `\r` of a line that already has one. */
export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

export interface CodeWriteOk {
  filePath: string;
  /** mtime AFTER the write, so the pane's next save guards against this one. */
  mtimeMs: number;
}

/**
 * Write text back to a file the user opened in a pane.
 *
 * `absPath` MUST already have been through resolveInRoot AND the grant check in
 * file-grants.ts. This function knows about neither; it is the last step, not
 * the boundary.
 *
 * `expectedMtimeMs` is the load-bearing argument. The entire premise of this
 * feature is a user editing a file in the same folder an agent is working in,
 * so "changed underneath me" is the NORMAL case here rather than the exotic
 * one. A mismatch is refused outright and never merged or resolved by picking a
 * winner: silently choosing costs somebody their work with no message, which is
 * the one outcome the user cannot recover from. Mirrors writeMarkdownFile's
 * guard exactly rather than inventing a second conflict rule.
 *
 * Passing `undefined` skips the check, for a caller that genuinely has no prior
 * read to compare against. Every caller in wmux passes one.
 */
export function writeCodeFile(
  absPath: string,
  content: string,
  expectedMtimeMs?: number,
): CodeWriteOk | ExplorerListError {
  if (typeof content !== 'string') return fail('Invalid content', 'invalid_path');
  if (isBinaryPath(absPath)) return fail('Not a text file', 'binary');

  const stat = statForWrite(absPath, expectedMtimeMs);
  if ('error' in stat) return stat;

  const encoding = probeEncoding(absPath, stat.size);
  if (typeof encoding !== 'string') return encoding;

  const out = encodeForDisk(absPath, content, encoding);
  if (!Buffer.isBuffer(out)) return out;
  if (out.length > MAX_CODE_BYTES) return fail('File exceeds the 2MB limit', 'too_large');

  try {
    fs.writeFileSync(absPath, out);
    return { filePath: absPath, mtimeMs: fs.lstatSync(absPath).mtimeMs };
  } catch (err: any) {
    // Path-free on the wire for the reason mapErrno states — a Node fs error
    // message embeds the absolute path, and on Windows that carries the user's
    // account name.
    console.error('[code-file] write failed:', err?.message ?? err);
    return fail('Failed to write file', 'write_failed');
  }
}

/** lstat plus every refusal that must happen before a byte is written. */
function statForWrite(
  absPath: string,
  expectedMtimeMs: number | undefined,
): fs.Stats | ExplorerListError {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absPath);
  } catch {
    return fail('File not found', 'not_found');
  }
  // Same refusals the read side makes. A symlink that appeared since the read
  // is exactly the swap resolveInRoot's segment walk cannot close (see its
  // TOCTOU note), so re-checking here is not redundant — it is the narrower,
  // later check on the operation that actually mutates something.
  if (stat.isSymbolicLink()) return fail('Refusing to write through a symlink', 'invalid_path');
  if (!stat.isFile()) return fail('Not a regular file', 'invalid_path');
  if (expectedMtimeMs !== undefined && stat.mtimeMs !== expectedMtimeMs) {
    return fail('File changed on disk since it was opened', 'conflict');
  }
  return stat;
}

/**
 * How the file on disk is currently spelled.
 *
 * Read from DISK rather than round-tripped through the renderer: this is the
 * file being overwritten, so its own bytes are the authority, and an encoding
 * field on the wire would be one more renderer-supplied input to distrust for
 * no gain.
 */
function probeEncoding(absPath: string, size: number): CodeEncoding | ExplorerListError {
  let fd: number | null = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const head = Buffer.alloc(Math.min(3, size));
    if (head.length > 0) fs.readSync(fd, head, 0, head.length, 0);
    return detectEncoding(head);
  } catch (err: any) {
    console.error('[code-file] encoding probe failed:', err?.message ?? err);
    return fail('Failed to write file', 'write_failed');
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* best effort */ } }
  }
}

/**
 * The exact bytes to write: line endings restored to the file's own style, then
 * encoded the way it was already stored.
 *
 * The size cap is applied by the caller to THIS buffer rather than to the
 * incoming string, because UTF-16 doubles most source text — measuring the
 * string would let a file through at up to twice the limit the read side will
 * then refuse to reopen.
 */
function encodeForDisk(
  absPath: string,
  content: string,
  encoding: CodeEncoding,
): Buffer | ExplorerListError {
  try {
    const existing = readCodeFile(absPath);
    const keepCrlf = !('error' in existing) && usesCrlf(existing.content);
    return encode(keepCrlf ? toCrlf(content) : content, encoding);
  } catch (err: any) {
    console.error('[code-file] encode failed:', err?.message ?? err);
    return fail('Failed to write file', 'write_failed');
  }
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
