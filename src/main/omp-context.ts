/**
 * omp (Oh My Pi) integration (issue #165).
 *
 * The fourth agent wmux teaches about itself, after Claude Code, OpenCode and
 * Kiro. It is a Windows-native terminal coding agent, which makes it a closer
 * fit for wmux than most — the request in #165 was from a team that is "100%
 * omp on Windows 11" and read wmux as Claude-only.
 *
 * ── Where the block goes ─────────────────────────────────────────────────────
 *
 * omp's `native` discovery provider reads `~/.omp/agent/AGENTS.md` at USER
 * scope, for every session, and native files have the highest discovery
 * priority of any provider. That is the one global, per-user location, so it is
 * where the block belongs.
 *
 * Worth being explicit about a tempting shortcut that was rejected: omp also
 * ships `claude` and `agents-md` discovery providers, so on many machines it
 * would already pick up the block wmux writes to ~/.claude/CLAUDE.md and appear
 * to work with no code at all. That is not something to rely on — it is true
 * only while the user has Claude Code installed AND has not put `claude` in
 * `disabledProviders`, and it makes wmux's behaviour on an omp-only machine
 * depend on a competing tool being present. Writing the native file means omp
 * support does not quietly evaporate when someone uninstalls Claude Code.
 *
 * ── Why a whole file rather than a splice ────────────────────────────────────
 *
 * Same reasoning as kiro-context.ts, for a different reason. Kiro reads every
 * file in a steering directory, so wmux can own one. Here the file is a single
 * shared AGENTS.md that the user may well have written in — so the block is
 * spliced between markers exactly as it is for Claude Code and OpenCode, and
 * everything outside the markers is left alone.
 *
 * Status is reported by resources/omp-extension/wmux.js, installed under the
 * separate "Status hooks" consent toggle. Omp discovers global extensions in
 * ~/.omp/agent/extensions. Main-session snapshots keep async child jobs busy
 * after the foreground turn ends; rebound child factories do not report.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type * as Electron from 'electron';
import { injectWmuxBlock, readRenderedInstructions } from './agent-instructions';
import { stripWmuxBlock, stripLegacyBlocks } from './claude-context';
import { isWmuxPluginFile, pluginNeedsUpdate } from './agent-plugin-file';

/**
 * The omp agent directory — `~/.omp/agent` unless the env overrides omp itself
 * honours are set in wmux's own environment:
 *
 * - `PI_CODING_AGENT_DIR` replaces the whole agent directory (default profile
 *   only; a `~` prefix expands to home, otherwise the value is resolved).
 * - `PI_CONFIG_DIR` replaces the user config root, so the agent directory
 *   becomes `~/<PI_CONFIG_DIR>/agent`.
 *
 * `PI_CODING_AGENT_DIR` wins when both are set: it is the narrower override and
 * omp applies it to `getAgentDir()` itself, whereas `PI_CONFIG_DIR` only moves
 * the root the default is derived from. Values set per-shell after wmux
 * launched are unknowable from here and fall back to the default — a miss,
 * never a write to the wrong place.
 */
export function getOmpAgentDir(): string {
  const agentOverride = process.env.PI_CODING_AGENT_DIR?.trim();
  if (agentOverride) {
    if (agentOverride === '~') return os.homedir();
    if (agentOverride.startsWith('~/') || agentOverride.startsWith('~\\')) {
      return path.join(os.homedir(), agentOverride.slice(2));
    }
    return path.resolve(agentOverride);
  }
  const configOverride = process.env.PI_CONFIG_DIR?.trim();
  if (configOverride) {
    return path.join(os.homedir(), configOverride, 'agent');
  }
  return path.join(os.homedir(), '.omp', 'agent');
}

/**
 * `<agentDir>/AGENTS.md` — omp's user-scope native context file.
 *
 * Note the `agent` segment: `~/.omp/` is also the project-local directory name,
 * and only the user-level one is nested under `agent/`.
 */
export function getOmpAgentsMdPath(agentDir = getOmpAgentDir()): string {
  return path.join(agentDir, 'AGENTS.md');
}

/** Ensures ~/.omp/agent/AGENTS.md contains the wmux block. */
export function ensureOmpContext(): void {
  try {
    // Rendered, not read: carries this install's absolute CLI path (#158).
    const wmuxBlock = readRenderedInstructions();
    if (wmuxBlock === null) return;

    const agentsPath = getOmpAgentsMdPath();
    fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
    const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf-8') : '';
    const next = injectWmuxBlock(existing, wmuxBlock, stripLegacyBlocks);
    // Don't churn the mtime when nothing changed — omp watches these files.
    if (next === existing) return;
    fs.writeFileSync(agentsPath, next, 'utf-8');
    console.log('[wmux] Updated wmux context in', agentsPath);
  } catch (err) {
    console.warn('[wmux] Failed to update omp context:', err);
  }
}

/**
 * Remove the wmux block (issue #132's inverse requirement: every write wmux
 * makes outside its own directory must be undoable).
 *
 * Only the block between the markers goes. A file the user has written their
 * own instructions into keeps all of them, and a file that becomes empty as a
 * result is deleted rather than left as a stray artefact of an integration the
 * user just switched off.
 */
export function removeOmpContext(): void {
  try {
    const agentsPath = getOmpAgentsMdPath();
    if (!fs.existsSync(agentsPath)) return;
    const existing = fs.readFileSync(agentsPath, 'utf-8');
    // null means there is no wmux block in there at all — a file the user
    // created themselves under this name, which is not ours to touch.
    const next = stripWmuxBlock(existing);
    if (next === null || next === existing) return;
    if (next.trim() === '') fs.unlinkSync(agentsPath);
    else fs.writeFileSync(agentsPath, next, 'utf-8');
    console.log('[wmux] Removed wmux context from', agentsPath);
  } catch (err) {
    console.warn('[wmux] Failed to remove omp context:', err);
  }
}

/** Where the extension lands: `<agentDir>/extensions/wmux.js`. */
function getOmpExtensionPath(): string {
  return path.join(getOmpAgentDir(), 'extensions', 'wmux.js');
}

/** Installs the status bridge without modifying a user's own wmux.js. */
export function ensureOmpExtension(): void {
  try {
    let source = path.join(__dirname, '../../resources/omp-extension/wmux.js');
    try {
      const { app } = require('electron') as typeof Electron;
      if (app.isPackaged) source = path.join(process.resourcesPath, 'omp-extension', 'wmux.js');
    } catch { /* Node unit tests use the development resource. */ }
    const src = fs.readFileSync(source, 'utf-8');
    const dest = getOmpExtensionPath();
    const target = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf-8') : null;
    if (target !== null && !isWmuxPluginFile(target)) {
      console.warn('[wmux] Refusing to overwrite the user-owned omp extension:', dest);
      return;
    }
    if (!pluginNeedsUpdate(src, target)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, src, 'utf-8');
  } catch (err) {
    console.warn('[wmux] Failed to install the omp extension:', err);
  }
}

/** The inverse of ensureOmpExtension, restricted to wmux-owned files. */
export function removeOmpExtension(): void {
  try {
    const dest = getOmpExtensionPath();
    if (!fs.existsSync(dest) || !isWmuxPluginFile(fs.readFileSync(dest, 'utf-8'))) return;
    fs.unlinkSync(dest);
  } catch (err) {
    console.warn('[wmux] Failed to remove the omp extension:', err);
  }
}
