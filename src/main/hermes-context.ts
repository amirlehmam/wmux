/**
 * Hermes Agent (`hermes`, NousResearch) integration: a plugin of wmux's own
 * that reports each pane's run state — notifications, approval and clarify
 * prompts ("Needs you"), working/idle, the prompt log and the diff refresh.
 *
 * Hermes has no Claude-style hook file, but its Python plugins register
 * lifecycle hooks (`on_human_input_request`, `pre_llm_call`, `pre_tool_call`,
 * `on_session_end`, ...). The plugin translates those into the Claude Code hook
 * events wmux already models and runs wmux-hook.js for each, so a Hermes pane
 * goes through exactly the path a Claude Code pane does. The mapping and its
 * rules are in resources/hermes-plugin/__init__.py.
 *
 * ── Where ────────────────────────────────────────────────────────────────────
 *
 * `<HERMES_HOME>/plugins/wmux/` — a directory of wmux's own, so nothing the user
 * wrote is parsed or rewritten. HERMES_HOME is honoured only when absolute; the
 * default is `%LOCALAPPDATA%\hermes` on Windows and `~/.hermes` elsewhere,
 * matching `_platform_default_hermes_home` in hermes_constants.py. Named
 * profiles (`<home>/profiles/<name>/`) keep their own plugins and are not
 * written.
 *
 * ── Enabling ─────────────────────────────────────────────────────────────────
 *
 * Hermes plugins are opt-in (`plugins.enabled` in config.yaml). wmux never
 * edits config.yaml itself: when the list does not name `wmux`, it runs Hermes's
 * own `hermes plugins enable wmux --no-allow-tool-override`, resolved by
 * absolute path inside the Hermes home so a PATH entry cannot shadow it. When
 * that binary is not there, the plugin is installed but idle and the log says
 * which command to run.
 *
 * `plugins.disabled` naming `wmux` (the user ran `hermes plugins disable
 * wmux`) is respected: the files stay current but wmux never re-enables it.
 *
 * Removal deletes the plugin files wmux can prove are its own (the version
 * marker). The `wmux` entry left in `plugins.enabled` names nothing and is
 * ignored by Hermes; editing the user's config to take it out is not worth the
 * risk to the rest of that file.
 *
 * Nothing is written unless the Hermes home exists: creating it on a machine
 * that never ran Hermes would be the #132 mistake.
 *
 * Checked against Hermes Agent's plugin loader (hermes_cli/plugins.py,
 * plugins_discovery.py) and hook catalog as of November 2026.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { isWmuxPluginFile, pluginNeedsUpdate } from './agent-plugin-file';

const PLUGIN_FILES = ['plugin.yaml', '__init__.py'] as const;

/** Pure: the platform default Hermes home for this environment. */
export function defaultHermesHome(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim();
    return path.join(local || path.join(home, 'AppData', 'Local'), 'hermes');
  }
  return path.join(home, '.hermes');
}

/** `$HERMES_HOME` when absolute, else the platform default. */
export function getHermesHome(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const override = env.HERMES_HOME?.trim();
  return override && path.isAbsolute(override) ? path.normalize(override) : defaultHermesHome(env, home);
}

/** Every home wmux may have written into (current and default), for removal. */
function hermesHomes(env: NodeJS.ProcessEnv, home: string): string[] {
  return [...new Set([getHermesHome(env, home), defaultHermesHome(env, home)])];
}

export function getHermesPluginDir(hermesHome = getHermesHome()): string {
  return path.join(hermesHome, 'plugins', 'wmux');
}

function getPluginSrcDir(): string {
  try {
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) return path.join(process.resourcesPath, 'hermes-plugin');
  } catch { /* not running under Electron */ }
  return path.join(__dirname, '../../resources/hermes-plugin');
}

