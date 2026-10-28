/**
 * Qwen Code (Alibaba's `qwen` CLI) integration — the Claude Code integration,
 * pointed at ~/.qwen.
 *
 * Qwen Code is a Gemini CLI fork whose hooks (0.14.0+) were rebuilt on Claude
 * Code's contract: the same event names, the same `{matcher, hooks:[{type:
 * 'command', command}]}` entries, the same snake_case stdin payload with
 * `session_id` on every event. Unlike Grok it does NOT read
 * ~/.claude/settings.json, so nothing wmux wrote for Claude reaches it — every
 * piece below is the Claude piece written again into Qwen's own files:
 *
 *   ~/.qwen/QWEN.md         the wmux block, between markers (instructions)
 *   ~/.qwen/settings.json   `hooks` — the Claude set plus StopFailure (hooks)
 *                           `mcpServers.chrome-devtools` (browserMcp)
 *
 * Verified live against qwen 0.25.3 + Ollama: every event reports, and
 * `--resume` reopens the conversation (qwen-resume.ts).
 *
 * ── Why every hook carries `--provider qwen` ────────────────────────────────
 *
 * The payload is shaped like Claude's, so without a tag wmux-hook.js would
 * forward Qwen's `session_id` as a Claude session and a restore would type
 * `claude --resume <qwen-id>`. The tag makes the hook tell main whose id it is,
 * and lets the helper translate the two places Qwen's payload differs: tool
 * names (`run_shell_command`, not `Bash`) and `UserPromptSubmit`, which Qwen
 * also fires for tool-result continuations (only `submitted_prompt` is text a
 * human typed). The helper also forwards only a strict UUID session id for
 * Qwen: a subagent's `<uuid>-agent-<name>` would overwrite the pane's handle.
 *
 * ── Never on a machine that has not run Qwen ────────────────────────────────
 *
 * Every write is gated on Qwen's home directory existing: creating ~/.qwen on a
 * machine that has never run Qwen would be the #132 mistake. `QWEN_HOME` is
 * honoured when wmux's own environment carries an ABSOLUTE value (Grok's rule —
 * a relative one means something different in every pane), and removal sweeps
 * the default home too, so an uninstall reaches what an earlier launch wrote.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { injectWmuxBlock, readRenderedInstructions } from './agent-instructions';
import {
  applyChromeDevtoolsMcp,
  getHookScriptPath,
  stripChromeDevtoolsMcp,
  stripLegacyBlocks,
  stripWmuxBlock,
} from './claude-context';

function defaultQwenHome(): string {
  return path.join(os.homedir(), '.qwen');
}

/** `$QWEN_HOME`, default ~/.qwen — where settings.json and QWEN.md live. */
export function getQwenHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.QWEN_HOME?.trim();
  return override && path.isAbsolute(override) ? path.normalize(override) : defaultQwenHome();
}

/** Every home wmux may have written into: the current one and the default. */
function qwenHomes(): string[] {
  return [...new Set([getQwenHome(), defaultQwenHome()])];
}

const contextPathIn = (home: string) => path.join(home, 'QWEN.md');
const settingsPathIn = (home: string) => path.join(home, 'settings.json');

export function getQwenContextPath(): string {
  return contextPathIn(getQwenHome());
}

export function getQwenSettingsPath(): string {
  return settingsPathIn(getQwenHome());
}

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ─── Instructions: ~/.qwen/QWEN.md ───────────────────────────────────────────

/** Ensures ~/.qwen/QWEN.md carries the wmux block. No-op when Qwen never ran here. */
export function ensureQwenContext(): void {
  try {
    if (!isDirectory(getQwenHome())) return;
    // Rendered, not read: carries this install's absolute CLI path (#158).
    const wmuxBlock = readRenderedInstructions();
    if (wmuxBlock === null) return;
    const contextPath = getQwenContextPath();
    const existing = fs.existsSync(contextPath) ? fs.readFileSync(contextPath, 'utf-8') : '';
    const next = injectWmuxBlock(existing, wmuxBlock, stripLegacyBlocks);
    if (next === existing) return; // already current; don't churn the mtime
    fs.writeFileSync(contextPath, next, 'utf-8');
    console.log('[wmux] Updated wmux context in', contextPath);
  } catch (err) {
    console.warn('[wmux] Failed to update Qwen context:', err);
  }
}

