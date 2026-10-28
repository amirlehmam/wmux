// ─── Terminal file links: what a Ctrl+click on a printed path may open ───────
// Ctrl+click on a file path printed in a terminal. The renderer
// (`utils/terminal-file-links.ts`) only finds path-shaped text; this module
// decides what it may open.
//
// Unlike every other explorer channel, it takes the path AS PRINTED, relative
// or absolute, because the renderer has no root to relativize against: main
// resolves it against the pane's explorer root and sends it through
// explorer-fs.ts's
// `resolveInRoot`, so a printed path gets exactly the reach a click in the
// explorer tree has. The only thing allowed past the jail is a file on
// markdown's extension whitelist, which `markdown.readFile` already opens from
// any absolute path. An ssh pane gets nothing — its handler in ipc-handlers.ts
// refuses it before this module is called. The renderer opens a jailed text
// file in the preview tab.

import * as path from 'path';
import { promises as fsp } from 'fs';
import type { TerminalFileLinkResult } from '../shared/types';
import { resolveInRoot } from './explorer-fs';
import { isBinaryPath } from './code-file';
import { isAllowedMarkdownPath } from './markdown-file';

export const MAX_LINK_TEXT = 1024;

// A UNC or device path is never a link. This runs on HOVER over terminal
// output, which a remote host or a printed file controls: stat-ing a
// `\\host\share\a.md` would open an SMB connection (an NTLM leak) and, on an
// unreachable host, hold the call for the whole SMB timeout.
const NETWORK_OR_DEVICE = /^[\\/]{2}/;

const OUTSIDE_ROOT: TerminalFileLinkResult = { error: 'Path is outside the root', code: 'outside_root' };
const NOT_FOUND: TerminalFileLinkResult = { error: 'File not found', code: 'not_found' };

function isInside(rel: string): boolean {
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function isValidLinkText(text: unknown): text is string {
  return typeof text === 'string' && text.length > 0 && text.length <= MAX_LINK_TEXT && !text.includes('\0');
}

/** A file under the root, through the jail; null means "not under the root". */
async function resolveJailed(realRoot: string, target: string): Promise<TerminalFileLinkResult | null> {
  const rel = path.relative(realRoot, target);
  if (!isInside(rel)) return null;
  const relPath = rel.split(path.sep).join('/');
  const resolved = await resolveInRoot(realRoot, relPath, 'file');
  if ('error' in resolved) return resolved.code === 'outside_root' ? null : resolved;
  const name = path.basename(resolved.abs);
  return { kind: 'jailed', relPath, absPath: resolved.abs, name, viewable: !isBinaryPath(name) };
}

/** Markdown anywhere on a LOCAL disk. Async: this answers a hover, and a slow
 *  disk must not stall main's loop. lstat + isFile refuses a symlink. */
async function resolveMarkdown(target: string): Promise<TerminalFileLinkResult> {
  if (!isAllowedMarkdownPath(target)) return OUTSIDE_ROOT;
  try {
    if (!(await fsp.lstat(target)).isFile()) return NOT_FOUND;
  } catch {
    return NOT_FOUND;
  }
  return { kind: 'markdown', absPath: target, name: path.basename(target) };
}

export async function resolveTerminalFileLink(
  realRoot: string | null,
  text: unknown,
): Promise<TerminalFileLinkResult> {
  if (!isValidLinkText(text)) return { error: 'Invalid path', code: 'invalid_path' };
  if (NETWORK_OR_DEVICE.test(text)) return OUTSIDE_ROOT;
  if (!realRoot && !path.isAbsolute(text)) return OUTSIDE_ROOT;

  const target = realRoot ? path.resolve(realRoot, text) : path.resolve(text);
  if (NETWORK_OR_DEVICE.test(target)) return OUTSIDE_ROOT;

  const jailed = realRoot ? await resolveJailed(realRoot, target) : null;
  return jailed ?? resolveMarkdown(target);
}
