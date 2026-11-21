/**
 * ssh-explorer.ts — the folder view and code viewer for a workspace whose
 * session lives on a remote host.
 *
 * The local explorer is a jail over `fs` (`resolveInRoot`, explorer-fs.ts). This is the
 * same jail over `ssh`: a workspace with an ssh target (ssh-targets.ts) lists, reads and
 * writes the checkout on the remote host, and NEVER a local path. No function here falls
 * back to the local disk when ssh fails: an unreachable host is the `ssh-unreachable`
 * error, because showing a local copy of a path that happens to exist is the failure
 * this module exists to prevent.
 *
 * Every operation is ONE ssh call running a POSIX `sh` script, passed as a single
 * `sh -c '<script>' sh '<arg>'…` string through `posixShellQuote`. The script text is a
 * constant; everything user-controlled (relative path, new name, expected mtime)
 * reaches it as a positional argument, and file content arrives on stdin.
 *
 * ## The jail
 *
 * Mirrors `resolveInRoot`: the renderer sends a relative path; no `..`, no empty or `.`
 * segment, no NUL; the root is canonicalised once (`cd -P`), and every segment below it
 * is checked with `[ -L ]` and refused when it is a symlink, the last one included. The
 * path is validated here AND again by the script, so a bug in either is not the
 * boundary. As locally, a swap between the walk and the use is accepted (no openat on a
 * shell).
 *
 * The remote host needs POSIX `sh`, `cd -P`, `pwd -P`, `cat`, `mv`, `rm`, `rmdir`,
 * `mkdir`, `chmod`, `awk`, `mktemp`, GNU `find` (`-printf`) and GNU `stat` (`-c`). Without
 * GNU find (busybox, BSD) a listing is `read_failed`; it does not guess.
 *
 * ## Conflicts
 *
 * An mtime is the integer `trunc(seconds * 1000)` of `find -printf %T@`, computed
 * identically here and in the script, so the number the renderer got is the number a
 * save compares. A save writes a temp file in the same directory and renames it over the
 * target (atomic for readers), checking the mtime before AND immediately before the
 * rename. The window after that last check is accepted: closing it needs a lock the
 * remote host does not have. `rename` replaces the inode, so hard links are not kept.
 */

import { remoteRelSegments } from './ssh-path';
import {
  isWslRouteUnreachable,
  toolForSession,
  type RunResult,
  type SshRunner,
} from './ssh-exec';
import type { SshTarget } from './ssh-targets';
import {
  decode,
  detectEncoding,
  encode,
  isBinaryPath,
  looksBinary,
  MAX_CODE_BYTES,
  SNIFF_BYTES,
  toCrlf,
  usesCrlf,
  type CodeReadOk,
  type CodeWriteOk,
} from './code-file';
import { remoteFilePath, remoteInvocation, type SshInvocation } from './ssh-command';
import { traceSpawn } from './exec-trace';
import { sshLaneKey, withSpawnSlot } from './exec-gate';
import { runSshRouted } from './exec-worker-routed';
import { invalidateSnapshots } from './exec-snapshot';
import { FILTERED_NAMES, MAX_ENTRIES } from './explorer-fs';
import type { ExplorerEntry, ExplorerListError, ExplorerListResult } from '../shared/types';

/** Collaborators a test replaces. Production uses the defaults. */
export interface RemoteDeps {
  run: SshRunner;
  tool: (target: SshTarget) => string;
}

const defaultDeps: RemoteDeps = {
  run: runSshRouted,
  tool: (target) => toolForSession(target.session, 'ssh'),
};

/** Exit codes the scripts use. 255 is ssh's own and is never produced here. */
const EXIT = {
  invalidPath: 10,
  outsideRoot: 12,
  symlink: 13,
  notFound: 14,
  notADirectory: 15,
  notARegularFile: 16,
  conflict: 17,
  tooLarge: 19,
  denied: 20,
  writeFailed: 21,
  exists: 22,
  notEmpty: 23,
} as const;

const SSH_UNREACHABLE = 255;

/** One ssh round trip, including the connect, so it gets more than a local read. */
const REQUEST_TIMEOUT_MS = 30_000;
/** A directory listing is capped by MAX_ENTRIES after the fact, so allow a big raw answer. */
const LIST_MAX_BUFFER = 32 * 1024 * 1024;

function fail(message: string, code: ExplorerListError['code']): ExplorerListError {
  return { error: message, code };
}

// ─── Scripts ────────────────────────────────────────────────────────────────
// $1 = root, $2 = relative path (already validated by JS, validated again here).
// Sets $cur to the canonical absolute path of the target, or exits.

