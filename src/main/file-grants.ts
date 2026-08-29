// ─── Write grants: which paths a renderer may save to ────────────────────────
// Every renderer→disk write in wmux passes through this set. It began as
// markdown-grants.ts for issue #116 (F3) and is now shared by the markdown and
// code surfaces, because two grant sets would be two answers to "may this be
// written" and the failure mode of that drift is a silent write to a file one
// of them would have refused.
//
// The problem it solves has not changed. The renderer holds a backing path in
// its store and hands it back on save, but file CONTENT is explicitly untrusted
// (it arrives from CLI callers, agents and files) and the renderer that renders
// it also has preload/IPC access. So a renderer-supplied write path is treated
// as attacker-controlled, and main writes only where it remembers the user
// having opened something.
//
// ─── What counts as consent, and what changed ────────────────────────────────
// Originally: a native dialog, or an authenticated pipe client. #210 then
// considered a jailed markdown read that minted a grant BECAUSE it was jailed,
// and refused it — correctly, for what it was: an automatic grant, minted as a
// side effect of a read the user had not asked for, over the folder the user's
// real work lives in. "Jailed to a pane root" is not consent; it is a smaller
// blast radius.
//
// That refusal is now partially reversed, deliberately, and this is the record
// of it. The transaction the explorer's editor performs is a different one: the
// user clicks a row in a tree, types into the buffer, and presses Ctrl+S. The
// grant records THAT gesture. The rule it establishes:
//
//   A write lands only on a path that was opened into a live pane in this
//   window, in this session, THROUGH THE JAIL — and only if the file has not
//   changed on disk since it was read (the mtime guard, enforced by the
//   writers, not here).
//
// Narrower than "anything under the root", wider than "only what a dialog
// returned". A reader who wants to widen it further should know they are
// arguing with #210, not discovering an oversight.
//
// Still deliberately NOT a grant source: MARKDOWN_READ_FILE. It takes a
// renderer-supplied ABSOLUTE path (it backs reload-from-disk and
// drag-and-drop), so granting on it would let the renderer mint its own grants
// and the set would mean nothing. A dropped file stays read-only until the user
// confirms a destination in Save As. The jailed reads — CODE_READ_FILE and
// EXPLORER_READ_MARKDOWN — mint; the unjailed one does not. That is the whole
// distinction, and it is the reason the jailed markdown read had to be a
// separate channel rather than a flag on the existing one.

import * as path from 'path';

// Keyed by webContents id: one window's grants are not another's. Entries are
// dropped when the window goes away.
const grants = new Map<number, Set<string>>();

/** Case-insensitive on Windows, where the same file has many spellings.
 *  Exported for explorer-fs.ts's jail — a second copy of this rule is exactly
 *  the drift markdown-file.ts was extracted to prevent. */
export function canonical(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Record that this path was opened by something that counts as consent: a
 * native dialog, an authenticated pipe client, or a jailed open from the file
 * tree. See the header for why the last one is on that list.
 */
export function grantFilePath(webContentsId: number, filePath: string): void {
  if (!filePath) return;
  let set = grants.get(webContentsId);
  if (!set) {
    set = new Set<string>();
    grants.set(webContentsId, set);
  }
  set.add(canonical(filePath));
}

/** Whether a write to this path is allowed from this renderer. */
export function isFilePathGranted(webContentsId: number, filePath: string): boolean {
  if (!filePath) return false;
  return grants.get(webContentsId)?.has(canonical(filePath)) ?? false;
}

/** Forget a window's grants when it is destroyed. */
export function clearFileGrants(webContentsId: number): void {
  grants.delete(webContentsId);
}

/** Test seam — the module-level map would otherwise leak between cases. */
export function resetFileGrants(): void {
  grants.clear();
}
