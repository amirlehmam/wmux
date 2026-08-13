import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  POWERSHELL_HOSTS,
  SHIM_PROBE_MARKER,
  probePowerShellShim,
  type ProbeOutcome,
  type ShimProbeDeps,
} from '../../src/main/powershell-shim';

/**
 * PowerShell callers lost their argument quoting through wmux.cmd (issue #154):
 * PowerShell strips the quotes when invoking a batch file, cmd.exe re-reads the
 * bare `>` / `|` / `&` as shell syntax, and `wmux browser eval
 * "document.title.length>0"` silently redirected its own output into a file
 * named `0` — exit 0, no output, a junk file, and `wmux send` transmitting text
 * the user never wrote.
 *
 * The redirect is applied to cmd.exe's invocation line before wmux.cmd starts,
 * which is why the fix is a .ps1 (PowerShell prefers it over every PATHEXT
 * entry and splats @args natively) and not more careful batch quoting.
 *
 * A .ps1 PowerShell refuses to run is a hard error with no fallback to the .cmd
 * beside it, so the shim only goes on PATH once a probe from its own directory
 * has actually run. These tests pin that gate, and — where a PowerShell host
 * exists — that the shim really does deliver the reported argument intact.
 */

const SHIM_DIR = path.join(__dirname, '..', '..', 'src', 'cli-bin-ps');

const deps = (
  outcomes: Record<string, ProbeOutcome>,
  hosts: string[] = POWERSHELL_HOSTS,
): ShimProbeDeps => ({
  hosts,
  run: async (exe) => outcomes[exe] ?? { status: 'missing' },
});

const ran = (stdout: string): ProbeOutcome => ({ status: 'ran', stdout });

describe('PowerShell shim gate (issue #154)', () => {
  it('enables the shim when every installed host runs the probe', async () => {
    const ok = await probePowerShellShim(SHIM_DIR, deps({
      'powershell.exe': ran(`${SHIM_PROBE_MARKER}\n`),
      'pwsh.exe': ran(`${SHIM_PROBE_MARKER}\n`),
    }));
    expect(ok).toBe(true);
  });

  it('enables it when the only installed host runs it', async () => {
    // pwsh-only machines are common; an absent host cannot be broken by a shim
    // it never resolves.
    const ok = await probePowerShellShim(SHIM_DIR, deps({ 'pwsh.exe': ran(SHIM_PROBE_MARKER) }));
    expect(ok).toBe(true);
  });

  it('refuses when ANY installed host blocks scripts', async () => {
    // Restricted is the Windows PowerShell 5.1 default, and a user's panes and
    // their children do not all run the same host. One refusal is one place
    // `wmux` would stop working entirely — worse than the quoting bug.
    const ok = await probePowerShellShim(SHIM_DIR, deps({
      'powershell.exe': ran(''),
      'pwsh.exe': ran(`${SHIM_PROBE_MARKER}\n`),
    }));
    expect(ok).toBe(false);
  });

  it('refuses when no host could be probed at all', async () => {
    // Unverified is not the same as unused: PATH is where the risk lives.
    expect(await probePowerShellShim(SHIM_DIR, deps({}))).toBe(false);
  });

  it('refuses on output that is not the marker (a profile banner, an error)', async () => {
    const ok = await probePowerShellShim(SHIM_DIR, deps({
      'pwsh.exe': ran('cannot be loaded because running scripts is disabled'),
    }));
    expect(ok).toBe(false);
  });

  it('ships the probe script the gate executes, next to the shim it vouches for', () => {
    // Same directory and same origin, or the probe stops being representative
    // of the file it is clearing.
    expect(fs.existsSync(path.join(SHIM_DIR, 'wmux.ps1'))).toBe(true);
    expect(fs.readFileSync(path.join(SHIM_DIR, 'wmux-shim-probe.ps1'), 'utf-8'))
      .toContain(SHIM_PROBE_MARKER);
  });

  it('passes arguments through natively instead of re-exposing them to a shell', () => {
    const shim = fs.readFileSync(path.join(SHIM_DIR, 'wmux.ps1'), 'utf-8');
    expect(shim).toContain('@args');
    expect(shim).toMatch(/\$env:WMUX_CLI/);
  });
});

/**
 * The reported repro, end to end: does `>` inside a free-form argument survive?
 *
 * Skipped where no PowerShell exists (CI on Linux). Where one does, this is the
 * assertion that would have caught the bug — the unit tests above only pin the
 * gate, not the quoting behaviour that motivated it.
 */
const powershell = (() => {
  if (process.platform !== 'win32') return null;
  for (const host of POWERSHELL_HOSTS) {
    try {
      execFileSync(host, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 20000 });
      return host;
    } catch {
      // Not installed, or refuses to start — try the next.
    }
  }
  return null;
})();

describe.skipIf(!powershell)('a shim invoked from PowerShell (issue #154)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-shim-'));
  // Stands in for the CLI: prints argv as JSON, so a mangled argument is visible.
  const echo = path.join(dir, 'echo.js');
  fs.writeFileSync(echo, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  fs.writeFileSync(path.join(dir, 'wmux.cmd'), '@echo off\r\nnode "%WMUX_CLI%" %*\r\n');
  fs.copyFileSync(path.join(SHIM_DIR, 'wmux.ps1'), path.join(dir, 'wmux.ps1'));

  /** Run `wmux <args>` the way a user types it, letting PATH pick the shim. */
  function callThroughPath(args: string[]): string {
    const quoted = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(' ');
    return execFileSync(
      powershell!,
      ['-NoProfile', '-NonInteractive', '-Command', `$env:PATH = '${dir};' + $env:PATH; wmux ${quoted}`],
      {
        encoding: 'utf-8',
        timeout: 30000,
        cwd: dir,
        env: { ...process.env, WMUX_CLI: echo, PSExecutionPolicyPreference: 'Bypass' },
      },
    );
  }

  it('delivers a `>` in free-form text to the CLI instead of redirecting to a file', () => {
    const out = callThroughPath(['browser', 'eval', 'document.title.length>0']);

    expect(JSON.parse(out)).toEqual(['browser', 'eval', 'document.title.length>0']);
    // The bug's signature: cmd.exe created a file named after the redirect target.
    expect(fs.existsSync(path.join(dir, '0'))).toBe(false);
  });

  it('keeps `|` and `&` out of the shell too', () => {
    expect(JSON.parse(callThroughPath(['browser', 'eval', 'a|b']))).toEqual(['browser', 'eval', 'a|b']);
    expect(JSON.parse(callThroughPath(['notify', 'Build & deploy finished'])))
      .toEqual(['notify', 'Build & deploy finished']);
  });
});
