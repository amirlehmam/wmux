// ─── Markdown write grants (issue #116, F3) ──────────────────────────────────
// F3 adds the first renderer→disk *write* in the markdown surface. The renderer
// holds the backing path in its store and hands it back on save — but markdown
// content is explicitly untrusted (it arrives from CLI callers, agents and
// files), and the renderer that renders it also has preload/IPC access. So a
// renderer-supplied write path is treated as attacker-controlled.
//
// The grant set is the answer: main remembers which paths were opened *by a
// native dialog* or *by an authenticated pipe client* during this run, and
// refuses to write anywhere else. That keeps the blast radius of a renderer-side
// bug at "files the user already opened in this session" instead of
// "~/.ssh/authorized_keys".
//
// Deliberately NOT a grant source: MARKDOWN_READ_FILE. It takes a
// renderer-supplied path (it backs reload-from-disk and drag-and-drop), so
// granting on it would let the renderer mint its own grants and the set would
// mean nothing. A dropped file is therefore read-only until the user confirms
// a destination in the Save As dialog — the dialog IS the user's consent.

import * as path from 'path';

// Keyed by webContents id: one window's grants are not another's. Entries are
// dropped when the window goes away.
const grants = new Map<number, Set<string>>();

/** Case-insensitive on Windows, where the same file has many spellings. */
function canonical(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Record that the user (or an authenticated pipe client) opened this path. */
export function grantMarkdownPath(webContentsId: number, filePath: string): void {
  if (!filePath) return;
  let set = grants.get(webContentsId);
  if (!set) {
    set = new Set<string>();
    grants.set(webContentsId, set);
  }
  set.add(canonical(filePath));
}

/** Whether a write to this path is allowed from this renderer. */
export function isMarkdownPathGranted(webContentsId: number, filePath: string): boolean {
  if (!filePath) return false;
  return grants.get(webContentsId)?.has(canonical(filePath)) ?? false;
}

/** Forget a window's grants when it is destroyed. */
export function clearMarkdownGrants(webContentsId: number): void {
  grants.delete(webContentsId);
}

/** Test seam — the module-level map would otherwise leak between cases. */
export function resetMarkdownGrants(): void {
  grants.clear();
}
