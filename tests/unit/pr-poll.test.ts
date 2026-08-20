import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * The PR poller in the PowerShell integration can raise a PR badge but never
 * lower one (issue #4).
 *
 * Two things keep a merged or foreign PR pinned to a workspace row:
 *
 *  1. The tick reports only on success. `gh pr view` failing — no PR for this
 *     branch, not a repo, gh not authed — sends nothing at all, so the last
 *     value stands. `clear_pr` is handled in App.tsx but has no sender, unlike
 *     `clear_git_branch`, whose clearing half is already wired up in both the
 *     PowerShell and bash integrations.
 *
 *  2. `Start-Job` hands the child runspace the location captured at call time
 *     and keeps it there. The poller is started on the shell's first idle (a
 *     deliberate startup-cost fix), so every later `gh pr view` answers for the
 *     directory the pane opened in — `cd` to another repo or worktree and the
 *     row keeps showing the first one's PR.
 *
 * The per-tick decision is a pure function so it can be exercised here against
 * a real PowerShell host rather than pattern-matched; the wiring around it is
 * read back out of the script.
 */

const SCRIPT = path.join(__dirname, '..', '..', 'src', 'shell-integration', 'wmux-powershell-integration.ps1');
// Normalized to LF: the script is CRLF on disk, and every offset below looks
// for a brace on its own line.
const source = fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');

/**
 * Lift a top-level `function Name { … }` out of the integration script.
 * Terminated by a closing brace in column 0, which is how every function in
 * this file is written.
 */
