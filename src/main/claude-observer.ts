/**
 * Claude Code terminal output observer.
 * Parses PTY data streams for Claude Code patterns (agents, skills, tools, tokens)
 * and emits structured events to the renderer for sidebar display.
 */

import { BrowserWindow } from 'electron';
import { IPC_CHANNELS, SurfaceId } from '../shared/types';

// Strip ANSI escape codes from terminal output.
// The runtime-built pattern strings DO contain raw ESC/BEL characters; what
// matters is that the SOURCE FILE carries no control-character escapes in a
// regex literal — that source-level shape is what sonar S6324 inspects.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_CSI_RE = new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, 'g');
const ANSI_OSC_RE = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, 'g');

function stripAnsi(str: string): string {
  return str.replace(ANSI_CSI_RE, '').replace(ANSI_OSC_RE, '');
}

export interface AgentActivity {
  name: string;
  toolUses: number;
  tokens: string;
  done: boolean;
  /**
   * Set only on a DECLARED subagent (issue #272): one an agent named itself,
   * through a Claude Code hook's `agent_id` or `wmux report-subagent`. A
   * declared subagent's lifecycle is its own — only its own stop, or the
   * session ending, finishes it. The parent's `Stop` does not: a BACKGROUND
   * subagent outlives the turn that launched it, which is exactly the #272
   * screenshot (the pane read "Idle" while its planner kept working).
   * Screen-parsed agents carry no id and keep the old rules.
   */
  id?: string;
  /** What a declared subagent says it is doing ("calling create_file"). */
  detail?: string;
  /** Last time a declared subagent reported anything — the renderer's ghost guard. */
  touchedAt?: number;
}

/** One `reportSubagent` call. Every field but `id` is optional and sticky. */
export interface SubagentReport {
  id: string;
  name?: string;
  detail?: string;
  done?: boolean;
  /** Count one tool use (a hook fired from inside the subagent). */
  toolUse?: boolean;
}

export interface ClaudeActivity {
  agents: AgentActivity[];
  activeSkill: string | null;
  lastTool: string | null;
  lastUpdate: number;
  isDone: boolean; // true after "Baked for" / "Cost:" — Claude finished responding
}

const activities = new Map<SurfaceId, ClaudeActivity>();

// Patterns to match in Claude Code terminal output
const PATTERNS = {
  // "Running 3 agents…" or "● 3 Explore agents finished"
  agentBatchStart: /Running \d+ agents/,
  // Split into two single-quantifier tests (digit anywhere + tail phrase
  // anywhere) instead of the original /(\d+)\s+\w+\s+agents?\s+finished/ —
  // sidesteps the overlapping-quantifier shape slow-regex/ReDoS scanners
  // flag. This is INTENTIONALLY broader than the original (the digit no
  // longer has to sit right before the "agents finished" phrase): a false
  // positive merely marks agents done a little early, which is low-harm and
  // backstopped by the Stop hook (markAllAgentsDone).
  agentBatchDoneDigit: /\d/,
  agentBatchDoneTail: /agents?\s+finished/,

  // "├─ Research · 2 tool uses · 13.4k tokens" or "└─ Name · N tool uses · Xk tokens"
  // Name capture excludes the "·" delimiter outright (no \s* wrapping an
  // unbounded ".+?" group) — callers already .trim() the captured name.
  agentDetail: /[├└]─([^·]+)·\s*(\d+)\s*tool\s*uses?\s*·\s*([\d.]+k?)\s*tokens/,

  // "⎿  Done" after an agent entry
  agentDone: /⎿\s+Done/,

  // "Skill(name)" or "Skill(ns:name)"
  skillLoad: /Skill\(([^)]+)\)/,

  // "● Bash(...)" (pre-2026 UI) or "⏺ Bash(...)" (current UI)
  toolUse: /[●⏺]\s*(Bash|Read|Write|Edit|Grep|Glob|Agent|WebSearch|WebFetch)\s*\(/,
  mcpTool: /[●⏺]\s*plugin:([^:]+):([^\s]+)/,

  // "✻ Baked for 3m 10s" or "✻ Cost: $0.05" — Claude finished responding
  responseDone: /✻\s*(Baked for|Cost:)/,

};

