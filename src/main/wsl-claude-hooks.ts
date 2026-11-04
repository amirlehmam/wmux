/**
 * wmux's Claude Code hooks inside WSL distros (issue #428).
 *
 * Claude Code running INSIDE a WSL pane reads the distro's own
 * `~/.claude/settings.json`, not the Windows one `ensureClaudeHooks` writes, so
 * without this no hook fired there: the pane never got a state, a
 * `claudeSessionId`, or a session restore. This module writes the same hook set
 * into each distro's file and takes it back, under the `hooks` consent feature
 * (agent-integration.ts is the only caller of `setWslClaudeHooksWanted`).
 *
 * ── What the hooks run ──────────────────────────────────────────────────────
 *
 * Linux node cannot open `\\.\pipe\wmux`, and the Windows `node "C:/…"` command
 * means nothing to a Linux shell. Each hook command is instead
 *
 *   [ ! -f "${WMUX_BASH_SCRIPT%/*}/wmux-hook-wsl.sh" ] || sh "${WMUX_BASH_SCRIPT%/*}/wmux-hook-wsl.sh" --event Stop
 *
 * `WMUX_BASH_SCRIPT` is set (as a /mnt path) only in a WSL pane wmux opened, so
 * Claude in any other terminal finds no helper and ends the hook at once,
 * without starting a Windows process. The test is for the helper FILE, not the
 * variable: a pane opened by a wmux without the helper (a downgrade) would
 * otherwise run `sh <missing file>`, which dash exits 2 on, and exit 2 from a
 * PreToolUse hook makes Claude Code block the tool. Inside a pane, the helper beside the bash integration runs the
 * Windows `wmux-hook.js` with the Windows runtime through interop: the transport
 * the bash integration's `_wmux_report` already uses (2.55.0), with WSLENV
 * carrying the surface, pipe and token back out (pane-browser-env.ts). Nothing
 * in the command names an install path, so it survives wmux moving or updating,
 * and the bytes never change, so re-applying is a no-op.
 *
 * ── Never waking a stopped distro ───────────────────────────────────────────
 *
 * Touching a distro, even `\\wsl.localhost\<distro>\…` from Windows, boots its
 * VM. So the only distros considered are the ones `wsl.exe --list --running`
 * reports, at two moments: when the consent decision is applied (startup and
 * every Settings change), and a few seconds after a WSL pane opens, when the
 * distro it started is up. Removal follows the same rule: a distro that was
 * stopped when the user switched hooks off is cleaned the next time it is seen
 * running. Everything here is asynchronous (execFile and fs.promises); a pane
 * opening only arms a timer, so it costs `PtyManager.create()` nothing.
 *
 * ── What is never touched ───────────────────────────────────────────────────
 *
 * As on Windows: a distro with no `~/.claude/settings.json` (Claude never ran
 * there) gets nothing; a file that does not parse is left alone; the user's own
 * hooks and keys are kept, and the file is rewritten only when wmux's entries
 * actually change. A settings file that resolves outside the distro (a symlink
 * to the Windows `~/.claude`, which `ensureClaudeHooks` owns) is skipped, or the
 * two writers would undo each other on every launch. Docker Desktop's internal
 * distros are skipped outright.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import { applyWmuxHookCommands, removeWmuxHooks } from './claude-context';
import { system32 } from './system32';

/** The helper beside the bash integration (src/shell-integration/). */
export const WSL_HOOK_HELPER = 'wmux-hook-wsl.sh';

/**
 * One hook command as the distro's Claude Code runs it, with /bin/sh. Contains
 * `wmux-hook` (claude-context.ts HOOK_MARKER), which is what removal matches.
 */
export function wslHookCommand(args: string): string {
  const helper = `\${WMUX_BASH_SCRIPT%/*}/${WSL_HOOK_HELPER}`;
  return `[ ! -f "${helper}" ] || sh "${helper}" ${args}`;
}

/** Pure: the settings with wmux's WSL hook entries in place, user hooks kept. */
export function applyWslClaudeHooks(settings: unknown): any {
  return applyWmuxHookCommands(settings, {
    tool: (tool) => wslHookCommand(tool),
    event: (event) => wslHookCommand(`--event ${event}`),
  });
}

/** Pure inverse of {@link applyWslClaudeHooks}; the Windows one, same marker. */
export function removeWslClaudeHooks(settings: unknown): any {
  return removeWmuxHooks(settings);
}

