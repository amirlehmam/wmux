/**
 * The main-process half of the GPU watchdog (issue #229): the decision, and
 * the one effect — restarting wmux's own GPU process.
 *
 * ## Why main decides
 *
 * The renderer probe (`src/renderer/utils/gpu-watchdog.ts`) can only say "no
 * frame has been produced for 15 s while my document believes it is visible".
 * That is necessary and not sufficient: a document is also "visible" under an
 * always-on-top overlay, on a monitor that has gone to sleep, behind a locked
 * session for a moment, and every one of those is a window nobody is looking
 * at. Main can see the two things that turn the report into a verdict:
 *
 *   - the window is FOCUSED (`BrowserWindow.isFocused`, from WM_ACTIVATE — a
 *     focused window cannot be minimized or fully occluded), and
 *   - the user has touched the machine within the last 30 s
 *     (`powerMonitor.getSystemIdleTime`, the OS's own `GetLastInputInfo`).
 *
 * Together they mean: the user is at the keyboard, wmux is the foreground
 * window, and it has painted nothing for 15 s. That is the reporter's
 * situation exactly, and nothing else. It also means the heal happens the
 * moment the user notices — clicking into a frozen window is precisely what
 * triggers it — rather than at 3 a.m. on a machine nobody is watching.
 *
 * ## Why the restart is safe
 *
 * Every PTY lives in this process; the renderer keeps its DOM, its Zustand
 * store and its xterm buffers; Chromium relaunches a GPU process on demand.
 * The reporter did this by hand (`Stop-Process` on the GPU PID) and lost
 * nothing across seven panes and six nested agents. The WebGL contexts every
 * visible terminal holds are lost, and `terminal-renderer.ts` already handles
 * that (#218): each pane drops to the DOM renderer and repaints, and picks
 * WebGL back up on its next show.
 *
 * ## Why it is rate-limited
 *
 * Chromium counts a killed GPU process as a crash, and after a few in a short
 * window it gives up on hardware acceleration for the rest of the session. A
 * false positive every few minutes would therefore turn a healthy wmux into a
 * software-rendered one with no visible reason. Five minutes between restarts
 * bounds that damage even if every gate above is somehow fooled.
 *
 * Off switch: `"gpuWatchdog": false` in `wmux-workspace-prefs` (settings.json),
 * read at report time like `confirmAppClose` — no restart needed.
 */
import { IPC_CHANNELS } from '../shared/types';
import { logDiagnostic } from './crash-diagnostics';
import { loadSettings } from './settings-store';

export interface GpuRestartConfig {
  /** Minimum time between two restarts. */
  minIntervalMs: number;
  /** The user must have touched the machine this recently. */
  maxIdleSeconds: number;
}

export const GPU_RESTART_DEFAULTS: GpuRestartConfig = {
  minIntervalMs: 5 * 60_000,
  maxIdleSeconds: 30,
};

export interface GpuRestartInput extends GpuRestartConfig {
  now: number;
  enabled: boolean;
  /** From `app.getAppMetrics()`; null when Chromium lists no GPU process. */
  gpuPid: number | null;
  focused: boolean;
  visible: boolean;
  minimized: boolean;
  /** `powerMonitor.getSystemIdleTime()`. */
  idleSeconds: number;
  lastRestartAt: number | null;
}

export type GpuRestartDecision =
  | { action: 'restart'; pid: number }
  | {
      action: 'skip';
      reason: 'disabled' | 'no-gpu-process' | 'hidden' | 'minimized' | 'unfocused' | 'idle' | 'rate-limited';
    };

export function decideGpuRestart(i: GpuRestartInput): GpuRestartDecision {
  if (!i.enabled) return { action: 'skip', reason: 'disabled' };
  if (i.gpuPid === null) return { action: 'skip', reason: 'no-gpu-process' };
  if (!i.visible) return { action: 'skip', reason: 'hidden' };
  if (i.minimized) return { action: 'skip', reason: 'minimized' };
  if (!i.focused) return { action: 'skip', reason: 'unfocused' };
  if (i.idleSeconds > i.maxIdleSeconds) return { action: 'skip', reason: 'idle' };
  if (i.lastRestartAt !== null && i.now - i.lastRestartAt < i.minIntervalMs) {
    return { action: 'skip', reason: 'rate-limited' };
  }
  return { action: 'restart', pid: i.gpuPid };
}

