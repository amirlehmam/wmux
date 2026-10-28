/**
 * Grok Build (xAI's `grok` CLI) integration.
 *
 * Grok needs less from wmux than any agent before it, because it already reads
 * Claude Code's files: with its Claude compatibility on (every `[compat.claude]`
 * cell defaults to true) it loads ~/.claude/CLAUDE.md and runs the hooks in
 * ~/.claude/settings.json. So a machine with the Claude integration granted was
 * already teaching Grok about wmux. This module covers the two places that
 * falls short.
 *
 * ── Hooks: $GROK_HOME/hooks/wmux.json ────────────────────────────────────────
 *
 * The same entries `applyWmuxHooks` writes for Claude Code, byte for byte, plus
 * the two turn endings only Grok has. `StopCancelled` runs INSTEAD of `Stop`
 * when a turn ends without completing (Ctrl+C, a declined permission, the turn
 * limit) and `StopFailure` instead of it on an API error; without them an
 * interrupted Grok turn left the pane reading `working` until the trust window
 * aged it out. wmux-hook.js reports both as `Stop`, which is what ends an
 * interrupted turn; fired inside a subagent (`subagentType` on the payload)
 * they become `SubagentStop`, which ends only the child and never the
 * parent's turn (see `reportedEvent`).
 *
 * Duplicating the Claude entries is safe because Grok dedupes handlers across
 * sources on (event, command, url, matcher) — so with compat on each hook runs
 * once, and with `compat.claude.hooks = false` this file alone still carries
 * the full set. That only holds while the bytes match — any drift in the
 * command bytes runs every hook twice — which is why the command strings come
 * from claude-context.ts (`applyWmuxHooks` + `wmuxEventHookCommand`) rather
 * than being spelled again here.
 *
 * The helper also reads Grok's camelCase envelope (`notificationType`,
 * `toolName`, `toolInput`; grok 1.0.44 sends the notification type ONLY in
 * camelCase), and never forwards a session id when `GROK_HOOK_EVENT` is set:
 * Grok sends a snake_case `session_id` alias too, and it would reach a
 * `claude --resume` line on restore.
 *
 * ── Instructions: $GROK_HOME/rules/wmux.md, only when Grok would miss them ───
 *
 * Grok loads every `*.md` in its home rules dir, so like Kiro this is a file of
 * wmux's own. But it is written only when Grok will NOT already read the wmux
 * block out of ~/.claude/CLAUDE.md — otherwise every Grok session would load the
 * same ~5 KB of instructions twice.
 *
 * Nothing is written unless Grok's home directory exists: creating ~/.grok on a
 * machine that has never run Grok would be the #132 mistake.
 *
 * ── Three things #259's live test could not reach ────────────────────────────
 *
 * The account had no usage, so no successful turn, no subagent and no
 * background task; Grok's own hook docs settle all three.
 *
 *  1. A Grok subagent is its OWN session firing the same hooks on the parent's
 *     pane, marked `subagentType`. Its `SessionEnd` released the pane's record
 *     mid-turn, and its `UserPromptSubmit` — the task brief — cleared a "Needs
 *     you" nobody answered and entered the prompt log as something the user
 *     typed. So `reportedEvent` in wmux-hook.js reports neither (its tool
 *     events and Notifications still pass).
 *  2. `task_complete` fires when a background shell exits. Under the
 *     unknown-type default of `claude-notification.ts` that was "Needs you"
 *     plus the bell, so it is `info` there.
 *  3. Ownership of hooks/wmux.json is STRUCTURAL, not "contains `wmux-hook`" —
 *     see `isWmuxHooksFile` below.
 *
 * ── Known gap, not fixed ─────────────────────────────────────────────────────
 *
 * Grok documents that a `StopCancelled` report may arrive AFTER the next
 * turn's `UserPromptSubmit` (it is dispatched off the command loop; the fix is
 * tracking `promptId`), so a cancel followed at once by a queued prompt can
 * read idle until that turn's first tool call.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readRenderedInstructions } from './agent-instructions';
import {
  applyWmuxHooks,
  getClaudeMdPath,
  getHookScriptPath,
  wmuxEventHookCommand,
} from './claude-context';

const START_MARKER = '<!-- wmux:start';

/** Grok's turn endings that Claude Code has no equivalent for. */
const GROK_ONLY_EVENTS = ['StopCancelled', 'StopFailure'] as const;