const PRELUDE = `
LC_ALL=C; export LC_ALL
set -f
root=$1; rel=$2
real=$(cd -P -- "$root" 2>/dev/null && pwd -P) || exit ${EXIT.notFound}
cur=$real
if [ -n "$rel" ]; then
  old=$IFS; IFS=/
  for seg in $rel; do
    IFS=$old
    case $seg in ''|.|..) exit ${EXIT.outsideRoot};; esac
    cur=$cur/$seg
    if [ -L "$cur" ]; then exit ${EXIT.symlink}; fi
    [ -e "$cur" ] || exit ${EXIT.notFound}
    IFS=/
  done
  IFS=$old
fi
`;

const NEEDS_DIR = `[ -d "$cur" ] || exit ${EXIT.notADirectory}\n`;
const NEEDS_FILE = `[ -n "$rel" ] && [ -f "$cur" ] || exit ${EXIT.notARegularFile}\n`;
const NEEDS_ANY_NONROOT = `[ -n "$rel" ] || exit ${EXIT.invalidPath}
[ -f "$cur" ] || [ -d "$cur" ] || exit ${EXIT.notARegularFile}\n`;

/** mtime of "$cur" as integer milliseconds: the same arithmetic as `mtimeMsOf`. */
const CURMS = `curms() { find "$cur" -prune -printf '%T@' | awk '{printf "%.0f", int($1*1000)}'; }\n`;

export const LIST_SCRIPT = `${PRELUDE}${NEEDS_DIR}[ -r "$cur" ] && [ -x "$cur" ] || exit ${EXIT.denied}
cd -P -- "$cur" || exit ${EXIT.denied}
find . -mindepth 1 -maxdepth 1 -printf '%y\\0%s\\0%T@\\0%f\\0'
`;

// $3 = size limit in bytes. Prints "<size> <mtime-seconds>\\n", then the bytes.
export const READ_SCRIPT = `${PRELUDE}${NEEDS_FILE}[ -r "$cur" ] || exit ${EXIT.denied}
meta=$(find "$cur" -prune -printf '%s %T@') || exit ${EXIT.denied}
size=\${meta%% *}
if [ "$size" -gt "$3" ]; then exit ${EXIT.tooLarge}; fi
printf '%s\\n' "$meta"
cat -- "$cur" || exit ${EXIT.denied}
`;

// $3 = expected mtime in ms, or empty to skip the check. Content on stdin.
// Prints the new mtime in ms.
export const WRITE_SCRIPT = `${PRELUDE}${NEEDS_FILE}${CURMS}expected=$3
check() { if [ -n "$expected" ] && [ "$(curms)" != "$expected" ]; then exit ${EXIT.conflict}; fi; }
[ -w "$cur" ] || exit ${EXIT.denied}
check
dir=\${cur%/*}
tmp=$(mktemp "$dir/.wmux-save.XXXXXX") || exit ${EXIT.writeFailed}
trap 'rm -f -- "$tmp"' EXIT HUP INT TERM
cat > "$tmp" || exit ${EXIT.writeFailed}
mode=$(stat -c %a -- "$cur" 2>/dev/null) && chmod "$mode" -- "$tmp" 2>/dev/null
check
mv -f -- "$tmp" "$cur" || exit ${EXIT.writeFailed}
trap - EXIT HUP INT TERM
curms
`;

// $2 = the PARENT directory (relative), $3 = new name, $4 = 'dir' | 'file'.
export const CREATE_SCRIPT = `${PRELUDE}${NEEDS_DIR}[ -w "$cur" ] || exit ${EXIT.denied}
name=$3; kind=$4
case $name in ''|.|..|*/*) exit ${EXIT.invalidPath};; esac
new=$cur/$name
if [ -e "$new" ] || [ -L "$new" ]; then exit ${EXIT.exists}; fi
if [ "$kind" = dir ]; then
  mkdir -- "$new" || exit ${EXIT.writeFailed}
else
  ( set -C; : > "$new" ) || exit ${EXIT.writeFailed}
fi
`;

// $2 = the entry, $3 = its new name, in the same directory.
export const RENAME_SCRIPT = `${PRELUDE}${NEEDS_ANY_NONROOT}name=$3
case $name in ''|.|..|*/*) exit ${EXIT.invalidPath};; esac
new=\${cur%/*}/$name
if [ -e "$new" ] || [ -L "$new" ]; then exit ${EXIT.exists}; fi
mv -- "$cur" "$new" || exit ${EXIT.writeFailed}
`;

