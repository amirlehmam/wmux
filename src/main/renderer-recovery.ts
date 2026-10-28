// Getting a stuck window back without losing a terminal (issue #289).
//
// The reporter's second instance froze: the window still dragged (that is the
// OS), clicks did nothing, `wmux ping` answered (main was fine), and every pipe
// request that needed the renderer timed out. The renderer sat at 0% CPU with
// every thread waiting — blocked, not busy — and the only way out wmux offered
// was killing it, which kills every pane.
//
// It did not have to. Every PTY lives in MAIN, keyed by surface id, and a
// reloaded window asks `session:load-auto` for its own slot — the state its
// renderer last pushed — so it comes back with the same surface ids and each
// pane re-attaches to its still-running shell through `pty.has`. A reload is
// therefore the recovery, and the only thing it can lose is whatever changed in
// the renderer since its last auto-save.
//
// Chromium already detects the hang: `BrowserWindow 'unresponsive'` fires when
// the renderer stops acknowledging input. Offered, never automatic — a renderer
// can be legitimately slow (a 100k-line paste, a huge markdown file) and a
// reload the user did not ask for is its own kind of data loss. "Wait" is the
// default button for the reason close-guard.ts gives: a stray Enter must not
// confirm. If the window recovers by itself, `'responsive'` takes the question
// back down.
//
// A renderer that is GONE (crashed, OOM-killed) leaves a blank window behind;
// that gets the same offer, minus the waiting — on any `render-process-gone`
// that is not a clean exit.
//
// This file is the copy and the decisions; `WindowManager.watchRendererHealth`
// (window-manager.ts) asks the question. `'responsive'` aborts the dialog via
// its `signal`. A hung renderer is `forcefullyCrashRenderer()`d before
// `reload()`, since it may never run the navigation it is asked for, and a
// `reloading` flag stops that kill's own `render-process-gone` from asking a
// second time.

export type RendererTrouble = 'unresponsive' | 'gone';

export interface RecoveryCopy {
  message: string;
  detail: string;
  buttons: [string, string];
}

export function rendererRecoveryCopy(kind: RendererTrouble): RecoveryCopy {
  if (kind === 'gone') {
    return {
      message: 'The wmux window stopped working.',
      detail: 'Your terminals are still running. Reload the window to get them back.',
      buttons: ['Reload window', 'Close'],
    };
  }
  return {
    message: 'The wmux window is not responding.',
    detail: 'Your terminals are still running. Reloading the window reconnects to them; '
      + 'only changes made in the last few seconds may be lost.',
    buttons: ['Reload window', 'Wait'],
  };
}

/** `render-process-gone` reasons that are not a failure: nothing to recover. */
export function isRecoverableGone(reason: string): boolean {
  return reason !== 'clean-exit';
}