function defaultGrokHome(): string {
  return path.join(os.homedir(), '.grok');
}

/**
 * `$GROK_HOME`, default ~/.grok — the root of both the rules and hooks dirs.
 *
 * The override is read only from wmux's OWN environment (one exported per-shell
 * after launch is unknowable here — a miss, never a write to the wrong place),
 * and only when it is ABSOLUTE. A relative value means "relative to wherever
 * grok is started", which is a different directory for every pane and not the
 * one wmux happens to be running in; resolving it against wmux's cwd would
 * write hooks into a folder nobody named.
 */
export function getGrokHome(): string {
  const override = process.env.GROK_HOME?.trim();
  return override && path.isAbsolute(override) ? path.normalize(override) : defaultGrokHome();
}

/**
 * Every home wmux may have written into: the current one, and the default. They
 * differ only while GROK_HOME is set, and removal sweeps both — an uninstall
 * that only looks where it would write TODAY leaves behind the file it wrote
 * before the variable was set, which is an inverse that cannot undo (#132).
 */
function grokHomes(): string[] {
  return [...new Set([getGrokHome(), defaultGrokHome()])];
}

const rulesPathIn = (home: string) => path.join(home, 'rules', 'wmux.md');
const hooksPathIn = (home: string) => path.join(home, 'hooks', 'wmux.json');

export function getGrokRulesPath(): string {
  return rulesPathIn(getGrokHome());
}

export function getGrokHooksPath(): string {
  return hooksPathIn(getGrokHome());
}

