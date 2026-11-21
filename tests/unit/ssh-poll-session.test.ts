import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { makeSpawnCounter, type SpawnCounter } from '../helpers/ssh-spawn-counter';
import { handleGitView } from '../../src/main/git-view';
import { getChangedFilesWithBaseline, resetDiffCaches } from '../../src/main/diff-provider';
import { remoteChangedFiles, remoteFileDiff } from '../../src/main/ssh-diff';
import { remoteListDir, type RemoteDeps } from '../../src/main/ssh-explorer';
import { runSsh } from '../../src/main/ssh-exec';
import { runWithSshGit, type SshGitContext } from '../../src/main/ssh-git';
import { runWithSpawnPriority } from '../../src/main/exec-gate';
import { configureSnapshots, resetSnapshots } from '../../src/main/exec-snapshot';
import { configureExecTrace } from '../../src/main/exec-trace';
import { parseSshTarget, type SshTarget } from '../../src/main/ssh-targets';
import type { GitViewRequest } from '../../src/shared/git-view';
import { hasPosixTools } from '../helpers/posix-tools';
import { git, makeTmpDir } from '../helpers/git-repo';

/**
 * A 60-second session on an ssh workspace, as the three pollers run it, counted
 * in remote spawns: the Git pane (every 4 s: repo, working, one file's diff), the
 * Diff tab (every 2 s: the file list and the selected file's diff) and the
 * explorer's +N/-N column (every 4 s), all open on an unchanged tree; a click in
 * the folder view at 10 s and a file picked in the Diff tab at 12 s; ONE edit
 * at 20 s that nothing announces; then idle until 60 s.
 *
 * It runs the real code against a real repository with a counting fake ssh, and
 * a clock that only the code under test reads (Date), so 60 s costs a few
 * seconds. The baseline is the same session with the snapshot mechanism switched
 * off (`configureSnapshots`), so the assertions are ratios, not absolute counts.
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasPosixTools(['git', 'gnu-find', 'stat-c', 'mktemp']))('a 60 s session of the three pollers on an ssh workspace', () => {
  let tmp: string;
  let repo: string;
  let counter: SpawnCounter;
  const targetAt = (root: string): SshTarget => {
    const parsed = parseSshTarget(['ssh', 'dev@box'], root);
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed;
  };
  const ctx = (): SshGitContext => ({ target: targetAt(repo), tool: () => counter.tool });
  const deps = (): RemoteDeps => ({ run: runSsh, tool: () => counter.tool });
  const tool = () => counter.tool;

  beforeAll(() => {
    tmp = makeTmpDir('wmux-ssh-session-');
    counter = makeSpawnCounter(tmp, 'session-ssh', 4);
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
    resetDiffCaches();
    resetSnapshots();
    configureSnapshots({ enabled: true });
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
    configureExecTrace(false);
    git(repo, 'reset', '-q');
  });

  // ─── The pollers, each as it calls main ────────────────────────────────────
  const gitView = async (req: GitViewRequest, poll: boolean) => {
    const res = await runWithSpawnPriority(poll ? 'bg' : 'fg', () => handleGitView(req, ctx()));
    if (!res.ok) throw new Error(res.error);
    return res.data;
  };
  const gitPane = (poll: boolean) => Promise.all([
    gitView({ op: 'repo', cwd: '' }, poll),
    gitView({ op: 'working', cwd: '', worktree: repo }, poll),
    gitView({ op: 'workingDiff', cwd: '', worktree: repo, file: 'a.txt', section: 'unstaged' }, poll),
  ]);
  const diffTab = (poll: boolean, file: string) => runWithSpawnPriority(poll ? 'bg' : 'fg', async () => {
    const files = await remoteChangedFiles(targetAt(repo), undefined, tool);
    const diff = await remoteFileDiff(targetAt(repo), file, undefined, tool);
    return { files, diff };
  });
  const explorerColumn = (poll: boolean) => runWithSpawnPriority(poll ? 'bg' : 'fg',
    () => runWithSshGit(ctx(), () => getChangedFilesWithBaseline(repo)));

  interface Session {
    total: number;
    phases: { open: number; beforeEdit: number; afterEdit: number };
    editSeenAtS: number;
    lastFilesSeen: string[];
  }

  /** Runs the session at 500 ms steps and returns the spawn counts. */
  async function runSession(options: { untilMs: number; scripted: boolean } = { untilMs: 60_000, scripted: true }): Promise<Session> {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    let selectedInDiffTab = 'a.txt';
    let editSeenAtS = -1;
    let lastFilesSeen: string[] = [];
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
          if ('files' in r.files) {
            lastFilesSeen = r.files.files.map((f) => `${f.path}:${f.additions}`);
            if (edited && editSeenAtS < 0 && r.files.files.some((f) => f.path === 'a.txt' && f.additions === 2)) editSeenAtS = s;
          }
        }));
        if (ms % 4000 === 0) jobs.push(gitPane(true), explorerColumn(true));
      }
      if (options.scripted && ms === 10_000) jobs.push(remoteListDir(targetAt(repo), 'src', {}, deps())); // a click in the folder view
      if (options.scripted && ms === 12_000) {
        // A file picked in the Diff tab: its diff is asked for as a person asks.
        selectedInDiffTab = 'b.txt';
        jobs.push(runWithSpawnPriority('fg', () => remoteFileDiff(targetAt(repo), 'b.txt', undefined, tool)));
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
      lastFilesSeen,
    };
  }

  it('spawns far less with the snapshot than without, and finds the edit just as well', async () => {
    configureSnapshots({ enabled: false });
    const before = await runSession();

    resetDiffCaches();
    resetSnapshots();
    configureSnapshots({ enabled: true });
    git(repo, 'checkout', '-q', '--', 'a.txt');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'four\n');
    counter.reset();
    const after = await runSession();

    // The edit (at 20.5 s) is found by the next Diff tab poll without the snapshot, and within one more poll with it.
    expect(before.editSeenAtS).toBe(22);
    expect(after.editSeenAtS).toBeGreaterThanOrEqual(22);
    expect(after.editSeenAtS).toBeLessThanOrEqual(24);
    // Both ends show the same tree at the end.
    expect(after.lastFilesSeen).toEqual(before.lastFilesSeen);
    expect(after.total).toBeLessThan(before.total * 0.4);
    expect(after.phases.afterEdit).toBeLessThan(before.phases.afterEdit * 0.3);
  });

  it('on a tree nobody touches, polling backs off: two quiet minutes cost a small fraction of the spawns', async () => {
    const quiet = { untilMs: 120_000, scripted: false };
    configureSnapshots({ enabled: false });
    const before = await runSession(quiet);
    resetDiffCaches();
    resetSnapshots();
    configureSnapshots({ enabled: true });
    counter.reset();
    const after = await runSession(quiet);
    expect(after.lastFilesSeen).toEqual(before.lastFilesSeen);
    expect(after.total).toBeLessThan(before.total * 0.15);
  });

  it('while polls pile up, a click never waits: the last slot of three is kept for it', async () => {
    configureSnapshots({ enabled: false });
    const slow = makeSpawnCounter(tmp, 'slow-ssh', 150);
    const lines: string[] = [];
    configureExecTrace(true, (l) => lines.push(l));
    const slowCtx = (): SshGitContext => ({ target: targetAt(repo), tool: () => slow.tool });
    const poll = (req: GitViewRequest) => runWithSpawnPriority('bg', () => handleGitView(req, slowCtx()));
    const polls = [
      poll({ op: 'repo', cwd: '' }),
      poll({ op: 'working', cwd: '', worktree: repo }),
      poll({ op: 'workingDiff', cwd: '', worktree: repo, file: 'a.txt', section: 'unstaged' }),
      poll({ op: 'workingDiff', cwd: '', worktree: repo, file: 'b.txt', section: 'unstaged' }),
      poll({ op: 'graph', cwd: '', worktree: repo, scope: 'worktree', limit: 10 }),
      poll({ op: 'branch', cwd: '', worktree: repo, base: 'main' }),
    ];
    await sleep(60);
    expect(slow.peak()).toBe(2); // six polls asked at once, two run: the third slot is not theirs
    const click = remoteListDir(targetAt(repo), 'src', {}, { run: runSsh, tool: () => slow.tool });
    await sleep(30);
    expect(slow.peak()).toBe(3); // the click started at once
    await Promise.all([click, ...polls]);
    expect(slow.peak()).toBe(3);
    const fg = lines.filter((l) => / prio=fg /.test(l));
    expect(fg).toHaveLength(1);
    expect(fg[0]).toMatch(/ op=list loc=ssh prio=fg wait=0 /);
    const waits = lines.filter((l) => / prio=bg /.test(l)).map((l) => Number(/ wait=(\d+) /.exec(l)?.[1]));
    expect(Math.max(...waits)).toBeGreaterThan(0); // the polls are what queued
  });
});