/** Takes the block back out; a file that held nothing else is deleted (#132). */
export function removeQwenContext(): void {
  for (const home of qwenHomes()) {
    try {
      const contextPath = contextPathIn(home);
      if (!fs.existsSync(contextPath)) continue;
      const existing = fs.readFileSync(contextPath, 'utf-8');
      const next = stripWmuxBlock(existing);
      if (next === null || next === existing) continue;
      if (next.trim() === '') fs.unlinkSync(contextPath);
      else fs.writeFileSync(contextPath, next, 'utf-8');
      console.log('[wmux] Removed wmux context from', contextPath);
    } catch (err) {
      console.warn('[wmux] Failed to remove Qwen context:', err);
    }
  }
}

// ─── Hooks: ~/.qwen/settings.json `hooks` ────────────────────────────────────

/** Appended to every command wmux registers in Qwen's settings. */
export const QWEN_PROVIDER_ARG = '--provider qwen';

/**
 * Tools tracked by a per-tool PostToolUse entry, in Claude's spelling. Qwen
 * accepts Claude tool names as exact matcher aliases (`Bash` matches
 * `run_shell_command`), so the matchers stay Claude's, and the helper's argv
 * carries the name every consumer in wmux already understands.
 */
const QWEN_TRACKED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Agent', 'WebSearch', 'WebFetch', 'Skill'];

/**
 * Lifecycle events, and whether each runs in the background. Claude's set
 * (claude-context.ts explains each choice) plus StopFailure, which Qwen fires
 * INSTEAD of Stop on an API error or loop detection — without it such a turn
 * left the pane reading `working`. wmux-hook.js reports it as `Stop`.
 * `async` needs Qwen 0.15.0+; older versions ignore the field.
 */
const QWEN_EVENT_HOOKS: ReadonlyArray<{ event: string; async: boolean }> = [
  { event: 'Notification', async: false },
  { event: 'Stop', async: false },
  { event: 'StopFailure', async: false },
  { event: 'SubagentStop', async: false },
  { event: 'SubagentStart', async: true },
  { event: 'SessionStart', async: false },
  { event: 'UserPromptSubmit', async: true },
  { event: 'PreToolUse', async: true },
  { event: 'SessionEnd', async: false },
];

/** Every hook array wmux writes into — and therefore the only ones it removes from. */
export const QWEN_HOOK_EVENTS = ['PostToolUse', ...QWEN_EVENT_HOOKS.map(h => h.event)];

/**
 * The hook script as it appears on Qwen's command line: bare when it can be,
 * quoted only when it must.
 *
 * Bare is not cosmetic. Launched from PowerShell or cmd (no `MSYSTEM`), Qwen
 * runs a hook as `spawn(ComSpec, ['/d', '/s', '/c', command], {shell: false})`
 * WITHOUT `windowsVerbatimArguments` — so Node escapes every `"` in the command
 * as `\"`, cmd.exe does not unescape it, and node receives a literal quote:
 * `node "C:/Users/me/OneDrive - Org/…/wmux-hook.js"` arrived as
 * `"C:/Users/me/OneDrive` and died on MODULE_NOT_FOUND, so a Qwen pane started
 * from pwsh never reported a single event. Measured on Qwen 0.26.1; from Git
 * Bash it picks bash instead, which is why a probe run THERE passes — verify
 * from pwsh. A command with no quotes at all reads the same to cmd, bash and
 * PowerShell. Bare (through the stub below) is the 2.42.1 fix.
 */
export function qwenHookTarget(hookScript: string): string {
  return /^[\w.:/~-]+$/.test(hookScript) ? hookScript : `"${hookScript}"`;
}

export function qwenToolHookCommand(hookScript: string, tool: string): string {
  return `node ${qwenHookTarget(hookScript)} ${tool} ${QWEN_PROVIDER_ARG}`;
}