function readOrEmpty(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

/**
 * Pure: does this config.toml switch `compat.claude.agents` off?
 *
 * Accepts the `[compat.claude]` table, a dotted key under `[compat]`, and a
 * fully dotted key at the top level.
 * ponytail: line scan, not a TOML parser — an inline table
 * (`claude = { agents = false }`) reads as "on". The miss costs a Grok session
 * the wmux instructions, which is where things stood before; add a parser if
 * anyone writes it that way.
 */
export function claudeAgentsCompatOff(toml: string): boolean {
  let table = '';
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/\s#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[[')) { table = '\0'; continue; } // array of tables: never ours
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { table = header[1].replace(/["'\s]/g, ''); continue; }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (!kv) continue;
    const key = [table, kv[1].replace(/["'\s]/g, '')].filter(Boolean).join('.');
    if (key === 'compat.claude.agents') return kv[2].trim() === 'false';
  }
  return false;
}

/**
 * Will Grok already see the wmux block in ~/.claude/CLAUDE.md?
 *
 * Resolved the way Grok resolves the cell — env var over config.toml over the
 * default (on). The env var read is wmux's own, which every pane inherits; one
 * exported per-shell after launch is unknowable here, and the worst case is the
 * instructions loading twice.
 */
export function grokReadsClaudeContext(): boolean {
  const env = process.env.GROK_CLAUDE_AGENTS_ENABLED?.trim();
  const compatOn = env
    ? !/^(0|false|no|off)$/i.test(env)
    : !claudeAgentsCompatOff(readOrEmpty(path.join(getGrokHome(), 'config.toml')));
  return compatOn && readOrEmpty(getClaudeMdPath()).includes(START_MARKER);
}

/** Pure: the whole hooks file, given the absolute path to wmux-hook.js. */
export function buildGrokHooks(hookScript: string): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = { ...applyWmuxHooks({}, hookScript).hooks };
  for (const event of GROK_ONLY_EVENTS) {
    hooks[event] = [{ hooks: [{ type: 'command', command: wmuxEventHookCommand(hookScript, event) }] }];
  }
  return { hooks };
}

/**
 * Write `content` to a file wmux owns inside Grok's home, or leave a same-named
 * file of the user's alone. No-op when Grok has never run here.
 */
function writeOwnedFile(filePath: string, content: string, isOurs: (s: string) => boolean): void {
  if (!isDirectory(getGrokHome())) return;
  if (fs.existsSync(filePath)) {
    const current = fs.readFileSync(filePath, 'utf-8');
    if (!isOurs(current)) {
      console.warn(`[wmux] ${filePath} exists and is not wmux-managed — leaving it alone`);
      return;
    }
    if (current === content) return; // already current; don't churn the mtime
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  console.log(`[wmux] Updated ${filePath}`);
}

function removeOwnedFile(filePath: string, isOurs: (s: string) => boolean): void {
  if (!fs.existsSync(filePath)) return;
  if (!isOurs(fs.readFileSync(filePath, 'utf-8'))) return;
  fs.unlinkSync(filePath);
  console.log(`[wmux] Removed ${filePath}`);
}

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `node "<anything>wmux-hook.js" <arg>` — the only command shape wmux registers. */
const WMUX_HOOK_COMMAND_RE = /^node "[^"]*wmux-hook\.js" \S/;

function isWmuxHandler(handler: unknown): boolean {
  return isRecord(handler)
    && handler.type === 'command'
    && typeof handler.command === 'string'
    && WMUX_HOOK_COMMAND_RE.test(handler.command);
}

/** Every handler under one event, or null when it is not a list of matcher groups. */
function handlersOf(groups: unknown): unknown[] | null {
  if (!Array.isArray(groups)) return null;
  const out: unknown[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return null;
    out.push(...group.hooks);
  }
  return out;
}

/**
 * Pure: is this hooks file ENTIRELY wmux's?
 *
 * JSON has no comment to carry a marker, and "contains the string wmux-hook" is
 * not ownership: `wmux.json` is the obvious name for a file a user writes by
 * hand to wire Grok into wmux, and the moment they add one hook of their own to
 * it a substring test has wmux overwrite that hook on the next launch and delete
 * it when the toggle goes off. So the test is structural — nothing but a `hooks`
 * object, and every handler in it a wmux-hook.js command. One foreign handler,
 * one extra top-level key, or a file that does not parse, and it is the user's.
 * It matches the command SHAPE rather than this install's path, so a file
 * written before the install moved is still recognised and refreshed.
 */
export function isWmuxHooksFile(content: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return false; }
  if (!isRecord(parsed) || !isRecord(parsed.hooks)) return false;
  if (Object.keys(parsed).some(k => k !== 'hooks')) return false;
  let count = 0;
  for (const groups of Object.values(parsed.hooks)) {
    const handlers = handlersOf(groups);
    if (!handlers?.every(isWmuxHandler)) return false;
    count += handlers.length;
  }
  return count > 0;
}

const isOurRules = (s: string) => s.includes(START_MARKER);

/**
 * Called AFTER ensureClaudeContext, so the CLAUDE.md check sees this launch's
 * write. When Grok reads that block, a rules file left by an earlier launch
 * (compat was off then) is removed rather than kept as a duplicate.
 */
export function ensureGrokContext(): void {
  try {
    if (grokReadsClaudeContext()) { removeGrokContext(); return; }
    // Rendered, not read: carries this install's absolute CLI path (#158).
    const rendered = readRenderedInstructions();
    if (rendered === null) return;
    writeOwnedFile(getGrokRulesPath(), rendered.trimEnd() + '\n', isOurRules);
  } catch (err) {
    console.warn('[wmux] Failed to update Grok context:', err);
  }
}

export function removeGrokContext(): void {
  try {
    for (const home of grokHomes()) removeOwnedFile(rulesPathIn(home), isOurRules);
  } catch (err) {
    console.warn('[wmux] Failed to remove Grok context:', err);
  }
}

export function ensureGrokHooks(): void {
  try {
    const content = JSON.stringify(buildGrokHooks(getHookScriptPath()), null, 2) + '\n';
    writeOwnedFile(getGrokHooksPath(), content, isWmuxHooksFile);
  } catch (err) {
    console.warn('[wmux] Failed to update Grok hooks:', err);
  }
}

export function removeGrokHooks(): void {
  try {
    for (const home of grokHomes()) removeOwnedFile(hooksPathIn(home), isWmuxHooksFile);
  } catch (err) {
    console.warn('[wmux] Failed to remove Grok hooks:', err);
  }
}
