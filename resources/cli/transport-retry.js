"use strict";
/**
 * The shared retry policy for idempotent wmux pipe requests.
 *
 * A busy wmux answers `All pipe instances are busy` on the native named pipe,
 * and on WSL npiperelay exits before it attaches. Restoring a workspace starts
 * many panes at once, so a session/status report can lose that race through no
 * fault of its own. Retrying is safe only for requests that can be asked twice
 * (reports, releases, prompt admission); a spawn or a typed key must not be
 * duplicated, so callers opt in rather than every sendV2 retrying.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WmuxBusyError = void 0;
exports.isTransientWmuxError = isTransientWmuxError;
exports.retryTransient = retryTransient;
/** wmux is there but did not answer in time, or dropped the connection. */
class WmuxBusyError extends Error {
}
exports.WmuxBusyError = WmuxBusyError;
function isTransientWmuxError(error) {
    if (error instanceof WmuxBusyError)
        return true;
    const code = error?.code;
    if (code === 'EBUSY' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT')
        return true;
    // npiperelay reports the native pipe error on stderr and exits non-zero; the
    // CLI now folds that text into the error message.
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /All pipe instances are busy|pipe busy|timed out/i.test(message);
}
/**
 * Ask again while wmux is merely busy. The caller supplies the idempotent
 * attempt; the timeout grows so a genuinely slow wmux gets more room on each
 * try, and the budget stops a dead wmux from holding a hook process forever.
 */
async function retryTransient(attempt, patience, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    const deadline = now() + patience.budgetMs;
    let attemptMs = patience.firstAttemptMs;
    for (let tries = 0;; tries++) {
        try {
            return await attempt(Math.max(1, Math.min(attemptMs, deadline - now())));
        }
        catch (error) {
            const pause = Math.min(250 * (tries + 1), 1000);
            if (!isTransientWmuxError(error) || now() + pause >= deadline)
                throw error;
            if (tries === 0)
                patience.onWait?.();
            await sleep(pause);
            attemptMs *= 2;
        }
    }
}
