import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  cachedForPoll,
  configureSnapshots,
  fetchFingerprint,
  currentPollInterval,
  invalidateSnapshots,
  MAX_POLL_INTERVAL_MS,
  noteAgentEdit,
  QUIET_BEFORE_BACKOFF_MS,
  resetSnapshots,
  SNAPSHOT_MAX_ENTRIES,
  snapshotEntryCount,
  SNAPSHOT_TTL_MS,
  UNUSABLE_BACKOFF_MS,
} from '../../src/main/exec-snapshot';
import { FINGERPRINT_FILE_KEYS_MAX, parseFingerprint } from '../../src/main/exec-snapshot-fingerprint';
import { runWithSpawnPriority, sshLaneKey } from '../../src/main/exec-gate';
import { handleGitView } from '../../src/main/git-view';
import { getChangedFilesWithBaseline, getFileDiff, resetDiffCaches } from '../../src/main/diff-provider';
import { remoteChangedFiles, remoteFileDiff } from '../../src/main/ssh-diff';
import { remoteCreateEntry, type RemoteDeps } from '../../src/main/ssh-explorer';
import { runSsh } from '../../src/main/ssh-exec';
import { runGitBatch } from '../../src/main/exec-git-batch';
import { runWithSshGit, SSH_UNREACHABLE_MESSAGE, type SshGitContext } from '../../src/main/ssh-git';
import { makeSpawnCounter, type SpawnCounter } from '../helpers/ssh-spawn-counter';
import { parseSshTarget, type SshTarget } from '../../src/main/ssh-targets';
import type { GitViewRequest } from '../../src/shared/git-view';
import { hasPosixTools } from '../helpers/posix-tools';
import { git, makeTmpDir } from '../helpers/git-repo';

// ─── parseFingerprint ────────────────────────────────────────────────────────

describe('parseFingerprint', () => {
  it('is unusable when the script says it had no stat, no hash tool or too many files', () => {
    expect(parseFingerprint('NOSTAT\n')).toBeNull();
    expect(parseFingerprint('NOHASH\n')).toBeNull();
  });

  it('is unusable for an answer that is not the digest form', () => {
    expect(parseFingerprint('T /r\nR aaa refs/heads/main\nW /r\nS # branch.head main\n')).toBeNull();
    expect(parseFingerprint('')).toBeNull();
  });
});

describe('parseFingerprint, digest form', () => {
  const digest = (algo: string, text: string): string => createHash(algo).update(text).digest('hex');
  const build = (algo = 'sha1', extra: string[] = []): string => [
    `V ${algo}`,
    'T /r',
    'W 1 /r',
    'W 2 /wt',
    'RD 00000000000000aa',
    'SD 1 1111111111111111',
    'ZD 1 2222222222222222',
    'SD 2 3333333333333333',
    'ZD 2 4444444444444444',
    `K 1 ${digest(algo === 'md5' ? 'md5' : 'sha1', 'a.txt').slice(0, 12)} aaaaaaaaaaaa`,
    `K 1 ${digest(algo === 'md5' ? 'md5' : 'sha1', 'odd name|x.txt').slice(0, 12)} bbbbbbbbbbbb`,
    'C 1',
    ...extra,
    '',
  ].join('\n');

  it('keys a file by the digest of its path, and a clean file in a complete worktree by one constant', () => {
    for (const algo of ['sha1', 'md5']) {
      const fp = parseFingerprint(build(algo))!;
      expect(fp.toplevel).toBe('/r');
      expect(fp.refs).toBe('00000000000000aa');
      expect(fp.fileKey('/r', 'a.txt')).toBe('["file","aaaaaaaaaaaa"]');
      expect(fp.fileKey('/r', 'odd name|x.txt')).toBe('["file","bbbbbbbbbbbb"]');
      expect(fp.fileKey('/r', 'clean.txt')).toBe('["clean"]');
      // A worktree without C: any file is keyed by the whole worktree's digests.
      expect(fp.fileKey('/wt', 'a.txt')).toBe('["worktree","3333333333333333","4444444444444444"]');
      expect(fp.fileKey('/elsewhere', 'a.txt')).toBeNull();
      expect(fp.fileKey('/r', '')).toBeNull();
    }
  });

  it('changes with any digest, and a file key only with that file\'s own', () => {
    const base = parseFingerprint(build())!;
    const other = parseFingerprint(build().replace('aaaaaaaaaaaa', 'cccccccccccc'))!;
    expect(other.all).not.toBe(base.all);
    expect(other.fileKey('/r', 'a.txt')).not.toBe(base.fileKey('/r', 'a.txt'));
    expect(other.fileKey('/r', 'odd name|x.txt')).toBe(base.fileKey('/r', 'odd name|x.txt'));
    expect(other.refs).toBe(base.refs);
    expect(parseFingerprint(build().replace('00000000000000aa', '00000000000000ab'))!.refs).not.toBe(base.refs);
    expect(parseFingerprint(build())!.all).toBe(base.all);
  });

  it('falls back to the worktree key for a path whose digest two files share', () => {
    const twice = `K 1 ${digest('sha1', 'a.txt').slice(0, 12)} dddddddddddd`;
    expect(parseFingerprint(build('sha1', [twice]))!.fileKey('/r', 'a.txt')).toBe('["worktree","1111111111111111","2222222222222222"]');
  });

  it('ignores lines it does not know and refers only to worktrees it was told about', () => {
    const fp = parseFingerprint(build('sha1', ['K 9 aaaaaaaaaaaa bbbbbbbbbbbb', 'SD 9 5555555555555555', 'C 9', 'junk']))!;
    expect(fp.fileKey('/r', 'a.txt')).toBe('["file","aaaaaaaaaaaa"]');
  });

  it('is unusable when the answer is not complete or names a tool this side cannot use', () => {
    expect(parseFingerprint(build('crc32'))).toBeNull();
    expect(parseFingerprint(build().replace('RD 00000000000000aa\n', ''))).toBeNull();
    expect(parseFingerprint(`${build()}CAPPED\n`)).toBeNull();
    expect(parseFingerprint(`NOSTAT\n${build()}`)).toBeNull();
  });
});

