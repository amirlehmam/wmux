import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import { makeWslSpawnCounter, type WslSpawnCounter } from '../helpers/wsl-spawn-counter';

const fakeState = vi.hoisted(() => ({ exe: '', cwd: '' }));
vi.mock('../../src/main/system32', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/system32')>()),
  wslExecutable: () => fakeState.exe,
  wslSystemRoot: () => fakeState.cwd,
}));
// A UNC path means nothing to this (Linux) test's file system: `statSync` of one answers for the directory it stands for.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const standsFor = (p: unknown): unknown => {
    const m = typeof p === 'string' ? /^\\\\wsl\.localhost\\[^\\]+(.*)$/.exec(p) : null;
    return m ? m[1].replace(/\\/g, '/') : p;
  };
  const statSync = ((p: unknown, ...rest: unknown[]) => (actual.statSync as (...a: unknown[]) => unknown)(standsFor(p), ...rest)) as typeof actual.statSync;
  return { ...actual, statSync, default: { ...actual, statSync } };
});

import { handleGitView, noteWslWrite, wslPathToWindows } from '../../src/main/git-view';
import { getChangedFiles, getChangedFilesWithBaseline, getFileDiff, resetDiffCaches } from '../../src/main/diff-provider';
import { resetBatchBackoff } from '../../src/main/exec-git-batch';
import { runWithSpawnPriority } from '../../src/main/exec-gate';
import { configureSnapshots, currentPollInterval, noteAgentEdit, resetSnapshots } from '../../src/main/exec-snapshot';
import { contextLaneKey } from '../../src/main/exec-location';
import { configureExecTrace } from '../../src/main/exec-trace';
import type { GitViewRequest } from '../../src/shared/git-view';
import { hasPosixTools } from '../helpers/posix-tools';
import { git, makeTmpDir } from '../helpers/git-repo';

