import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { stripWmuxBlock, stripLegacyBlocks } from './claude-context';
import { injectWmuxBlock as spliceBlock, readRenderedInstructions } from './agent-instructions';

/**
 * Pure: insert/replace the wmux block within existing content, preserving the rest.
 *
 * Thin wrapper over the shared splice in agent-instructions.ts, kept as a named
 * export because the existing tests target it here. The implementation moved
 * when omp became the third agent needing it (#165) — and the copy written for
 * omp had already lost the `trimEnd()` this one depends on, appending one blank
 * line per launch to a file the agent reads every session.
 */
export function injectWmuxBlock(rawExisting: string, wmuxBlock: string): string {
  return spliceBlock(rawExisting, wmuxBlock, stripLegacyBlocks);
}

function getAgentsMdPath(): string {
  return path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md');
}

/** Ensures ~/.config/opencode/AGENTS.md contains the wmux block. */
export function ensureOpencodeContext(): void {
  try {
    // Rendered, not read: carries this install's absolute CLI path (#158).
    const wmuxBlock = readRenderedInstructions();
    if (wmuxBlock === null) return;
    const agentsPath = getAgentsMdPath();
    const dir = path.dirname(agentsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf-8') : '';
    const next = injectWmuxBlock(existing, wmuxBlock);
    if (next !== existing) {
      fs.writeFileSync(agentsPath, next, 'utf-8');
      console.log('[wmux] Updated wmux context in ~/.config/opencode/AGENTS.md');
    }
  } catch (err) {
    console.warn('[wmux] Failed to update OpenCode context:', err);
  }
}

const VERSION_RE = /wmux-plugin-version:\s*(\S+)/;

/** Pure: compare embedded version markers to decide whether to re-install. */
export function pluginNeedsUpdate(src: string, target: string | null): boolean {
  if (target === null) return true;
  const s = src.match(VERSION_RE)?.[1];
  const t = target.match(VERSION_RE)?.[1];
  if (s === undefined) return true; // fail safe: unversioned source → always reinstall
  return s !== t;
}

function getPluginSrcPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'opencode-plugin', 'wmux.js');
    }
  } catch { /* not running under Electron */ }
  return path.join(__dirname, '../../resources/opencode-plugin/wmux.js');
}

/** Installs/updates the wmux OpenCode plugin into ~/.config/opencode/plugin/. */
export function ensureOpencodePlugin(): void {
  try {
    const srcPath = getPluginSrcPath();
    if (!fs.existsSync(srcPath)) {
      console.warn('[wmux] opencode plugin source not found at', srcPath);
      return;
    }
    const src = fs.readFileSync(srcPath, 'utf-8');
    const destDir = path.join(os.homedir(), '.config', 'opencode', 'plugin');
    const dest = path.join(destDir, 'wmux.js');
    const target = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf-8') : null;
    if (!pluginNeedsUpdate(src, target)) return;
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(dest, src, 'utf-8');
    console.log('[wmux] Installed wmux OpenCode plugin to', dest);
  } catch (err) {
    console.warn('[wmux] Failed to install OpenCode plugin:', err);
  }
}

/**
 * Delete wmux's block from ~/.config/opencode/AGENTS.md (issue #132).
 *
 * Mirrors removeClaudeContext: the file goes only when it held nothing but our
 * block, so an AGENTS.md the user wrote survives with just the block excised.
 * The stripping itself is shared — the two files use identical markers, and
 * having one implementation is what stops the two paths from drifting.
 */
export function removeOpencodeContext(): void {
  try {
    const agentsPath = getAgentsMdPath();
    if (!fs.existsSync(agentsPath)) return;
    const stripped = stripWmuxBlock(fs.readFileSync(agentsPath, 'utf-8'));
    if (stripped === null) return;
    if (stripped === '') fs.unlinkSync(agentsPath);
    else fs.writeFileSync(agentsPath, stripped, 'utf-8');
    console.log('[wmux] Removed wmux context from ~/.config/opencode/AGENTS.md');
  } catch (err) {
    console.warn('[wmux] Failed to remove OpenCode context:', err);
  }
}

/**
 * Remove the wmux OpenCode plugin (issue #132).
 *
 * Guarded on the version marker wmux stamps into its own plugin source: a
 * wmux.js the user wrote or vendored themselves has no marker and is left where
 * it is, because uninstalling our integration must not delete their file.
 */
export function removeOpencodePlugin(): void {
  try {
    const dest = path.join(os.homedir(), '.config', 'opencode', 'plugin', 'wmux.js');
    if (!fs.existsSync(dest)) return;
    if (!VERSION_RE.test(fs.readFileSync(dest, 'utf-8'))) return;
    fs.unlinkSync(dest);
    console.log('[wmux] Removed the wmux OpenCode plugin from', dest);
  } catch (err) {
    console.warn('[wmux] Failed to remove OpenCode plugin:', err);
  }
}