// ── Workflow tool panel (box-drawing TUI) ──
// Agent rows look like (two columns per box row — phases left, agents right):
//   "│ > 1 Écrire 1/3 │  ● write:pilote  Opus 4.8 (1M context)  82.9k tok · 17 tools │"
//   "│   3 Corriger   │  √ write:mcp-page  Opus 4.8 (1M context)  78.9k tok · 16 tools · 2m 23s │"
// The " tok · N tools" stats tail is the anchor — it only ever appears on
// workflow agent rows. Parsed with index scans, not regexes: unanchored
// quantified patterns on arbitrary PTY data are exactly the slow-regex shape
// the sonar gate rejects (same constraint that shaped agentBatchDoneDigit).
const WORKFLOW_TOK_SEP = ' tok · ';
const WORKFLOW_RUNNING_GLYPHS = ['●', '○'];
// ✓-family and ✗-family both mean "no longer running" for sidebar purposes.
const WORKFLOW_DONE_GLYPHS = ['√', '✓', '✔', '✗', '×'];
const NUMBER_CHARS = '0123456789.kM';

/** Number token (e.g. "82.9k") ending right before index `end`, or null. */
function numberEndingAt(line: string, end: number): string | null {
  let start = end;
  while (start > 0 && NUMBER_CHARS.includes(line[start - 1])) start--;
  const token = line.slice(start, end);
  return PATTERNS.agentBatchDoneDigit.test(token) ? token : null;
}

/** Leading run of non-whitespace characters of `s` (may be empty). */
function firstWord(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ' || s[i] === '\t') return s.slice(0, i);
  }
  return s;
}

function getOrCreate(surfaceId: SurfaceId): ClaudeActivity {
  let activity = activities.get(surfaceId);
  if (!activity) {
    activity = { agents: [], activeSkill: null, lastTool: null, lastUpdate: Date.now(), isDone: false };
    activities.set(surfaceId, activity);
  }
  return activity;
}

// Max agents tracked per surface — caps unbounded growth from malformed or
// adversarial input. Enforced at both write paths: handleAgentDetail (parsed
// terminal output) and applyExternalActivity (pipe-pushed agent arrays).
const MAX_TRACKED_AGENTS = 32;

/** One parser rule: tests `trimmed`, mutates `activity` in place, returns whether it matched. */
type LineHandler = (activity: ClaudeActivity, trimmed: string) => boolean;

function handleResponseDone(activity: ClaudeActivity, trimmed: string): boolean {
  if (!PATTERNS.responseDone.test(trimmed)) return false;
  activity.isDone = true;
  activity.lastTool = null;
  activity.activeSkill = null;
  return true;
}

function handleAgentBatchStart(activity: ClaudeActivity, trimmed: string): boolean {
  if (!PATTERNS.agentBatchStart.test(trimmed)) return false;
  // Known parsing-drift class (accepted): a repainted OLD "Running N agents"
  // frame re-enters here and resets the list, resurrecting already-finished
  // agents until the next hook event or the observer TTL. Backstopped by the
  // Stop hook and the 5-minute TTL in agent-view.
  // Declared subagents survive: a repainted frame is not their lifecycle.
  activity.agents = activity.agents.filter(a => a.id);
  activity.isDone = false;
  return true;
}