function readOrNull(filePath: string): string | null {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Is the directory wmux's? Every file wmux writes there carries the marker, so
 * one of them is proof — which also covers an install interrupted after the
 * first file. A user file without the marker is never ours.
 */
function ownsPluginDir(dir: string): boolean {
  let present = 0;
  for (const name of PLUGIN_FILES) {
    const content = readOrNull(path.join(dir, name));
    if (content === null) continue;
    if (!isWmuxPluginFile(content)) return false;
    present++;
  }
  if (present > 0) return true;
  try { return fs.readdirSync(dir).length === 0; } catch { return true; }
}

/**
 * Pure: does this config.yaml's `plugins.enabled` list name `wmux`?
 *
 * A line scan, not a YAML parser: block lists (`- wmux`) and flow lists
 * (`enabled: [a, wmux]`) under a top-level `plugins:`. A miss only costs one
 * redundant `hermes plugins enable`, which is idempotent.
 */
export function hermesConfigEnablesWmux(yaml: string): boolean {
  return hermesPluginListNames(yaml, 'enabled', 'wmux');
}

/** Pure: has the user switched the plugin off (`hermes plugins disable wmux`)? */
export function hermesConfigDisablesWmux(yaml: string): boolean {
  return hermesPluginListNames(yaml, 'disabled', 'wmux');
}

function hermesPluginListNames(yaml: string, key: 'enabled' | 'disabled', name: string): boolean {
  let inPlugins = false;
  let inEnabled = false;
  let enabledIndent = -1;
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inPlugins = /^plugins:\s*$/.test(line);
      inEnabled = false;
      continue;
    }
    if (!inPlugins) continue;
    const enabled = new RegExp(`^\\s*${key}:\\s*(.*)$`).exec(line);
    if (enabled) {
      const rest = enabled[1].trim();
      if (rest.startsWith('[')) {
        return rest.replace(/[[\]'"]/g, '').split(',').map((s) => s.trim()).includes(name);
      }
      inEnabled = true;
      enabledIndent = indent;
      continue;
    }
    if (inEnabled) {
      const item = /^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
      if (item && indent >= enabledIndent) {
        if (item[1] === name) return true;
        continue;
      }
      if (indent <= enabledIndent) inEnabled = false;
    }
  }
  return false;
}

/** Hermes's own executable inside its home, or null. Never resolved through PATH. */
export function findHermesExecutable(hermesHome: string, platform: NodeJS.Platform = process.platform): string | null {
  const name = platform === 'win32' ? 'hermes.exe' : 'hermes';
  const candidates = [
    path.join(hermesHome, 'bin', name),
    path.join(hermesHome, 'hermes-agent', '.hermes', 'bin', name),
  ];
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
}

/** Run `hermes plugins enable wmux`; resolves on exit, never rejects. */
function enablePlugin(hermesHome: string): Promise<void> {
  const exe = findHermesExecutable(hermesHome);
  if (!exe) {
    console.warn('[wmux] Hermes plugin installed; run `hermes plugins enable wmux` to turn it on');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      const child = spawn(exe, ['plugins', 'enable', 'wmux', '--no-allow-tool-override'], {
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, HERMES_HOME: hermesHome },
      });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 60_000);
      child.on('error', (err) => { clearTimeout(timer); console.warn('[wmux] hermes plugins enable failed:', err); resolve(); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) console.log('[wmux] Enabled the wmux Hermes plugin');
        else console.warn(`[wmux] hermes plugins enable wmux exited ${code}`);
        resolve();
      });
    } catch (err) {
      console.warn('[wmux] hermes plugins enable failed:', err);
      resolve();
    }
  });
}

export interface HermesPluginOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  srcDir?: string;
  /** Test seam: replaces the `hermes plugins enable` call. */
  enable?: (hermesHome: string) => Promise<void> | void;
}

/** Install (or update) the plugin and make sure Hermes has it enabled. */
export async function ensureHermesPlugin(opts: HermesPluginOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const hermesHome = getHermesHome(env, opts.home ?? os.homedir());
  try {
    if (!isDirectory(hermesHome)) return;
    const srcDir = opts.srcDir ?? getPluginSrcDir();
    const sources = PLUGIN_FILES.map((name) => [name, readOrNull(path.join(srcDir, name))] as const);
    if (sources.some(([, src]) => src === null)) {
      console.warn('[wmux] Hermes plugin source not found at', srcDir);
      return;
    }
    const dir = getHermesPluginDir(hermesHome);
    if (isDirectory(dir) && !ownsPluginDir(dir)) {
      console.warn(`[wmux] ${dir} exists and is not wmux-managed — leaving it alone`);
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    let changed = false;
    // PLUGIN_FILES puts the marker file last, so a half-finished install is
    // still one the next launch recognises and completes.
    for (const [name, src] of sources) {
      const target = path.join(dir, name);
      if (pluginNeedsUpdate(src as string, readOrNull(target))) {
        fs.writeFileSync(target, src as string, 'utf-8');
        changed = true;
      }
    }
    if (changed) console.log('[wmux] Installed the wmux Hermes plugin to', dir);
    const config = readOrNull(path.join(hermesHome, 'config.yaml')) ?? '';
    // A user who ran `hermes plugins disable wmux` meant it: never undo that.
    if (hermesConfigDisablesWmux(config)) {
      if (changed) console.log('[wmux] The wmux Hermes plugin is disabled in Hermes; leaving it off');
    } else if (!hermesConfigEnablesWmux(config)) {
      await (opts.enable ?? enablePlugin)(hermesHome);
    }
  } catch (err) {
    console.warn('[wmux] Failed to install Hermes plugin:', err);
  }
}

/** Take the plugin back, only from a directory wmux can prove is its own. */
export function removeHermesPlugin(opts: Pick<HermesPluginOptions, 'env' | 'home'> = {}): void {
  for (const hermesHome of hermesHomes(opts.env ?? process.env, opts.home ?? os.homedir())) {
    try {
      const dir = getHermesPluginDir(hermesHome);
      if (!isDirectory(dir) || !ownsPluginDir(dir) || fs.readdirSync(dir).length === 0) continue;
      for (const name of PLUGIN_FILES) {
        const file = path.join(dir, name);
        const content = readOrNull(file);
        if (content !== null && isWmuxPluginFile(content)) fs.unlinkSync(file);
      }
      fs.rmSync(path.join(dir, '__pycache__'), { recursive: true, force: true });
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      console.log('[wmux] Removed the wmux Hermes plugin from', dir);
    } catch (err) {
      console.warn('[wmux] Failed to remove Hermes plugin:', err);
    }
  }
}