function extractFunction(name: string): string {
  const start = source.indexOf(`function ${name} {`);
  expect(start, `${name} is not defined in ${path.basename(SCRIPT)}`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', start);
  expect(end, `${name} has no column-0 closing brace`).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

/**
 * The job's script block — everything the poller runs on a tick. Anchored on
 * the `Start-Job` *call*, not the first mention of the word: the comments above
 * it discuss the job, and slicing from those swept in the functions in between.
 */
function pollerJobBlock(): string {
  const start = source.indexOf('= Start-Job ');
  expect(start, 'no Start-Job call in the integration script').toBeGreaterThan(-1);
  return source.slice(start);
}

function findPowerShell(): string | null {
  for (const exe of ['pwsh.exe', 'powershell.exe', 'pwsh']) {
    try {
      execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore' });
      return exe;
    } catch {
      // Not installed, or refused to run — try the next host.
    }
  }
  return null;
}

const host = findPowerShell();

/**
 * Run `Get-WmuxPrMessage` in a real host. Written to a temp .ps1 and invoked
 * with -File: the arguments carry JSON and quotes, and -Command would have them
 * re-parsed by the host's own command-line splitter on the way in.
 */
function prMessage(args: {
  surfaceId: string;
  prJson: string;
  exitCode: number;
  inRepo?: boolean;
  reported?: boolean;
}): string {
  // Single-quoted PowerShell literals: the payload is JSON, and a double-quoted
  // string would have its `"` and `$` re-read by the parser.
  const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const script = [
    extractFunction('Get-WmuxPrMessage'),
    '',
    `Get-WmuxPrMessage -SurfaceId ${ps(args.surfaceId)} ` +
      `-PrJson ${ps(args.prJson)} -ExitCode ${args.exitCode} ` +
      `-InRepo $${args.inRepo ?? true} -Reported $${args.reported ?? false}`,
    '',
  ].join('\n');

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pr-')), 'probe.ps1');
  fs.writeFileSync(file, script, 'utf8');
  try {
    return execFileSync(host as string, ['-NoProfile', '-NonInteractive', '-File', file], {
      encoding: 'utf8',
    }).trim();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

describe.skipIf(!host)('Get-WmuxPrMessage — what a poller tick decides to send', () => {
  const surfaceId = 'surf-1111';

  it('reports the PR when gh resolved one', () => {
    const json = JSON.stringify({ number: 450, state: 'MERGED', title: 'Fix the thing' });
    expect(prMessage({ surfaceId, prJson: json, exitCode: 0 })).toBe(
      `report_pr ${surfaceId} 450 MERGED Fix the thing`,
    );
  });

  it('keeps a multi-word title in one piece', () => {
    // pipe-server.ts:139 rejoins everything past the state, so spaces survive
    // the trip — the message just has to carry them.
    const json = JSON.stringify({ number: 7, state: 'OPEN', title: 'a b c d' });
    expect(prMessage({ surfaceId, prJson: json, exitCode: 0 })).toBe(`report_pr ${surfaceId} 7 OPEN a b c d`);
  });

  it('retracts its own report when the branch it reported has no PR', () => {
    // The tick that used to send nothing and leave the previous PR up forever.
    expect(prMessage({ surfaceId, prJson: '', exitCode: 1, reported: true })).toBe(`clear_pr ${surfaceId}`);
  });

  it('retracts when gh exits zero but says nothing', () => {
    expect(prMessage({ surfaceId, prJson: '', exitCode: 0, reported: true })).toBe(`clear_pr ${surfaceId}`);
  });

  it('retracts rather than reporting unparseable output', () => {
    expect(prMessage({ surfaceId, prJson: 'not json at all', exitCode: 0, reported: true })).toBe(
      `clear_pr ${surfaceId}`,
    );
  });

  // PR metadata is workspace-scoped but every pwsh pane polls, so a pane that
  // clears unconditionally speaks for panes it knows nothing about. Two panes
  // in one workspace — one on a branch with a PR, one not — would take turns
  // reporting and clearing every 45s. A pane only ever retracts its own claim.
  it('stays quiet when it never reported a PR in the first place', () => {
    expect(prMessage({ surfaceId, prJson: '', exitCode: 1, reported: false })).toBe('');
  });

  // Walking out of a repo is the one way a badge could outlive what it
  // describes: the prompt clears the branch off the row on the very next
  // command, and a poller that stayed quiet here would leave the PR sitting
  // beside a row that no longer has a repo behind it. The retraction is safe
  // for the same reason as every other one — it names this pane, and the
  // renderer honours a clear only from the pane that currently owns the badge.
  it('retracts its own badge when the pane walks out of the repo', () => {
    expect(prMessage({ surfaceId, prJson: '', exitCode: 1, inRepo: false, reported: true })).toBe(
      `clear_pr ${surfaceId}`,
    );
  });

  // Still nothing to say for a pane that never claimed the badge — the pane in
  // ~ must not clear the PR its neighbour just reported.
  it('stays quiet outside a repo when it never claimed the badge', () => {
    expect(prMessage({ surfaceId, prJson: '', exitCode: 1, inRepo: false, reported: false })).toBe('');
  });

  it('reports nothing from outside a repo even if gh answered', () => {
    const json = JSON.stringify({ number: 450, state: 'MERGED', title: 't' });
    expect(prMessage({ surfaceId, prJson: json, exitCode: 0, inRepo: false })).toBe('');
  });
});

describe.skipIf(!host)('the integration script itself', () => {
  it('parses in a real PowerShell host', () => {
    // Nothing else here would notice a syntax error: the tests above lift one
    // function out of the file, and the ones below read it as text. A shell
    // integration that fails to parse takes the whole pane's prompt, git
    // branch and shell state down with it, silently.
    const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-parse-')), 'parse.ps1');
    fs.writeFileSync(
      probe,
      [
        '$errors = $null',
        `$null = [System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT.replace(/'/g, "''")}', [ref]$null, [ref]$errors)`,
        'if ($errors) { $errors | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" } }',
        '',
      ].join('\n'),
      'utf8',
    );
    try {
      const out = execFileSync(host as string, ['-NoProfile', '-NonInteractive', '-File', probe], {
        encoding: 'utf8',
      }).trim();
      expect(out, `parse errors in ${path.basename(SCRIPT)}`).toBe('');
    } finally {
      fs.rmSync(path.dirname(probe), { recursive: true, force: true });
    }
  });
});

/**
 * Run `Resolve-WmuxPaneCwd` in a real host against a real temp file. This is
 * genuinely filesystem-shaped behavior (missing file, empty file, a path that
 * no longer exists) so it's exercised with real files rather than mocked.
 */
function resolvePaneCwd(cwdFile: string | null): string {
  const script = [extractFunction('Resolve-WmuxPaneCwd'), '', `$r = Resolve-WmuxPaneCwd -CwdFile ${cwdFile ? `'${cwdFile.replace(/'/g, "''")}'` : "''"}`, 'if ($null -eq $r) { "<null>" } else { $r }', ''].join('\n');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-resolve-')), 'probe.ps1');
  fs.writeFileSync(file, script, 'utf8');
  try {
    return execFileSync(host as string, ['-NoProfile', '-NonInteractive', '-File', file], {
      encoding: 'utf8',
    }).trim();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

describe.skipIf(!host)('Resolve-WmuxPaneCwd — what the job trusts as "the pane is here"', () => {
  it('resolves a file that names a real directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-realdir-'));
    const cwdFile = path.join(dir, 'cwd.txt');
    fs.writeFileSync(cwdFile, dir, 'utf8');
    expect(resolvePaneCwd(cwdFile)).toBe(dir);
  });

  it('returns nothing when the hand-off file does not exist', () => {
    const missing = path.join(os.tmpdir(), 'wmux-does-not-exist', 'cwd.txt');
    expect(resolvePaneCwd(missing)).toBe('<null>');
  });

  it('returns nothing when the hand-off file is empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-empty-'));
    const cwdFile = path.join(dir, 'cwd.txt');
    fs.writeFileSync(cwdFile, '', 'utf8');
    expect(resolvePaneCwd(cwdFile)).toBe('<null>');
  });

  it('returns nothing when the hand-off file is whitespace only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-ws-'));
    const cwdFile = path.join(dir, 'cwd.txt');
    fs.writeFileSync(cwdFile, '   \n', 'utf8');
    expect(resolvePaneCwd(cwdFile)).toBe('<null>');
  });

  it('returns nothing when the named path no longer exists (deleted since the write)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-stale-'));
    const cwdFile = path.join(dir, 'cwd.txt');
    const goneDir = path.join(dir, 'gone');
    fs.mkdirSync(goneDir);
    fs.writeFileSync(cwdFile, goneDir, 'utf8');
    fs.rmdirSync(goneDir);
    expect(resolvePaneCwd(cwdFile)).toBe('<null>');
  });

  it('returns nothing when no cwd file was ever configured', () => {
    expect(resolvePaneCwd(null)).toBe('<null>');
  });
});

