import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readRenderedInstructions } from './agent-instructions';

const START_MARKER = '<!-- wmux:start';
const END_MARKER = '<!-- wmux:end -->';


function getClaudeMdPath(): string {
  return path.join(os.homedir(), '.claude', 'CLAUDE.md');
}

/** An H1 that opens a block wmux wrote before it delimited them with markers. */
const LEGACY_HEADING = /^#\s+[ws]mux\s*$/;
/** Text only wmux's own block contains — a user's `# wmux` notes must survive. */
const LEGACY_SIGNATURES = [
  /You are running inside [ws]mux/,
  /^[ws]mux browser open <url>/m,
];

/**
 * Remove copies of the wmux block that predate the markers (and the smux-era
 * name), so the managed section is the only one left.
 *
 * Early versions appended the block with no `<!-- wmux:start -->` around it.
 * Splicing keys off the FIRST marker pair, so those copies were never updated
 * and never removed: they accumulate, one per rename or marker change, and are
 * loaded into every session on the machine forever. The file this was found on
 * carried six — five `# wmux`, one `# smux` — several contradicting each other
 * about the CLI's own name.
 *
 * Only a `# wmux` / `# smux` H1 whose body carries one of wmux's own sentences
 * is taken. Fenced code is tracked so a `# Title` inside an example cannot end
 * a span early, and the managed block is excluded from the scan entirely — it
 * has the same heading and is handled by the markers.
 */
export function stripLegacyBlocks(content: string): string {
  const managed = managedSpan(content);
  if (managed) {
    return collapse(
      stripLegacyBlocks(content.substring(0, managed.start))
      + content.substring(managed.start, managed.end)
      + stripLegacyBlocks(content.substring(managed.end)),
    );
  }
  return collapse(dropLegacySections(content.split('\n')).join('\n'));
}

/** The marker-delimited block, which the scan must leave alone. */
function managedSpan(content: string): { start: number; end: number } | null {
  const start = content.indexOf(START_MARKER);
  if (start === -1) return null;
  const end = content.indexOf(END_MARKER, start);
  return end === -1 ? null : { start, end: end + END_MARKER.length };
}

const isFence = (line: string): boolean => line.trimStart().startsWith('```');

/** Index just past the section opened at `from`: the next unfenced H1, or EOF. */
function sectionEnd(lines: string[], from: number): number {
  let end = from + 1;
  let fenced = false;
  while (end < lines.length) {
    if (isFence(lines[end])) fenced = !fenced;
    else if (!fenced && /^#\s+\S/.test(lines[end])) break;
    end++;
  }
  return end;
}

function dropLegacySections(lines: string[]): string[] {
  const kept: string[] = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    if (isFence(lines[i])) inFence = !inFence;
    const end = !inFence && LEGACY_HEADING.test(lines[i]) ? sectionEnd(lines, i) : -1;
    if (end !== -1 && LEGACY_SIGNATURES.some((re) => re.test(lines.slice(i, end).join('\n')))) {
      i = end;
      continue;
    }
    kept.push(lines[i]);
    i++;
  }
  return kept;
}