/** The GPU process's pid out of `app.getAppMetrics()`, or null. */
export function findGpuPid(metrics: ReadonlyArray<{ type: string; pid: number }>): number | null {
  const gpu = metrics.find((m) => m.type === 'GPU');
  return gpu && Number.isInteger(gpu.pid) && gpu.pid > 0 ? gpu.pid : null;
}

/** What the renderer sent, coerced — it is a report, not an instruction. */
export function sanitizeStallReport(raw: unknown): { missed: number; stalledForMs: number } {
  const r = (raw ?? {}) as { missed?: unknown; stalledForMs?: unknown };
  const num = (v: unknown, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : 0;
  return { missed: num(r.missed, 1_000), stalledForMs: num(r.stalledForMs, 24 * 3_600_000) };
}

function watchdogEnabled(): boolean {
  try {
    const prefs = loadSettings()['wmux-workspace-prefs'] as { gpuWatchdog?: unknown } | undefined;
    return prefs?.gpuWatchdog !== false;
  } catch {
    return true;
  }
}

/**
 * Wire the IPC handler and the `child-process-gone` log line. Electron is
 * required lazily so the decision above stays importable from a plain node
 * test.
 */
export function installGpuWatchdog(): void {
  const { app, ipcMain, powerMonitor, BrowserWindow } = require('electron') as typeof import('electron');
  let lastRestartAt: number | null = null;
  let lastSkipReason: string | null = null;
  let killedPid: number | null = null;

  app.on('child-process-gone', (_event, details) => {
    if (details.type !== 'GPU') return;
    // Every GPU exit is worth a line: Chromium's own watchdog killing a hung
    // GPU main thread would have shown up here in the reporter's log, and its
    // absence is what pointed at a wedge rather than a hang.
    logDiagnostic('gpu-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      byWatchdog: killedPid !== null,
    });
    killedPid = null;
  });

  ipcMain.on(IPC_CHANNELS.GPU_STALL, (event, raw: unknown) => {
    const report = sanitizeStallReport(raw);
    const win = BrowserWindow.fromWebContents(event.sender);
    const now = Date.now();
    let idleSeconds = 0;
    try { idleSeconds = powerMonitor.getSystemIdleTime(); } catch { /* keep 0: fail towards acting */ }

    const decision = decideGpuRestart({
      ...GPU_RESTART_DEFAULTS,
      now,
      enabled: watchdogEnabled(),
      gpuPid: findGpuPid(app.getAppMetrics()),
      focused: win?.isFocused() ?? false,
      visible: win?.isVisible() ?? false,
      minimized: win?.isMinimized() ?? true,
      idleSeconds,
      lastRestartAt,
    });

    if (decision.action === 'skip') {
      // A wedged-but-unfocused window reports every 15 s; log the reason once
      // per run rather than once per report, or this fills main.log.
      if (decision.reason !== lastSkipReason) {
        logDiagnostic('gpu-stall', { ...report, idleSeconds, skip: decision.reason });
        lastSkipReason = decision.reason;
      }
      return;
    }
    lastSkipReason = null;
    lastRestartAt = now;
    killedPid = decision.pid;
    try {
      process.kill(decision.pid, 'SIGKILL');
      logDiagnostic('gpu-restart', { ...report, idleSeconds, pid: decision.pid });
    } catch (err) {
      killedPid = null;
      logDiagnostic('gpu-restart-failed', { pid: decision.pid, code: (err as NodeJS.ErrnoException)?.code });
      return;
    }
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC_CHANNELS.GPU_RESTARTED, { stalledForMs: report.stalledForMs });
    }
  });
}