/**
 * Run `Invoke-WmuxPrTick` in a real host with a stubbed `-Send`, so the
 * send-succeeded/send-failed branches can be driven without a live pipe. The
 * stub records whether it ran (and with what) by writing to a marker file —
 * PowerShell script blocks passed through `Start-Job`-adjacent plumbing can't
 * hand a value back to the Node test process any other way.
 */
function invokeTick(args: {
  message: string;
  currentlyReported: boolean;
  sendSucceeds: boolean;
}): { reported: boolean; sendCalledWith: string | null } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-tick-'));
  const marker = path.join(dir, 'sent.txt').replace(/\\/g, '\\\\');
  const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const script = [
    extractFunction('Invoke-WmuxPrTick'),
    '',
    `$send = { param($m) Set-Content -LiteralPath '${marker}' -Value $m -Encoding UTF8; $${args.sendSucceeds} }`,
    `$r = Invoke-WmuxPrTick -Message ${ps(args.message)} -CurrentlyReported $${args.currentlyReported} -Send $send`,
    '"reported=$r"',
    '',
  ].join('\n');
  const file = path.join(dir, 'probe.ps1');
  fs.writeFileSync(file, script, 'utf8');
  try {
    const out = execFileSync(host as string, ['-NoProfile', '-NonInteractive', '-File', file], {
      encoding: 'utf8',
    }).trim();
    const markerPath = path.join(dir, 'sent.txt');
    const sendCalledWith = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : null;
    return { reported: out === 'reported=True', sendCalledWith };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!host)('Invoke-WmuxPrTick — the flag only advances on a send that landed', () => {
  it('flips reported to true after a report_pr send that succeeds', () => {
    const { reported, sendCalledWith } = invokeTick({
      message: 'report_pr surf-1 5 OPEN t',
      currentlyReported: false,
      sendSucceeds: true,
    });
    expect(sendCalledWith).toBe('report_pr surf-1 5 OPEN t');
    expect(reported).toBe(true);
  });

  it('flips reported to false after a clear_pr send that succeeds', () => {
    const { reported } = invokeTick({
      message: 'clear_pr surf-1',
      currentlyReported: true,
      sendSucceeds: true,
    });
    expect(reported).toBe(false);
  });

  // This is defect 1: the old job set `$reported = $msg.StartsWith("report_pr")`
  // BEFORE attempting the send, so a clear that failed to go out still made the
  // pane believe it had nothing left to retract, and no later tick would ever
  // try that clear again. The flag must stay put on a failed send so the next
  // tick computes the same clear_pr and retries it.
  it('leaves reported=true alone when a clear_pr send fails, so the clear is retried', () => {
    const { reported, sendCalledWith } = invokeTick({
      message: 'clear_pr surf-1',
      currentlyReported: true,
      sendSucceeds: false,
    });
    expect(sendCalledWith).toBe('clear_pr surf-1'); // the send was attempted
    expect(reported).toBe(true); // but the flag didn't move, so it'll retry
  });

  it('leaves reported=false alone when a report_pr send fails, so the report is retried', () => {
    const { reported } = invokeTick({
      message: 'report_pr surf-1 5 OPEN t',
      currentlyReported: false,
      sendSucceeds: false,
    });
    expect(reported).toBe(false);
  });

  it('never calls Send when the tick has nothing to say, and leaves the flag untouched', () => {
    const { reported, sendCalledWith } = invokeTick({
      message: '',
      currentlyReported: true,
      sendSucceeds: true,
    });
    expect(sendCalledWith).toBeNull();
    expect(reported).toBe(true);
  });
});

