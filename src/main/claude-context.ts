import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const START_MARKER = '<!-- wmux:start';
const END_MARKER = '<!-- wmux:end -->';

function getInstructionsPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'claude-instructions', 'claude-instructions.md');
    }
  } catch {
    // Not in Electron
  }
  return path.join(__dirname, '../../resources/claude-instructions.md');
}

function getClaudeMdPath(): string {
  return path.join(os.homedir(), '.claude', 'CLAUDE.md');
}

/**
 * Ensures the user's global ~/.claude/CLAUDE.md contains the wmux section.
 * - Creates ~/.claude/ and CLAUDE.md if they don't exist
 * - Inserts the wmux block if not present
 * - Updates the wmux block if it's outdated
 * - Never touches content outside the <!-- wmux:start --> / <!-- wmux:end --> markers
 */
export function ensureClaudeContext(): void {
  try {
    const instructionsPath = getInstructionsPath();
    if (!fs.existsSync(instructionsPath)) {
      console.warn('[wmux] claude-instructions.md not found at', instructionsPath);
      return;
    }

    const wmuxBlock = fs.readFileSync(instructionsPath, 'utf-8');
    const claudeMdPath = getClaudeMdPath();
    const claudeDir = path.dirname(claudeMdPath);

    // Ensure ~/.claude/ exists
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    if (!fs.existsSync(claudeMdPath)) {
      // No CLAUDE.md yet — create with just the wmux block
      fs.writeFileSync(claudeMdPath, wmuxBlock, 'utf-8');
      console.log('[wmux] Created ~/.claude/CLAUDE.md with wmux context');
      return;
    }

    // CLAUDE.md exists — check for existing wmux block
    const existing = fs.readFileSync(claudeMdPath, 'utf-8');
    const startIdx = existing.indexOf(START_MARKER);
    const endIdx = existing.indexOf(END_MARKER);

    if (startIdx === -1) {
      // No wmux block — append it
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      fs.writeFileSync(claudeMdPath, existing + separator + wmuxBlock, 'utf-8');
      console.log('[wmux] Appended wmux context to ~/.claude/CLAUDE.md');
      return;
    }

    if (endIdx === -1) {
      // Broken markers — replace from start marker to end of file
      const before = existing.substring(0, startIdx);
      fs.writeFileSync(claudeMdPath, before + wmuxBlock, 'utf-8');
      console.log('[wmux] Fixed and updated wmux context in ~/.claude/CLAUDE.md');
      return;
    }

    // Both markers found — replace the block
    const currentBlock = existing.substring(startIdx, endIdx + END_MARKER.length);
    if (currentBlock.trim() === wmuxBlock.trim()) {
      // Already up to date
      return;
    }

    const before = existing.substring(0, startIdx);
    const after = existing.substring(endIdx + END_MARKER.length);
    fs.writeFileSync(claudeMdPath, before + wmuxBlock + after, 'utf-8');
    console.log('[wmux] Updated wmux context in ~/.claude/CLAUDE.md');
  } catch (err) {
    console.warn('[wmux] Failed to update Claude context:', err);
  }
}

const HOOK_MARKER = 'wmux-hook';

function getSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function getCliAbsolutePath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron');
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'cli', 'wmux.js');
    }
  } catch {}
  return path.resolve(path.join(__dirname, '../cli/wmux.js'));
}

/** Tools tracked via PostToolUse hooks for the sidebar/diff view. */
const TRACKED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Agent', 'WebSearch', 'WebFetch', 'Skill'];

/**
 * Pure builder for the wmux hook blocks. Given the parsed settings object and
 * the absolute path to wmux-hook.js, returns a new settings object whose
 * `hooks` contains fresh wmux PostToolUse/Notification/Stop/SubagentStop
 * entries, with any prior wmux entries replaced and all non-wmux (user) hooks
 * preserved. Extracted so the merge logic is unit-testable without touching
 * the fs (issue #53).
 */