// $2 = the entry. A file, or an EMPTY directory: no recursive delete from a tree click.
export const DELETE_SCRIPT = `${PRELUDE}${NEEDS_ANY_NONROOT}if [ -d "$cur" ]; then
  rmdir -- "$cur" || exit ${EXIT.notEmpty}
else
  rm -- "$cur" || exit ${EXIT.writeFailed}
fi
`;

// ─── Pure helpers ───────────────────────────────────────────────────────────

export { remoteRelSegments };

/** A single new file or folder name. */
export function isValidEntryName(name: unknown): name is string {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..'
    && !name.includes('/') && !name.includes('\0') && name.length <= 255;
}

/** `find -printf %T@` ("1700000000.1234567890") to integer ms; the script does the same sum. */
export function mtimeMsOf(seconds: string): number {
  const value = Number(seconds);
  return Number.isFinite(value) ? Math.trunc(value * 1000) : 0;
}

/** The key a save grant for a remote file is held under; see `ipc-handlers.ts`. */
export function remoteGrantKey(filePath: string): string {
  return `ssh-code:${filePath}`;
}

type Kind = 'list' | 'read' | 'write';

function mapFailure(result: RunResult, kind: Kind, viaWsl: boolean): ExplorerListError {
  // On the WSL route wsl.exe can fail before ssh runs (not starting, no such
  // distro); that is the same "cannot reach it" to the user, never a local run.
  if (viaWsl ? isWslRouteUnreachable(result.status, result.spawnFailed) : result.status === SSH_UNREACHABLE) {
    // The cause (host key, refused, timeout, publickey) is in stderr, which can
    // carry local paths: main logs it, the renderer gets the fixed sentence.
    console.error('[ssh-explorer] ssh failed:', result.stderr.trim().split(/\r?\n/).pop());
    return fail('Could not reach the remote host over ssh', 'ssh-unreachable');
  }
  switch (result.status) {
    case EXIT.invalidPath:
    case EXIT.notARegularFile:
    case EXIT.exists:
      return fail('Invalid path', 'invalid_path');
    case EXIT.outsideRoot:
    case EXIT.symlink:
      return fail('Path is outside the root', 'outside_root');
    case EXIT.notFound:
      return fail(kind === 'list' ? 'Directory not found' : 'File not found', 'not_found');
    case EXIT.notADirectory:
      return fail('Not a directory', 'not_a_directory');
    case EXIT.conflict:
      return fail('File changed on the remote host since it was opened', 'conflict');
    case EXIT.tooLarge:
      return fail('File exceeds the 2MB limit', 'too_large');
    case EXIT.denied:
      return fail('Permission denied', 'denied');
    case EXIT.writeFailed:
    case EXIT.notEmpty:
      return fail('Failed to write file', 'write_failed');
    default:
      console.error('[ssh-explorer] remote command failed:', result.status, result.stderr.trim().split(/\r?\n/).pop());
      return fail(kind === 'write' ? 'Failed to write file' : 'Failed to read from the remote host',
        kind === 'write' ? 'write_failed' : 'read_failed');
  }
}

/** The trace name of a script (exec-trace.ts): its operation, never anything it was given. */
function traceOpOf(script: string): string {
  const ops: Array<[string, string]> = [
    [LIST_SCRIPT, 'list'], [READ_SCRIPT, 'read'], [WRITE_SCRIPT, 'write'],
    [CREATE_SCRIPT, 'create'], [RENAME_SCRIPT, 'rename'], [DELETE_SCRIPT, 'delete'],
  ];
  return ops.find(([known]) => known === script)?.[1] ?? 'script';
}

async function exec(
  target: SshTarget,
  script: string,
  args: string[],
  kind: Kind,
  deps: RemoteDeps,
  extra: { input?: Buffer; maxBuffer?: number } = {},
): Promise<RunResult | ExplorerListError> {
  let invocation: SshInvocation;
  try {
    invocation = remoteInvocation(target, script, args, deps.tool);
  } catch (err) {
    console.error('[ssh-explorer] no ssh executable:', err instanceof Error ? err.message : err);
    return fail('Could not reach the remote host over ssh', 'ssh-unreachable');
  }
  // A write changes what a listing says, from its start until it has finished.
  const lane = sshLaneKey(target);
  if (kind === 'write') changedByUs(lane);
  const result = await withSpawnSlot(lane, async (slot) => {
    const done = traceSpawn(() => traceOpOf(script), slot);
    const ran = await deps.run(invocation.file, invocation.args, REQUEST_TIMEOUT_MS, {
      cwd: invocation.viaWsl ? invocation.cwd : target.session.workingDirectory,
      // A listing and a read can be repeated if a persistent worker fails; a save, create, rename and delete never are.
      idempotent: kind !== 'write',
      ...extra,
    });
    done?.(ran.status, ran.stdoutBuffer.length, ran.via, ran.cold);
    return ran;
  }).finally(() => { if (kind === 'write') changedByUs(lane); });
  return result.status === 0 ? result : mapFailure(result, kind, invocation.viaWsl);
}

