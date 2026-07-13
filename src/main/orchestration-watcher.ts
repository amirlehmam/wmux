/**
 * orchestration-watcher.ts — polls the OS temp directory for active
 * wmux-orchestrator runs and broadcasts their state.json to all windows.
 *
 * The wmux-orchestrator Claude Code plugin writes its run state to
 * `{os.tmpdir()}/wmux-orch-*\/state.json` (see skills/orchestrate/SKILL.md
 * Phase 6). This watcher is fully decoupled from the plugin — it only
 * reads files, never writes. It runs as long as wmux is running; when a
 * run completes, it sends one final "complete" update then stops tracking it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BrowserWindow } from 'electron';
import { IPC_CHANNELS, OrchestrationState } from '../shared/types';

const POLL_INTERVAL_MS = 1000;
// How long to keep showing a completed run after it finishes (ms)
const COMPLETE_LINGER_MS = 30_000;

interface Tracked {
  orchDir: string;
  lastMtimeMs: number;
  lastStatus: string;
  completedAt: number | null;
}

let pollTimer: NodeJS.Timeout | null = null;
const tracked = new Map<string, Tracked>();
// The currently-displayed run. When an older run finishes and a newer one
// starts, we switch to the newer one. Only ONE is shown at a time.
let active: string | null = null;

function listOrchDirs(): string[] {
  try {
    const tmp = os.tmpdir();
    const entries = fs.readdirSync(tmp, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith('wmux-orch-'))
      .map((e) => path.join(tmp, e.name));
  } catch {
    return [];
  }
}

/**
 * Shape-check a parsed state.json before it is allowed near the renderer.
 * state.json is written by a separate process (the Claude Code plugin, or an
 * agent hand-rolling the file), so it is untrusted input. A run missing `id`
 * or `waves` used to be broadcast anyway and then throw inside the sidebar's
 * render — and an uncaught throw in render unmounts the entire React tree,
 * leaving a black window that only a restart clears. Anything that does not
 * satisfy the contract is ignored rather than shipped to the UI.
 */
export function isValidState(value: unknown): value is OrchestrationState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  if (typeof s.id !== 'string' || s.id === '') return false;
  if (typeof s.status !== 'string') return false;
  if (!Array.isArray(s.waves)) return false;
  return s.waves.every((w) => {
    if (!w || typeof w !== 'object') return false;
    const wave = w as Record<string, unknown>;
    return typeof wave.index === 'number' && Array.isArray(wave.agents);
  });
}

// Dirs we've already rejected, so a bad file doesn't log once per poll tick.
const warned = new Set<string>();

function readState(orchDir: string): OrchestrationState | null {
  const stateFile = path.join(orchDir, 'state.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch {
    // Missing, unreadable, or mid-write (partial JSON) — try again next tick.
    return null;
  }

  if (!isValidState(parsed)) {
    if (!warned.has(orchDir)) {
      warned.add(orchDir);
      console.warn(
        `[orchestration-watcher] ignoring malformed state.json (needs string "id", string "status", array "waves"): ${stateFile}`,
      );
    }
    return null;
  }
  warned.delete(orchDir);

  parsed._orchDir = orchDir;
  return parsed;
}

function getMtime(orchDir: string): number {
  try {
    return fs.statSync(path.join(orchDir, 'state.json')).mtimeMs;
  } catch {
    return 0;
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function tick(): void {
  const dirs = listOrchDirs();
  const now = Date.now();

  // Add any new orch dirs to the tracked map
  for (const dir of dirs) {
    if (!tracked.has(dir)) {
      tracked.set(dir, { orchDir: dir, lastMtimeMs: 0, lastStatus: '', completedAt: null });
    }
  }

  // Remove tracked dirs that no longer exist on disk
  for (const key of Array.from(tracked.keys())) {
    if (!dirs.includes(key)) {
      tracked.delete(key);
      warned.delete(key);
      if (active === key) {
        active = null;
        broadcast(IPC_CHANNELS.ORCHESTRATION_CLEAR, {});
      }
    }
  }

  // Find the most interesting run to show: prefer any "running" one,
  // else the most recently mtime'd one that's still within linger window.
  let best: { dir: string; state: OrchestrationState; mtime: number } | null = null;
  for (const t of tracked.values()) {
    const state = readState(t.orchDir);
    if (!state) continue;
    const mtime = getMtime(t.orchDir);

    // Track completion time once we see a non-running status
    if (state.status !== 'running' && t.completedAt === null) {
      t.completedAt = now;
    }
    if (state.status === 'running') {
      t.completedAt = null;
    }

    // Skip runs that completed long ago (past the linger window)
    if (state.status !== 'running' && t.completedAt !== null && (now - t.completedAt) > COMPLETE_LINGER_MS) {
      continue;
    }

    // Prefer running runs; among running runs, prefer most recent
    const isBetter = !best
      || (state.status === 'running' && best.state.status !== 'running')
      || (state.status === best.state.status && mtime > best.mtime);
    if (isBetter) {
      best = { dir: t.orchDir, state, mtime };
    }
  }

  if (!best) {
    if (active !== null) {
      active = null;
      broadcast(IPC_CHANNELS.ORCHESTRATION_CLEAR, {});
    }
    return;
  }

  const t = tracked.get(best.dir)!;
  const statusChanged = t.lastStatus !== best.state.status;
  const mtimeChanged = t.lastMtimeMs !== best.mtime;
  const activeChanged = active !== best.dir;

  if (activeChanged || mtimeChanged || statusChanged) {
    t.lastMtimeMs = best.mtime;
    t.lastStatus = best.state.status;
    active = best.dir;
    broadcast(IPC_CHANNELS.ORCHESTRATION_UPDATE, best.state);
  }
}

export function startOrchestrationWatcher(): void {
  if (pollTimer) return;
  // Run an immediate tick so the sidebar picks up an in-flight run at wmux start.
  try { tick(); } catch (err) { console.warn('[orchestration-watcher] initial tick failed:', err); }
  pollTimer = setInterval(() => {
    try { tick(); } catch (err) { console.warn('[orchestration-watcher] tick failed:', err); }
  }, POLL_INTERVAL_MS);
}

export function stopOrchestrationWatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  tracked.clear();
  warned.clear();
  active = null;
}