export function applyWmuxHooks(settings: any, hookScript: string): any {
  const next = { ...(settings || {}) };
  next.hooks = { ...(next.hooks || {}) };

  // PostToolUse passes the tool name as a positional arg; Notification/Stop
  // pass an --event flag so the helper reports an event type instead.
  const makeToolCmd = (tool: string) => `node "${hookScript}" ${tool} 2>/dev/null || true`;
  const makeEventCmd = (event: string) => `node "${hookScript}" --event ${event} 2>/dev/null || true`;

  // Drop any prior wmux entry from a hook array, preserving user hooks.
  const stripWmux = (entries: any): any[] =>
    (Array.isArray(entries) ? entries : []).filter((e: any) => {
      if (!Array.isArray(e.hooks)) return true;
      return !e.hooks.some((h: any) => h.command?.includes('wmux-hook'));
    });

  // PostToolUse — one entry per tracked tool for specific sidebar tracking.
  next.hooks.PostToolUse = [
    ...stripWmux(next.hooks.PostToolUse),
    ...TRACKED_TOOLS.map(tool => ({
      matcher: tool,
      hooks: [{ type: 'command', command: makeToolCmd(tool) }],
    })),
  ];

  // Notification — Claude Code is asking for input/permission (waiting on you).
  next.hooks.Notification = [
    ...stripWmux(next.hooks.Notification),
    { hooks: [{ type: 'command', command: makeEventCmd('Notification') }] },
  ];

  // Stop — Claude Code finished its turn and is back at the prompt.
  next.hooks.Stop = [
    ...stripWmux(next.hooks.Stop),
    { hooks: [{ type: 'command', command: makeEventCmd('Stop') }] },
  ];

  // SubagentStop — one parallel subagent finished (drives sidebar agent lines).
  next.hooks.SubagentStop = [
    ...stripWmux(next.hooks.SubagentStop),
    { hooks: [{ type: 'command', command: makeEventCmd('SubagentStop') }] },
  ];

  return next;
}

/**
 * Ensures Claude Code's ~/.claude/settings.json has the wmux hooks:
 *  - PostToolUse   → drives the sidebar/diff view (tool activity)
 *  - Notification  → fires a wmux notification when the agent needs input/permission
 *  - Stop          → fires a wmux notification when the agent finishes its turn
 *  - SubagentStop  → fires when one parallel subagent finishes (sidebar agent lines)
 * Uses absolute CLI paths (not env var). Never touches non-wmux hook entries
 * (issue #53): existing user hooks in each array are preserved.
 */
export function ensureClaudeHooks(): void {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) return;

    const raw = fs.readFileSync(settingsPath, 'utf-8');
    let settings: any;
    try { settings = JSON.parse(raw); } catch { return; }

    // Use absolute path to the hook helper script OUTSIDE the ASAR.
    // __dirname is inside app.asar when packaged — Node.js outside Electron
    // can't read ASAR files, so we use the standalone copy in resources/cli/.
    let hookScript: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { app } = require('electron') as typeof import('electron');
      if (app.isPackaged) {
        hookScript = path.join(process.resourcesPath, 'cli', 'wmux-hook.js');
      } else {
        hookScript = path.resolve(path.join(__dirname, '../../resources/cli/wmux-hook.js'));
      }
    } catch {
      hookScript = path.resolve(path.join(__dirname, '../../resources/cli/wmux-hook.js'));
    }
    hookScript = hookScript.split(path.sep).join('/');

    const updated = applyWmuxHooks(settings, hookScript);
    fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2), 'utf-8');
    console.log('[wmux] Configured PostToolUse/Notification/Stop/SubagentStop hooks in ~/.claude/settings.json');
  } catch (err) {
    console.warn('[wmux] Failed to update Claude hooks:', err);
  }
}

/**
 * Configures chrome-devtools-mcp to connect to wmux's CDP proxy on localhost:9222.
 * Disables the plugin version and adds a custom MCP server in settings.json with
 * --browserUrl pointing to wmux. This is more reliable than modifying the plugin cache.
 */
export function ensureChromeDevtoolsConfig(): void {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) return;

    const raw = fs.readFileSync(settingsPath, 'utf-8');
    let settings: any;
    try { settings = JSON.parse(raw); } catch { return; }

    let changed = false;

    // Disable the plugin (it launches its own Chrome)
    if (settings.enabledPlugins?.['chrome-devtools-mcp@claude-plugins-official'] !== false) {
      if (!settings.enabledPlugins) settings.enabledPlugins = {};
      settings.enabledPlugins['chrome-devtools-mcp@claude-plugins-official'] = false;
      changed = true;
    }

    // Add as custom MCP server with --browserUrl
    if (!settings.mcpServers) settings.mcpServers = {};
    const existing = settings.mcpServers['chrome-devtools'];
    if (!existing || !JSON.stringify(existing).includes('9222')) {
      settings.mcpServers['chrome-devtools'] = {
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp@latest', '--browserUrl=http://127.0.0.1:9222'],
      };
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      console.log('[wmux] Configured chrome-devtools-mcp as custom MCP server → localhost:9222');
    }
  } catch (err) {
    console.warn('[wmux] Failed to configure chrome-devtools-mcp:', err);
  }
}