// ─── Operations ─────────────────────────────────────────────────────────────

/**
 * Identical listings that overlap share one spawn: a tree that re-renders, a
 * refill of every expanded folder and a Refresh press all ask for the same
 * directory within one round trip. A listing never joins one that started before
 * a change this process made to the same host (`writeEpoch`), so "I just created
 * a file and refreshed" cannot be answered with the listing from before it.
 * Only the in-flight call is shared; nothing is kept once it settles.
 */
const listingsInFlight = new Map<string, Promise<ExplorerListResult>>();
const writeEpochs = new Map<string, number>();

function bumpWriteEpoch(lane: string): void {
  writeEpochs.set(lane, (writeEpochs.get(lane) ?? 0) + 1);
}

/**
 * wmux is about to change, or just changed, something on this host (a save, a
 * create, a rename, a delete): no listing in flight and no cached git answer
 * (exec-snapshot.ts) may be served as the state after it.
 */
function changedByUs(lane: string): void {
  bumpWriteEpoch(lane);
  invalidateSnapshots(lane);
}

export function remoteListDir(
  target: SshTarget,
  relPath: unknown,
  opts: { showHidden?: boolean } = {},
  deps: RemoteDeps = defaultDeps,
): Promise<ExplorerListResult> {
  const segments = remoteRelSegments(relPath);
  if (!Array.isArray(segments)) return Promise.resolve(segments);
  const lane = sshLaneKey(target);
  const key = [lane, writeEpochs.get(lane) ?? 0, remoteFilePath(target, segments), opts.showHidden ? 'h' : ''].join('\0');
  const running = listingsInFlight.get(key);
  if (running) return running;
  const started = listDirUncached(target, segments, opts, deps).finally(() => listingsInFlight.delete(key));
  listingsInFlight.set(key, started);
  return started;
}

async function listDirUncached(
  target: SshTarget,
  segments: string[],
  opts: { showHidden?: boolean },
  deps: RemoteDeps,
): Promise<ExplorerListResult> {
  const ran = await exec(target, LIST_SCRIPT, [target.path, segments.join('/')], 'list', deps, {
    maxBuffer: LIST_MAX_BUFFER,
  });
  if ('error' in ran) return ran;

  const fields = ran.stdoutBuffer.toString('utf8').split('\0');
  const entries: ExplorerEntry[] = [];
  let truncated = false;
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [type, size, mtime, name] = [fields[i], fields[i + 1], fields[i + 2], fields[i + 3]];
    if (!name) continue;
    if (!opts.showHidden && (name.startsWith('.') || FILTERED_NAMES.has(name))) continue;
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const kind: ExplorerEntry['kind'] = type === 'l' ? 'symlink' : type === 'd' ? 'dir' : 'file';
    entries.push({
      name,
      kind,
      size: Number(size) || 0,
      mtimeMs: mtimeMsOf(mtime),
      viewable: kind === 'file' && !isBinaryPath(name),
    });
  }
  return { root: target.path, relPath: segments.join('/'), entries, truncated, remote: true };
}

interface RemoteBytes {
  filePath: string;
  bytes: Buffer;
  mtimeMs: number;
}

async function readRemoteBytes(
  target: SshTarget,
  segments: string[],
  deps: RemoteDeps,
): Promise<RemoteBytes | ExplorerListError> {
  if (segments.length === 0) return fail('Invalid path', 'invalid_path');
  const ran = await exec(
    target,
    READ_SCRIPT,
    [target.path, segments.join('/'), String(MAX_CODE_BYTES)],
    'read',
    deps,
    { maxBuffer: MAX_CODE_BYTES + 4096 },
  );
  if ('error' in ran) return ran;
  const newline = ran.stdoutBuffer.indexOf(0x0a);
  const meta = newline < 0 ? '' : ran.stdoutBuffer.subarray(0, newline).toString('utf8');
  const match = /^(\d+) (\d+(?:\.\d+)?)$/.exec(meta);
  if (!match) return fail('Failed to read from the remote host', 'read_failed');
  const bytes = ran.stdoutBuffer.subarray(newline + 1);
  return { filePath: remoteFilePath(target, segments), bytes, mtimeMs: mtimeMsOf(match[2]) };
}

