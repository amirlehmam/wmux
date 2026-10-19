/**
 * Antigravity CLI (`agy`) integration: a plugin of wmux's own that reports each
 * pane's conversation, so a restored tab can reopen it with
 * `agy --conversation <id>` (see agy-resume.ts).
 *
 * agy loads every plugin under ~/.gemini/config/plugins/, and a plugin is a
 * directory holding `plugin.json` and, at its root, a `hooks.json`. So this is a
 * directory of wmux's own rather than an edit to the user's ~/.gemini/config/
 * hooks.json: nothing the user wrote is ever parsed, merged or rewritten, and
 * taking it back is deleting three files wmux can recognise as its own.
 *
 * Nothing is written unless agy has run on this machine (its
 * ~/.gemini/antigravity-cli exists): creating ~/.gemini for a program the user
 * never installed would be the #132 mistake.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isWmuxPluginFile, pluginNeedsUpdate } from './agent-plugin-file';

const HOOK_SCRIPT = 'wmux-agy-hook.cjs';

/** The two events the hook script reports from — see its header for why both. */
const AGY_HOOK_EVENTS = ['SessionStart', 'PreInvocation'] as const;

function agyHome(home = os.homedir()): string {
  return path.join(home, '.gemini', 'antigravity-cli');
}

export function getAgyPluginDir(home = os.homedir()): string {
  return path.join(home, '.gemini', 'config', 'plugins', 'wmux');
}

/** Pure: the plugin manifest. The directory name is what agy keys enablement by. */
export function buildAgyPluginManifest(): string {
  return JSON.stringify({ name: 'wmux' }, null, 2) + '\n';
}

/**
 * Pure: the plugin's hooks.json.
 *
 * Bare `node <script>`: agy runs a hook from the directory holding its
 * hooks.json, and on Windows passes a quoted argument to node with the quotes
 * still on — an absolute path would have to be quoted the moment it contained a
 * space (every default node install does), and would then not be found.
 */
export function buildAgyHooks(): string {
  const handlers: Record<string, unknown[]> = {};
  for (const event of AGY_HOOK_EVENTS) {
    handlers[event] = [{ type: 'command', command: `node ${HOOK_SCRIPT} ${event}`, timeout: 5 }];
  }
  return JSON.stringify({ 'wmux-session': handlers }, null, 2) + '\n';
}

function getHookScriptSrcPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) return path.join(process.resourcesPath, 'agy-plugin', HOOK_SCRIPT);
  } catch { /* not running under Electron */ }
  return path.join(__dirname, '../../resources/agy-plugin', HOOK_SCRIPT);
}

function readOrNull(filePath: string): string | null {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Is the plugin directory wmux's? Its hook script carries the version marker
 * every file wmux installs elsewhere carries. A directory that exists without
 * it, and is not empty, is a plugin the user happened to call `wmux`.
 */
function ownsPluginDir(dir: string): boolean {
  const script = readOrNull(path.join(dir, HOOK_SCRIPT));
  if (script !== null) return isWmuxPluginFile(script);
  try { return fs.readdirSync(dir).length === 0; } catch { return true; }
}

function writeIfChanged(filePath: string, content: string): boolean {
  if (readOrNull(filePath) === content) return false;
  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
}

export function ensureAgyPlugin(home = os.homedir(), scriptSrc = getHookScriptSrcPath()): void {
  try {
    if (!isDirectory(agyHome(home))) return;
    const src = readOrNull(scriptSrc);
    if (src === null) {
      console.warn('[wmux] agy plugin source not found at', scriptSrc);
      return;
    }
    const dir = getAgyPluginDir(home);
    if (isDirectory(dir) && !ownsPluginDir(dir)) {
      console.warn(`[wmux] ${dir} exists and is not wmux-managed — leaving it alone`);
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    let changed = writeIfChanged(path.join(dir, 'plugin.json'), buildAgyPluginManifest());
    changed = writeIfChanged(path.join(dir, 'hooks.json'), buildAgyHooks()) || changed;
    // The script last: it is the ownership marker, so a half-finished install
    // is one the next launch still recognises and completes.
    const scriptPath = path.join(dir, HOOK_SCRIPT);
    if (pluginNeedsUpdate(src, readOrNull(scriptPath))) {
      fs.writeFileSync(scriptPath, src, 'utf-8');
      changed = true;
    }
    if (changed) console.log('[wmux] Installed the wmux agy plugin to', dir);
  } catch (err) {
    console.warn('[wmux] Failed to install agy plugin:', err);
  }
}

/** Take the plugin back — only from a directory wmux can prove is its own. */
export function removeAgyPlugin(home = os.homedir()): void {
  try {
    const dir = getAgyPluginDir(home);
    const script = readOrNull(path.join(dir, HOOK_SCRIPT));
    if (script === null || !isWmuxPluginFile(script)) return;
    // The two JSON files go only when they are still exactly what wmux wrote.
    for (const [name, ours] of [['plugin.json', buildAgyPluginManifest()], ['hooks.json', buildAgyHooks()]] as const) {
      const file = path.join(dir, name);
      if (readOrNull(file) === ours) fs.unlinkSync(file);
    }
    fs.unlinkSync(path.join(dir, HOOK_SCRIPT));
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    console.log('[wmux] Removed the wmux agy plugin from', dir);
  } catch (err) {
    console.warn('[wmux] Failed to remove agy plugin:', err);
  }
}