/**
 * wsl.exe writes UTF-16LE (no BOM) unless `WSL_UTF8=1` is set; a program run
 * inside the distro writes whatever it writes, UTF-8 in practice.
 */
export function decodeWslOutput(buf: Buffer): string {
  const text = buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8');
  return text.replace(/^\uFEFF/, '');
}

/** The names `wsl.exe --list --running --quiet` printed, one per line. */
export function parseWslDistroList(buf: Buffer): string[] {
  return decodeWslOutput(buf)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Distros that are part of another product, never a place a user runs Claude. */
export function isSkippedDistro(name: string): boolean {
  return /^docker-desktop(-data)?$/i.test(name);
}

/**
 * Whether `winPath` is inside `distro`'s own filesystem. Anything else is either
 * a symlink out to a Windows drive (`C:\Users\me\.claude\settings.json`, owned
 * by the Windows writer) or not a path wmux should write at all.
 */
export function isInsideDistro(winPath: string, distro: string): boolean {
  const lower = winPath.toLowerCase();
  const name = distro.toLowerCase();
  return lower.startsWith(`\\\\wsl.localhost\\${name}\\`) || lower.startsWith(`\\\\wsl$\\${name}\\`);
}

export type WslHookOutcome = 'installed' | 'removed' | 'unchanged' | 'absent' | 'unreadable' | 'outside';

/**
 * Bring one settings file in line with `wanted`. Never creates the file, never
 * rewrites one whose wmux entries are already right, and leaves a file that does
 * not parse as it is (the same rules as `ensureClaudeHooks`/`removeClaudeHooks`).
 */
export async function reconcileWslSettingsFile(file: string, wanted: boolean): Promise<WslHookOutcome> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf-8');
  } catch {
    return 'absent';
  }
  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    return 'unreadable';
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'unreadable';
  const next = wanted ? applyWslClaudeHooks(settings) : removeWslClaudeHooks(settings);
  const text = JSON.stringify(next, null, 2);
  if (text === JSON.stringify(settings, null, 2)) return 'unchanged';
  // In place, not temp + rename: across \\wsl.localhost a rename would replace
  // the file with a new one owned and permissioned by whatever the 9P server
  // picks, where an overwrite keeps the user's mode and owner.
  await fs.promises.writeFile(file, text, 'utf-8');
  return wanted ? 'installed' : 'removed';
}

/** The only place this module meets wsl.exe; tests substitute it. */
export interface WslBoundary {
  /** Distros whose VM is up right now. Must never start one. */
  runningDistros(): Promise<string[]>;
  /**
   * Where the default user's `~/.claude/settings.json` is in a RUNNING distro,
   * symlinks resolved, as a Windows path; `outside` when it resolves out of the
   * distro (see {@link isInsideDistro}); null when there is none or it cannot be
   * told.
   */
  claudeSettingsPath(distro: string): Promise<WslSettingsLocation>;
}

export type WslSettingsLocation = { file: string } | { outside: string } | null;

function wslExe(): string {
  return system32('wsl.exe');
}

function runWsl(args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        wslExe(), args,
        { encoding: 'buffer', windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 },
        (err, stdout) => resolve(err ? null : stdout),
      );
    } catch {
      resolve(null);
    }
  });
}

let wslInstalled: boolean | null = null;

export const defaultWslBoundary: WslBoundary = {
  async runningDistros() {
    if (process.platform !== 'win32') return [];
    if (wslInstalled === null) wslInstalled = fs.existsSync(wslExe());
    if (!wslInstalled) return [];
    const out = await runWsl(['--list', '--running', '--quiet']);
    return out ? parseWslDistroList(out) : [];
  },
  async claudeSettingsPath(distro) {
    // `--cd ~` is the default user's home without a shell to quote through.
    // `readlink -f` resolves a symlinked settings file (dotfiles, or a link out
    // to the Windows ~/.claude), and fails, like busybox's, on a missing ~/.claude.
    const linux = await runWsl(['-d', distro, '--cd', '~', '--exec', 'readlink', '-f', '.claude/settings.json']);
    const linuxPath = linux ? decodeWslOutput(linux).trim() : '';
    if (!linuxPath.startsWith('/')) return null;
    const win = await runWsl(['-d', distro, '--exec', 'wslpath', '-w', linuxPath]);
    const winPath = win ? decodeWslOutput(win).trim() : '';
    if (!winPath) return null;
    return isInsideDistro(winPath, distro) ? { file: winPath } : { outside: winPath };
  },
};

