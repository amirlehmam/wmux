// A quit that never finishes (issue #289).
//
// The reporter's main.log ended `exit via=app.exit reason=drain-ptys`, and the
// process then lived for SIXTEEN HOURS — no window, no renderer, its GPU,
// network and audio utility processes still running beside it. The next launch
// came up next to it on the same profile (the single-instance lock is released
// early in shutdown, so the new instance never saw it), and that instance's
// window later froze. `app.exit()` had been called; the process just never got
// to the end of its own teardown.
//
// Where it stuck is not knowable from here, and is not the point. Everything
// after `app.exit()` is Chromium and Node unwinding in native code — thread
// joins, a ConPTY close, a DLL detach — and once one of those waits forever, no
// JavaScript in this process runs again: not a timer, not a worker (Node stops
// workers early in environment teardown). The only thing that can still act is
// ANOTHER process.
//
// So every quit arms one, from `will-quit` in ./index: wmux's own executable
// run as plain Node (ELECTRON_RUN_AS_NODE — no window, no second wmux, and a
// GUI-subsystem exe so no console flashes), detached, with a ~20-line inline
// script. It polls the parent's pid every 250 ms and exits the moment the
// parent is gone, which on a healthy quit is well under a second. Only a parent
// that outlives the deadline (`QUIT_TEARDOWN_BUDGET_MS + 15 s`, set by
// ./index) is terminated — and then whatever it was stuck on no longer
// matters. The kill is logged to main.log as `exit-watchdog killed=<pid>`.
// Chromium's child processes exit on their own once their browser process's
// IPC channel breaks.
//
// Deliberately not a .cmd or PowerShell helper: a hidden detached script that
// kills a process is the dropper shape zip-updater.ts goes out of its way to
// avoid. This is the app's own signed-or-not binary running JS it was handed.

import { spawn } from 'child_process';

/** Polling period for "is the parent still alive?". Bounds the window in which
 *  a recycled pid could be mistaken for the parent. */
export const EXIT_WATCHDOG_POLL_MS = 250;

/**
 * The script the watchdog runs. Pure, so its behaviour is testable by
 * evaluating it against a fake `process` rather than by quitting wmux.
 *
 * `process.kill(pid, 0)` throws ESRCH once the parent is gone — that is the
 * exit. Any OTHER error (EPERM) means it exists but cannot be signalled, and
 * the watchdog gives up rather than looping for nothing.
 */
export function exitWatchdogScript(pid: number, deadlineMs: number, logPath: string): string {
  return [
    `const pid = ${JSON.stringify(pid)}, deadline = Date.now() + ${JSON.stringify(deadlineMs)}, logPath = ${JSON.stringify(logPath)};`,
    'const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM" ? null : false; } };',
    'const tick = () => {',
    '  const a = alive();',
    '  if (a !== true) process.exit(0);',
    '  if (Date.now() < deadline) { setTimeout(tick, ' + EXIT_WATCHDOG_POLL_MS + '); return; }',
    '  try { process.kill(pid); } catch (e) {}',
    '  try { require("fs").appendFileSync(logPath, new Date().toISOString() + " pid=" + process.pid + " exit-watchdog killed=" + pid + "\\n"); } catch (e) {}',
    '  process.exit(0);',
    '};',
    'tick();',
  ].join('\n');
}

export interface ExitWatchdogDeps {
  pid: number;
  execPath: string;
  deadlineMs: number;
  logPath: string;
}

let armed = false;

/**
 * Start the watchdog for this process. Once per run — a second quit pass must
 * not spawn a second one. Never throws: a quit must go on whether or not its
 * safety net could be put up.
 */
export function armExitWatchdog(deps: ExitWatchdogDeps): boolean {
  if (armed) return false;
  armed = true;
  try {
    const child = spawn(deps.execPath, ['-e', exitWatchdogScript(deps.pid, deps.deadlineMs, deps.logPath)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.on('error', () => { /* best-effort by construction */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
