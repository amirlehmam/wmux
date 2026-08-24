/**
 * remote-insert.ts — decide what text a paste or a drop puts into a terminal.
 *
 * Lives in main because every input to the decision does: the clipboard, the
 * ssh detector, the filesystem, scp, and the user config. The renderer used to
 * drive this and paid up to four IPC round trips per Ctrl+V transcribing main's
 * own data back to it — including one on every plain text paste that could
 * never succeed. It now asks one question and types the answer.
 *
 * The ssh session is passed in rather than looked up here, so this module never
 * has to import the detector that `ipc-handlers` owns.
 */

import { clipboard } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { windowsTerminalQuote, posixShellQuote } from './shell-quote';
import { uploadFiles } from './remote-upload';
import type { DetectedSsh } from './ssh-argv';
import type { InsertionResult } from '../shared/types';

// Re-exported so callers and tests can name the contract from the module
// that produces it, while `shared/types` stays its single declaration.
export type { InsertionResult };


/**
 * Is upload switched on for this gesture?
 *
 * `[remote]` in `~/.wmux/config.toml`; both halves default to on, and the two
 * are independent — someone who disables it for paste keeps it for drop.
 * Takes the config section rather than reading it, so the mapping is testable
 * without a config file.
 */
export function uploadEnabled(
  remote: { uploadOnPaste?: boolean; uploadOnDrop?: boolean } | undefined,
  mode: 'paste' | 'drop',
): boolean {
  const toggle = mode === 'paste' ? remote?.uploadOnPaste : remote?.uploadOnDrop;
  return toggle !== false;
}

/** What a paste is made of, once the clipboard has been read. */
export type PasteSource =
  | { kind: 'files'; localPaths: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'none' };


/** Text for local paths — the behaviour a non-ssh pane has always had. */
export function localInsertionText(paths: string[]): string {
  return paths.map(windowsTerminalQuote).join(' ');
}

/** Text for paths on the far side of an ssh connection. */
export function remoteInsertionText(paths: string[]): string {
  return paths.map(posixShellQuote).join(' ');
}

/**
 * Read the clipboard into whatever the paste should be made of.
 *
 * Order matters. A screenshot is an image with no text, and a file copied in
 * Explorer is a *file reference* with neither an image nor text — which is why
 * checking only `readImage()` made that paste do nothing at all while dragging
 * the same file worked.
 */
export function readClipboardSource(): PasteSource {
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    const dir = path.join(os.tmpdir(), 'wmux');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `screenshot-${Date.now()}.png`);
    fs.writeFileSync(file, image.toPNG());
    return { kind: 'files', localPaths: [file] };
  }

  // Explorer's Ctrl+C. Electron does not surface CF_HDROP on Windows — it
  // advertises `text/uri-list` and reads it back empty — so `FileNameW`, a
  // single-path format, is all that is reachable. Several files at once stay
  // the drag-and-drop route.
  const copied = clipboardFilePath();
  if (copied) return { kind: 'files', localPaths: [copied] };

  const text = clipboard.readText();
  return text ? { kind: 'text', text } : { kind: 'none' };
}

function clipboardFilePath(): string | null {
  let raw: Buffer;
  try {
    raw = clipboard.readBuffer('FileNameW');
  } catch {
    return null;
  }
  if (!raw || raw.length === 0) return null;
  const filePath = raw.toString('ucs2').replace(/\0+$/, '').trim();
  return filePath && isRegularFile(filePath) ? filePath : null;
}

/**
 * Only regular files are uploadable — a directory is not something to hand scp,
 * and a clipboard entry can outlive the file it names. Anything else falls back
 * to inserting the local path, which is what cmux's `plan()` does too.
 */
function isRegularFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the text to type.
 *
 * `session` is null for a local pane, which is also what a failed detection
 * looks like — either way the answer is the local path, which is merely the
 * old behaviour rather than something wrong.
 *
 * Pure: the clipboard read and the config lookup happen in the caller, which
 * is what lets the whole branch table be tested without an Electron window.
 */
export async function resolveInsertion(
  source: PasteSource,
  session: DetectedSsh | null,
  mayUpload: boolean,
): Promise<InsertionResult> {
  if (source.kind === 'none') return { text: null };
  // Text is typed as-is: there is no file to put anywhere.
  if (source.kind === 'text') return { text: source.text };

  const localPaths = source.localPaths;
  if (localPaths.length === 0) return { text: null };

  // `mayUpload` already folds in the config toggle for this gesture and the
  // Shift modifier: both mean "give me the local path", and nothing here can
  // tell them apart or needs to. Anything that is not a regular file is not
  // uploadable either.
  if (!mayUpload || !session || !localPaths.every(isRegularFile)) {
    return { text: localInsertionText(localPaths) };
  }

  const outcome = await uploadFiles(session, localPaths);
  if (!outcome.ok || outcome.remotePaths.length !== localPaths.length) {
    // Inserting the local path here would read as success while handing the
    // remote shell a path it cannot open.
    return {
      text: null,
      failure: { destination: session.destination, detail: outcome.error ?? 'unknown error' },
    };
  }
  return { text: remoteInsertionText(outcome.remotePaths) };
}
