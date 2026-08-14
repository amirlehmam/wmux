/**
 * A small, bounded record of what the main process did, so a crash report can
 * be answered rather than reasoned about (issue #150).
 *
 * ## Why this exists
 *
 * #150 has been open since 0.10: the main process dies with an uncaught
 * `Napi::Error` from `conpty.node`, always the same signature. The reporter has
 * done forensics on nine minidumps, and the question that finally mattered —
 * "was the crash guard actually installed in the process that died?" — could
 * not be answered by either of us, because wmux wrote **no log at all**. The
 * guard reports through `console.warn`, which in a packaged Electron build goes
 * to a console nobody is attached to.
 *
 * That is a bad place to be for a crash whose whole remaining question is about
 * process state at a moment nobody was watching. Design claims ("installed at
 * module load") are not observations, and this file is the difference.
 *
 * ## What it deliberately is not
 *
 * Not a logging framework, and not telemetry. Nothing leaves the machine. It
 * writes a handful of lines per run to wmux's OWN data directory — never
 * outside it, so it needs no part of the #132 consent gate — and it is capped,
 * because a diagnostic that fills a disk is worse than no diagnostic.
 *
 * It records process lifecycle only: start, teardown, and the reason for it.
 * No pane contents, no cwds, no command lines, no environment. A user handing
 * this file to a stranger should not be handing over anything else, which is
 * the lesson from the same reporter's decision to withhold their dumps because
 * a minidump carries the environment block in cleartext.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getAppDataDir } from '../shared/instance';

/** Cap for the on-disk log. Small — this is a few lines per run. */
const MAX_BYTES = 256 * 1024;

let warned = false;

export function getDiagnosticsPath(): string {
  return path.join(getAppDataDir(), 'logs', 'main.log');
}

/**
 * Append one line. Best-effort in the strongest sense: a diagnostic that can
 * fail a launch, or throw inside a shutdown handler, is a bug that is strictly
 * worse than the one it was added to investigate.
 */
export function logDiagnostic(event: string, fields: Record<string, unknown> = {}): void {
  try {
    const file = getDiagnosticsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // Truncate rather than rotate: the interesting run is the current one, and
    // a second file is a second thing to explain to whoever reads this.
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.writeFileSync(file, '');
    } catch { /* no file yet */ }

    const parts = Object.entries(fields).map(([k, v]) => `${k}=${String(v)}`);
    fs.appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${event}${parts.length ? ' ' + parts.join(' ') : ''}\n`);
  } catch (err) {
    // Say it once to the console we may or may not have, then stay quiet.
    if (!warned) {
      warned = true;
      console.warn('[wmux] could not write diagnostics log:', err);
    }
  }
}
