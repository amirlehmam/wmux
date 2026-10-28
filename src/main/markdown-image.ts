// ─── Local images in the markdown pane (issue #380) ─────────────────────────
// `![](shot.png)` in a markdown file means "the file next to this document".
// The renderer cannot load it itself: in a packaged build the page is
// `file:///…/dist/renderer/index.html`, so a relative src resolves against the
// APP directory, and a drive path or a `file:` URL is stripped by DOMPurify.
// So main reads the file and hands back a `data:` URL, behind
// `markdown:read-image`: read-only, and it mints nothing.
//
// ─── What this lets a document reach, stated honestly ───────────────────────
// The document is untrusted (it arrives from agents, CLI callers and files),
// and it may name `../../.ssh/id_rsa.png` or `C:\anything`. Absolute paths are
// part of the feature (an agent's report pointing at a screenshot it took), so
// LOCATION is not the boundary — a containment check under the document's
// folder would refuse the absolute path that is allowed one line above it.
// The boundary is the file's TYPE:
//
//   - the extension is one of IMAGE_TYPES, AND the bytes say so (magic bytes
//     for raster, an `<svg` root for SVG), so a renamed `id_rsa.png` is refused;
//   - a regular file, not a link (the markdown-file.ts rule: a link named
//     `x.png` could point anywhere), at most MAX_IMAGE_BYTES;
//   - never UNC unless the document itself lives on that same share, and never
//     a device path (`\\?\`, `\\.\`). An image src naming `\\attacker\x.png`
//     makes Windows authenticate to that host — an NTLM hash handed to whoever
//     wrote the markdown. That is the one fetch here with a victim other than
//     the pixels.
//
// So the reach is "image files this user can read", the same as a local HTML
// file opened in any browser. An SVG goes back as an `<img src=data:>` and is
// never inlined: SVG in an image context runs no script and loads nothing.
//
// ─── Why the document path comes from the renderer ──────────────────────────
// It would be narrower for main to know which document a surface shows, but
// main has no copy of the split tree (it asks the renderer), session restore
// brings back a markdown surface main never read, and MARKDOWN_READ_FILE
// already takes a renderer-supplied absolute path. The document path is
// therefore only the BASE for relative srcs and grants nothing: it must look
// like a markdown document (isAllowedMarkdownPath, absolute), and every rule
// above applies to the image whatever base was supplied.

import * as fs from 'fs';
import * as path from 'path';
import { isAllowedMarkdownPath } from './markdown-file';