export function qwenEventHookCommand(hookScript: string, event: string): string {
  return `node ${qwenHookTarget(hookScript)} --event ${event} ${QWEN_PROVIDER_ARG}`;
}

/**
 * Every shape wmux has written: the quoted path to resources/cli/wmux-hook.js
 * (≤ 2.42.0) and the bare or quoted path to the stub in Qwen's home.
 */
const WMUX_QWEN_COMMAND_RE = /^node (?:"[^"]*(?:wmux-hook\.js|wmux-qwen-hook\.cjs)"|\S*(?:wmux-hook\.js|wmux-qwen-hook\.cjs)) .*--provider qwen$/;

/**
 * The stub Qwen's hooks run: one `require` of the real helper, written into
 * Qwen's home. The install path (`…/OneDrive - Org/…/resources/cli`) is where
 * the spaces are, and inside a JS string literal no shell ever sees it; Qwen's
 * home is usually space-free, so the command needs no quotes (see
 * {@link qwenHookTarget}). `process.argv.slice(2)` is the same through the
 * stub, and the helper resolves its own siblings from its real location.
 * Known gap: a Qwen home WITH a space still gets the quoted form, which cmd
 * breaks — only Qwen passing `windowsVerbatimArguments` fixes that.
 */
export const QWEN_HOOK_STUB = 'wmux-qwen-hook.cjs';
const STUB_MARKER = '// wmux-qwen-hook: written by wmux';

export function qwenHookStubSource(hookScript: string): string {
  return `${STUB_MARKER}. Qwen Code hooks run this; regenerated on every wmux launch.\nrequire(${JSON.stringify(hookScript)});\n`;
}

const stubPathIn = (home: string) => path.join(home, QWEN_HOOK_STUB);

/** Writes the stub when it differs; answers the forward-slashed path commands name. */
function ensureQwenHookStub(home: string, hookScript: string): string {
  const stubPath = stubPathIn(home);
  const source = qwenHookStubSource(hookScript);
  let existing: string | null = null;
  try { existing = fs.readFileSync(stubPath, 'utf-8'); } catch { /* not written yet */ }
  if (existing !== source) fs.writeFileSync(stubPath, source, 'utf-8');
  return stubPath.split(path.sep).join('/');
}

/** Deletes the stub — only one wmux wrote, never a user's file of that name. */
function removeQwenHookStub(home: string): void {
  const stubPath = stubPathIn(home);
  try {
    if (fs.readFileSync(stubPath, 'utf-8').startsWith(STUB_MARKER)) fs.unlinkSync(stubPath);
  } catch { /* absent */ }
}

function isWmuxQwenEntry(entry: unknown): boolean {
  const hooks = (entry as { hooks?: unknown })?.hooks;
  return Array.isArray(hooks) && hooks.some((h: any) => typeof h?.command === 'string' && WMUX_QWEN_COMMAND_RE.test(h.command));
}

const stripWmuxEntries = (entries: unknown): unknown[] =>
  (Array.isArray(entries) ? entries : []).filter(e => !isWmuxQwenEntry(e));

