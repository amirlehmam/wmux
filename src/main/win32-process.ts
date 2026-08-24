/**
 * win32-process.ts — one way to ask Windows about running processes.
 *
 * Two callers need this and must not disagree about how it is done: the orphan
 * reaper (`pty-ledger.ts`, issue #139) and the ssh probe behind remote file
 * upload (`ssh-detect.ts`). Both had grown their own copy of the same
 * invocation, which is how the security-relevant part — resolving
 * `powershell.exe` by absolute path so a writeable PATH directory cannot shadow
 * it — ended up stated twice.
 *
 * `Get-CimInstance` rather than `wmic`, which is being removed from Windows.
 * The generated command deliberately contains no double quotes, so nothing
 * depends on how `execFile` escapes the argument.
 */

import { execFile } from 'child_process';
import { powershellPath } from './system32';

export interface Win32ProcessQuery {
  /**
   * PowerShell expressions evaluated per process, emitted in order and joined
   * by `|`. Expressions rather than plain property names because the callers
   * need computed columns — an epoch from `CreationDate`, a `CommandLine` with
   * its newlines flattened so one process stays on one line.
   */
  fields: string[];
  /** WQL `-Filter`, or omitted to enumerate every process. */
  filter?: string;
  timeoutMs: number;
  /** Raise for queries that enumerate everything; the default suits a few rows. */
  maxBuffer?: number;
  /**
   * Called with a human-readable cause when the query fails. Failure always
   * yields no rows — never a throw — because both callers treat "found nothing"
   * as the safe answer.
   */
  onFailure?: (cause: string) => void;
}

/**
 * Raw stdout, one `field1|field2|…` row per line. Empty string on any failure.
 *
 * Deliberately not pre-split: both callers already own a line parser that
 * splits and trims, so returning an array only bought a join and a second
 * split — three passes over a ~250KB payload where one will do.
 */
export function queryWin32Processes(query: Win32ProcessQuery): Promise<string> {
  const format = query.fields.map((_, i) => `{${i}}`).join('|');
  const filter = query.filter ? ` -Filter '${query.filter}'` : '';
  const script =
    `Get-CimInstance Win32_Process${filter} | ForEach-Object { ` +
    `Write-Output ('${format}' -f ${query.fields.join(',')}) }`;

  return new Promise((resolve) => {
    execFile(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: query.timeoutMs, maxBuffer: query.maxBuffer },
      (err, stdout, stderr) => {
        if (err) {
          const cause = (err as NodeJS.ErrnoException & { killed?: boolean }).killed
            ? `timed out after ${query.timeoutMs}ms`
            : (stderr || '').trim() || err.message;
          query.onFailure?.(cause);
          resolve('');
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}
