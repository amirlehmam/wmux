import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import * as path from 'path';
import { makeWslSpawnCounter, type WslSpawnCounter } from '../helpers/wsl-spawn-counter';

// The wsl.exe of these tests is a counting stand-in that runs the program in the local file system.
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

import { resetBatchBackoff } from '../../src/main/exec-git-batch';
import { handleGitView, wslPathToWindows } from '../../src/main/git-view';
import { getChangedFiles, getChangedFilesWithBaseline, getFileDiff, resetDiffCaches } from '../../src/main/diff-provider';
import { runWithSpawnPriority } from '../../src/main/exec-gate';
import { configureSnapshots, resetSnapshots } from '../../src/main/exec-snapshot';
import { configureExecTrace } from '../../src/main/exec-trace';
import { configureExecWorker, resetExecWorkersForTests } from '../../src/main/exec-worker';
import type { GitViewRequest } from '../../src/shared/git-view';
import { hasPosixTools } from '../helpers/posix-tools';
import { git, makeTmpDir } from '../helpers/git-repo';

/**
 * A 60-second session on a folder that lives on a WSL share, as the three pollers
 * run it, counted in `wsl.exe` starts: the Git pane (every 4 s: repo, working, one
 * file's diff), the Diff tab (every 2 s: the file list and the selected file's diff)
 * and the explorer's +N/-N column (every 4 s), all open on an unchanged tree; a click
 * in the Git pane at 10 s and a file picked in the Diff tab at 12 s; ONE edit at
 * 20.5 s that nothing announces; then idle until 60 s. The same session as
 * tests/unit/ssh-poll-session.test.ts runs for ssh, so the two paths can be compared.
 *
 * It runs the real code against a real repository with a counting fake wsl.exe and a
 * clock only the code under test reads (Date), so 60 s costs a few seconds. The
 * assertions are ratios between runs with and without the snapshot layer.
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasPosixTools(['git']))('a 60 s session of the three pollers on a WSL folder', () => {
  let tmp: string;
  let repo: string;
  let counter: WslSpawnCounter;
  const unc = (posix: string): string => wslPathToWindows('Ubuntu', posix);
  const cwd = (): string => unc(repo);

  beforeAll(() => {
    tmp = makeTmpDir('wmux-wsl-session-');
    fakeState.cwd = tmp;
    counter = makeWslSpawnCounter(tmp, 'session-wsl', 4);
    fakeState.exe = counter.exe;
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
    fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export {};\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first');
    git(repo, 'worktree', 'add', '-q', '-b', 'agent/work', path.join(tmp, 'agent-wt'), 'HEAD');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  beforeEach(() => {
    resetBatchBackoff();
    resetDiffCaches();
    git(repo, 'checkout', '-q', '--', '.');
    for (const f of fs.readdirSync(repo)) if (f.startsWith('u-')) fs.rmSync(path.join(repo, f));
    // The working state the views are open on: an unstaged edit, a staged file, two untracked files.
    fs.appendFileSync(path.join(repo, 'a.txt'), 'four\n');
    fs.writeFileSync(path.join(repo, 'u-staged.txt'), 's\n');
    git(repo, 'add', 'u-staged.txt');
    fs.writeFileSync(path.join(repo, 'u-one.txt'), 'x\ny\n');
    fs.writeFileSync(path.join(repo, 'u-two.txt'), 'x\n');
    counter.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
    git(repo, 'reset', '-q');
    configureExecTrace(false);
    resetExecWorkersForTests();
    configureExecWorker();
  });

  // ─── The pollers, each as it calls main ────────────────────────────────────
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
  const diffTab = (poll: boolean, file: string) => runWithSpawnPriority(poll ? 'bg' : 'fg', async () => {
    const files = await getChangedFiles(cwd());
    const diff = await getFileDiff(cwd(), file);
    return { files, diff };
  });
  const explorerColumn = (poll: boolean) => runWithSpawnPriority(poll ? 'bg' : 'fg', () => getChangedFilesWithBaseline(cwd()));

  interface Session {
    total: number;
    phases: { open: number; beforeEdit: number; afterEdit: number };
    editSeenAtS: number;
  }

  /** Runs the session at 500 ms steps and returns the start counts. */
  async function runSession(options: { untilMs: number; scripted: boolean } = { untilMs: 60_000, scripted: true }): Promise<Session> {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    let selectedInDiffTab = 'a.txt';
    let editSeenAtS = -1;
    let edited = false;
    const marks: Record<string, number> = {};
    for (let ms = 0; ms <= options.untilMs; ms += 500) {
      vi.setSystemTime(t0 + ms);
      const s = ms / 1000;
      const jobs: Array<Promise<unknown>> = [];
      if (ms === 0) {
        // The three views open: somebody just opened them, not a poll.
        jobs.push(gitPane(false), diffTab(false, selectedInDiffTab), explorerColumn(false));
      } else {
        if (ms % 2000 === 0) jobs.push(diffTab(true, selectedInDiffTab).then((r) => {
          if (edited && editSeenAtS < 0 && r.files.some((f) => f.path === 'a.txt' && f.additions === 2)) editSeenAtS = s;
        }));
        if (ms % 4000 === 0) jobs.push(gitPane(true), explorerColumn(true));
      }
      if (options.scripted && ms === 10_000) jobs.push(gitView({ op: 'graph', cwd: cwd(), worktree: cwd(), scope: 'worktree', limit: 10 }, false)); // a click in the Git pane
      if (options.scripted && ms === 12_000) {
        // A file picked in the Diff tab: its diff is asked for as a person asks.
        selectedInDiffTab = 'b.txt';
        jobs.push(runWithSpawnPriority('fg', () => getFileDiff(cwd(), 'b.txt')));
      }
      if (options.scripted && ms === 20_500) {
        // One edit that nothing announces: a rewrite of a.txt by something that is not wmux and fires no hook.
        await sleep(15);
        fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n');
        edited = true;
      }
      await Promise.all(jobs);
      if (ms === 0) marks.open = counter.spawns();
      if (ms === 20_000) marks.beforeEdit = counter.spawns();
    }
    const total = counter.spawns();
    return {
      total,
      phases: { open: marks.open, beforeEdit: marks.beforeEdit - marks.open, afterEdit: total - marks.beforeEdit },
      editSeenAtS,
    };
  }

  /** The session with the snapshot layer off is the batching alone: one wsl.exe start per poll question. */
  const withSnapshots = (on: boolean): void => {
    resetDiffCaches();
    resetSnapshots();
    resetBatchBackoff();
    configureSnapshots({ enabled: on });
    counter.reset();
  };

  it('the 60 s session needs far fewer wsl.exe starts with the shared snapshot than with batching alone', async () => {
    withSnapshots(false);
    const batched = await runSession();
    withSnapshots(true);
    git(repo, 'checkout', '-q', '--', 'a.txt');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'four\n');
    counter.reset();
    const now = await runSession();
    // The views opening cost the same either way; the saving is in the polls after.
    expect(now.phases.open).toBe(batched.phases.open);
    expect(now.total).toBeLessThan(batched.total * 0.5);
    expect(now.phases.afterEdit).toBeLessThan(batched.phases.afterEdit * 0.5);
    // The edit (at 20.5 s) is found by the next Diff tab poll without the snapshot, and within one more poll with it.
    expect(batched.editSeenAtS).toBe(22);
    expect(now.editSeenAtS).toBeGreaterThanOrEqual(22);
    expect(now.editSeenAtS).toBeLessThanOrEqual(24);
  });

  it('the same 60 s session with the persistent worker: one wsl.exe start serves the requests that were starts', async () => {
    configureExecWorker({ enabled: true });
    resetExecWorkersForTests();
    withSnapshots(true);
    const lines: string[] = [];
    configureExecTrace(true, (l) => lines.push(l));
    const now = await runSession();
    const requests = lines.filter((l) => !l.startsWith('ssh-trace op=worker:'));
    const viaWorker = requests.filter((l) => l.includes(' via=worker')).length;
    const viaSpawn = requests.filter((l) => l.includes(' via=spawn')).length;
    // Starts: the worker's (one, or a second if a request found the first busy), and nothing else.
    expect(now.total).toBeLessThanOrEqual(2);
    expect(viaSpawn).toBe(0);
    expect(viaWorker).toBe(requests.length);
    // The requests are the ones the same session makes as starts, give or take the timing of a fake clock.
    expect(requests.length).toBeGreaterThanOrEqual(40);
    expect(now.editSeenAtS).toBeGreaterThanOrEqual(22);
    expect(now.editSeenAtS).toBeLessThanOrEqual(24);
  });

  it('two quiet minutes on a tree nobody touches, in wsl.exe starts: polling backs off', async () => {
    const quiet = { untilMs: 120_000, scripted: false };
    withSnapshots(false);
    const batched = await runSession(quiet);
    withSnapshots(true);
    git(repo, 'checkout', '-q', '--', 'a.txt');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'four\n');
    counter.reset();
    const now = await runSession(quiet);
    expect(now.total).toBeLessThan(batched.total * 0.15);
  });
});