/**
 * The pollers of a folder on a WSL share (the Git pane, the Diff tab, the explorer's
 * +N/-N column) share one fingerprint, are background work, and back off, as an ssh
 * workspace's do (exec-snapshot.ts, exec-gate.ts) - and a Windows folder's do not.
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasPosixTools(['git', 'base64', 'mktemp', 'stat-c', 'sha1sum', 'awk']))('polls of a WSL folder', () => {
  let tmp: string;
  let repo: string;
  let counter: WslSpawnCounter;
  const unc = (posix: string): string => wslPathToWindows('Ubuntu', posix);
  const cwd = (): string => unc(repo);

  beforeAll(() => {
    tmp = makeTmpDir('wmux-wsl-poll-');
    fakeState.cwd = tmp;
    counter = makeWslSpawnCounter(tmp, 'poll-wsl', 3);
    fakeState.exe = counter.exe;
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => {
    fakeState.exe = counter.exe;
    resetDiffCaches();
    resetSnapshots();
    resetBatchBackoff();
    configureSnapshots({ enabled: true });
    git(repo, 'checkout', '-q', '--', '.');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'three\n');
    counter.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    configureExecTrace(false);
  });

  const gitView = async (req: GitViewRequest, poll: boolean) => {
    const res = await runWithSpawnPriority(poll ? 'bg' : 'fg', () => handleGitView(req));
    if (!res.ok) throw new Error(res.error);
    return res.data;
  };
  const gitPane = (poll: boolean) => Promise.all([
    gitView({ op: 'repo', cwd: cwd() }, poll),
    gitView({ op: 'working', cwd: cwd(), worktree: cwd() }, poll),
    gitView({ op: 'workingDiff', cwd: cwd(), worktree: cwd(), file: 'a.txt', section: 'unstaged' }, poll),
  ]);
  const diffTab = (poll: boolean) => runWithSpawnPriority(poll ? 'bg' : 'fg', async () => ({
    files: await getChangedFiles(cwd()),
    diff: await getFileDiff(cwd(), 'a.txt'),
  }));
  const column = (poll: boolean) => runWithSpawnPriority(poll ? 'bg' : 'fg', () => getChangedFilesWithBaseline(cwd()));
  const allThree = (poll: boolean) => Promise.all([gitPane(poll), diffTab(poll), column(poll)]);
  const spawnsOf = async (action: () => Promise<unknown>): Promise<number> => {
    counter.reset();
    await action();
    return counter.spawns();
  };

  it('share one fingerprint start per interval while the tree does not change', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    await allThree(false); // the three views opened: a person's requests
    // A person's requests keep nothing. The first poll makes the fingerprint (one start, shared by all three) and
    // computes what it will keep: the usual work, plus that one start.
    vi.setSystemTime(t0 + 2000);
    const first = await spawnsOf(() => allThree(true));
    expect(first).toBeGreaterThan(1);
    // Inside the interval: nothing at all.
    vi.setSystemTime(t0 + 2500);
    expect(await spawnsOf(() => allThree(true))).toBe(0);
    // Past it: the fingerprint, one start for all three views, and the answers it vouches for.
    vi.setSystemTime(t0 + 4000);
    expect(await spawnsOf(() => allThree(true))).toBe(1);
    vi.setSystemTime(t0 + 6000);
    expect(await spawnsOf(() => allThree(true))).toBe(1);
  });

  it('answer a poll from the cache with the very answer a fresh run gives', async () => {
    const fresh = await Promise.all([gitPane(false), diffTab(false), column(false)]);
    await sleep(5);
    const polled = await Promise.all([gitPane(true), diffTab(true), column(true)]);
    expect(polled).toEqual(fresh);
  });

  it('never answer a request a person made from the cache, and recompute after a person asked', async () => {
    await allThree(false);
    await allThree(true); // cached under a fingerprint now
    expect(await spawnsOf(() => gitView({ op: 'working', cwd: cwd(), worktree: cwd() }, false))).toBe(1);
    expect(await spawnsOf(() => diffTab(false))).toBe(1 + 1); // the file list's batch and the file diff's batch
  });

  it('see an edit nothing announced at the next poll, and not before the tree changed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    await allThree(false);
    vi.setSystemTime(t0 + 2000);
    const before = await diffTab(true);
    expect(before.files.find((f) => f.path === 'a.txt')?.additions).toBe(1);
    await sleep(15);
    fs.appendFileSync(path.join(repo, 'a.txt'), 'four\n');
    vi.setSystemTime(t0 + 4000);
    const after = await diffTab(true);
    expect(after.files.find((f) => f.path === 'a.txt')?.additions).toBe(2);
    expect(after.diff).toContain('+four');
    expect(after.diff).not.toBe(before.diff);
  });

  it('start the back-off over when wmux itself saved a file, or an agent says it edited one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    const lane = contextLaneKey({ wsl: { distro: 'Ubuntu', posix: repo } });
    await allThree(false);
    // 31 s of quiet, then three unchanged polls: the interval doubles each time.
    for (let s = 31; s <= 100; s += 8) {
      vi.setSystemTime(t0 + s * 1000);
      await allThree(true);
    }
    expect(currentPollInterval(lane)).toBeGreaterThan(1750);
    noteWslWrite(unc(path.join(repo, 'a.txt')));
    expect(currentPollInterval(lane)).toBe(1750);
    for (let s = 110; s <= 140; s += 8) {
      vi.setSystemTime(t0 + s * 1000);
      await allThree(true);
    }
    expect(currentPollInterval(lane)).toBeGreaterThan(1750);
    noteAgentEdit();
    expect(currentPollInterval(lane)).toBe(1750);
    // Not a file in a distro: nothing to wake.
    noteWslWrite('C:\\Users\\me\\notes.md');
    noteWslWrite(undefined);
  });

  it('back off while the tree is unchanged, and not for a Windows folder', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    const lane = contextLaneKey({ wsl: { distro: 'Ubuntu', posix: repo } });
    await allThree(false);
    const seen: number[] = [];
    for (let s = 31; s <= 200; s += 2) {
      vi.setSystemTime(t0 + s * 1000);
      await allThree(true);
      seen.push(currentPollInterval(lane));
    }
    expect(Math.max(...seen)).toBe(30_000);
    // A Windows folder (a plain path) is not on this layer at all: no fingerprint, no wsl.exe.
    counter.reset();
    await Promise.all([
      gitView({ op: 'working', cwd: repo, worktree: repo }, true),
      runWithSpawnPriority('bg', () => getChangedFiles(repo)),
      runWithSpawnPriority('bg', () => getFileDiff(repo, 'a.txt')),
    ]);
    expect(counter.spawns()).toBe(0);
  });

  it('keep a click ahead of a pile of polls: the last of three starts is not theirs', async () => {
    const slow = makeWslSpawnCounter(tmp, 'slow-poll-wsl', 150);
    fakeState.exe = slow.exe;
    configureSnapshots({ enabled: false });
    const lines: string[] = [];
    configureExecTrace(true, (l) => lines.push(l));
    const poll = (req: GitViewRequest) => runWithSpawnPriority('bg', () => handleGitView(req));
    const polls = [
      poll({ op: 'repo', cwd: cwd() }),
      poll({ op: 'working', cwd: cwd(), worktree: cwd() }),
      poll({ op: 'workingDiff', cwd: cwd(), worktree: cwd(), file: 'a.txt', section: 'unstaged' }),
      poll({ op: 'workingDiff', cwd: cwd(), worktree: cwd(), file: 'b.txt', section: 'unstaged' }),
      poll({ op: 'graph', cwd: cwd(), worktree: cwd(), scope: 'worktree', limit: 10 }),
      poll({ op: 'branch', cwd: cwd(), worktree: cwd(), base: 'main' }),
    ];
    await sleep(60);
    expect(slow.peak()).toBe(2); // six polls asked at once, two run
    const click = handleGitView({ op: 'graph', cwd: cwd(), worktree: cwd(), scope: 'worktree', limit: 5 });
    await sleep(30);
    expect(slow.peak()).toBe(3); // the click started at once
    await Promise.all([click, ...polls]);
    expect(slow.peak()).toBe(3);
    const fg = lines.filter((l) => / prio=fg /.test(l));
    expect(fg.length).toBeGreaterThan(0);
    expect(fg.every((l) => / wait=0 /.test(l))).toBe(true);
    const waits = lines.filter((l) => / prio=bg /.test(l)).map((l) => Number(/ wait=(\d+) /.exec(l)?.[1]));
    expect(Math.max(...waits)).toBeGreaterThan(0); // the polls are what queued
  });

  it('trace every start as loc=wsl, a fingerprint, a batch and a single git, with nothing about the folder', async () => {
    const lines: string[] = [];
    configureExecTrace(true, (l) => lines.push(l));
    await gitView({ op: 'working', cwd: cwd(), worktree: cwd() }, false); // a batch
    await gitView({ op: 'rangeDiff', cwd: cwd(), from: '', to: git(repo, 'rev-parse', 'HEAD').trim(), file: 'a.txt' }, false); // a single git
    await allThree(false);
    await sleep(5);
    await allThree(true); // a fingerprint
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      expect(line).toMatch(/^ssh-trace op=[a-z:-]+ loc=wsl prio=(fg|bg) wait=\d+ ms=\d+ exit=\d+ out=\d+$/);
      expect(line).not.toContain(tmp);
      expect(line).not.toContain('Ubuntu');
    }
    const ops = new Set(lines.map((l) => /op=(\S+)/.exec(l)?.[1]));
    expect(ops).toContain('git:batch');
    expect(ops).toContain('git:fingerprint');
    expect(ops).toContain('git:diff'); // the single `git diff` of the range diff
  });

  it('use the one-git-per-spawn code, with no fingerprint, when the distro cannot make one', async () => {
    // A distro whose `stat` has no `-c`: the stand-in runs the real script, with `stat` shadowed so the fingerprint says NOSTAT.
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'stat'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      await allThree(false);
      const first = await spawnsOf(() => allThree(true));
      expect(first).toBeGreaterThan(1); // one fingerprint tried, then the work
      const second = await spawnsOf(() => allThree(true));
      expect(second).toBeLessThanOrEqual(first);
      // The distro is not asked for a fingerprint again: a poll costs what it did without the layer.
      const lines: string[] = [];
      configureExecTrace(true, (l) => lines.push(l));
      await allThree(true);
      expect(lines.some((l) => l.includes('git:fingerprint'))).toBe(false);
    } finally {
      process.env.PATH = saved;
    }
  });
});
