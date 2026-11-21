import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'path';
import { makeSpawnCounter, type SpawnCounter } from '../helpers/ssh-spawn-counter';

import fs from 'fs';
import { listDir } from '../../src/main/explorer-fs';
import { readCodeFile } from '../../src/main/code-file';
import { remoteListDir, remoteReadCodeFile, type RemoteDeps } from '../../src/main/ssh-explorer';
import { runSsh } from '../../src/main/ssh-exec';
import { parseSshTarget, type SshTarget } from '../../src/main/ssh-targets';
import { hasPosixTools } from '../helpers/posix-tools';
import { makeTmpDir } from '../helpers/git-repo';

/**
 * The explorer's file listing and reading for a folder on a WSL share go through the Windows file
 * system over the share (explorer-fs.ts, code-file.ts). The ssh explorer's scripts (`LIST_SCRIPT`,
 * `READ_SCRIPT`) are one request each; these tests hold them to the same answers, and the same
 * refusals, as the local code on the same directory.
 */
const targetAt = (root: string): SshTarget => {
  const parsed = parseSshTarget(['ssh', 'dev@box'], root);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
};

describe.skipIf(!hasPosixTools(['gnu-find', 'stat-c', 'mktemp']))('the ssh explorer scripts and the local explorer agree', () => {
  let tmp: string;
  let root: string;
  let counter: SpawnCounter;
  const ENTRIES = 50;

  beforeAll(() => {
    tmp = makeTmpDir('wmux-wsl-io-');
    counter = makeSpawnCounter(tmp, 'io-ssh', 0);
    root = path.join(tmp, 'proj');
    const deep = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    for (let i = 0; i < ENTRIES; i++) fs.writeFileSync(path.join(deep, `file-${String(i).padStart(2, '0')}.ts`), `export const n = ${i};\n`);
    fs.mkdirSync(path.join(deep, 'sub'));
    fs.writeFileSync(path.join(deep, "it's $x.txt"), 'quote\n');
    fs.writeFileSync(path.join(deep, 'bom.txt'), Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('bom\n')]));
    fs.writeFileSync(path.join(deep, 'utf16.txt'), Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('u16\n', 'utf16le')]));
    fs.writeFileSync(path.join(deep, 'blob.txt'), Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x04]));
    fs.symlinkSync(path.join(deep, 'file-00.ts'), path.join(deep, 'link.ts'));
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'linkdir'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => counter.reset());

  const deps = (): RemoteDeps => ({ run: runSsh, tool: () => counter.tool });

  it('the same listing is one request, and gives the same entries', async () => {
    const local = await listDir(root, 'a/b/c', { showHidden: true });
    counter.reset();
    const remote = await remoteListDir(targetAt(root), 'a/b/c', { showHidden: true }, deps());
    expect(counter.spawns()).toBe(1);
    if (!('entries' in local) || !('entries' in remote)) throw new Error('listing failed');
    const key = (e: { name: string; kind: string; size: number; viewable: boolean }): string => `${e.name}|${e.kind}|${e.size}|${e.viewable}`;
    const byName = <T extends { name: string }>(list: T[]): T[] => [...list].sort((a, b) => (a.name < b.name ? -1 : 1));
    expect(byName(remote.entries).map(key)).toEqual(byName(local.entries).map(key));
    // mtime to the millisecond (the script prints seconds with a fraction).
    const mtimes = new Map(local.entries.map((e) => [e.name, Math.round(e.mtimeMs)]));
    for (const e of remote.entries) expect(Math.abs(e.mtimeMs - (mtimes.get(e.name) ?? 0))).toBeLessThanOrEqual(1);
    // Differences, stated: the order is the directory's own (find does not sort), and the root is the one asked for.
    expect(remote.relPath).toBe('a/b/c');
  });

  it('the same read is ONE request, and gives the same text, BOM and UTF-16 included, and the same refusals', async () => {
    for (const file of ['file-07.ts', "it's $x.txt", 'bom.txt', 'utf16.txt']) {
      const local = readCodeFile(path.join(root, 'a/b/c', file));
      counter.reset();
      const remote = await remoteReadCodeFile(targetAt(root), `a/b/c/${file}`, deps());
      expect(counter.spawns()).toBe(1);
      expect('content' in remote && remote.content).toBe('content' in local ? local.content : undefined);
    }
    const refusals = async (rel: string): Promise<[unknown, unknown]> => {
      const local = await listDir(root, rel, {}).then((r) => ('error' in r ? r.code : 'ok'));
      return [local, await remoteListDir(targetAt(root), rel, {}, deps()).then((r) => ('error' in r ? r.code : 'ok'))];
    };
    // A symlinked segment is outside the jail in both, and so is a missing or non-directory path.
    expect(await refusals('linkdir/b')).toEqual(['outside_root', 'outside_root']);
    expect(await refusals('a/nope')).toEqual(['not_found', 'not_found']);
    expect(await refusals('a/b/c/file-00.ts')).toEqual(['not_a_directory', 'not_a_directory']);
    const fileRefusal = async (rel: string): Promise<[unknown, unknown]> => {
      const r = await remoteReadCodeFile(targetAt(root), rel, deps());
      const { resolveInRoot } = await import('../../src/main/explorer-fs');
      const resolved = await resolveInRoot(root, rel, 'file');
      const l = 'abs' in resolved ? readCodeFile(resolved.abs) : resolved;
      return [('error' in l ? l.code : 'ok'), ('error' in r ? r.code : 'ok')];
    };
    expect(await fileRefusal('a/b/c/link.ts')).toEqual(['outside_root', 'outside_root']);
    expect(await fileRefusal('a/b/c/blob.txt')).toEqual(['binary', 'binary']);
    expect(await fileRefusal('a/b/c/missing.ts')).toEqual(['not_found', 'not_found']);
  });
});