/**
 * Recursively copies a directory tree from src to dest.
 * Creates dest and any intermediate directories as needed.
 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Auto-installs the wmux-orchestrator plugin into Claude Code's plugin cache.
 * - Copies resources/wmux-orchestrator/ → ~/.claude/plugins/cache/wmux-orchestrator/{version}/
 * - Registers in ~/.claude/plugins/installed_plugins.json
 * - Enables in ~/.claude/settings.json
 * Skips if already installed at the same version.
 */
export function ensureOrchestratorPlugin(): void {
  try {
    // 1. Locate plugin source directory
    let pluginSrcDir: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { app } = require('electron') as typeof import('electron');
      if (app.isPackaged) {
        pluginSrcDir = path.join(process.resourcesPath, 'wmux-orchestrator');
      } else {
        pluginSrcDir = path.resolve(path.join(__dirname, '../../resources/wmux-orchestrator'));
      }
    } catch {
      pluginSrcDir = path.resolve(path.join(__dirname, '../../resources/wmux-orchestrator'));
    }

    const pluginJsonSrc = path.join(pluginSrcDir, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(pluginJsonSrc)) {
      console.warn('[wmux] wmux-orchestrator plugin not found at', pluginSrcDir);
      return;
    }

    // 2. Read version from plugin.json
    let pluginMeta: any;
    try {
      pluginMeta = JSON.parse(fs.readFileSync(pluginJsonSrc, 'utf-8'));
    } catch {
      console.warn('[wmux] Failed to parse wmux-orchestrator plugin.json');
      return;
    }
    const version: string = pluginMeta.version || '0.0.0';

    // 3. Copy to ~/.claude/plugins/cache/wmux-orchestrator/{version}/
    const claudeDir = path.join(os.homedir(), '.claude');
    const cacheDir = path.join(claudeDir, 'plugins', 'cache', 'wmux-orchestrator', version);
    const targetPluginJson = path.join(cacheDir, '.claude-plugin', 'plugin.json');

    // Check if already installed at same version
    if (fs.existsSync(targetPluginJson)) {
      try {
        const existing = JSON.parse(fs.readFileSync(targetPluginJson, 'utf-8'));
        if (existing.version === version) {
          // Already installed at same version — skip copy, but still ensure registration
          ensurePluginRegistered(cacheDir, version, claudeDir);
          return;
        }
      } catch {
        // Corrupted target — re-install
      }
    }

    // Remove old version directory if it exists (clean install)
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }

    // Copy entire plugin directory
    copyDirSync(pluginSrcDir, cacheDir);
    console.log(`[wmux] Installed wmux-orchestrator v${version} to plugin cache`);

    // 4–5. Register and enable
    ensurePluginRegistered(cacheDir, version, claudeDir);
  } catch (err) {
    console.warn('[wmux] Failed to install wmux-orchestrator plugin:', err);
  }
}

/**
 * Registers the orchestrator plugin in installed_plugins.json and enables it in settings.json.
 */
function ensurePluginRegistered(installPath: string, version: string, claudeDir: string): void {
  const pluginKey = 'wmux-orchestrator@wmux';

  // Register in installed_plugins.json
  try {
    const installedPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
    let installed: any = {};
    if (fs.existsSync(installedPath)) {
      try { installed = JSON.parse(fs.readFileSync(installedPath, 'utf-8')); } catch { installed = {}; }
    } else {
      fs.mkdirSync(path.dirname(installedPath), { recursive: true });
    }

    const now = new Date().toISOString();
    const existing = installed[pluginKey];
    if (!existing || existing.version !== version || existing.installPath !== installPath) {
      installed[pluginKey] = {
        scope: 'user',
        installPath,
        version,
        installedAt: existing?.installedAt || now,
        lastUpdated: now,
      };
      fs.writeFileSync(installedPath, JSON.stringify(installed, null, 2), 'utf-8');
      console.log('[wmux] Registered wmux-orchestrator in installed_plugins.json');
    }
  } catch (err) {
    console.warn('[wmux] Failed to register plugin in installed_plugins.json:', err);
  }

  // Enable in settings.json
  try {
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (!fs.existsSync(settingsPath)) return;

    const raw = fs.readFileSync(settingsPath, 'utf-8');
    let settings: any;
    try { settings = JSON.parse(raw); } catch { return; }

    if (!settings.enabledPlugins) settings.enabledPlugins = {};
    if (settings.enabledPlugins[pluginKey] !== true) {
      settings.enabledPlugins[pluginKey] = true;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      console.log('[wmux] Enabled wmux-orchestrator in settings.json');
    }
  } catch (err) {
    console.warn('[wmux] Failed to enable plugin in settings.json:', err);
  }
}