// ─── The script, against a real git and a fake ssh ───────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasPosixTools(['git', 'gnu-find', 'stat-c', 'mktemp']))('the fingerprint and the snapshot cache, on a real repository', () => {
  let tmp: string;
  let repo: string;
  let wt: string;
  let counter: SpawnCounter;
  /** A fake ssh whose remote host lacks some tools: the same `sh -c`, but over a PATH without them. */
  const hostWithout = (name: string, missing: string[]): string => {
    const bin = path.join(tmp, `${name}-bin`);
    fs.mkdirSync(bin);
    for (const dir of ['/usr/bin', '/bin']) {
      for (const entry of fs.readdirSync(dir)) {
        if (missing.includes(entry)) continue;
        try { fs.symlinkSync(path.join(dir, entry), path.join(bin, entry)); } catch { /* listed twice */ }
      }
    }
    const tool = path.join(tmp, name);
    fs.writeFileSync(tool, `#!/bin/sh\nfor last; do :; done\nPATH='${bin}'\nexport PATH\nexec sh -c "$last"\n`, { mode: 0o755 });
    return tool;
  };
  let noHashTool = '';
  let md5OnlyTool = '';
  let noAwkTool = '';
  const targetAt = (root: string): SshTarget => {
    const parsed = parseSshTarget(['ssh', 'dev@box'], root);
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed;
  };
  const ctx = (root = repo, tool: () => string = () => counter.tool): SshGitContext => ({ target: targetAt(root), tool });
  const deps = (): RemoteDeps => ({ run: runSsh, tool: () => counter.tool });
  const bg = <T>(fn: () => T): T => runWithSpawnPriority('bg', fn);
  const edit = async (file: string, text: string) => {
    await sleep(15); // the kernel's coarse clock: a rewrite must land in a later tick to differ in mtime
    fs.writeFileSync(path.join(repo, file), text);
  };

  beforeAll(() => {
    tmp = makeTmpDir('wmux-ssh-snap-');
    counter = makeSpawnCounter(tmp, 'snap-ssh', 5);
    repo = path.join(tmp, 'repo');
    wt = path.join(tmp, 'agent-wt');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'worktree', 'add', '-q', '-b', 'agent/work', wt, 'HEAD');
    noHashTool = hostWithout('nohash-ssh', ['sha1sum', 'md5sum', 'shasum', 'cksum']);
    md5OnlyTool = hostWithout('md5only-ssh', ['sha1sum', 'shasum']);
    noAwkTool = hostWithout('noawk-ssh', ['awk', 'gawk', 'mawk', 'original-awk']);
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  beforeEach(() => {
    resetDiffCaches();
    resetSnapshots();
    configureSnapshots({ enabled: true });
    counter.reset();
    git(repo, 'checkout', '-q', '--', '.');
    git(repo, 'reset', '-q');
    for (const f of fs.readdirSync(repo)) if (f.startsWith('u-')) fs.rmSync(path.join(repo, f));
    for (const b of git(repo, 'branch', '--list', 'tmp/*', '--format=%(refname:short)').split('\n').filter(Boolean)) git(repo, 'branch', '-q', '-D', b);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('what the fingerprint sees', () => {
    const fp = async () => (await fetchFingerprint(ctx()))!;

    it('is one spawn, the same twice, and says what the checkout is', async () => {
      const first = await fp();
      expect(counter.spawns()).toBe(1);
      expect(first.toplevel).toBe(repo);
      expect((await fp()).all).toBe(first.all);
      expect(first.fileKey(repo, 'a.txt')).toBe('["clean"]');
    });

    it('sees an edit, even one that keeps the size, and only in that file\'s key', async () => {
      const before = await fp();
      await edit('a.txt', 'one\ntwo\nx\n');
      const first = await fp();
      expect(first.all).not.toBe(before.all);
      expect(first.fileKey(repo, 'a.txt')).not.toBe(before.fileKey(repo, 'a.txt'));
      expect(first.fileKey(repo, 'b.txt')).toBe(before.fileKey(repo, 'b.txt'));
      await edit('a.txt', 'one\ntwo\ny\n'); // same size, different bytes
      const second = await fp();
      expect(second.all).not.toBe(first.all);
      expect(second.fileKey(repo, 'a.txt')).not.toBe(first.fileKey(repo, 'a.txt'));
    });

    it('sees a new untracked file, a staged change, a new branch and an edit in a linked worktree', async () => {
      const seen = new Set<string>([(await fp()).all]);
      const expectNew = async () => {
        const all = (await fp()).all;
        expect(seen.has(all)).toBe(false);
        seen.add(all);
      };
      fs.writeFileSync(path.join(repo, 'u-new.txt'), 'x\n');
      await expectNew();
      await edit('b.txt', 'bee2\n');
      git(repo, 'add', 'b.txt');
      await expectNew();
      git(repo, 'branch', 'tmp/ref-only');
      await expectNew();
      await sleep(15);
      fs.writeFileSync(path.join(wt, 'agent-edit.txt'), 'y\n');
      await expectNew();
      fs.rmSync(path.join(wt, 'agent-edit.txt'));
    });

    it('is unusable when the host has no stat -c', async () => {
      const fakeBin = path.join(tmp, 'nostat-bin');
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, 'stat'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const saved = process.env.PATH;
      process.env.PATH = `${fakeBin}:${saved}`;
      try {
        expect(await fetchFingerprint(ctx())).toBeNull();
      } finally {
        process.env.PATH = saved;
      }
    });

    it('is a fingerprint of nothing for a folder that is not a repository, and an error for an unreachable host', async () => {
      const plain = path.join(tmp, 'plain');
      fs.mkdirSync(plain, { recursive: true });
      const none = (await fetchFingerprint(ctx(plain)))!;
      expect(none.toplevel).toBe('');
      const dead = path.join(tmp, 'dead-ssh');
      fs.writeFileSync(dead, '#!/bin/sh\nexit 255\n', { mode: 0o755 });
      await expect(fetchFingerprint(ctx(repo, () => dead))).rejects.toThrow(SSH_UNREACHABLE_MESSAGE);
    });
  });

  describe('the digest form of the fingerprint', () => {
    const answer = async (tool: () => string, root = repo): Promise<string> => {
      const out = await runGitBatch(ctx(root, tool), root, [{ dir: 'f', args: [] }], 'git:fingerprint');
      return out![0].stdout;
    };
    const digestAnswer = (root = repo) => answer(() => counter.tool, root);
    const fpVia = async (tool: () => string, root = repo) => (await fetchFingerprint(ctx(root, tool)))!;
    const changeFiles = (count: number): void => {
      for (let i = 0; i < count; i++) fs.writeFileSync(path.join(repo, `u-bulk-${i}.txt`), `bulk ${i}\n`);
    };

    it('is the digest form where the host has sha1sum or md5sum, and says NOHASH where it has no hash tool or no awk', async () => {
      expect((await digestAnswer()).startsWith('V sha1\n')).toBe(true);
      expect(await answer(() => md5OnlyTool)).toMatch(/^V md5\n/);
      expect(await answer(() => noHashTool)).toBe('NOHASH\n');
      expect(await answer(() => noAwkTool)).toBe('NOHASH\n');
      // Either digest is a usable fingerprint of the same checkout; NOHASH is none.
      for (const tool of [() => counter.tool, () => md5OnlyTool]) {
        expect((await fpVia(tool)).toplevel).toBe(repo);
      }
      for (const tool of [() => noHashTool, () => noAwkTool]) {
        expect(await fetchFingerprint(ctx(repo, tool))).toBeNull();
      }
    });

    it('is bounded for a large tree: per-file keys stop at 100 files, and the worktree is keyed as a whole', async () => {
      const big = path.join(tmp, 'big');
      fs.mkdirSync(big);
      git(big, 'init', '-q', '-b', 'main');
      for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(big, `f${i}`), 'x\n');
      git(big, 'add', '.');
      git(big, 'commit', '-q', '-m', 'big');
      for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(big, `f${i}`), 'y\n');
      const digest = await digestAnswer(big);
      expect(digest).not.toMatch(/^K /m);
      expect(digest).not.toMatch(/^C /m);
      const first = await fpVia(() => counter.tool, big);
      // No per-file key: every file is keyed by the whole worktree, so a change anywhere is seen in all.
      expect(first.fileKey(big, 'f1')).toMatch(/^\["worktree",/);
      fs.writeFileSync(path.join(big, 'f2'), 'zz\n');
      const second = await fpVia(() => counter.tool, big);
      expect(second.fileKey(big, 'f1')).not.toBe(first.fileKey(big, 'f1'));
      expect(second.all).not.toBe(first.all);
    });

    it('keeps per-file keys at exactly 100 files and drops them at 101', async () => {
      expect(FINGERPRINT_FILE_KEYS_MAX).toBe(100);
      changeFiles(100);
      let digest = await digestAnswer();
      expect(digest.split('\n').filter((l) => l.startsWith('K ') && l.startsWith('K 1 ')).length).toBe(100);
      expect(digest).toContain('\nC 1\n');
      fs.writeFileSync(path.join(repo, 'u-bulk-100.txt'), 'one more\n');
      digest = await digestAnswer();
      expect(digest.split('\n').filter((l) => l.startsWith('K 1 ')).length).toBe(0);
      expect(digest).not.toContain('\nC 1\n');
      // The other worktree is not affected by it.
      expect(digest).toContain('\nC 2\n');
    });

    it('keeps the 2000-file unusable rule', async () => {
      const many = path.join(tmp, 'many2');
      fs.mkdirSync(many);
      git(many, 'init', '-q', '-b', 'main');
      for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(many, `f${i}`), '');
      expect(await fetchFingerprint(ctx(many))).toBeNull();
      expect(await digestAnswer(many)).toContain('CAPPED');
    });

    it('is equal exactly when the state is the same, in both digest forms', async () => {
      /**
       * What a person could see change, read straight from git and the disk (no fingerprint code):
       * the oracle the digests are held to. Per file, the status records that name it and, for a file
       * git reports as modified or untracked, its size and mtime to the nanosecond.
       */
      const modified = (root: string): string[] => git(root, 'ls-files', '-m', '-o', '--exclude-standard', '-z').split('\0').filter(Boolean);
      const statOf = (root: string, file: string): string => {
        const st = fs.statSync(path.join(root, file), { bigint: true, throwIfNoEntry: false });
        return st ? `${st.size}:${st.mtimeNs}` : 'gone';
      };
      const fileTruth = (root: string, file: string): string => {
        const named = git(root, 'status', '--porcelain=v2', '-z', '-unormal').split('\0').filter((r) => r === file || r.endsWith(` ${file}`));
        return JSON.stringify([named, modified(root).includes(file) ? statOf(root, file) : null]);
      };
      const refsTruth = (): string => git(repo, 'for-each-ref', '--format=%(objectname) %(refname)');
      const allTruth = (): string => JSON.stringify([
        refsTruth(),
        [repo, wt].map((root) => [git(root, 'status', '--porcelain=v2', '--branch', '-z', '-unormal'), modified(root).map((f) => [f, statOf(root, f)])]),
      ]);
      const files: Array<[string, string]> = [[repo, 'a.txt'], [repo, 'b.txt'], [repo, 'a-renamed.txt'], [repo, 'u-new.txt'], [wt, 'agent-edit.txt']];
      type Fp = Awaited<ReturnType<typeof fpVia>>;
      interface Taken { digest: Fp; md5: Fp; all: string; refs: string; files: string[] }
      const states: Array<{ label: string; at: Taken }> = [];
      const record = async (label: string): Promise<void> => {
        states.push({
          label,
          at: {
            digest: await fpVia(() => counter.tool),
            md5: await fpVia(() => md5OnlyTool),
            all: allTruth(),
            refs: refsTruth(),
            files: files.map(([root, file]) => fileTruth(root, file)),
          },
        });
      };
      await record('clean');
      await edit('a.txt', 'one\ntwo\nx\n');
      await record('a edited');
      await edit('a.txt', 'one\ntwo\ny\n'); // same size, other bytes
      await record('a edited again, same size');
      fs.writeFileSync(path.join(repo, 'u-new.txt'), 'x\n');
      await record('an untracked file');
      await edit('b.txt', 'bee2\n');
      git(repo, 'add', 'b.txt');
      await record('b staged');
      git(repo, 'branch', 'tmp/ref-only');
      await record('a new ref');
      fs.rmSync(path.join(repo, 'u-new.txt'));
      await record('the untracked file gone');
      git(repo, 'mv', 'a.txt', 'a-renamed.txt');
      await record('a renamed in the index');
      git(repo, 'mv', 'a-renamed.txt', 'a.txt');
      await sleep(15);
      fs.writeFileSync(path.join(wt, 'agent-edit.txt'), 'y\n');
      await record('an edit in the linked worktree');
      fs.rmSync(path.join(wt, 'agent-edit.txt'));
      git(repo, 'reset', '-q');
      git(repo, 'checkout', '-q', '--', '.');
      git(repo, 'branch', '-q', '-D', 'tmp/ref-only');
      await record('back to clean');
      for (let i = 0; i < states.length; i++) {
        for (let j = i + 1; j < states.length; j++) {
          const label = `${states[i].label} vs ${states[j].label}`;
          const a = states[i].at;
          const b = states[j].at;
          const same = a.all === b.all;
          expect(a.digest.all === b.digest.all, label).toBe(same);
          expect(a.md5.all === b.md5.all, label).toBe(same);
          expect(a.digest.refs === b.digest.refs, label).toBe(a.refs === b.refs);
          for (const [n, [root, file]] of files.entries()) {
            const fileSame = a.files[n] === b.files[n];
            // A file that is unchanged is unchanged in the digest form too; one that changed
            // may be seen to change more often (never less) only where the digest form has no per-file key.
            const keyed = (x: Fp): boolean => !String(x.fileKey(root, file)).startsWith('["worktree"');
            if (keyed(a.digest) && keyed(b.digest)) expect(a.digest.fileKey(root, file) === b.digest.fileKey(root, file), `${label}: ${file}`).toBe(fileSame);
            else expect(a.digest.fileKey(root, file) === b.digest.fileKey(root, file), `${label}: ${file}`).toBe(false);
          }
        }
      }
      // The first and the last state are the same checkout: equal in every form, key for key.
      const first = states[0].at;
      const last = states[states.length - 1].at;
      expect(last.all).toBe(first.all);
      expect(last.digest.all).toBe(first.digest.all);
      expect(last.md5.all).toBe(first.md5.all);
      expect(last.digest.fileKey(repo, 'a.txt')).toBe(first.digest.fileKey(repo, 'a.txt'));
    });

    it('keys a staged-only file, a rename and a file in an untracked folder by themselves', async () => {
      const key = async (root: string, file: string) => (await fpVia(() => counter.tool)).fileKey(root, file);
      fs.mkdirSync(path.join(repo, 'u-dir'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'u-dir', 'inner.txt'), '1\n');
      await edit('b.txt', 'staged one\n');
      git(repo, 'add', 'b.txt');
      const before = { inner: await key(repo, 'u-dir/inner.txt'), staged: await key(repo, 'b.txt'), clean: await key(repo, 'a.txt') };
      for (const k of Object.values(before)) expect(k).not.toMatch(/^\["worktree"/);
      expect(before.clean).toBe('["clean"]');
      await edit('u-dir/inner.txt', '2222\n');
      expect(await key(repo, 'u-dir/inner.txt')).not.toBe(before.inner);
      expect(await key(repo, 'b.txt')).toBe(before.staged);
      expect(await key(repo, 'a.txt')).toBe(before.clean);
      await edit('b.txt', 'staged two\n');
      git(repo, 'add', 'b.txt');
      expect(await key(repo, 'b.txt')).not.toBe(before.staged);
      expect(await key(repo, 'u-dir/inner.txt')).not.toBe(before.inner);
      fs.rmSync(path.join(repo, 'u-dir'), { recursive: true });
    });

    it('handles paths with spaces, bars and a leading dash', async () => {
      const names = ['a file with spaces.txt', 'bar|name.txt', '-dash.txt', 'sub dir/x y.txt'];
      for (const n of names) {
        fs.mkdirSync(path.dirname(path.join(repo, `u-${n}`)), { recursive: true });
        fs.writeFileSync(path.join(repo, `u-${n}`), n);
      }
      const first = await fpVia(() => counter.tool);
      for (const n of names) expect(first.fileKey(repo, `u-${n}`)).toMatch(/^\["file",/);
      await edit(`u-${names[1]}`, 'changed bar file');
      const second = await fpVia(() => counter.tool);
      expect(second.fileKey(repo, `u-${names[1]}`)).not.toBe(first.fileKey(repo, `u-${names[1]}`));
      for (const n of [names[0], names[2], names[3]]) expect(second.fileKey(repo, `u-${n}`)).toBe(first.fileKey(repo, `u-${n}`));
      fs.rmSync(path.join(repo, 'u-sub dir'), { recursive: true, force: true });
    });
  });

  describe('a poll is answered without a batch while nothing changed', () => {
    const view = async (req: GitViewRequest, remote = ctx()) => {
      const res = await handleGitView(req, remote);
      if (!res.ok) throw new Error(res.error);
      return res.data;
    };
    const working: GitViewRequest = { op: 'working', cwd: '', worktree: '' };

    it('the first poll costs the fingerprint and the batch, the next ones within the TTL cost nothing', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const req = { ...working, worktree: repo };
      await bg(() => view(req));
      expect(counter.spawns()).toBe(2);
      await bg(() => view(req));
      await bg(() => view({ op: 'repo', cwd: '' }));          // repo is its own answer: one batch more...
      expect(counter.spawns()).toBe(4);                         // ...(two with a linked worktree), the fingerprint is shared
      await bg(() => view({ op: 'repo', cwd: '' }));
      expect(counter.spawns()).toBe(4);
    });

    it('after the TTL one fingerprint spawn serves every consumer, and nothing is fetched again', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const req = { ...working, worktree: repo };
      const first = await bg(() => view(req));
      await bg(() => view({ op: 'repo', cwd: '' }));
      await bg(() => remoteChangedFiles(targetAt(repo), undefined, () => counter.tool));
      counter.reset();
      vi.setSystemTime(Date.now() + SNAPSHOT_TTL_MS + 50);
      const again = await Promise.all([
        bg(() => view(req)),
        bg(() => view({ op: 'repo', cwd: '' })),
        bg(() => remoteChangedFiles(targetAt(repo), undefined, () => counter.tool)),
      ]);
      expect(counter.spawns()).toBe(1); // the fingerprint, once, for all three
      expect(again[0]).toEqual(first);
    });

    it('a person asking is never answered from the cache, and takes the entry with it', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const req = { ...working, worktree: repo };
      await bg(() => view(req));
      counter.reset();
      await view(req); // foreground
      expect(counter.spawns()).toBe(1);
      counter.reset();
      // A person was here, so the poll takes a new fingerprint, and the entry is gone: it computes again.
      await bg(() => view(req));
      expect(counter.spawns()).toBe(2);
      await bg(() => view(req));
      expect(counter.spawns()).toBe(2);
    });

    it('an edit is seen by the next poll after the TTL, and the answer is the new one', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const req = { ...working, worktree: repo };
      const before = await bg(() => view(req)) as { unstaged: unknown[] };
      expect(before.unstaged).toHaveLength(0);
      await edit('a.txt', 'one\ntwo\nthree\n');
      vi.setSystemTime(Date.now() + SNAPSHOT_TTL_MS + 50);
      counter.reset();
      const after = await bg(() => view(req)) as { unstaged: Array<{ path: string }> };
      expect(after.unstaged.map((f) => f.path)).toEqual(['a.txt']);
      expect(counter.spawns()).toBe(2); // the fingerprint changed: fingerprint + batch
    });

    it('a file diff is fetched again only when that file changed, not when another one did', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await edit('a.txt', 'one\ntwo\nthree\n');
      const diffOf = (file: string) => bg(() => remoteFileDiff(targetAt(repo), file, undefined, () => counter.tool));
      const first = await diffOf('a.txt');
      expect(first).toEqual({ diff: expect.stringContaining('+three') });
      await edit('b.txt', 'bee\nbee\n');
      vi.setSystemTime(Date.now() + SNAPSHOT_TTL_MS + 50);
      counter.reset();
      expect(await diffOf('a.txt')).toEqual(first);
      expect(counter.spawns()).toBe(1); // fingerprint only: a.txt's own key did not move
      await edit('a.txt', 'one\ntwo\nfour\n');
      vi.setSystemTime(Date.now() + SNAPSHOT_TTL_MS + 50);
      counter.reset();
      expect(await diffOf('a.txt')).toEqual({ diff: expect.stringContaining('+four') });
      expect(counter.spawns()).toBe(2);
    });

    it('the column and the Diff tab are one consumer: the second costs nothing', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      fs.writeFileSync(path.join(repo, 'u-one.txt'), 'x\ny\n');
      await edit('a.txt', 'one\ntwo\nthree\n');
      const column = await bg(() => runWithSshGit(ctx(), () => getChangedFilesWithBaseline(repo)));
      counter.reset();
      vi.setSystemTime(Date.now() + 1000);
      const tab = await bg(() => remoteChangedFiles(targetAt(repo), undefined, () => counter.tool));
      expect(counter.spawns()).toBe(0);
      expect('files' in tab && tab.files).toEqual(column.files);
    });

    it('a save through wmux invalidates at once, inside the TTL', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const before = await bg(() => remoteChangedFiles(targetAt(repo), undefined, () => counter.tool));
      expect(before).toEqual({ files: [] });
      expect(await remoteCreateEntry(targetAt(repo), '', 'u-made.txt', 'file', deps())).toEqual({ ok: true });
      counter.reset();
      const after = await bg(() => remoteChangedFiles(targetAt(repo), undefined, () => counter.tool));
      expect('files' in after && after.files.map((f) => f.path)).toEqual(['u-made.txt']);
      expect(counter.spawns()).toBe(3); // fingerprint, the batch, the untracked file's line count
    });

    it('an unreachable host stays an error: no stale "no changes" from the cache', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const dead = path.join(tmp, 'dead-ssh-2');
      fs.writeFileSync(dead, '#!/bin/sh\nexit 255\n', { mode: 0o755 });
      const ok = await bg(() => remoteChangedFiles(targetAt(repo), undefined, () => counter.tool));
      expect(ok).toEqual({ files: [] });
      vi.setSystemTime(Date.now() + SNAPSHOT_TTL_MS + 50);
      const down = await bg(() => remoteChangedFiles(targetAt(repo), undefined, () => dead));
      expect(down).toMatchObject({ code: 'ssh-unreachable', error: SSH_UNREACHABLE_MESSAGE });
      const res = await bg(() => handleGitView({ op: 'working', cwd: '', worktree: repo }, ctx(repo, () => dead)));
      expect(res).toMatchObject({ ok: false, error: SSH_UNREACHABLE_MESSAGE });
    });

    it('a fingerprint of a different checkout on the same host is not mixed up with this one', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const other = path.join(tmp, 'other');
      fs.mkdirSync(other);
      git(other, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(other, 'o.txt'), 'o\n');
      const here = await bg(() => remoteChangedFiles(targetAt(repo), undefined, () => counter.tool));
      const there = await bg(() => remoteChangedFiles(targetAt(other), undefined, () => counter.tool));
      expect(here).toEqual({ files: [] });
      expect('files' in there && there.files.map((f) => f.path)).toEqual(['o.txt']);
    });

    it('with the mechanism off every poll runs the full requests', async () => {
      configureSnapshots({ enabled: false });
      const req = { ...working, worktree: repo };
      await bg(() => view(req));
      await bg(() => view(req));
      expect(counter.spawns()).toBe(2);
    });

    it('a host with no usable fingerprint is asked once, then left to run in full', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const fakeBin = path.join(tmp, 'nostat-bin');
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, 'stat'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const saved = process.env.PATH;
      process.env.PATH = `${fakeBin}:${saved}`;
      try {
        const req = { ...working, worktree: repo };
        await bg(() => view(req));
        expect(counter.spawns()).toBe(2);              // the failed fingerprint, then the batch
        counter.reset();
        vi.setSystemTime(Date.now() + SNAPSHOT_TTL_MS + 50);
        await bg(() => view(req));
        await bg(() => view(req));
        expect(counter.spawns()).toBe(2);              // two batches, no fingerprint
        vi.setSystemTime(Date.now() + UNUSABLE_BACKOFF_MS + 50);
        counter.reset();
        await bg(() => view(req));
        expect(counter.spawns()).toBe(2);              // asked again after the backoff
      } finally {
        process.env.PATH = saved;
      }
    });
  });

  describe('a host that cannot make digests', () => {
    it('is polled without the shortcut, so every poll runs and sees the host as it is', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      let runs = 0;
      const poll = (): Promise<number> => bg(() => cachedForPoll({
        context: ctx(repo, () => noHashTool),
        key: 'no-hash',
        token: (fp) => fp.all,
        compute: async () => ++runs,
      }));
      expect(await poll()).toBe(1);
      vi.setSystemTime(Date.now() + SNAPSHOT_TTL_MS + 50);
      expect(await poll()).toBe(2);
      expect(await poll()).toBe(3);
    });
  });

  describe('backing off while nothing happens', () => {
    const req = (): GitViewRequest => ({ op: 'working', cwd: '', worktree: repo });
    const lane = () => sshLaneKey(targetAt(repo));
    let t0 = 0;
    /** One poll `seconds` into the session, as a poll; true when it spawned. */
    const pollAt = async (seconds: number): Promise<boolean> => {
      vi.setSystemTime(t0 + seconds * 1000);
      const before = counter.spawns();
      const res = await bg(() => handleGitView(req(), ctx()));
      if (!res.ok) throw new Error(res.error);
      return counter.spawns() > before;
    };
    /** The seconds at which a poll every `every` s spawned, for the session up to `until`. */
    const spawnTimes = async (from: number, until: number, every: number): Promise<number[]> => {
      const times: number[] = [];
      for (let s = from; s <= until; s += every) if (await pollAt(s)) times.push(s);
      return times;
    };
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      t0 = Date.now();
    });

    it('keeps the full cadence for 30 s, then doubles the gap up to 30 s', async () => {
      expect(QUIET_BEFORE_BACKOFF_MS).toBe(30_000);
      expect(MAX_POLL_INTERVAL_MS).toBe(30_000);
      const times = await spawnTimes(0, 300, 1);
      const gaps = times.slice(1).map((time, i) => time - times[i]);
      // The full cadence (a fingerprint every 2 s here: the TTL is 1.75 s) for the first 30 s...
      expect(gaps.filter((_, i) => times[i + 1] <= 30).every((g) => g <= 2)).toBe(true);
      // ...then each gap at least as long as the one before, capped at 30 s.
      const later = gaps.filter((_, i) => times[i] >= 30);
      expect(later.length).toBeGreaterThan(5);
      expect(later.every((g, i) => i === 0 || g >= later[i - 1])).toBe(true);
      // 30 s, plus up to one second for a poll that arrives every second.
      expect(Math.max(...later)).toBeGreaterThanOrEqual(30);
      expect(Math.max(...later)).toBeLessThanOrEqual(31);
      expect(later[0]).toBeGreaterThanOrEqual(3);
      // One fingerprint spawn in the first batch of requests, and a total far below one per 2 s.
      expect(times.length).toBeLessThan(15 + 14);
    });

    it('starts over when the tree changes, and the next poll after it sees the new answer', async () => {
      await spawnTimes(0, 200, 1);
      expect(currentPollInterval(lane())).toBe(MAX_POLL_INTERVAL_MS);
      await edit('a.txt', 'one\ntwo\nthree\n');
      // Still inside the held-back window: not seen yet, by design (30 s at most)...
      expect(await pollAt(201)).toBe(false);
      // ...and seen at the end of it, which also puts the cadence back to full.
      let seenAt = 202;
      while (!(await pollAt(seenAt))) seenAt++;
      expect(seenAt).toBeLessThanOrEqual(200 + 31);
      expect(currentPollInterval(lane())).toBe(SNAPSHOT_TTL_MS);
      const after = await spawnTimes(seenAt + 1, seenAt + 12, 1);
      expect(after.length).toBeGreaterThanOrEqual(4);
    });

    it('starts over at once on a click, and the next poll goes to the host', async () => {
      await spawnTimes(0, 200, 1);
      expect(currentPollInterval(lane())).toBeGreaterThan(SNAPSHOT_TTL_MS);
      vi.setSystemTime(t0 + 201_000);
      await handleGitView({ op: 'repo', cwd: '' }, ctx()); // foreground: a person
      expect(currentPollInterval(lane())).toBe(SNAPSHOT_TTL_MS);
      expect(await pollAt(202)).toBe(true);
    });

    it('starts over on a write through wmux, and on an agent hook signal', async () => {
      await spawnTimes(0, 200, 1);
      expect(await remoteCreateEntry(targetAt(repo), '', 'u-w.txt', 'file', deps())).toEqual({ ok: true });
      expect(currentPollInterval(lane())).toBe(SNAPSHOT_TTL_MS);
      expect(await pollAt(201)).toBe(true);
      await spawnTimes(202, 400, 1);
      expect(currentPollInterval(lane())).toBeGreaterThan(SNAPSHOT_TTL_MS);
      noteAgentEdit();
      expect(currentPollInterval(lane())).toBe(SNAPSHOT_TTL_MS);
      expect(await pollAt(401)).toBe(true);
    });

    it('does not slow a host that is busy: a change every few seconds keeps the full cadence', async () => {
      for (let s = 0; s <= 40; s += 4) {
        if (s > 0) await edit('a.txt', `one\n${s}\n`);
        await pollAt(s);
        await pollAt(s + 2);
      }
      expect(currentPollInterval(lane())).toBe(SNAPSHOT_TTL_MS);
    });
  });

  describe('cachedForPoll', () => {
    const request = (compute: () => Promise<string>, token: string | null = 'same') => ({
      context: ctx(),
      key: 'k',
      token: () => token,
      compute,
    });

    it('never keeps what it was told not to, nor a failure, and drops the entry on invalidation', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      let n = 0;
      const compute = vi.fn(async () => `v${++n}`);
      expect(await bg(() => cachedForPoll({ ...request(compute), cacheable: () => false }))).toBe('v1');
      expect(await bg(() => cachedForPoll({ ...request(compute), cacheable: () => false }))).toBe('v2');
      expect(await bg(() => cachedForPoll(request(compute)))).toBe('v3');
      expect(await bg(() => cachedForPoll(request(compute)))).toBe('v3');
      invalidateSnapshots(sshLaneKey(targetAt(repo)));
      expect(await bg(() => cachedForPoll(request(compute)))).toBe('v4');
      await expect(bg(() => cachedForPoll(request(async () => { throw new Error('boom'); }, 'other')))).rejects.toThrow('boom');
      expect(await bg(() => cachedForPoll(request(compute, 'other')))).toBe('v5');
    });

    it('does not cache when the fingerprint cannot vouch for the answer (token null)', async () => {
      const compute = vi.fn(async () => 'x');
      await bg(() => cachedForPoll(request(compute, null)));
      await bg(() => cachedForPoll(request(compute, null)));
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it('does not store an answer that was computed across an invalidation', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const lane = sshLaneKey(targetAt(repo));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const slow = bg(() => cachedForPoll(request(async () => { await gate; return 'before-write'; })));
      await sleep(80);
      invalidateSnapshots(lane);
      release();
      expect(await slow).toBe('before-write');
      expect(await bg(() => cachedForPoll(request(async () => 'after-write')))).toBe('after-write');
    });

    it('keeps at most SNAPSHOT_MAX_ENTRIES answers, the oldest going first, and a read keeps its entry young', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const computes = new Map<string, number>();
      const ask = (key: string) => bg(() => cachedForPoll({
        context: ctx(),
        key,
        token: () => 'same',
        compute: async () => { computes.set(key, (computes.get(key) ?? 0) + 1); return key; },
      }));
      await ask('first');
      for (let i = 0; i < SNAPSHOT_MAX_ENTRIES - 1; i++) await ask(`fill-${i}`);
      expect(snapshotEntryCount()).toBe(SNAPSHOT_MAX_ENTRIES);
      await ask('first'); // answered from the cache, and now the youngest
      expect(computes.get('first')).toBe(1);
      await ask('one-more'); // over the cap: the oldest goes, which is fill-0 and not 'first'
      expect(snapshotEntryCount()).toBe(SNAPSHOT_MAX_ENTRIES);
      await ask('first');
      expect(computes.get('first')).toBe(1);
      await ask('fill-0');
      expect(computes.get('fill-0')).toBe(2);
    });

    it('the no-poll path is the consumer\'s own code, once per call', async () => {
      const compute = vi.fn(async () => 'x');
      await cachedForPoll(request(compute));
      await cachedForPoll(request(compute));
      expect(compute).toHaveBeenCalledTimes(2);
      expect(counter.spawns()).toBe(0);
    });
  });
});

describe('getFileDiff outside ssh', () => {
  it('is untouched by the snapshot code: no remote context, nothing cached', async () => {
    resetDiffCaches();
    expect(await getFileDiff(os.tmpdir(), '')).toBe('');
  });
});