function isRecord(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Pure: `settings` with wmux's Qwen hooks in place — any earlier wmux entry
 * replaced, every user hook and every other key kept. Returns a new object.
 */
export function applyQwenHooks(settings: unknown, hookScript: string): Record<string, any> {
  const next: Record<string, any> = { ...(isRecord(settings) ? settings : {}) };
  const hooks: Record<string, any> = { ...(isRecord(next.hooks) ? next.hooks : {}) };

  hooks.PostToolUse = [
    ...stripWmuxEntries(hooks.PostToolUse),
    ...QWEN_TRACKED_TOOLS.map(tool => ({
      matcher: tool,
      hooks: [{ type: 'command', command: qwenToolHookCommand(hookScript, tool), async: true }],
    })),
  ];
  for (const { event, async } of QWEN_EVENT_HOOKS) {
    const handler = { type: 'command', command: qwenEventHookCommand(hookScript, event), ...(async ? { async: true } : {}) };
    hooks[event] = [...stripWmuxEntries(hooks[event]), { hooks: [handler] }];
  }
  next.hooks = hooks;
  return next;
}

/**
 * Pure inverse of {@link applyQwenHooks}. Arrays left empty are deleted, and a
 * `hooks` object left empty goes too — a declined integration leaves the file
 * indistinguishable from one wmux never touched.
 */
export function removeQwenHooksFrom(settings: unknown): Record<string, any> {
  const next: Record<string, any> = { ...(isRecord(settings) ? settings : {}) };
  if (!isRecord(next.hooks)) return next;
  const hooks: Record<string, any> = { ...next.hooks };
  for (const event of QWEN_HOOK_EVENTS) {
    if (!(event in hooks)) continue;
    const kept = stripWmuxEntries(hooks[event]);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete next.hooks;
  else next.hooks = hooks;
  return next;
}

/**
 * Read, transform and write Qwen's settings.json — only when it changes.
 *
 * Qwen's settings may hold comments (it is a Gemini CLI fork), which JSON.parse
 * refuses: such a file is left alone rather than rewritten without them. A
 * missing file is created only when `createIfMissing` and Qwen's home exists.
 */
function updateQwenSettings(
  settingsPath: string,
  transform: (settings: Record<string, any>) => Record<string, any>,
  createIfMissing: boolean,
): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, 'utf-8');
  } catch {
    if (!createIfMissing || !isDirectory(path.dirname(settingsPath))) return false;
    raw = '{}';
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    console.warn(`[wmux] ${settingsPath} is not plain JSON (comments?) — leaving it alone`);
    return false;
  }
  if (!isRecord(parsed)) return false;
  const before = JSON.stringify(parsed, null, 2);
  const after = JSON.stringify(transform(parsed), null, 2);
  if (after === before) return false;
  fs.writeFileSync(settingsPath, after + '\n', 'utf-8');
  return true;
}

export function ensureQwenHooks(): void {
  try {
    if (!isDirectory(getQwenHome())) return;
    const hookScript = ensureQwenHookStub(getQwenHome(), getHookScriptPath());
    if (updateQwenSettings(getQwenSettingsPath(), s => applyQwenHooks(s, hookScript), true)) {
      console.log(`[wmux] Configured ${QWEN_HOOK_EVENTS.join('/')} hooks in`, getQwenSettingsPath());
    }
  } catch (err) {
    console.warn('[wmux] Failed to update Qwen hooks:', err);
  }
}

export function removeQwenHooks(): void {
  for (const home of qwenHomes()) {
    try {
      if (updateQwenSettings(settingsPathIn(home), removeQwenHooksFrom, false)) {
        console.log('[wmux] Removed wmux hooks from', settingsPathIn(home));
      }
      removeQwenHookStub(home);
    } catch (err) {
      console.warn('[wmux] Failed to remove Qwen hooks:', err);
    }
  }
}

// ─── Browser MCP: ~/.qwen/settings.json `mcpServers` ─────────────────────────
//
// Qwen reads user-scope MCP servers from settings.json, in the same
// `{command, args}` shape as Claude's ~/.claude.json — so the same entry, the
// same "did wmux author this" test and the same inverse apply unchanged.

export function ensureQwenMcp(): void {
  try {
    if (!isDirectory(getQwenHome())) return;
    const changed = updateQwenSettings(getQwenSettingsPath(), s => applyChromeDevtoolsMcp(s).next, true);
    if (changed) console.log('[wmux] Configured chrome-devtools-mcp in', getQwenSettingsPath(), '→ localhost:9222');
  } catch (err) {
    console.warn('[wmux] Failed to update chrome-devtools-mcp for Qwen:', err);
  }
}

export function removeQwenMcp(): void {
  for (const home of qwenHomes()) {
    try {
      if (updateQwenSettings(settingsPathIn(home), s => stripChromeDevtoolsMcp(s).next, false)) {
        console.log('[wmux] Removed chrome-devtools-mcp from', settingsPathIn(home));
      }
    } catch (err) {
      console.warn('[wmux] Failed to remove chrome-devtools-mcp for Qwen:', err);
    }
  }
}
