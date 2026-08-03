import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PtyLedger,
  selectOrphans,
  parseEntries,
  parseProcessLines,
  queryProcesses,
  PROBE_TIMEOUT_MS,
  REUSE_TOLERANCE_MS,
  type LedgerEntry,
  type LiveProcess,
} from '../../src/main/pty-ledger';

// Issue #139: a crashed wmux never reaches will-quit, so killAll() never runs
// and every pane's shell — plus the agent and MCP servers beneath it — keeps
// running. The ledger is what lets the next launch find them.
//
// The tests that matter most here are the ones that pin what must NOT be
// killed: this list feeds `taskkill /T /F`, so a stale entry whose PID has been
// recycled would take out an unrelated process tree.

const T0 = 1_700_000_000_000;

const entry = (pid: number, image = 'pwsh.exe', startedAt = T0): LedgerEntry => ({ pid, image, startedAt });
const live = (pid: number, image = 'pwsh.exe', startedAt = T0): LiveProcess => ({ pid, image, startedAt });

describe('selectOrphans', () => {
  it('selects a recorded PID that is still alive and still the same process', () => {
    expect(selectOrphans([entry(1234)], [live(1234)])).toEqual([1234]);
  });

  it('ignores a recorded PID that is no longer running (the common case)', () => {
    expect(selectOrphans([entry(1234)], [])).toEqual([]);
  });

  it('does NOT select a recycled PID now running a different image', () => {
    expect(selectOrphans([entry(1234, 'pwsh.exe')], [live(1234, 'chrome.exe')])).toEqual([]);
  });

  it('does NOT select a recycled PID with the same image but a later creation time', () => {
    const recycled = live(1234, 'pwsh.exe', T0 + REUSE_TOLERANCE_MS + 1);
    expect(selectOrphans([entry(1234, 'pwsh.exe', T0)], [recycled])).toEqual([]);
  });

  it('tolerates clock skew inside the reuse window', () => {
    const skewed = live(1234, 'pwsh.exe', T0 + REUSE_TOLERANCE_MS - 1);
    expect(selectOrphans([entry(1234, 'pwsh.exe', T0)], [skewed])).toEqual([1234]);
  });

  it('matches the image name case-insensitively (Win32_Process casing varies)', () => {
    expect(selectOrphans([entry(1234, 'PWSH.EXE')], [live(1234, 'pwsh.exe')])).toEqual([1234]);
  });

  it('selects only the surviving entries out of a mixed list', () => {
    const entries = [entry(1, 'pwsh.exe'), entry(2, 'cmd.exe'), entry(3, 'wsl.exe')];
    const alive = [live(1, 'pwsh.exe'), live(2, 'notepad.exe'), live(3, 'wsl.exe')];
    expect(selectOrphans(entries, alive)).toEqual([1, 3]);
  });
});

describe('parseProcessLines', () => {
  it('parses the pid|image|epochMs lines the PowerShell probe emits', () => {
    const out = '4321|pwsh.exe|1700000000000\r\n99|cmd.exe|1700000001000\r\n';
    expect(parseProcessLines(out)).toEqual([
      { pid: 4321, image: 'pwsh.exe', startedAt: 1_700_000_000_000 },
      { pid: 99, image: 'cmd.exe', startedAt: 1_700_000_001_000 },
    ]);
  });

  it('drops malformed lines rather than inventing a process to kill', () => {
    const out = ['', 'garbage', '12|pwsh.exe', 'abc|pwsh.exe|1700000000000', '0|pwsh.exe|1700000000000',
      '13||1700000000000', '14|pwsh.exe|notanumber', '15|pwsh.exe|1700000000000'].join('\n');
    expect(parseProcessLines(out)).toEqual([{ pid: 15, image: 'pwsh.exe', startedAt: 1_700_000_000_000 }]);
  });
});

describe('parseEntries', () => {
  it('keeps well-formed entries', () => {
    expect(parseEntries({ entries: [entry(7)] })).toEqual([entry(7)]);
  });

  it('drops anything malformed — the file is user-writable', () => {
    const raw = {
      entries: [
        null,
        { pid: 0, image: 'pwsh.exe', startedAt: T0 },
        { pid: -1, image: 'pwsh.exe', startedAt: T0 },
        { pid: 1.5, image: 'pwsh.exe', startedAt: T0 },
        { pid: 8, image: '', startedAt: T0 },
        { pid: 9, image: 'pwsh.exe' },
        { pid: 10, image: 'pwsh.exe', startedAt: T0 },
      ],
    };
    expect(parseEntries(raw)).toEqual([entry(10)]);
  });

  it('returns [] for a file with no entries array', () => {
    expect(parseEntries(null)).toEqual([]);
    expect(parseEntries({})).toEqual([]);
    expect(parseEntries({ entries: 'nope' })).toEqual([]);
  });
});