/** Removal leaves gaps behind; three or more blank lines become one break. */
function collapse(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Ensures the user's global ~/.claude/CLAUDE.md contains the wmux section.
 * - Creates ~/.claude/ and CLAUDE.md if they don't exist
 * - Inserts the wmux block if not present
 * - Updates the wmux block if it's outdated
 * - Drops marker-less copies left by older versions (they are ours, and stale)
 * - Never touches content outside the <!-- wmux:start --> / <!-- wmux:end --> markers
 */
export function ensureClaudeContext(): void {
  try {
    // Rendered rather than read: the block carries this install's absolute CLI
    // path, so a session that wmux did not spawn (and therefore has no `wmux`
    // on PATH) can still tell "not running" from "not reachable" — issue #158.
    const wmuxBlock = readRenderedInstructions();
    if (wmuxBlock === null) return;
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
    const raw = fs.readFileSync(claudeMdPath, 'utf-8');
    const existing = stripLegacyBlocks(raw);
    const startIdx = existing.indexOf(START_MARKER);
    const endIdx = existing.indexOf(END_MARKER);

    if (startIdx === -1) {
      // No wmux block — append it
      if (existing.trim() === '') {
        fs.writeFileSync(claudeMdPath, wmuxBlock, 'utf-8');
      } else {
        const separator = existing.endsWith('\n') ? '\n' : '\n\n';
        fs.writeFileSync(claudeMdPath, existing + separator + wmuxBlock, 'utf-8');
      }
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
    if (currentBlock.trim() === wmuxBlock.trim() && existing === raw) {
      // Already up to date, and nothing stale left beside it
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

/**
 * Remove the marker-delimited wmux block from a CLAUDE.md-style document,
 * leaving everything the user wrote (issue #132). Pure, so the marker
 * arithmetic is testable without touching a real home directory.
 *
 * Returns `null` when there is nothing to remove, so callers can skip the write
 * entirely rather than rewriting a file they did not change. A start marker with
 * no end marker means a previous write was interrupted or hand-edited: the block
 * is taken to run to end-of-file, matching how ensureClaudeContext repairs the
 * same damage. The blank lines that joined the block to its surroundings are
 * collapsed so removal doesn't leave a growing gap behind.
 */
export function stripWmuxBlock(content: string): string | null {
  const startIdx = content.indexOf(START_MARKER);
  if (startIdx === -1) return null;
  const endIdx = content.indexOf(END_MARKER, startIdx);
  const before = content.substring(0, startIdx);
  const after = endIdx === -1 ? '' : content.substring(endIdx + END_MARKER.length);
  const joined = before.trimEnd() + (after.trim() ? '\n\n' + after.trimStart() : '');
  return joined.trim() ? joined.trimEnd() + '\n' : '';
}

/**
 * Delete wmux's block from ~/.claude/CLAUDE.md. When the file consisted of
 * nothing but that block — i.e. wmux created it — the file itself is removed,
 * since leaving an empty CLAUDE.md behind is still a file the user never asked
 * for.
 */
export function removeClaudeContext(): void {
  try {
    const claudeMdPath = getClaudeMdPath();
    if (!fs.existsSync(claudeMdPath)) return;
    const stripped = stripWmuxBlock(fs.readFileSync(claudeMdPath, 'utf-8'));
    if (stripped === null) return; // no wmux block — nothing of ours to take back
    if (stripped === '') fs.unlinkSync(claudeMdPath);
    else fs.writeFileSync(claudeMdPath, stripped, 'utf-8');
    console.log('[wmux] Removed wmux context from ~/.claude/CLAUDE.md');
  } catch (err) {
    console.warn('[wmux] Failed to remove Claude context:', err);
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

/** Drop any wmux entry from one hook array, preserving the user's own hooks. */
const stripWmux = (entries: any): any[] =>
  (Array.isArray(entries) ? entries : []).filter((e: any) => {
    if (!Array.isArray(e.hooks)) return true;
    return !e.hooks.some((h: any) => h.command?.includes(HOOK_MARKER));
  });

/**
 * The hook arrays wmux installs into, and therefore the ones it may remove from.
 *
 * The first four are the original set (issue #128). The four added for issue
 * #151 are the *opening* half of the lifecycle: without them the only thing
 * wmux ever heard was work ending, so a turn spent thinking, or one spent inside
 * a single long command, read as `idle` from start to finish.
 *
 * Anything added here must also be added to removeWmuxHooks' reach — which is
 * this same list — or declining the integration would leave orphans behind
 * (issue #132).
 */
const WMUX_HOOK_EVENTS = [
  'PostToolUse', 'Notification', 'Stop', 'SubagentStop',
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SessionEnd',
] as const;

/**
 * Inverse of {@link applyWmuxHooks}: returns a settings object with every wmux
 * hook entry removed and every user hook left alone (issue #132).
 *
 * A hook array that ends up empty is deleted rather than left as `[]`, and a
 * `hooks` object with nothing left in it goes too — so declining the
 * integration restores the file to something indistinguishable from one wmux
 * had never touched, instead of leaving its footprints behind as empty shells.
 */
export function removeWmuxHooks(settings: any): any {
  const next = { ...(settings || {}) };
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  const hooks = { ...next.hooks };
  for (const event of WMUX_HOOK_EVENTS) {
    if (!(event in hooks)) continue;
    const kept = stripWmux(hooks[event]);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  return next;
}

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

  // The per-tool-call hooks run in the BACKGROUND. Every wmux hook is a pure
  // observer: it reports to the pipe and never blocks a tool or injects
  // context, so there is nothing for Claude Code to wait on — and it did wait,
  // a measured 125-145 ms per hook process (Git Bash wrapper + node boot + the
  // pipe round trip) on the critical path of EVERY tool call. `async: true` is
  // honoured since Claude Code 2.1.x; older versions ignore the field.
  //
  // Ordering is not a concern: each report carries the wall-clock it fired at,
  // and agent-state.ts drops a report older than the one it already accepted,
  // so a slow PostToolUse landing after the Stop it preceded cannot resurrect a
  // finished turn (issue #151). SessionStart, Stop and SessionEnd stay
  // synchronous: they fire once per turn or session, and SessionEnd runs while
  // the process is leaving.
  const ASYNC = { async: true } as const;

  // PostToolUse — one entry per tracked tool for specific sidebar tracking.
  next.hooks.PostToolUse = [
    ...stripWmux(next.hooks.PostToolUse),
    ...TRACKED_TOOLS.map(tool => ({
      matcher: tool,
      hooks: [{ type: 'command', command: makeToolCmd(tool), ...ASYNC }],
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

  // ── Turn-opening events (issue #151) ───────────────────────────────────────
  // Everything above reports work FINISHING. These report it starting, which is
  // the difference between a sidebar you can read at a glance and one that says
  // "Idle" through the whole first half of every turn.

  // SessionStart — Claude Code launched, resumed, /clear'd or /compact'd. Marks
  // the pane a known agent session at depth 0, so a brand-new session reads
  // "Idle" instead of borrowing the shell's "Running" (claude is a foreground
  // command, so the shell says running for the session's whole life).
  next.hooks.SessionStart = [
    ...stripWmux(next.hooks.SessionStart),
    { hooks: [{ type: 'command', command: makeEventCmd('SessionStart') }] },
  ];

  // UserPromptSubmit — the human just sent a message: the turn is in flight, and
  // anything the pane was waiting to be told, it has now been told.
  next.hooks.UserPromptSubmit = [
    ...stripWmux(next.hooks.UserPromptSubmit),
    { hooks: [{ type: 'command', command: makeEventCmd('UserPromptSubmit'), ...ASYNC }] },
  ];

  // PreToolUse — a tool is starting. Deliberately matcher-less, unlike
  // PostToolUse: PostToolUse is per-tool because it drives the sidebar's tool
  // LABEL and the diff view, which only make sense for the tracked tools. This
  // one drives "is anything happening at all", and a turn spent entirely in
  // untracked tools is still a turn. The helper reads the tool name off stdin.
  next.hooks.PreToolUse = [
    ...stripWmux(next.hooks.PreToolUse),
    { hooks: [{ type: 'command', command: makeEventCmd('PreToolUse'), ...ASYNC }] },
  ];

  // SessionEnd — Claude Code exited but the shell lives on. Releases the pane so
  // it stops claiming any agent state at all, rather than freezing on whatever
  // it last said.
  next.hooks.SessionEnd = [
    ...stripWmux(next.hooks.SessionEnd),
    { hooks: [{ type: 'command', command: makeEventCmd('SessionEnd') }] },
  ];

  return next;
}

/**
 * Ensures Claude Code's ~/.claude/settings.json has the wmux hooks:
 *  - PostToolUse   → drives the sidebar/diff view (tool activity)
 *  - Notification  → fires a wmux notification when the agent needs input/permission
 *  - Stop          → fires a wmux notification when the agent finishes its turn
 *  - SubagentStop  → fires when one parallel subagent finishes (sidebar agent lines)
 *  - SessionStart  → the pane is now an agent session, idle (issue #151)
 *  - UserPromptSubmit → the human replied: turn started, block over (issue #151)
 *  - PreToolUse    → a tool started, so long tools don't read as idle (issue #151)
 *  - SessionEnd    → Claude Code exited; release the pane (issue #151)
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
    console.log(`[wmux] Configured ${WMUX_HOOK_EVENTS.join('/')} hooks in ~/.claude/settings.json`);
  } catch (err) {
    console.warn('[wmux] Failed to update Claude hooks:', err);
  }
}

/** Take wmux's hooks back out of ~/.claude/settings.json, leaving user hooks (issue #132). */
export function removeClaudeHooks(): void {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) return;
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    let settings: any;
    try { settings = JSON.parse(raw); } catch { return; }

    const updated = removeWmuxHooks(settings);
    // Compare before writing: on every launch after a decline this function runs
    // again, and rewriting an unchanged file would keep bumping its mtime for no
    // reason (and race anyone else editing it).
    const next = JSON.stringify(updated, null, 2);
    if (next === JSON.stringify(settings, null, 2)) return;
    fs.writeFileSync(settingsPath, next, 'utf-8');
    console.log('[wmux] Removed wmux hooks from ~/.claude/settings.json');
  } catch (err) {
    console.warn('[wmux] Failed to remove Claude hooks:', err);
  }
}

/**
 * Version selected for this wmux release. Do not use a mutable npm dist-tag
 * here: this command is persisted in Claude's settings and may execute long
 * after the wmux release that wrote it.
 */
export const CHROME_DEVTOOLS_MCP_PACKAGE = 'chrome-devtools-mcp@1.7.0';

/** Build the custom MCP server entry written to Claude's settings. */
export function buildChromeDevtoolsMcpServer(): { command: string; args: string[] } {
  return {
    command: 'npx',
    args: ['-y', CHROME_DEVTOOLS_MCP_PACKAGE, '--browserUrl=http://127.0.0.1:9222'],
  };
}

/**
 * Whether a `chrome-devtools` entry already in settings.json is one wmux wrote.
 *
 * The predicate has to be "did wmux author this", not "is this what wmux wants".
 * Pinning the package (#161) means the desired entry changes on every release
 * that moves the pin, and a plain inequality check would therefore rewrite the
 * entry on every launch — including one the user had deliberately retuned. That
 * is precisely the behaviour issue #132 was filed about, and it would have made
 * the write path contradict {@link removeChromeDevtoolsConfig}, which already
 * takes care to leave a user's own entry alone on the way out.
 *
 * wmux's signature is narrow and stable across pins: launched via npx, running
 * the chrome-devtools-mcp package, aimed at wmux's own CDP proxy port. Anything
 * else — a different port, a global install, extra flags someone added — is
 * treated as the user's and left untouched.
 */
export function isWmuxAuthoredMcpEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as { command?: unknown; args?: unknown };
  if (e.command !== 'npx') return false;
  if (!Array.isArray(e.args)) return false;
  const args = e.args.filter((a): a is string => typeof a === 'string');
  return (
    args.some(a => a.startsWith('chrome-devtools-mcp@')) &&
    args.includes('--browserUrl=http://127.0.0.1:9222')
  );
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

    // Add as custom MCP server with --browserUrl.
    //
    // Written when there is no entry at all, and rewritten only when the entry
    // present is one wmux itself authored — which is how the @latest → pinned
    // migration reaches existing installs without wmux clobbering an entry the
    // user has since retuned. See isWmuxAuthoredMcpEntry.
    if (!settings.mcpServers) settings.mcpServers = {};
    const existing = settings.mcpServers['chrome-devtools'];
    const desired = buildChromeDevtoolsMcpServer();
    const mine = !existing || isWmuxAuthoredMcpEntry(existing);
    if (mine && JSON.stringify(existing) !== JSON.stringify(desired)) {
      settings.mcpServers['chrome-devtools'] = desired;
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
 * Undo {@link ensureChromeDevtoolsConfig} (issue #132): drop the MCP server
 * entry wmux added and stop forcing the official plugin off.
 *
 * Only an entry that points at wmux's own CDP proxy port is removed — a user
 * who has since pointed `chrome-devtools` somewhere of their own keeps it.
 * Likewise the `enabledPlugins` flag is only cleared when it is still `false`,
 * the value wmux set; a user who deliberately re-enabled it is left alone.
 */
export function removeChromeDevtoolsConfig(): void {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) return;
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    let settings: any;
    try { settings = JSON.parse(raw); } catch { return; }

    let changed = false;
    const entry = settings.mcpServers?.['chrome-devtools'];
    if (entry && JSON.stringify(entry).includes('9222')) {
      delete settings.mcpServers['chrome-devtools'];
      if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
      changed = true;
    }
    const pluginKey = 'chrome-devtools-mcp@claude-plugins-official';
    if (settings.enabledPlugins?.[pluginKey] === false) {
      delete settings.enabledPlugins[pluginKey];
      if (Object.keys(settings.enabledPlugins).length === 0) delete settings.enabledPlugins;
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      console.log('[wmux] Removed chrome-devtools-mcp configuration from ~/.claude/settings.json');
    }
  } catch (err) {
    console.warn('[wmux] Failed to remove chrome-devtools-mcp config:', err);
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

/**
 * Uninstall the orchestrator plugin wmux auto-installed (issue #132): remove its
 * plugin-cache directory, its registration, and its enabled flag.
 *
 * Only the `wmux-orchestrator@wmux` key is touched, and only the cache path
 * wmux itself wrote to — a plugin the user installed by hand from the standalone
 * repo lives under a different install path and survives.
 */
export function removeOrchestratorPlugin(): void {
  const pluginKey = 'wmux-orchestrator@wmux';
  const claudeDir = path.join(os.homedir(), '.claude');

  try {
    const cacheRoot = path.join(claudeDir, 'plugins', 'cache', 'wmux-orchestrator');
    if (fs.existsSync(cacheRoot)) {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
      console.log('[wmux] Removed wmux-orchestrator from the plugin cache');
    }
  } catch (err) {
    console.warn('[wmux] Failed to remove orchestrator plugin cache:', err);
  }

  try {
    const installedPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
    if (fs.existsSync(installedPath)) {
      const installed = JSON.parse(fs.readFileSync(installedPath, 'utf-8'));
      if (installed[pluginKey]) {
        delete installed[pluginKey];
        fs.writeFileSync(installedPath, JSON.stringify(installed, null, 2), 'utf-8');
      }
    }
  } catch (err) {
    console.warn('[wmux] Failed to deregister orchestrator plugin:', err);
  }

  try {
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (!fs.existsSync(settingsPath)) return;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (settings.enabledPlugins?.[pluginKey] === undefined) return;
    delete settings.enabledPlugins[pluginKey];
    if (Object.keys(settings.enabledPlugins).length === 0) delete settings.enabledPlugins;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    console.log('[wmux] Disabled wmux-orchestrator in ~/.claude/settings.json');
  } catch (err) {
    console.warn('[wmux] Failed to disable orchestrator plugin:', err);
  }
}
