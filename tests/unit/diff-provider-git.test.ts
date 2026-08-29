/**
 * The git path of the diff provider must never let invocations pile up.
 *
 * On a large working tree `git diff HEAD --numstat` takes ~1s. A caller asking
 * faster than that (the diff pane did, at render speed) used to stack one
 * `git.exe` per call — 10-40/s measured, saturating the main process and
 * lagging every keystroke, since the main process is also the PTY relay
 * (issue #141).
 *
 * The snapshot (non-git) path already coalesced via `scansInFlight`; the git
 * path did not. These tests pin the guarantee for the git path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promisify } from 'util';

// ─── execFile mock ──────────────────────────────────────────────────────────
// diff-provider does `promisify(execFile)` at module load, so the mock has to
// carry the promisify.custom symbol Node's real execFile has — otherwise
// promisify resolves with stdout alone and the `{ stdout }` destructure breaks.

interface Call { args: string[]; release: () => void }
const calls: Call[] = [];
/** When true, invocations hang until explicitly released. */
let holdCalls = false;

function stdoutFor(args: string[]): string {
  if (args[0] === 'rev-parse') return 'true\n';
  if (args[0] === 'status') return ' M src/a.ts\n';
  if (args[0] === 'diff' && args.includes('--numstat')) return '3\t1\tsrc/a.ts\n';
  return '';
}

const execFileImpl: any = (_cmd: string, args: string[]) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  calls.push({ args, release });
  if (!holdCalls) release();
  return gate.then(() => ({ stdout: stdoutFor(args), stderr: '' }));
};
execFileImpl[promisify.custom] = execFileImpl;

vi.mock('child_process', () => ({ execFile: execFileImpl }));

const gitArgs = () => calls.map((c) => c.args.join(' '));
const countMatching = (needle: string) => gitArgs().filter((a) => a.includes(needle)).length;
/** Release everything queued and let the microtask chain advance. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    calls.forEach((c) => c.release());
    await Promise.resolve();
  }
}

interface Changed { path: string; status: string; additions: number; deletions: number }
let getChangedFiles: (cwd: string) => Promise<Changed[]>;
let resetDiffCaches: () => void;

beforeEach(async () => {
  calls.length = 0;
  holdCalls = false;
  vi.resetModules();
  const mod = await import('../../src/main/diff-provider');
  getChangedFiles = mod.getChangedFiles as typeof getChangedFiles;
  resetDiffCaches = mod.resetDiffCaches;
  resetDiffCaches();
});

describe('getChangedFiles — git path concurrency', () => {
  it('coalesces overlapping calls into a single git pass', async () => {
    holdCalls = true;
    const pending = [
      getChangedFiles('/repo'),
      getChangedFiles('/repo'),
      getChangedFiles('/repo'),
      getChangedFiles('/repo'),
      getChangedFiles('/repo'),
    ];
    holdCalls = false;
    await drain();
    const results = await Promise.all(pending);

    expect(countMatching('--numstat')).toBe(1);
    // Every caller still gets the answer.
    for (const r of results) expect(r).toHaveLength(1);
  });

  it('runs again once the previous pass has settled', async () => {
    await getChangedFiles('/repo');
    expect(countMatching('--numstat')).toBe(1);
    await getChangedFiles('/repo');
    expect(countMatching('--numstat')).toBe(2);
  });

  it('does not coalesce across different directories', async () => {
    await Promise.all([getChangedFiles('/repo-a'), getChangedFiles('/repo-b')]);
    expect(countMatching('--numstat')).toBe(2);
  });

  it('caches the repo probe instead of re-running rev-parse every pass', async () => {
    await getChangedFiles('/repo');
    await getChangedFiles('/repo');
    await getChangedFiles('/repo');
    expect(countMatching('rev-parse')).toBe(1);
  });
});

/**
 * `git status --porcelain` emits `XY PATH`, where X is the INDEX column and Y
 * the WORKTREE one. For the most common state of all — modified, not staged —
 * X is a SPACE, so the leading space is data and not padding.
 *
 * Trimming the whole output therefore shifts the FIRST line one character left,
 * and only the first: `trim()` touches the ends of a string, so every interior
 * row keeps its space. The result was a path missing its initial letter, which
 * then failed to match the same file's key in `git diff HEAD --numstat` — and
 * because that join falls back to `?? 0`, the failure surfaced as a file that
 * genuinely had no changes rather than as an error. Live since v0.5.2, invisible
 * until 2.7 started rendering the numbers per row.
 */
describe('getChangedFiles — porcelain parsing', () => {
  it('keeps the leading space of the first line, so the path is intact', async () => {
    const [file] = await getChangedFiles('/repo');
    expect(file.path).toBe('src/a.ts');
  });

  it('joins the numstat counts onto that path', async () => {
    const [file] = await getChangedFiles('/repo');
    expect(file.additions).toBe(3);
    expect(file.deletions).toBe(1);
  });

  it('reads the status off the correct two columns', async () => {
    const [file] = await getChangedFiles('/repo');
    expect(file.status).toBe('modified');
  });
});