export async function remoteReadCodeFile(
  target: SshTarget,
  relPath: unknown,
  deps: RemoteDeps = defaultDeps,
): Promise<CodeReadOk | ExplorerListError> {
  const segments = remoteRelSegments(relPath);
  if (!Array.isArray(segments)) return segments;
  if (segments.length > 0 && isBinaryPath(segments[segments.length - 1])) return fail('Not a text file', 'binary');
  const read = await readRemoteBytes(target, segments, deps);
  if ('error' in read) return read;
  if (looksBinary(read.bytes.subarray(0, SNIFF_BYTES))) return fail('Not a text file', 'binary');
  return { filePath: read.filePath, content: decode(read.bytes), mtimeMs: read.mtimeMs };
}

export async function remoteWriteCodeFile(
  target: SshTarget,
  relPath: unknown,
  content: unknown,
  expectedMtimeMs: number | undefined,
  deps: RemoteDeps = defaultDeps,
): Promise<CodeWriteOk | ExplorerListError> {
  if (typeof content !== 'string') return fail('Invalid content', 'invalid_path');
  const segments = remoteRelSegments(relPath);
  if (!Array.isArray(segments)) return segments;
  if (segments.length === 0) return fail('Invalid path', 'invalid_path');
  if (isBinaryPath(segments[segments.length - 1])) return fail('Not a text file', 'binary');

  // The file's own bytes decide its encoding and line endings, as locally
  // (`writeCodeFile`): a textarea gives back LF, and a CRLF file saved that way
  // would show every line changed in the next commit.
  const existing = await readRemoteBytes(target, segments, deps);
  if ('error' in existing) return existing;
  if (expectedMtimeMs !== undefined && existing.mtimeMs !== expectedMtimeMs) {
    return fail('File changed on the remote host since it was opened', 'conflict');
  }
  const keepCrlf = usesCrlf(decode(existing.bytes));
  const out = encode(keepCrlf ? toCrlf(content) : content, detectEncoding(existing.bytes.subarray(0, 3)));
  if (out.length > MAX_CODE_BYTES) return fail('File exceeds the 2MB limit', 'too_large');

  // Compare against the mtime of the bytes the encoding was derived from, so a
  // change between the read above and this write is a conflict too.
  const ran = await exec(
    target,
    WRITE_SCRIPT,
    [target.path, segments.join('/'), expectedMtimeMs === undefined ? '' : String(existing.mtimeMs)],
    'write',
    deps,
    { input: out },
  );
  if ('error' in ran) return ran;
  const newMtime = /^\d+$/.exec(ran.stdout.trim());
  if (!newMtime) return fail('Failed to write file', 'write_failed');
  return { filePath: existing.filePath, mtimeMs: Number(newMtime[0]) };
}

export type RemoteEntryOk = { ok: true };

export async function remoteCreateEntry(
  target: SshTarget,
  parentRelPath: unknown,
  name: unknown,
  kind: 'file' | 'dir',
  deps: RemoteDeps = defaultDeps,
): Promise<RemoteEntryOk | ExplorerListError> {
  const segments = remoteRelSegments(parentRelPath);
  if (!Array.isArray(segments)) return segments;
  if (!isValidEntryName(name)) return fail('Invalid path', 'invalid_path');
  const ran = await exec(target, CREATE_SCRIPT, [target.path, segments.join('/'), name, kind], 'write', deps);
  return 'error' in ran ? ran : { ok: true };
}

export async function remoteRenameEntry(
  target: SshTarget,
  relPath: unknown,
  newName: unknown,
  deps: RemoteDeps = defaultDeps,
): Promise<RemoteEntryOk | ExplorerListError> {
  const segments = remoteRelSegments(relPath);
  if (!Array.isArray(segments)) return segments;
  if (segments.length === 0 || !isValidEntryName(newName)) return fail('Invalid path', 'invalid_path');
  const ran = await exec(target, RENAME_SCRIPT, [target.path, segments.join('/'), newName], 'write', deps);
  return 'error' in ran ? ran : { ok: true };
}

export async function remoteDeleteEntry(
  target: SshTarget,
  relPath: unknown,
  deps: RemoteDeps = defaultDeps,
): Promise<RemoteEntryOk | ExplorerListError> {
  const segments = remoteRelSegments(relPath);
  if (!Array.isArray(segments)) return segments;
  if (segments.length === 0) return fail('Invalid path', 'invalid_path');
  const ran = await exec(target, DELETE_SCRIPT, [target.path, segments.join('/')], 'write', deps);
  return 'error' in ran ? ran : { ok: true };
}