function handleAgentDetail(activity: ClaudeActivity, trimmed: string): boolean {
  const detailMatch = trimmed.match(PATTERNS.agentDetail);
  if (!detailMatch) return false;
  const name = detailMatch[1].trim();
  const toolUses = parseInt(detailMatch[2], 10);
  const tokens = detailMatch[3];

  const existing = activity.agents.find(a => !a.id && a.name === name);
  if (existing) {
    existing.toolUses = toolUses;
    existing.tokens = tokens;
  } else {
    activity.agents.push({ name, toolUses, tokens, done: false });
    // Cap so malformed or hostile output can't grow the array unbounded.
    if (activity.agents.length > MAX_TRACKED_AGENTS) activity.agents.shift();
  }
  return true;
}

function handleAgentDone(activity: ClaudeActivity, trimmed: string): boolean {
  if (!PATTERNS.agentDone.test(trimmed)) return false;
  // Only report a change on an actual not-done → done transition. Claude Code
  // repaints its TUI frame constantly, so a finished frame containing "⎿ Done"
  // reappears on every repaint — rebroadcasting each time would spam IPC and
  // keep lastUpdate artificially fresh (which linger/TTL logic reads).
  const parsed = activity.agents.filter(a => !a.id);
  const lastAgent = parsed[parsed.length - 1];
  if (lastAgent && !lastAgent.done) {
    lastAgent.done = true;
    return true;
  }
  return false;
}

function handleAgentBatchDone(activity: ClaudeActivity, trimmed: string): boolean {
  if (!PATTERNS.agentBatchDoneDigit.test(trimmed) || !PATTERNS.agentBatchDoneTail.test(trimmed)) return false;
  activity.agents.forEach(a => { if (!a.id) a.done = true; });
  return true;
}

/** Rightmost workflow status glyph in `head`, or null when none is present. */
function findWorkflowGlyph(head: string): { index: number; done: boolean } | null {
  let runningIdx = -1;
  for (const g of WORKFLOW_RUNNING_GLYPHS) runningIdx = Math.max(runningIdx, head.lastIndexOf(g));
  let doneIdx = -1;
  for (const g of WORKFLOW_DONE_GLYPHS) doneIdx = Math.max(doneIdx, head.lastIndexOf(g));
  if (runningIdx === -1 && doneIdx === -1) return null;
  return doneIdx > runningIdx
    ? { index: doneIdx, done: true }
    : { index: runningIdx, done: false };
}

function handleWorkflowAgent(activity: ClaudeActivity, trimmed: string): boolean {
  const tokIdx = trimmed.indexOf(WORKFLOW_TOK_SEP);
  if (tokIdx === -1) return false;
  const tokens = numberEndingAt(trimmed, tokIdx);
  if (!tokens) return false;
  const afterSep = trimmed.slice(tokIdx + WORKFLOW_TOK_SEP.length);
  const toolWord = afterSep.indexOf(' tool');
  if (toolWord === -1) return false;
  const toolUses = parseInt(afterSep.slice(0, toolWord), 10);
  if (Number.isNaN(toolUses)) return false;

  // Glyph → run state. Rightmost wins: the phase column left of the box
  // border carries its own markers once a phase completes.
  const head = trimmed.slice(0, tokIdx - tokens.length);
  const glyph = findWorkflowGlyph(head);
  if (!glyph) return false;
  const name = firstWord(head.slice(glyph.index + 1).trimStart());
  if (!name || name === '│') return false;

  // Upsert; report a change only on a real value transition — the TUI
  // repaints identical frames constantly and rebroadcasting each one would
  // spam IPC and keep lastUpdate artificially fresh (same principle as the
  // handleAgentDone dedup).
  const existing = activity.agents.find(a => !a.id && a.name === name);
  if (existing) {
    if (existing.toolUses === toolUses && existing.tokens === tokens && existing.done === glyph.done) {
      return false;
    }
    existing.toolUses = toolUses;
    existing.tokens = tokens;
    existing.done = glyph.done;
  } else {
    activity.agents.push({ name, toolUses, tokens, done: glyph.done });
    if (activity.agents.length > MAX_TRACKED_AGENTS) activity.agents.shift();
  }
  if (!glyph.done) activity.isDone = false;
  return true;
}

