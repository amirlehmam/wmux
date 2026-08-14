import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDiagnosticsPath, logDiagnostic } from '../../src/main/crash-diagnostics';

/**
 * Issue #150. The main process has been dying with the same uncaught
 * `Napi::Error` from conpty.node since 0.10, and the question the investigation
 * finally turned on — "was the crash guard actually installed in the process
 * that died?" — could not be answered by anyone, because wmux wrote no log at
 * all. The guard reported through `console.warn`, which in a packaged Electron
 * build goes nowhere anybody can read afterwards.
 *
 * These pin the properties that make the file worth having: it lands somewhere
 * findable, it records the facts a crash report needs, it cannot grow without
 * bound, and — most importantly — it cannot itself throw. A diagnostic that
 * fails a launch or breaks a shutdown handler is strictly worse than the bug it
 * was added to investigate.
 */
describe('crash diagnostics (issue #150)', () => {
  let home: string;
  let saved: { APPDATA?: string; USERPROFILE?: string; HOME?: string };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-diag-'));
    saved = { APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    process.env.APPDATA = home;
    process.env.USERPROFILE = home;
    process.env.HOME = home;
  });

  afterEach(() => {
    for (const k of ['APPDATA', 'USERPROFILE', 'HOME'] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  const read = () => fs.readFileSync(getDiagnosticsPath(), 'utf8');

  it('writes inside wmux\'s own data directory', () => {
    // Never outside it: anything else would belong behind the #132 consent
    // gate, and a crash log is not worth asking for permission to write.
    expect(getDiagnosticsPath().startsWith(home)).toBe(true);
    expect(getDiagnosticsPath().endsWith(path.join('logs', 'main.log'))).toBe(true);
  });

  it('creates the directory it needs and records the event', () => {
    logDiagnostic('start', { version: '1.1.1', guard: true });
    const line = read().trim();
    expect(line).toContain('start');
    expect(line).toContain('version=1.1.1');
    expect(line).toContain('guard=true');
    expect(line).toContain(`pid=${process.pid}`);
  });

  it('timestamps every line, so a crash can be correlated with the Event Log', () => {
    // The whole point is lining this up against a "Faulting application" entry
    // whose only fixed reference is a wall-clock time.
    logDiagnostic('will-quit');
    expect(read()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
  });

  it('appends rather than replacing, so the run has a sequence', () => {
    logDiagnostic('start', { guard: true });
    logDiagnostic('session-end', { ptys: 4 });
    logDiagnostic('will-quit', { ptys: 0 });
    const lines = read().trim().split('\n');
    expect(lines).toHaveLength(3);
    // Ordering is the evidence: "session-end saw 4 PTYs, will-quit saw 0" is
    // the observation that says the early kill actually ran.
    expect(lines[1]).toContain('ptys=4');
    expect(lines[2]).toContain('ptys=0');
  });

  it('caps the file instead of growing forever', () => {
    fs.mkdirSync(path.dirname(getDiagnosticsPath()), { recursive: true });
    fs.writeFileSync(getDiagnosticsPath(), 'x'.repeat(300 * 1024));
    logDiagnostic('start');
    // Truncated, then the new line written — the current run is the one that
    // matters, and a diagnostic that fills a disk is worse than none.
    expect(fs.statSync(getDiagnosticsPath()).size).toBeLessThan(1024);
    expect(read()).toContain('start');
  });

  it('never throws, whatever the filesystem does', () => {
    // Called from a shutdown handler and from first-line startup. Throwing
    // there would turn a diagnostic into an outage.
    process.env.APPDATA = '\0:/definitely/not/writable';
    expect(() => logDiagnostic('start', { guard: false })).not.toThrow();
  });

  it('survives values that are not strings', () => {
    expect(() => logDiagnostic('start', {
      a: undefined, b: null, c: 0, d: false, e: { nested: 1 },
    })).not.toThrow();
    expect(read()).toContain('d=false');
  });
});