/** Extension → MIME. The extension gate; the bytes are checked separately. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

/** Per image. Base64 makes it ~13 MB on the wire, which is already plenty. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type MarkdownImageErrorCode =
  | 'no_path'
  | 'unsupported_path'
  | 'unc_refused'
  | 'unsupported_type'
  | 'not_found'
  | 'symlink'
  | 'not_regular_file'
  | 'too_large'
  | 'not_an_image'
  | 'read_failed';

export interface MarkdownImageError {
  error: string;
  code: MarkdownImageErrorCode;
}

export type ResolvedImage = { path: string } | MarkdownImageError;

const win = path.win32;

const DRIVE_ABSOLUTE = /^[a-z]:[\\/]/i;
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;

function fail(code: MarkdownImageErrorCode, error: string): MarkdownImageError {
  return { error, code };
}

function isUnc(p: string): boolean {
  return p.startsWith('\\\\') || p.startsWith('//');
}

/** `\\server\share`, lowercased — the part of a UNC path that names a host. */
function uncShare(p: string): string | null {
  const parts = p.replace(/\//g, '\\').split('\\');
  // ['', '', server, share, ...]
  if (parts.length < 4 || parts[0] !== '' || parts[1] !== '' || !parts[2] || !parts[3]) return null;
  return `\\\\${parts[2]}\\${parts[3]}`.toLowerCase();
}

function isDevicePath(p: string): boolean {
  return /^[\\/]{2}[?.][\\/]/.test(p);
}

/** Percent-decoding that never throws: `100%.png` is a legal file name. */
function decode(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** Drop a `?query` / `#fragment` — `shot.png?raw=true` is common in READMEs. */
function stripSuffix(p: string): string {
  const cut = p.search(/[?#]/);
  return cut >= 0 ? p.slice(0, cut) : p;
}

/** `file:` URL → a Windows path (UNC when it names a host other than localhost). */
function fromFileUrl(src: string): string {
  let rest = src.slice('file:'.length);
  if (rest.startsWith('//')) {
    rest = rest.slice(2);
    const slash = rest.indexOf('/');
    const host = slash >= 0 ? rest.slice(0, slash) : rest;
    rest = slash >= 0 ? rest.slice(slash) : '';
    // `file://server/share/x` is UNC — reported as such so the caller refuses
    // it with the same rule as `\\server\share\x`.
    if (host && host.toLowerCase() !== 'localhost') return `\\\\${host}${decode(stripSuffix(rest)).replace(/\//g, '\\')}`;
  }
  // `file:///C:/x` and `file:/C:/x` both leave `/C:/x` here.
  const local = decode(stripSuffix(rest)).replace(/^\/(?=[a-z]:)/i, '');
  return local.replace(/\//g, '\\');
}

/** The src as a Windows path, before the UNC rule — or why it has none. */
function candidatePath(raw: string, doc: string | null): string | MarkdownImageError {
  if (/^file:/i.test(raw)) return fromFileUrl(raw);
  if (DRIVE_ABSOLUTE.test(raw) || isUnc(raw)) return decode(stripSuffix(raw));
  if (SCHEME.test(raw) || /^[a-z]:/i.test(raw)) {
    // `https:` never reaches here (the renderer keeps those), and `C:foo` is
    // relative to the current directory OF DRIVE C, which nobody means.
    return fail('unsupported_path', 'Unsupported image path');
  }
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    // Root-relative. On a static site that is the SITE root, on Windows the
    // root of the current drive — neither is the document's folder, and
    // guessing one of them is worse than a visible broken image.
    return fail('unsupported_path', 'Root-relative image paths are not supported');
  }
  if (!doc) return fail('unsupported_path', 'A relative image needs a document saved to disk');
  return win.resolve(win.dirname(doc), decode(stripSuffix(raw)));
}

/** Device paths always, UNC unless the document is on that same share. */
function refuseRemote(candidate: string, doc: string | null): MarkdownImageError | null {
  if (isDevicePath(candidate)) return fail('unc_refused', 'Device paths are refused');
  if (!isUnc(candidate)) return null;
  const share = uncShare(candidate);
  if (share && doc && share === uncShare(doc)) return null;
  return fail('unc_refused', 'Network images are refused unless the document is on the same share');
}

/**
 * Where an image src points, given the document that names it. Pure: no
 * filesystem access, so the rules are testable without one.
 *
 * `documentPath` is optional — a surface whose content was pushed over the
 * pipe has no backing file, and can still show an absolute path; only a
 * relative src needs a base.
 */
export function resolveImagePath(documentPath: string | null | undefined, src: string): ResolvedImage {
  const raw = (src ?? '').trim();
  if (!raw) return fail('no_path', 'No image path');

  const doc = documentPath ? win.normalize(documentPath) : null;
  if (doc && (!isAllowedMarkdownPath(doc) || !(DRIVE_ABSOLUTE.test(doc) || uncShare(doc)))) {
    return fail('unsupported_path', 'The document path is not a markdown file');
  }

  const candidate = candidatePath(raw, doc);
  if (typeof candidate !== 'string') return candidate;

  const refused = refuseRemote(candidate, doc);
  if (refused) return refused;

  const resolved = win.normalize(candidate);
  if (!DRIVE_ABSOLUTE.test(resolved) && !uncShare(resolved)) {
    return fail('unsupported_path', 'Unsupported image path');
  }
  return { path: resolved };
}

const startsWith = (buf: Buffer, bytes: number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/**
 * The MIME the BYTES claim, or null. Raster formats have fixed signatures;
 * SVG is text, so it counts when an `<svg` tag appears in its head (after an
 * optional BOM, XML prolog, comments or doctype) and the head has no NUL — a
 * binary file with `<svg` somewhere in it is not an SVG.
 */
export function sniffImageType(buf: Buffer): string | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(buf, ascii('BM')) && buf.length >= 26) return 'image/bmp';
  if (startsWith(buf, [0x00, 0x00, 0x01, 0x00]) && buf.length >= 6) return 'image/x-icon';
  const head = buf.subarray(0, 4096);
  if (!head.includes(0) && /<svg[\s>]/i.test(head.toString('utf-8'))) return 'image/svg+xml';
  return null;
}

/** Whether the bytes are acceptable for a file with this extension. */
export function bytesMatchExtension(ext: string, sniffed: string | null): boolean {
  if (!sniffed || !(ext in IMAGE_TYPES)) return false;
  // A mislabelled raster (a JPEG saved as .png) is common and harmless; an SVG
  // must say it is one, and a raster extension must hold raster bytes.
  const svgExt = ext === '.svg';
  return svgExt === (sniffed === 'image/svg+xml');
}

export type MarkdownImageResult = { dataUrl: string; path: string } | MarkdownImageError;

/** Resolve, check and read one image. Never throws. */
export async function readMarkdownImage(
  documentPath: string | null | undefined,
  src: string,
): Promise<MarkdownImageResult> {
  const resolved = resolveImagePath(documentPath, src);
  if ('error' in resolved) return resolved;
  const filePath = resolved.path;

  const ext = win.extname(filePath).toLowerCase();
  if (!(ext in IMAGE_TYPES)) return fail('unsupported_type', `Unsupported image type: ${ext || '(none)'}`);

  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(filePath);
  } catch {
    return fail('not_found', 'Image not found');
  }
  if (stat.isSymbolicLink()) return fail('symlink', 'Refusing to read a symlink');
  if (!stat.isFile()) return fail('not_regular_file', 'Not a regular file');
  if (stat.size > MAX_IMAGE_BYTES) return fail('too_large', 'Image exceeds the 10MB limit');

  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(filePath);
  } catch (err: unknown) {
    return fail('read_failed', (err as Error)?.message || 'Failed to read image');
  }
  // Re-checked on the bytes actually read: the file may have grown since lstat.
  if (buf.length > MAX_IMAGE_BYTES) return fail('too_large', 'Image exceeds the 10MB limit');

  const sniffed = sniffImageType(buf);
  if (!bytesMatchExtension(ext, sniffed)) return fail('not_an_image', 'The file is not the image its name says');

  return { dataUrl: `data:${sniffed};base64,${buf.toString('base64')}`, path: filePath };
}
