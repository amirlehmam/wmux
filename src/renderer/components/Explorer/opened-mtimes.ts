// The mtime a code tab's buffer was read at, handed from the open (open-preview.ts) to the pane.
//
// `codeContent` goes into the store but its mtime had nowhere to go, and CodePane's read effect
// returns early when content is already present, so a file opened from the tree was SAVED with no
// expected mtime: the one check that stops a save from silently winning a race against an agent
// (or, for a remote file, against anything on the remote host) was skipped for the first save.
// In memory only, like `codeContent` itself: a restored tab has no content and re-reads, which
// records the mtime itself.
//
// An entry is taken by the pane that opens the file. A surface that is closed first never takes
// it, so closing a surface drops it (SURFACE_CLOSED_EVENT), and the map is capped besides.

import { setBounded } from '../../../shared/bounded-map';
import { SURFACE_CLOSED_EVENT } from '../../store/pty-teardown';

/** The most entries kept: one per code tab opened and not yet shown. */
export const OPENED_MTIMES_MAX = 64;

const openedMtimes = new Map<string, { filePath: string; mtimeMs: number }>();

/** Record the mtime `filePath` was read at when it was opened into `surfaceId`. */
export function recordOpenedMtime(surfaceId: string, filePath: string, mtimeMs: number): void {
  setBounded(openedMtimes, surfaceId, { filePath, mtimeMs }, OPENED_MTIMES_MAX);
}

/** The mtime recorded for `filePath` when it was opened into `surfaceId`; taken once. */
export function takeOpenedMtime(surfaceId: string, filePath: string): number | undefined {
  const entry = openedMtimes.get(surfaceId);
  if (!entry || entry.filePath !== filePath) return undefined;
  openedMtimes.delete(surfaceId);
  return entry.mtimeMs;
}

/** Tests only: how many are held. */
export function openedMtimeCount(): number {
  return openedMtimes.size;
}

if (typeof document !== 'undefined') {
  document.addEventListener(SURFACE_CLOSED_EVENT, (event) => {
    const surfaceId = (event as CustomEvent<{ surfaceId?: string }>).detail?.surfaceId;
    if (typeof surfaceId === 'string') openedMtimes.delete(surfaceId);
  });
}