/**
 * Run `Invoke-WmuxExitCleanup` in a real host, so the shell's own way out can
 * be exercised without a real process exit.
 */
function invokeExitCleanup(cwdFile: string | null): { cwdFileRemoved: boolean } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-exit-'));
  const ps = (v: string | null) => (v === null ? '$null' : `'${v.replace(/'/g, "''")}'`);
  const script = [extractFunction('Invoke-WmuxExitCleanup'), '', `Invoke-WmuxExitCleanup -CwdFile ${ps(cwdFile)}`, ''].join('\n');
  const file = path.join(dir, 'probe.ps1');
  fs.writeFileSync(file, script, 'utf8');
  try {
    execFileSync(host as string, ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8' });
    return { cwdFileRemoved: cwdFile ? !fs.existsSync(cwdFile) : true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The shell's exit handler owes exactly one thing: its own hand-off file. The
// badge is dropped from the renderer's `pty:exit` handler instead, which sees
// a shell that was killed just as well as one that left on its own.
describe.skipIf(!host)('Invoke-WmuxExitCleanup — what a shell owes on the way out', () => {
  it('removes the cwd hand-off file when one was configured', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-exit-cwd-'));
    const cwdFile = path.join(dir, 'cwd.txt');
    fs.writeFileSync(cwdFile, dir, 'utf8');
    try {
      expect(invokeExitCleanup(cwdFile).cwdFileRemoved).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing, quietly, when the pane has no hand-off file', () => {
    expect(() => invokeExitCleanup(null)).not.toThrow();
  });

  it('does not throw when the file is already gone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-exit-missing-'));
    const cwdFile = path.join(dir, 'never-written.txt');
    try {
      expect(invokeExitCleanup(cwdFile).cwdFileRemoved).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Drive `Remove-StaleWmuxCwdFiles` over a real directory in a real host.
 * Returns the file names still standing afterwards.
 */
function pruneCwdFiles(dir: string, olderThanDays: number): string[] {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-prune-'));
  const script = [
    extractFunction('Remove-StaleWmuxCwdFiles'),
    '',
    `Remove-StaleWmuxCwdFiles -Directory '${dir.replace(/'/g, "''")}' -OlderThan (Get-Date).AddDays(-${olderThanDays})`,
    '',
  ].join('\n');
  const file = path.join(probeDir, 'probe.ps1');
  fs.writeFileSync(file, script, 'utf8');
  try {
    execFileSync(host as string, ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8' });
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

// A pane that is killed rather than closed runs no exit handler, so nothing
// removes its hand-off file — without a sweep the directory grows one small
// file per pane for the life of the machine.
describe.skipIf(!host)('Remove-StaleWmuxCwdFiles — the sweep for panes that were killed', () => {
  const age = (file: string, days: number) => {
    const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, when, when);
  };

  it('drops a hand-off file nothing has touched for longer than the cutoff', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-stale-'));
    try {
      const stale = path.join(dir, 'cwd-surf-old.txt');
      fs.writeFileSync(stale, dir, 'utf8');
      age(stale, 3);
      expect(pruneCwdFiles(dir, 1)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a live pane alone — its file is rewritten on every prompt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-live-'));
    try {
      const live = path.join(dir, 'cwd-surf-live.txt');
      const stale = path.join(dir, 'cwd-surf-dead.txt');
      fs.writeFileSync(live, dir, 'utf8');
      fs.writeFileSync(stale, dir, 'utf8');
      age(stale, 3);
      expect(pruneCwdFiles(dir, 1)).toEqual(['cwd-surf-live.txt']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('touches nothing else in the directory, however old', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-other-'));
    try {
      const other = path.join(dir, 'screenshot-1.png');
      fs.writeFileSync(other, 'x', 'utf8');
      age(other, 30);
      expect(pruneCwdFiles(dir, 1)).toEqual(['screenshot-1.png']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says nothing about a directory that does not exist', () => {
    const dir = path.join(os.tmpdir(), 'wmux-absent-dir-that-was-never-made');
    expect(() => pruneCwdFiles(dir, 1)).not.toThrow();
  });
});

describe.skipIf(!host)('the poller job', () => {
  it('can call Get-WmuxPrMessage inside the job runspace', () => {
    // A job is a separate runspace and inherits none of the session's
    // functions, so the tick's decision function is handed over as the job's
    // initialization script. If that hand-off ever stopped working the tick
    // would throw on every pass and clear the badge forever — the same symptom
    // as the bug, from the other direction.
    const initLine = source.split('\n').find((l) => l.includes('[scriptblock]::Create('));
    expect(initLine, 'no initialization script built for the job').toBeTruthy();

    const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-job-')), 'job.ps1');
    fs.writeFileSync(
      probe,
      [
        extractFunction('Get-WmuxPrMessage'),
        '',
        (initLine as string).trim(),
        '$j = Start-Job -InitializationScript $_wmux_pr_init -ScriptBlock {',
        "  Get-WmuxPrMessage -SurfaceId 'surf-1' -PrJson '{\"number\":450,\"state\":\"MERGED\",\"title\":\"t\"}' " +
          '-ExitCode 0 -InRepo $true -Reported $false',
        '}',
        '$null = Wait-Job $j -Timeout 30',
        'Receive-Job $j',
        'Remove-Job $j -Force',
        '',
      ].join('\n'),
      'utf8',
    );
    try {
      const out = execFileSync(host as string, ['-NoProfile', '-NonInteractive', '-File', probe], {
        encoding: 'utf8',
      }).trim();
      expect(out).toBe('report_pr surf-1 450 MERGED t');
    } finally {
      fs.rmSync(path.dirname(probe), { recursive: true, force: true });
    }
  });

  it('can call Resolve-WmuxPaneCwd and Invoke-WmuxPrTick inside the job runspace', () => {
    // Same hand-off mechanism as above, for the two functions added to fix
    // defects #1 and #2 — if either were left out of the initialization
    // script the job would throw the moment it tried to call them.
    const initLine = source.split('\n').find((l) => l.includes('[scriptblock]::Create('));
    expect(initLine, 'no initialization script built for the job').toBeTruthy();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-job2-'));
    const cwdFile = path.join(dir, 'cwd.txt');
    fs.writeFileSync(cwdFile, dir, 'utf8');
    const probe = path.join(dir, 'job.ps1');
    fs.writeFileSync(
      probe,
      [
        extractFunction('Get-WmuxPrMessage'),
        extractFunction('Resolve-WmuxPaneCwd'),
        extractFunction('Invoke-WmuxPrTick'),
        '',
        (initLine as string).trim(),
        `$cwdFile = '${cwdFile.replace(/'/g, "''")}'`,
        '$j = Start-Job -InitializationScript $_wmux_pr_init -ScriptBlock {',
        '  param($cwdFile)',
        '  $resolved = Resolve-WmuxPaneCwd -CwdFile $cwdFile',
        "  $sent = Invoke-WmuxPrTick -Message 'clear_pr surf-1' -CurrentlyReported $true -Send { param($m) $false }",
        '  "resolved=$resolved sent=$sent"',
        '} -ArgumentList $cwdFile',
        '$null = Wait-Job $j -Timeout 30',
        'Receive-Job $j',
        'Remove-Job $j -Force',
        '',
      ].join('\n'),
      'utf8',
    );
    try {
      const out = execFileSync(host as string, ['-NoProfile', '-NonInteractive', '-File', probe], {
        encoding: 'utf8',
      }).trim();
      // Resolve-WmuxPaneCwd found the real dir; Invoke-WmuxPrTick kept the
      // flag true because the stubbed send returned $false (the retry path).
      expect(out).toBe(`resolved=${dir} sent=True`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PR poller wiring', () => {
  it('sends whatever the tick decided, not only the success case', () => {
    const job = pollerJobBlock();
    expect(job).toContain('Get-WmuxPrMessage');
    // The old shape: a lone `if` around the send, with no else.
    expect(job).not.toMatch(/if\s*\(\s*\$LASTEXITCODE\s*-eq\s*0\s*-and\s*\$prJson\s*\)/);
  });

  it('re-reads the pane cwd on every tick instead of trusting Start-Job', () => {
    const job = pollerJobBlock();
    expect(job).toContain('Set-Location');
  });

  it('asks whether the pane is in a repo before deciding anything', () => {
    // Distinguishes "on a branch with no PR" (the pane's own claim to retract)
    // from "not looking at a repo at all" (nothing to say about the badge).
    expect(pollerJobBlock()).toMatch(/git\s+rev-parse/);
  });

  it('remembers whether it was the one that reported', () => {
    const job = pollerJobBlock();
    expect(job).toContain('-Reported');
  });

  it('touches the hand-off file each tick, so a live pane is never swept', () => {
    // The sweep reads age as "is anyone still here", and the prompt is the
    // only other writer — so a pane parked at an idle prompt for a day would
    // otherwise have its own file deleted by the next shell to start, and
    // stop being polled until someone typed in it.
    expect(pollerJobBlock()).toMatch(/LastWriteTime\s*=\s*Get-Date/);
  });

  it('routes the send through Invoke-WmuxPrTick instead of flipping the flag inline', () => {
    // The bug this guards: `$reported = $msg.StartsWith("report_pr")` executed
    // BEFORE the pipe write, so a failed send still lost the pane's memory of
    // having reported. Send-then-flip has to happen in one place the tests can
    // drive with a stubbed send (see the Invoke-WmuxPrTick describe block
    // below) rather than inline in the job where only a live pipe reaches it.
    const job = pollerJobBlock();
    expect(job).toContain('Invoke-WmuxPrTick');
    expect(job).not.toMatch(/\$reported\s*=\s*\$msg\.StartsWith/);
  });

  it('treats an unresolvable cwd as no information, not as "stay put"', () => {
    // The old shape skipped Set-Location on a bad hand-off and fell through to
    // probing git/gh from wherever the job runspace last was — reporting a
    // stale repo's PR as if it were current. Resolve-WmuxPaneCwd centralizes
    // "can we even tell where the pane is" so the job can skip the probe
    // entirely rather than guess.
    const job = pollerJobBlock();
    expect(job).toContain('Resolve-WmuxPaneCwd');
  });

  it('keeps the cwd hand-off in the temp directory the integrations already use', () => {
    // wmux-bash-integration.sh writes under <temp>\wmux; sharing it keeps this
    // from becoming a second scratch location, and makes the leftovers easy to
    // find if the exit handler ever misses one.
    expect(source).toMatch(/Join-Path \(\[System\.IO\.Path\]::GetTempPath\(\)\) "wmux"/);
    expect(source).toContain('PSEngineEvent]::Exiting');
  });

  it('publishes the pane cwd from the prompt, which is where it is known', () => {
    // The job is a separate process: an env var set after it started is
    // invisible to it, so the live location has to be handed over out-of-band.
    expect(source).toContain('Update-WmuxCwdFile');
    const prompt = source.slice(source.indexOf('function prompt {'));
    expect(prompt.slice(0, prompt.indexOf('\n}\n'))).toContain('Update-WmuxCwdFile');
  });
});
