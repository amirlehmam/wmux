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
  //
  // Bare `node …` — not `2>/dev/null || true`. The helper already exits 0
  // when the pipe is absent, so the shell wrapper never kept a downed wmux
  // from blocking the agent. It DID break every consumer that is not bash:
  // Grok (and anything else that honours ~/.claude/settings.json) runs these
  // commands in PowerShell on Windows, where `>/dev/null` is Out-File of
  // `C:\dev\null` and every hook fails with exit 1. Claude Code on Windows
  // may still use Git Bash, so a PowerShell-only spelling (`2>$null`) is
  // equally wrong. No redirect is valid in bash, cmd and pwsh.
  const makeToolCmd = (tool: string) => `node "${hookScript}" ${tool}`;
  const makeEventCmd = (event: string) => `node "${hookScript}" --event ${event}`;

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
 * Where Claude Code actually reads user-scope MCP servers from (issue #237).
 *
 * NOT `~/.claude/settings.json`, which is where wmux wrote this for six
 * releases. `settings.json` has no `mcpServers` key — its schema strips unknown
 * keys rather than erroring, so the entry landed in a file, changed nothing, and
 * `ensureChromeDevtoolsConfig` logged a success. `claude mcp list` never showed
 * it. That is the whole of #237's first blocker, and it is a silent failure by
 * construction: there is no observable difference between "written" and
 * "written somewhere nobody reads" unless you go and look.
 *
 * `~/.claude.json`'s top-level `mcpServers` is the user scope — what
 * `claude mcp add --scope user` writes. `settings.json` holds only the
 * approval/policy keys (`enabledMcpjsonServers`, `allowedMcpServers`, …), which
 * is why the `enabledPlugins` half below stays exactly where it was.
 */
function getClaudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * Version selected for this wmux release. Do not use a mutable npm dist-tag
 * here: this command is persisted in Claude's config and may execute long
 * after the wmux release that wrote it.
 */
export const CHROME_DEVTOOLS_MCP_PACKAGE = 'chrome-devtools-mcp@1.7.0';

/** Build the custom MCP server entry written to Claude's user config. */
export function buildChromeDevtoolsMcpServer(): { command: string; args: string[] } {
  return {
    command: 'npx',
    args: ['-y', CHROME_DEVTOOLS_MCP_PACKAGE, '--browserUrl=http://127.0.0.1:9222'],
  };
}

/**
 * Whether a `chrome-devtools` entry already in Claude's config is one wmux wrote.
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

/** The `mcpServers` object of a parsed config, or undefined if there isn't a usable one. */
function mcpServersOf(config: unknown): Record<string, unknown> | undefined {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  const servers = (config as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return undefined;
  return servers as Record<string, unknown>;
}

/**
 * Put the `chrome-devtools` entry into a parsed `~/.claude.json`, or report that
 * it is already right.
 *
 * Pure and separate from the write because `~/.claude.json` is Claude Code's own
 * live state file — it holds the OAuth account, per-project history, onboarding
 * flags — and wmux rewrites it whole. Every needless write is a chance to lose
 * something Claude Code wrote a millisecond earlier, so "changed" has to be
 * exact, not approximate.
 */
export function applyChromeDevtoolsMcp(config: unknown): { next: any; changed: boolean } {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { next: config, changed: false };
  }
  const next = config as Record<string, any>;
  const existing = mcpServersOf(next)?.['chrome-devtools'];
  // Somebody else's entry stands; wmux does not get to retune it.
  if (existing && !isWmuxAuthoredMcpEntry(existing)) return { next, changed: false };
  const desired = buildChromeDevtoolsMcpServer();
  if (existing && JSON.stringify(existing) === JSON.stringify(desired)) return { next, changed: false };
  if (!mcpServersOf(next)) next.mcpServers = {};
  next.mcpServers['chrome-devtools'] = desired;
  return { next, changed: true };
}

/**
 * The inverse: drop the entry, and the `mcpServers` object with it if wmux's was
 * the only one in there — an empty key left behind is still a footprint in a
 * file wmux was asked to stay out of.
 *
 * Matches on {@link isWmuxAuthoredMcpEntry}, not on the port alone: a user who
 * has since pointed `chrome-devtools` at their own Chrome keeps it.
 *
 * This is also the migration for #237's first blocker. Older releases wrote the
 * entry into `~/.claude/settings.json`, where it did nothing; the same function
 * clears it from there, because the shape is identical and it is wmux's litter
 * either way. It is actively confusing litter: #237 was reported by someone who
 * found the entry sitting in settings.json, correct in every detail, while
 * `claude mcp list` disagreed.
 */
export function stripChromeDevtoolsMcp(config: unknown): { next: any; changed: boolean } {
  const next = config as Record<string, any>;
  const servers = mcpServersOf(config);
  if (!servers || !('chrome-devtools' in servers)) return { next, changed: false };
  if (!isWmuxAuthoredMcpEntry(servers['chrome-devtools'])) return { next, changed: false };
  delete servers['chrome-devtools'];
  if (Object.keys(servers).length === 0) delete next.mcpServers;
  return { next, changed: true };
}

/** Parsed JSON at `filePath`, or null if it is missing or unreadable. */
function readJsonIfExists(filePath: string): any {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Write a parsed config back over Claude Code's live state file.
 *
 * Temp-file + rename, for the reason `session-persistence.ts` spells out at
 * length (#214): a plain `writeFileSync` over 160 KB of somebody else's state
 * leaves a truncated file readable if the process dies mid-write, and this
 * particular file holds the user's Claude Code login. `renameSync` maps onto
 * `MoveFileExW`/`MOVEFILE_REPLACE_EXISTING`, so the old file is replaced rather
 * than ever being absent.
 */
function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = filePath + '.wmux.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * The `~/.claude.json` half, both directions. Guarded on the file existing:
 * wmux does not bring Claude Code's state file into being on a machine where
 * Claude Code has never run, and an absent file means there is no install to
 * configure either.
 */
function syncClaudeConfigMcp(wanted: boolean): void {
  try {
    const configPath = getClaudeConfigPath();
    const config = readJsonIfExists(configPath);
    if (!config) return;
    const { next, changed } = wanted ? applyChromeDevtoolsMcp(config) : stripChromeDevtoolsMcp(config);
    if (!changed) return;
    writeJsonAtomic(configPath, next);
    console.log(
      wanted
        ? '[wmux] Configured chrome-devtools-mcp in ~/.claude.json → localhost:9222'
        : '[wmux] Removed chrome-devtools-mcp from ~/.claude.json'
    );
  } catch (err) {
    console.warn('[wmux] Failed to update chrome-devtools-mcp in ~/.claude.json:', err);
  }
}

/**
 * The `~/.claude/settings.json` half: the official plugin's enabled flag, which
 * genuinely IS read from here, plus the removal of the MCP entry older releases
 * wrote into this file by mistake. The stale entry goes on BOTH paths, so an
 * existing install is cleaned up by the upgrade rather than by the user first
 * having to switch the feature off.
 */
function syncSettingsPluginFlag(wanted: boolean): void {
  const pluginKey = 'chrome-devtools-mcp@claude-plugins-official';
  try {
    const settingsPath = getSettingsPath();
    const settings = readJsonIfExists(settingsPath);
    if (!settings) return;

    let changed = stripChromeDevtoolsMcp(settings).changed;

    if (wanted) {
      // The official plugin launches its own Chrome, which is the thing being
      // replaced.
      if (settings.enabledPlugins?.[pluginKey] !== false) {
        if (!settings.enabledPlugins) settings.enabledPlugins = {};
        settings.enabledPlugins[pluginKey] = false;
        changed = true;
      }
    } else if (settings.enabledPlugins?.[pluginKey] === false) {
      // Only `false` — the value wmux set. A user who deliberately re-enabled
      // the plugin keeps their `true`.
      delete settings.enabledPlugins[pluginKey];
      if (Object.keys(settings.enabledPlugins).length === 0) delete settings.enabledPlugins;
      changed = true;
    }

    if (changed) fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[wmux] Failed to update the chrome-devtools plugin flag:', err);
  }
}

/**
 * Point chrome-devtools-mcp at wmux's CDP proxy on localhost:9222, and stop the
 * official plugin from launching a Chrome of its own.
 *
 * Two files, because the two halves are read from two places (issue #237): the
 * server definition goes to `~/.claude.json`, the plugin flag stays in
 * `~/.claude/settings.json`.
 */
export function ensureChromeDevtoolsConfig(): void {
  syncClaudeConfigMcp(true);
  syncSettingsPluginFlag(true);
}

/**
 * Undo {@link ensureChromeDevtoolsConfig} (issue #132): drop the MCP server
 * entry wmux added — from both the file it belongs in and the file older
 * releases put it in — and stop forcing the official plugin off.
 */
export function removeChromeDevtoolsConfig(): void {
  syncClaudeConfigMcp(false);
  syncSettingsPluginFlag(false);
}



/**
 * The bundled wmux-orchestrator plugin, DEPRECATED in 2.12.0 (issue #239).
 *
 * wmux used to copy `resources/wmux-orchestrator/` into Claude Code's plugin
 * cache and hand-write `~/.claude/plugins/installed_plugins.json` to register
 * it. That never worked, and #239 is the careful report of why: the file uses a
 * v2 schema — `{ version: 2, plugins: { "<plugin>@<marketplace>": [ … ] } }` —
 * and wmux wrote its entry at the TOP LEVEL, as an object rather than an array,
 * under a cache layout (`cache/<plugin>/<version>`) that is not Claude's
 * (`cache/<marketplace>/<plugin>/<version>`) either. Claude Code therefore never
 * listed the plugin, never loaded its skills or commands, and marked the copied
 * tree `.orphaned_at` for garbage collection — while `enabledPlugins` said
 * `true` and wmux logged a successful install.
 *
 * The obvious repair is to ship a real local marketplace and register through a
 * supported path, and that is the right fix for a plugin worth keeping. This one
 * is not: parallel agent orchestration is now something Claude Code does itself,
 * far better than a shell-script wave planner driving panes from the outside.
 * So the plugin is retired rather than re-plumbed, and wmux writes NOTHING into
 * Claude Code's plugin machinery any more.
 *
 * What remains is the inverse, below. Deprecating a feature that spent releases
 * writing into someone else's config is not "stop writing" — it is "stop
 * writing, and take back what was written", the same rule #132 set for every
 * other integration. Anyone who still wants the orchestrator can install it as
 * a normal plugin from github.com/amirlehmam/wmux-orchestrator; wmux's sidebar
 * orchestration panel keeps reading its state file either way.
 */

/** The key wmux used in both `installed_plugins.json` and `enabledPlugins`. */
const ORCHESTRATOR_PLUGIN_KEY = 'wmux-orchestrator@wmux';

/**
 * Whether a top-level `installed_plugins.json` value is the malformed entry
 * wmux wrote — and so is safe to delete without asking anyone.
 *
 * Two independent things say "wmux wrote this". It sits at the top level, where
 * Claude Code puts nothing (its own entries live under `plugins`), and it is a
 * bare object, where Claude Code stores an ARRAY of install records. A value
 * that is an array is left alone on principle: it is not a shape wmux ever
 * produced, so whatever put it there is better placed than this function to
 * decide it should go.
 */
export function isWmuxOrchestratorRegistration(entry: unknown): boolean {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry);
}

/**
 * Take wmux's orchestrator entries out of a parsed `installed_plugins.json`.
 *
 * Pure, and returns whether anything changed, because the caller must not
 * rewrite a file it had no reason to touch — a needless write to Claude Code's
 * own state file is exactly the kind of uninvited edit #132 was filed about.
 *
 * `plugins[ORCHESTRATOR_PLUGIN_KEY]` is deliberately NOT removed. That is where
 * a plugin installed the supported way lands, which is precisely what the
 * deprecation notice tells people to do instead — so removing it would uninstall
 * the replacement while cleaning up the thing it replaced.
 */
export function pruneOrchestratorRegistration(installed: unknown): { next: any; changed: boolean } {
  if (!installed || typeof installed !== 'object' || Array.isArray(installed)) {
    return { next: installed, changed: false };
  }
  const next = installed as Record<string, unknown>;
  if (!isWmuxOrchestratorRegistration(next[ORCHESTRATOR_PLUGIN_KEY])) {
    return { next, changed: false };
  }
  delete next[ORCHESTRATOR_PLUGIN_KEY];
  return { next, changed: true };
}

/**
 * Whether `enabledPlugins["wmux-orchestrator@wmux"]` is still wmux's to clear.
 *
 * It is not, once the plugin is properly installed under `plugins` — at that
 * point the flag is what keeps a user's own, hand-installed orchestrator
 * switched on, and clearing it would silently disable it. The flag only goes
 * when there is no real installation behind it, which is the state every
 * install wmux created is in.
 */
export function orchestratorFlagIsStale(settings: unknown, installed: unknown): boolean {
  const s = settings as { enabledPlugins?: Record<string, unknown> } | null | undefined;
  if (!s?.enabledPlugins || !(ORCHESTRATOR_PLUGIN_KEY in s.enabledPlugins)) return false;
  const registry = (installed ?? {}) as { plugins?: Record<string, unknown> };
  const properly = registry.plugins?.[ORCHESTRATOR_PLUGIN_KEY];
  return !(Array.isArray(properly) ? properly.length > 0 : !!properly);
}

/**
 * Remove every trace of the auto-installed orchestrator plugin: the cache tree
 * wmux copied, its malformed registration, and the enabled flag that pointed at
 * neither.
 *
 * Runs on EVERY launch that reaches {@link applyConsent} now, not only when the
 * feature is switched off — a deprecated integration has no "on". It is
 * idempotent and silent when there is nothing of wmux's to find, which is the
 * state of a fresh install and of every user who declined #132's prompt.
 *
 * `cache/wmux-orchestrator/` is wmux's own invention: Claude Code nests a plugin
 * under its marketplace (`cache/<marketplace>/<plugin>/<version>`), so nothing
 * but wmux ever wrote this path, and a hand-installed copy is somewhere else.
 */
export function removeOrchestratorPlugin(): void {
  const claudeDir = path.join(os.homedir(), '.claude');
  const installedPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');

  try {
    const cacheRoot = path.join(claudeDir, 'plugins', 'cache', 'wmux-orchestrator');
    if (fs.existsSync(cacheRoot)) {
      fs.rmSync(cacheRoot, { recursive: true, force: true });
      console.log('[wmux] Removed the deprecated wmux-orchestrator plugin from the Claude Code cache');
    }
  } catch (err) {
    console.warn('[wmux] Failed to remove orchestrator plugin cache:', err);
  }

  // Read once and reuse: the enabled-flag decision below needs to know whether a
  // real installation exists, and that answer lives in this same file.
  let installed: any = null;
  try {
    if (fs.existsSync(installedPath)) installed = JSON.parse(fs.readFileSync(installedPath, 'utf-8'));
  } catch { installed = null; }

  try {
    if (installed) {
      const { next, changed } = pruneOrchestratorRegistration(installed);
      if (changed) {
        fs.writeFileSync(installedPath, JSON.stringify(next, null, 2), 'utf-8');
        console.log('[wmux] Removed the wmux-orchestrator entry from installed_plugins.json');
      }
    }
  } catch (err) {
    console.warn('[wmux] Failed to deregister orchestrator plugin:', err);
  }

  try {
    const settingsPath = path.join(claudeDir, 'settings.json');
    if (!fs.existsSync(settingsPath)) return;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (!orchestratorFlagIsStale(settings, installed)) return;
    delete settings.enabledPlugins[ORCHESTRATOR_PLUGIN_KEY];
    if (Object.keys(settings.enabledPlugins).length === 0) delete settings.enabledPlugins;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    console.log('[wmux] Cleared the stale wmux-orchestrator flag in ~/.claude/settings.json');
  } catch (err) {
    console.warn('[wmux] Failed to clear the orchestrator plugin flag:', err);
  }
}
