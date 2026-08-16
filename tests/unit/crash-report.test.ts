import { describe, it, expect } from 'vitest';
import {
  parseEventRows,
  joinCrashRecords,
  describeWerConfig,
  formatCrashReport,
} from '../../src/cli/wmux';

/**
 * `wmux crash-report` (issue #174).
 *
 * The command exists because "wmux crashed, here's a dump" is a request
 * maintainers make casually and users answer casually, and on Windows a
 * minidump carries the process environment block — which for this project's
 * users is where the credentials live. The reporter who raised it found live
 * keys in all eight dumps they checked, eleven in the worst.
 *
 * A warning alone would have left the dump as the path of least resistance.
 * This makes the safe answer the easy one, so what it must be tested for is
 * exactly that: that the output is worth sending, and that it carries nothing
 * it should not.
 */

const REPORT_ID = '2920533c-0171-4a9e-8303-c23fe6832b6e';
const OFFSET = '0000000003290be5';
const HOME_PATH = 'C:\\Users\\a.real.name\\AppData\\Local\\Programs\\wmux\\wmux.exe';
/** Windows records the PE file version, which is four-part. */
const EXE_VERSION = [1, 1, 0, 0].join('.');

const appError = (reportId = REPORT_ID) =>
  ['AE', '2026-08-14T13:15:11.000Z', 'wmux.exe', EXE_VERSION, 'wmux.exe', 'c0000409', OFFSET, reportId].join('\t');
const werReport = (reportId = REPORT_ID) =>
  ['WER', '2026-08-14T13:15:12.000Z', 'BEX64', '0000000000000007', reportId].join('\t');

describe('parseEventRows', () => {
  it('joins the two records Windows writes for one crash', () => {
    // Application Error has the offset; only Windows Error Reporting has the
    // additional parameter — the field that says 0xc0000409 was a deliberate
    // __fastfail(7) and not memory corruption. #150 turns on that distinction,
    // so a report carrying one record without the other answers nothing.
    const [event] = parseEventRows(`${appError()}\n${werReport()}`);

    expect(event.exceptionCode).toBe('0xc0000409');
    expect(event.faultOffset).toBe(`0x${OFFSET}`);
    expect(event.additionalParameter).toBe('0x0000000000000007 (BEX64)');
    expect(event.version).toBe(EXE_VERSION);
  });

  it('joins on the report id rather than on timestamp proximity', () => {
    // The two records are written seconds apart, and a busy machine can
    // interleave crashes of different programs between them.
    const rows = [appError('aaaa-1'), appError('bbbb-2'), werReport('bbbb-2')].join('\n');
    const events = parseEventRows(rows);

    expect(events[0].additionalParameter).toBe('(no Windows Error Reporting record)');
    expect(events[1].additionalParameter).toBe('0x0000000000000007 (BEX64)');
  });

  it('matches report ids case-insensitively', () => {
    const [event] = parseEventRows(`${appError(REPORT_ID.toUpperCase())}\n${werReport(REPORT_ID)}`);
    expect(event.additionalParameter).toContain('BEX64');
  });

  it('says so when there is no Windows Error Reporting record', () => {
    // Rather than printing an empty field that reads like a parse failure.
    const [event] = parseEventRows(appError());
    expect(event.additionalParameter).toBe('(no Windows Error Reporting record)');
  });

  it('ignores rows that are not crash records', () => {
    // PowerShell writes warnings and blank lines into the same stream.
    const events = parseEventRows(`\nGet-WinEvent : No events were found.\n${appError()}\n\n`);
    expect(events).toHaveLength(1);
  });

  it('ignores a truncated row instead of emitting undefined fields', () => {
    expect(parseEventRows('AE\t2026-08-14T13:15:11.000Z\twmux.exe')).toHaveLength(0);
  });
});

describe('joinCrashRecords', () => {
  it('labels a field Windows did not record rather than leaving it blank', () => {
    const [event] = joinCrashRecords(
      [{ time: 't', version: '', faultingModule: '', exceptionCode: '', faultOffset: '', reportId: 'x' }],
      [],
    );
    expect(event.version).toBe('(not recorded)');
    expect(event.faultingModule).toBe('(not recorded)');
  });
});

