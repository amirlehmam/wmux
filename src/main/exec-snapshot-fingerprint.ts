/**
 * exec-snapshot-fingerprint.ts — reading the fingerprint a host's script prints (exec-snapshot.ts has the
 * design: what it is for, what it sees and what it cannot).
 *
 * Pure: a script's answer in, a `RemoteFingerprint` (or null: unusable) out. The script is
 * `fingerprint` in exec-git-batch-script.ts.
 */

import { createHash } from 'crypto';

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

export interface RemoteFingerprint {
  /** Hash of everything: equal means no view of this checkout has anything new. */
  all: string;
  /** Hash of the refs alone, for an answer that depends on where a named base points. */
  refs: string;
  /** The checkout's top level, as git printed it (empty when it is not a repository). */
  toplevel: string;
  /**
   * What decides one file's diff in one worktree: the status lines that name it
   * (HEAD and index object included) and its stat line. Null when the worktree
   * is not one this fingerprint covers, so the caller does not cache.
   */
  fileKey(worktree: string, file: string): string | null;
}

/** The hash tools the remote script uses, and the same ones here: it prints which. */
const REMOTE_ALGORITHMS = new Set(['sha1', 'md5']);

/** The most the remote script keeps per worktree: more than this and the worktree has one key. */
export const FINGERPRINT_FILE_KEYS_MAX = 100;

interface DigestSection {
  path: string;
  /** The remote digest of this worktree's status lines (`SD`). */
  status: string;
  /** The remote digest of this worktree's stat lines (`ZD`). */
  stat: string;
  /** Digest of a path -> digest of what decides its diff; null when two paths collided (not usable). */
  files: Map<string, string | null>;
  /** The remote said these keys cover every file the worktree reports (`C`): a file with none is clean. */
  complete: boolean;
}

/**
 * The fingerprint a script run printed, or null when it says it could not make one (or
 * printed none, as a host without a hash tool does). The script's own (`V <algo>`,
 * exec-git-batch.ts): a few hundred bytes for a typical tree, equal exactly when every
 * digest in it is.
 *
 *     V sha1 | T <top level> | RD <refs digest> |
 *     W <k> <path>, SD <k> <status digest>, ZD <k> <stat digest>,
 *     K <k> <path digest> <record digest>   (per file, at most 100 per worktree),
 *     C <k>                                  (the K lines are complete)
 *
 * A file's key is its record digest (the status lines that name it and its stat
 * line), found by the digest of its path, which is made here with the same tool.
 * With `C` a file with no `K` line is clean and keeps one constant key. A worktree
 * with more than 100 changed files or 400 status lines has no `K` or `C` lines: every
 * file in it is keyed by the worktree's two digests, so it is fetched again when
 * anything in that worktree changed (never missed, only more often).
 */
export function parseFingerprint(text: string): RemoteFingerprint | null {
  const lines = text.split('\n');
  if (lines.includes('NOSTAT') || lines.includes('CAPPED')) return null;
  let algorithm = '';
  let toplevel = '';
  let refs: string | undefined;
  const byIndex = new Map<string, DigestSection>();
  for (const line of lines) {
    if (line.startsWith('V ')) algorithm = line.slice(2);
    else if (line.startsWith('T ')) toplevel = line.slice(2);
    else if (line.startsWith('RD ')) refs = line.slice(3);
    else {
      const worktree = /^W (\d+) (.*)$/.exec(line);
      if (worktree) {
        byIndex.set(worktree[1], { path: worktree[2], status: '', stat: '', files: new Map(), complete: false });
        continue;
      }
      const sum = /^(SD|ZD) (\d+) ([0-9a-f]+)$/.exec(line);
      if (sum) {
        const section = byIndex.get(sum[2]);
        if (section) { if (sum[1] === 'SD') section.status = sum[3]; else section.stat = sum[3]; }
        continue;
      }
      const done = /^C (\d+)$/.exec(line);
      if (done) {
        const section = byIndex.get(done[1]);
        if (section) section.complete = true;
        continue;
      }
      const key = /^K (\d+) ([0-9a-f]+) ([0-9a-f]+)$/.exec(line);
      const owner = key ? byIndex.get(key[1]) : undefined;
      if (key && owner) owner.files.set(key[2], owner.files.has(key[2]) ? null : key[3]);
    }
  }
  // An answer that is not complete is not a fingerprint: the poll runs in full.
  if (!REMOTE_ALGORITHMS.has(algorithm) || refs === undefined) return null;
  const sections = new Map<string, DigestSection>();
  for (const section of byIndex.values()) sections.set(section.path, section);
  return {
    all: sha1(text),
    refs,
    toplevel,
    fileKey(worktree, file) {
      const section = sections.get(worktree);
      if (!section || !file) return null;
      const own = section.files.get(createHash(algorithm).update(file).digest('hex').slice(0, 12));
      if (own) return JSON.stringify(['file', own]);
      // Every file the worktree reports has a key, and this one has none: it is clean, which does not change.
      if (own === undefined && section.complete) return JSON.stringify(['clean']);
      return JSON.stringify(['worktree', section.status, section.stat]);
    },
  };
}