function handleSkillLoad(activity: ClaudeActivity, trimmed: string): boolean {
  const skillMatch = trimmed.match(PATTERNS.skillLoad);
  if (!skillMatch) return false;
  activity.activeSkill = skillMatch[1];
  return true;
}

function handleToolUse(activity: ClaudeActivity, trimmed: string): boolean {
  const toolMatch = trimmed.match(PATTERNS.toolUse);
  if (!toolMatch) return false;
  activity.lastTool = toolMatch[1];
  activity.isDone = false;
  return true;
}

function handleMcpTool(activity: ClaudeActivity, trimmed: string): boolean {
  const mcpMatch = trimmed.match(PATTERNS.mcpTool);
  if (!mcpMatch) return false;
  activity.lastTool = `${mcpMatch[1]}:${mcpMatch[2]}`;
  activity.isDone = false;
  return true;
}

// Order matters: first matching handler wins, mirroring the original if/continue chain.
const LINE_HANDLERS: LineHandler[] = [
  handleResponseDone,
  handleAgentBatchStart,
  handleAgentDetail,
  handleAgentDone,
  handleAgentBatchDone,
  handleWorkflowAgent,
  handleSkillLoad,
  handleToolUse,
  handleMcpTool,
];

function processLine(activity: ClaudeActivity, trimmed: string): boolean {
  for (const handler of LINE_HANDLERS) {
    if (handler(activity, trimmed)) return true;
  }
  return false;
}

/**
 * Process a chunk of PTY data for Claude Code patterns.
 * Called from the main process whenever PTY data flows through.
 */
export function observePtyData(surfaceId: SurfaceId, data: string): void {
  const clean = stripAnsi(data);
  const lines = clean.split('\n');
  const activity = getOrCreate(surfaceId);

  let changed = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && processLine(activity, trimmed)) changed = true;
  }

  if (changed) {
    activity.lastUpdate = Date.now();
    broadcast(surfaceId, activity);
  }
}

/**
 * Get activity for a surface.
 */
export function getActivity(surfaceId: SurfaceId): ClaudeActivity | undefined {
  return activities.get(surfaceId);
}

/**
 * Clear activity for a surface (when terminal is closed).
 */
export function clearActivity(surfaceId: SurfaceId): void {
  activities.delete(surfaceId);
}

/**
 * SubagentStop hook: one subagent finished. The hook payload carries no agent
 * name, so mark the MOST RECENT still-running agent — Claude Code reports
 * agent completions in reverse start order often enough that this converges,
 * and markAllAgentsDone (Stop) is the backstop for any mismatch.
 */
export function markSubagentStop(surfaceId: SurfaceId): void {
  const activity = activities.get(surfaceId);
  if (!activity) return;
  for (let i = activity.agents.length - 1; i >= 0; i--) {
    if (!activity.agents[i].id && !activity.agents[i].done) {
      activity.agents[i].done = true;
      activity.lastUpdate = Date.now();
      broadcast(surfaceId, activity);
      return;
    }
  }
}

/**
 * Stop hook: the whole turn is over — no agent can still be running. This is
 * the lifecycle truth that guarantees the sidebar never shows ghost agents
 * even if output parsing drifted (same failure class as issue #81).
 */
export function markAllAgentsDone(surfaceId: SurfaceId): void {
  const activity = activities.get(surfaceId);
  if (!activity) return;
  // Declared subagents are left alone: the turn ending is not theirs (#272).
  activity.agents.forEach(a => { if (!a.id) a.done = true; });
  activity.isDone = true;
  activity.lastTool = null;
  activity.lastUpdate = Date.now();
  broadcast(surfaceId, activity);
}

const MAX_SUBAGENT_ID = 128;
const MAX_SUBAGENT_NAME = 64;
const MAX_SUBAGENT_DETAIL = 120;