describe('describeWerConfig', () => {
  it('says nothing when local dumps are not enabled', () => {
    expect(describeWerConfig({ configured: false })).toEqual([]);
  });

  it('warns loudest about a full-memory dump', () => {
    // DumpType=2 adds the heap to the environment block. The reporter turned
    // this on at the maintainer's suggestion, then found all eleven of their
    // credentials in the resulting 664 MB file.
    const lines = describeWerConfig({ configured: true, dumpType: '2', folder: 'C:\\dumps' }).join('\n');

    expect(lines).toContain('full memory');
    expect(lines).toContain('process heap');
    expect(lines).toContain('environment block');
    expect(lines).toContain('C:\\dumps');
  });

  it('still warns for a minidump, which also carries the environment block', () => {
    const lines = describeWerConfig({ configured: true, dumpType: '1' }).join('\n');

    expect(lines).toContain('minidump');
    expect(lines).toContain('environment block');
    expect(lines).not.toContain('process heap');
  });
});

describe('formatCrashReport', () => {
  const base = {
    events: parseEventRows(`${appError()}\n${werReport()}`),
    diagnostics: ['2026-08-14T21:15:06.312Z pid=24312 start version=1.1.1 electron=43.0.0 guard=true'],
    wer: { configured: false } as const,
    platform: 'win32',
    osVersion: '10.0.26200',
  };

  it('tells the reader not to send a dump', () => {
    // The point of the whole command. If this line goes missing, the output is
    // just a convenience and the issue is not addressed.
    const report = formatCrashReport(base);
    expect(report).toContain('Do NOT attach a crash dump');
    expect(report).toContain('docs/crash-reports.md');
  });

  it('carries the fingerprint a maintainer needs to tell same-signature from new', () => {
    const report = formatCrashReport(base);
    expect(report).toContain('0xc0000409');
    expect(report).toContain(`0x${OFFSET}`);
    expect(report).toContain('0x0000000000000007');
  });

  it('reports the version of the wmux that ran, taken from its own log', () => {
    // Not from a package.json next to the CLI: mid-upgrade those differ, and
    // the crash belongs to the build that was running.
    expect(formatCrashReport(base)).toContain('wmux version: 1.1.1');
  });

  it('uses the most recent start line when the log spans several runs', () => {
    const report = formatCrashReport({
      ...base,
      diagnostics: [
        '2026-08-14T21:15:06.312Z pid=1 start version=1.1.0 guard=true',
        '2026-08-14T21:15:11.004Z pid=1 session-end ptys=6 guard=true',
        '2026-08-15T09:00:00.000Z pid=2 start version=1.1.1 guard=true',
      ],
    });
    expect(report).toContain('wmux version: 1.1.1');
    expect(report).not.toContain('wmux version: 1.1.0');
  });

  it('admits it does not know the version rather than guessing', () => {
    expect(formatCrashReport({ ...base, diagnostics: [] })).toContain('unknown (no log)');
  });

  it('contains no filesystem path from the crash record', () => {
    // The guarantee that makes this safe to paste. Application Error carries
    // the full path of the faulting executable, which holds the Windows
    // username — a real name on most work machines. We never read that
    // property, and this is the test that keeps it that way.
    const report = formatCrashReport(base);
    expect(report).not.toContain(HOME_PATH);
    expect(report).not.toMatch(/C:\\Users\\/);
  });

  it('explains where to look by hand when the log has aged out', () => {
    // A user whose crash is older than the Application log's retention gets a
    // route to the same four fields rather than an empty section.
    const report = formatCrashReport({ ...base, events: [] });
    expect(report).toContain('Event Viewer');
    expect(report).toContain('Application Error');
  });

  it('says the Event Log section does not apply off Windows', () => {
    const report = formatCrashReport({ ...base, events: [], platform: 'linux', osVersion: '6.1.0' });
    expect(report).toContain('not Windows');
  });

  it('appends the local-dump warning when this machine is configured for one', () => {
    const report = formatCrashReport({ ...base, wer: { configured: true, dumpType: '2' } });
    expect(report).toContain('Local crash dumps are ENABLED');
  });
});