/**
 * One pass over the running distros. `done` remembers the distros already
 * brought to `wanted` in this run of wmux, so the passes a pane opening
 * triggers cost one `--list` once every distro is settled. A distro with no
 * settings file is not remembered: Claude may be installed there later.
 */
export async function syncWslClaudeHooks(
  wanted: boolean,
  boundary: WslBoundary,
  done: Map<string, boolean> = new Map(),
): Promise<Record<string, WslHookOutcome>> {
  const outcomes: Record<string, WslHookOutcome> = {};
  for (const distro of await boundary.runningDistros()) {
    if (isSkippedDistro(distro) || done.get(distro) === wanted) continue;
    try {
      const location = await boundary.claudeSettingsPath(distro);
      if (!location) { outcomes[distro] = 'absent'; continue; }
      if ('outside' in location) {
        outcomes[distro] = 'outside';
        done.set(distro, wanted);
        continue;
      }
      const outcome = await reconcileWslSettingsFile(location.file, wanted);
      outcomes[distro] = outcome;
      if (outcome !== 'absent') done.set(distro, wanted);
      if (outcome === 'installed') console.log(`[wmux] Configured Claude Code hooks in ${distro}:~/.claude/settings.json`);
      if (outcome === 'removed') console.log(`[wmux] Removed wmux hooks from ${distro}:~/.claude/settings.json`);
    } catch (err) {
      // Not remembered, so the next pass retries.
      console.warn(`[wmux] Failed to update Claude hooks in WSL distro ${distro}:`, err);
    }
  }
  return outcomes;
}

// ─── Scheduling: when a pass runs ───────────────────────────────────────────

/** When a pane opens, the distro it starts is usually up within the first delay. */
export const PANE_SYNC_DELAYS_MS = [5_000, 30_000] as const;

/** A decision applied this soon after a WSL pane opened also waits for its boot. */
const PANE_BOOT_WINDOW_MS = 30_000;

let wanted: boolean | null = null;
let boundary: WslBoundary = defaultWslBoundary;
const reconciled = new Map<string, boolean>();
let inFlight: Promise<void> | null = null;
let rerun = false;
let lastPaneAt = -Infinity;
const armed = new Map<number, NodeJS.Timeout>();

function requestSync(): void {
  if (wanted === null) return;
  if (inFlight) { rerun = true; return; }
  const target = wanted;
  inFlight = syncWslClaudeHooks(target, boundary, reconciled)
    .then(() => undefined, (err) => { console.warn('[wmux] WSL hook sync failed:', err); })
    .finally(() => {
      inFlight = null;
      if (rerun) { rerun = false; requestSync(); }
    });
}

function armPaneSyncs(): void {
  for (const delay of PANE_SYNC_DELAYS_MS) {
    // Re-arming replaces the pending timer, so restoring twenty WSL panes
    // schedules two passes, not forty.
    const prev = armed.get(delay);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => { armed.delete(delay); requestSync(); }, delay);
    timer.unref?.();
    armed.set(delay, timer);
  }
}

/**
 * The consent gate's decision for the `hooks` feature. Called ONLY from
 * agent-integration.ts `applyFeature`: until it is, nothing in a distro is ever
 * read or written (an unanswered prompt writes nothing either way).
 */
export function setWslClaudeHooksWanted(next: boolean): void {
  if (wanted !== next) reconciled.clear();
  wanted = next;
  requestSync();
  if (Date.now() - lastPaneAt < PANE_BOOT_WINDOW_MS) armPaneSyncs();
}

/** PtyManager opened a WSL pane: once its distro is up, bring it in line too. */
export function noteWslPaneOpened(): void {
  lastPaneAt = Date.now();
  if (wanted === null) return;
  armPaneSyncs();
}

/** Tests: the boundary to use, and a clean slate. */
export function resetWslClaudeHooksForTests(next: WslBoundary = defaultWslBoundary): void {
  for (const timer of armed.values()) clearTimeout(timer);
  armed.clear();
  reconciled.clear();
  wanted = null;
  boundary = next;
  inFlight = null;
  rerun = false;
  lastPaneAt = -Infinity;
}

/** Tests: resolves once no pass is running or queued. */
export async function wslClaudeHooksIdle(): Promise<void> {
  while (inFlight) await inFlight;
}