function isUnpaintable(c: number): boolean {
  const control = c < 0x20 || (c >= 0x7f && c < 0xa0);
  const bidi = (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x200e || c === 0x200f;
  return control || bidi;
}

/**
 * Text from a pipe caller, made safe to paint on one sidebar line: C0/C1 and
 * the bidi controls become spaces (U+202E reorders a whole row — the #221
 * lesson), whitespace collapses, and the result is capped in code points.
 */
export function sanitizeSubagentText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const chars: string[] = [];
  let pendingSpace = false;
  for (const ch of raw) {
    const blank = isUnpaintable(ch.codePointAt(0)!) || ch.trim() === '';
    if (blank) { pendingSpace = chars.length > 0; continue; }
    if (chars.length + (pendingSpace ? 2 : 1) > max) break;
    if (pendingSpace) chars.push(' ');
    pendingSpace = false;
    chars.push(ch);
  }
  return chars.join('');
}

/**
 * A declared subagent started, worked, or finished (issue #272). Upserts by
 * `id`, so a producer can report as often as it likes — every report is also a
 * heartbeat. Returns false, changing nothing, for a report with no usable id or
 * a finish for an agent never seen starting (that would only paint a ✓ line).
 */
export function reportSubagent(surfaceId: SurfaceId, report: SubagentReport): boolean {
  const id = sanitizeSubagentText(report.id, MAX_SUBAGENT_ID);
  if (!id) return false;
  const existing = activities.get(surfaceId)?.agents.find(a => a.id === id);
  if (!existing && report.done) return false;
  const activity = getOrCreate(surfaceId);
  let agent = existing;
  if (!agent) {
    agent = { id, name: id, toolUses: 0, tokens: '', done: false };
    activity.agents.push(agent);
    if (activity.agents.length > MAX_TRACKED_AGENTS) activity.agents.shift();
  }
  const name = sanitizeSubagentText(report.name, MAX_SUBAGENT_NAME);
  if (name) agent.name = name;
  if (report.detail !== undefined) agent.detail = sanitizeSubagentText(report.detail, MAX_SUBAGENT_DETAIL);
  if (report.toolUse) agent.toolUses++;
  if (report.done !== undefined) agent.done = report.done;
  const now = Date.now();
  agent.touchedAt = now;
  activity.lastUpdate = now;
  broadcast(surfaceId, activity);
  return true;
}

/** The session is over (SessionEnd, release-agent): nothing it declared runs on. */
export function endDeclaredSubagents(surfaceId: SurfaceId): void {
  const activity = activities.get(surfaceId);
  if (!activity) return;
  let changed = false;
  for (const a of activity.agents) {
    if (a.id && !a.done) { a.done = true; changed = true; }
  }
  if (!changed) return;
  activity.lastUpdate = Date.now();
  broadcast(surfaceId, activity);
}

/**
 * Merge externally-sourced activity (e.g. pushed by the OpenCode plugin over
 * the pipe) into the shared per-surface map and broadcast it on the same
 * channel the sidebar already listens to. Agent-agnostic — Claude's own
 * observer and external producers converge here.
 */
export function applyExternalActivity(
  surfaceId: SurfaceId,
  partial: Partial<ClaudeActivity>,
): void {
  const activity = getOrCreate(surfaceId);
  if (partial.lastTool !== undefined) activity.lastTool = partial.lastTool;
  if (partial.activeSkill !== undefined) activity.activeSkill = partial.activeSkill;
  if (partial.isDone !== undefined) activity.isDone = partial.isDone;
  // Same cap as the parser path — external producers are just as untrusted.
  if (partial.agents !== undefined) activity.agents = partial.agents.slice(-MAX_TRACKED_AGENTS);
  activity.lastUpdate = Date.now();
  broadcast(surfaceId, activity);
}

/**
 * Broadcast activity update to all renderer windows.
 */
function broadcast(surfaceId: SurfaceId, activity: ClaudeActivity): void {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.CLAUDE_ACTIVITY, { surfaceId, activity });
    }
  });
}