describe('PtyLedger', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ledger-'));
    file = path.join(dir, 'pty-ledger.json');
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const read = () => JSON.parse(fs.readFileSync(file, 'utf-8'));

  it('records a spawned PID and stamps this process as the owner', () => {
    const ledger = new PtyLedger(file);
    ledger.add(4242, 'pwsh.exe');

    const saved = read();
    expect(saved.ownerPid).toBe(process.pid);
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0]).toMatchObject({ pid: 4242, image: 'pwsh.exe' });
    expect(saved.entries[0].startedAt).toBeGreaterThan(0);
  });

  it('forgets a PID once its PTY is killed, so a clean shutdown leaves nothing to reap', () => {
    const ledger = new PtyLedger(file);
    ledger.add(1, 'pwsh.exe');
    ledger.add(2, 'cmd.exe');
    ledger.remove(1);

    expect(read().entries.map((e: LedgerEntry) => e.pid)).toEqual([2]);
    ledger.clear();
    expect(read().entries).toEqual([]);
  });

  it('takeOver returns what a dead owner left behind, then claims the file', () => {
    // A PID far above the Windows range, so it cannot be running.
    fs.writeFileSync(file, JSON.stringify({ ownerPid: 0x7ffffff0, entries: [entry(4242)] }));

    const orphans = new PtyLedger(file).takeOver();

    expect(orphans).toEqual([entry(4242)]);
    expect(read()).toEqual({ ownerPid: process.pid, entries: [] });
  });

  it('takeOver returns nothing when the recorded owner is still running', () => {
    // Those PTYs have a live parent — they are not orphans, and killing them
    // would tear down another instance's terminals.
    expect(process.ppid).toBeGreaterThan(0);
    fs.writeFileSync(file, JSON.stringify({ ownerPid: process.ppid, entries: [entry(4242)] }));

    expect(new PtyLedger(file).takeOver()).toEqual([]);
  });

  it('takeOver reclaims a ledger this same PID already owned', () => {
    fs.writeFileSync(file, JSON.stringify({ ownerPid: process.pid, entries: [entry(4242)] }));
    expect(new PtyLedger(file).takeOver()).toEqual([entry(4242)]);
  });

  it('takeOver survives a missing or corrupt ledger', () => {
    expect(new PtyLedger(file).takeOver()).toEqual([]);

    fs.writeFileSync(file, 'not json {{{');
    expect(new PtyLedger(file).takeOver()).toEqual([]);
  });

  it('creates the ledger directory if it does not exist yet', () => {
    const nested = path.join(dir, 'a', 'b', 'pty-ledger.json');
    new PtyLedger(nested).add(1, 'pwsh.exe');
    expect(fs.existsSync(nested)).toBe(true);
  });
});

describe('queryProcesses (live Win32_Process probe)', () => {
  it('answers nothing for an empty request without spawning PowerShell', async () => {
    expect(await queryProcesses([])).toEqual([]);
  });

  // The command string is built to contain no double quotes so nothing depends
  // on execFile's escaping — this is the test that proves that actually holds.
  // Probing our own PID keeps it hermetic: the answer is known, and nothing
  // here ever reaches the killing half.
  // Must outlast the probe's own timeout, or a cold PowerShell start on a slow
  // machine fails the test as a timeout rather than reporting what went wrong.
  const LIVE_PROBE_BUDGET = PROBE_TIMEOUT_MS + 15_000;

  it('reports this process with a real image name and creation time', async () => {
    const found = await queryProcesses([process.pid]);

    expect(found).toHaveLength(1);
    expect(found[0].pid).toBe(process.pid);
    expect(found[0].image.toLowerCase()).toMatch(/\.exe$/);
    expect(found[0].startedAt).toBeLessThanOrEqual(Date.now());
    expect(found[0].startedAt).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000);
  }, LIVE_PROBE_BUDGET);

  it('would not select this process from a ledger entry naming a different image', async () => {
    const found = await queryProcesses([process.pid]);
    expect(found).toHaveLength(1); // assert before destructuring, for a clear failure
    const [self] = found;
    const stale = entry(process.pid, 'pwsh.exe', self.startedAt);

    expect(selectOrphans([stale], [self])).toEqual([]);
  }, LIVE_PROBE_BUDGET);
});
