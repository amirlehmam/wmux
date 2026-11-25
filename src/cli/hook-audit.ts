import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

/**
 * `wmux perf`: what Claude Code's hooks cost on every tool call.
 *
 * ## Why this exists
 *
 * "The agent is slow on Windows" was measured on a real machine as 1557 ms for
 * a `true` through the Bash tool, of which the shell was 57 ms. The rest was
 * synchronous hooks: Claude Code waits for each one before the tool result goes
 * back to the model, and on Windows each is at least one Git Bash start (about
 * 30 ms, against 2 ms for a fork on Linux). No setting brings process creation
 * to Linux speed, so the lever that is left is how many hooks block, and for
 * how long. Plugins add them without saying so, and an update puts back the
 * ones a user had edited out by hand, which is why this is a command and not a
 * one-time fix.
 *
 * ## Rules
 *
 * - It reports and never writes. Making a hook `async` stops it from blocking a
 *   tool or feeding text back to the agent, so it silently turns off a gate
 *   (a linter that refuses an edit, a permission check). Only the person who
 *   installed the hook knows which kind it is.
 * - It runs only `PreToolUse` and `PostToolUse` hooks, with a probe event. Those
 *   are the per-tool-call cost. A fake `Stop` or `UserPromptSubmit` would make a
 *   memory or session hook record a conversation that never happened, so hooks
 *   on other events are counted and not run.
 * - It needs no running wmux and never touches the pipe, like `crash-report`.
 *
 * src/cli ships as standalone JS outside the asar, so this module may import
 * nothing from src/main or src/shared.
 */

/** One hook as Claude Code would run it, with where it was declared. */
export interface HookEntry {
  /** Settings file path, or the plugin's `name@marketplace`. */
  source: string;
  sourceKind: 'settings' | 'plugin';
  event: string;
  matcher: string;
  /** `command`, `prompt`, `agent`, `http`: only `command` can be timed. */
  type: string;
  command: string;
  async: boolean;
  timeoutSec?: number;
  /** Set for a hook that asks for a shell other than the default bash. */
  shell?: string;
  pluginRoot?: string;
}

export type Verdict = 'ok' | 'slow' | 'heavy';

export interface TimedHook {
  hook: HookEntry;
  probeTool: string;
  ms: number;
  exitCode: number | null;
  timedOut: boolean;
  verdict: Verdict;
}

export interface PerfReport {
  shell: string | null;
  floorMs: number | null;
  runs: number;
  timed: TimedHook[];
  /** Sync tool-call hooks that were not run, with the reason. */
  untimed: { hook: HookEntry; reason: string }[];
  /** Sync hooks on events that are not per tool call: event → count. */
  otherSync: Record<string, number>;
  asyncCount: number;
  perTool: { tool: string; ms: number; hooks: number }[];
  statusline: { command: string; ms: number } | null;
}

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

/** Tools a hook is probed with, in order. The first one its matcher accepts wins. */
export const PROBE_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'] as const;

/** The tools whose total is printed: what an agent calls most. */
const SUMMARY_TOOLS = ['Bash', 'Read', 'Edit'] as const;

/** A hook that takes longer than this per run is reported as a timeout. */
const RUN_TIMEOUT_MS = 15_000;

/**
 * How a measured hook is judged.
 *
 * The floor on Windows is one Git Bash start, about 30 ms, and a hook that
 * starts node on top of it lands near 60-70 ms. `slow` therefore starts above
 * what a well-behaved node hook costs, and `heavy` is where one hook alone is
 * felt on every call.
 */
export function verdictFor(ms: number): Verdict {
  if (ms >= 300) return 'heavy';
  if (ms >= 100) return 'slow';
  return 'ok';
}

/** Does a hook group's matcher accept this tool? Empty and `*` accept all. */
export function matcherMatches(matcher: string, tool: string): boolean {
  if (matcher === '' || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    // A matcher that is not a valid pattern matches nothing in Claude Code either.
    return false;
  }
}

/** The tool to probe a matcher with, or null when it only accepts tools we do not fake. */
export function probeToolFor(matcher: string): string | null {
  return PROBE_TOOLS.find((tool) => matcherMatches(matcher, tool)) ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hookFromRaw(
  raw: unknown,
  base: Pick<HookEntry, 'source' | 'sourceKind' | 'event' | 'matcher' | 'pluginRoot'>,
): HookEntry | null {
  const h = asRecord(raw);
  if (!h) return null;
  const type = typeof h.type === 'string' ? h.type : 'command';
  return {
    ...base,
    type,
    command: typeof h.command === 'string' ? h.command : '',
    async: h.async === true,
    ...(typeof h.timeout === 'number' ? { timeoutSec: h.timeout } : {}),
    ...(typeof h.shell === 'string' ? { shell: h.shell } : {}),
  };
}

/**
 * Pure: flatten a `hooks` block (`{ Event: [{ matcher, hooks: [...] }] }`) into
 * entries. Anything that is not that shape is skipped, since a settings file a
 * user broke by hand must not take the whole report down.
 */
export function hooksFromConfig(
  hooksBlock: unknown,
  source: string,
  sourceKind: HookEntry['sourceKind'],
  pluginRoot?: string,
): HookEntry[] {
  const block = asRecord(hooksBlock);
  if (!block) return [];
  const out: HookEntry[] = [];
  for (const [event, groups] of Object.entries(block)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      out.push(...hooksFromGroup(group, { source, sourceKind, event, pluginRoot }));
    }
  }
  return out;
}

function hooksFromGroup(
  group: unknown,
  base: Pick<HookEntry, 'source' | 'sourceKind' | 'event' | 'pluginRoot'>,
): HookEntry[] {
  const g = asRecord(group);
  if (!g || !Array.isArray(g.hooks)) return [];
  const matcher = typeof g.matcher === 'string' ? g.matcher : '';
  return g.hooks
    .map((raw) => hookFromRaw(raw, { ...base, matcher }))
    .filter((entry): entry is HookEntry => entry !== null);
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

interface Discovered {
  hooks: HookEntry[];
  statuslineCommand: string | null;
}

function pluginHooks(configDir: string, enabled: Record<string, unknown>): HookEntry[] {
  const registry = readJson(path.join(configDir, 'plugins', 'installed_plugins.json'));
  const plugins = asRecord(registry?.plugins);
  if (!plugins) return [];
  const out: HookEntry[] = [];
  // A plugin installed at user and project scope lists the same path twice,
  // and Claude Code loads it once.
  const seen = new Set<string>();
  for (const [name, installs] of Object.entries(plugins)) {
    if (enabled[name] !== true || !Array.isArray(installs)) continue;
    for (const install of installs) {
      const root = asRecord(install)?.installPath;
      if (typeof root !== 'string' || seen.has(root)) continue;
      seen.add(root);
      const file = readJson(path.join(root, 'hooks', 'hooks.json'));
      if (file) out.push(...hooksFromConfig(file.hooks ?? file, name, 'plugin', root));
    }
  }
  return out;
}

/** Every hook Claude Code would load for a session started in `cwd`. */
export function discoverHooks(configDir: string, cwd: string): Discovered {
  const files = [
    path.join(configDir, 'settings.json'),
    path.join(configDir, 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ];
  const hooks: HookEntry[] = [];
  const enabled: Record<string, unknown> = {};
  let statuslineCommand: string | null = null;
  for (const file of files) {
    const json = readJson(file);
    if (!json) continue;
    hooks.push(...hooksFromConfig(json.hooks, file, 'settings'));
    // Later files are more specific, so their choice replaces an earlier one.
    Object.assign(enabled, asRecord(json.enabledPlugins) ?? {});
    const command = asRecord(json.statusLine)?.command;
    if (typeof command === 'string') statuslineCommand = command;
  }
  hooks.push(...pluginHooks(configDir, enabled));
  return { hooks, statuslineCommand };
}

/**
 * The shell Claude Code runs a hook in: Git Bash on Windows, bash elsewhere.
 *
 * Looked up by absolute path and never through PATH, so the number reported is
 * for the shell the agent really starts and not for whichever `bash` a PATH
 * entry put first (WSL's `bash.exe` in System32 is the usual one).
 */
export function resolveHookShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = fs.existsSync,
): string | null {
  const candidates: string[] = [];
  if (platform === 'win32') {
    if (env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(env.CLAUDE_CODE_GIT_BASH_PATH);
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')];
    for (const root of roots) {
      if (root) candidates.push(path.win32.join(root, 'Git', 'bin', 'bash.exe'));
    }
  } else {
    candidates.push(path.posix.join('/bin', 'bash'), path.posix.join('/usr', 'bin', 'bash'), path.posix.join('/bin', 'sh'));
  }
  return candidates.find((file) => exists(file)) ?? null;
}

function probePayload(event: string, tool: string, cwd: string): string {
  const toolInput = tool === 'Bash'
    ? { command: 'true', description: 'wmux perf probe' }
    : { file_path: path.join(cwd, 'wmux-perf-probe.missing') };
  return JSON.stringify({
    session_id: 'wmux-perf-probe',
    hook_event_name: event,
    cwd,
    tool_name: tool,
    tool_input: toolInput,
    ...(event === 'PostToolUse' ? { tool_response: {} } : {}),
  });
}

interface RunResult {
  ms: number;
  exitCode: number | null;
  timedOut: boolean;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * The hook command reaches bash in an environment variable and is `eval`ed,
 * never as the `-c` argument itself.
 *
 * Git Bash's runtime rewrites the arguments a native process hands it: an
 * argument with no space in it gets brace and glob expansion before bash sees
 * it. `${A:-${B}}/hooks/x.sh` arrived as `$A:-${B}/hooks/x.sh`, exited 127, and
 * was reported as a 36 ms hook that does nothing, when the real one starts jq
 * three times. Environment values are not rewritten.
 */
const COMMAND_VAR = 'WMUX_PERF_COMMAND';
const RUN_COMMAND_VAR = `eval "$${COMMAND_VAR}"`;

function timeCommand(
  shell: string,
  command: string,
  input: string,
  baseEnv: NodeJS.ProcessEnv,
  runs: number,
): RunResult {
  const times: number[] = [];
  let exitCode: number | null = null;
  const env = { ...baseEnv, [COMMAND_VAR]: command };
  for (let i = 0; i < runs; i++) {
    const started = process.hrtime.bigint();
    const result = spawnSync(shell, ['-c', RUN_COMMAND_VAR], {
      input,
      env,
      timeout: RUN_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    exitCode = result.status;
    // One timeout is the answer. Running it again only makes the report slower.
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      return { ms: RUN_TIMEOUT_MS, exitCode: null, timedOut: true };
    }
  }
  return { ms: median(times), exitCode, timedOut: false };
}

/** Why a sync tool-call hook cannot be timed, or null when it can. */
export function untimedReason(hook: HookEntry, skip: string | undefined): string | null {
  if (hook.type !== 'command') return `type "${hook.type}" is not a command`;
  if (!hook.command) return 'no command';
  if (hook.shell && hook.shell !== 'bash') return `runs in ${hook.shell}`;
  if (skip && hook.command.includes(skip)) return 'skipped by --skip';
  if (!probeToolFor(hook.matcher)) return 'matches none of the probed tools';
  return null;
}

export interface PerfOptions {
  runs: number;
  skip?: string;
  cwd: string;
  configDir: string;
  /** False lists the hooks without running any of them. */
  run: boolean;
}

function sumPerTool(timed: TimedHook[]): PerfReport['perTool'] {
  return SUMMARY_TOOLS.map((tool) => {
    const matching = timed.filter((t) => matcherMatches(t.hook.matcher, tool));
    return { tool, ms: matching.reduce((sum, t) => sum + t.ms, 0), hooks: matching.length };
  });
}

function hookEnv(hook: HookEntry, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: cwd };
  // Plugin commands are written against a forward-slash root, which is what
  // Claude Code hands them on Windows too.
  if (hook.pluginRoot) env.CLAUDE_PLUGIN_ROOT = hook.pluginRoot.replace(/\\/g, '/');
  return env;
}

export function buildReport(options: PerfOptions): PerfReport {
  const { hooks, statuslineCommand } = discoverHooks(options.configDir, options.cwd);
  const shell = options.run ? resolveHookShell() : null;
  const report: PerfReport = {
    shell,
    floorMs: null,
    runs: options.runs,
    timed: [],
    untimed: [],
    otherSync: {},
    asyncCount: hooks.filter((h) => h.async).length,
    perTool: [],
    statusline: null,
  };

  for (const hook of hooks) {
    if (hook.async) continue;
    if (!TOOL_EVENTS.has(hook.event)) {
      report.otherSync[hook.event] = (report.otherSync[hook.event] ?? 0) + 1;
      continue;
    }
    const reason = untimedReason(hook, options.skip) ?? (shell ? null : 'not run');
    if (reason || !shell) {
      report.untimed.push({ hook, reason: reason ?? 'not run' });
      continue;
    }
    const probeTool = probeToolFor(hook.matcher) as string;
    const input = probePayload(hook.event, probeTool, options.cwd);
    const result = timeCommand(shell, hook.command, input, hookEnv(hook, options.cwd), options.runs);
    report.timed.push({ hook, probeTool, ...result, verdict: verdictFor(result.ms) });
  }

  if (shell) {
    report.floorMs = timeCommand(shell, 'true', '', process.env, options.runs).ms;
    if (statuslineCommand) {
      const input = JSON.stringify({
        session_id: 'wmux-perf-probe',
        cwd: options.cwd,
        model: { id: 'probe', display_name: 'probe' },
        workspace: { current_dir: options.cwd, project_dir: options.cwd },
      });
      const result = timeCommand(shell, statuslineCommand, input, process.env, options.runs);
      report.statusline = { command: statuslineCommand, ms: result.ms };
    }
  }
  report.timed.sort((a, b) => b.ms - a.ms);
  report.perTool = sumPerTool(report.timed);
  return report;
}

function sourceLabel(hook: HookEntry): string {
  return hook.sourceKind === 'plugin' ? `plugin ${hook.source}` : hook.source;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function exitNote(timed: TimedHook): string {
  if (timed.timedOut) return `  (no answer after ${RUN_TIMEOUT_MS / 1000} s)`;
  if (timed.exitCode === 127) return '  (exit 127: the command was not found, so this hook does nothing but cost time)';
  return '';
}

function timedLines(timed: TimedHook[]): string[] {
  const lines: string[] = [];
  for (const t of timed) {
    const ms = `${Math.round(t.ms)} ms`.padStart(8);
    lines.push(`${ms}  ${t.verdict.padEnd(5)}  ${t.hook.event} [${t.hook.matcher || '*'}]  ${sourceLabel(t.hook)}`);
    lines.push(`${' '.repeat(17)}${clip(t.hook.command, 100)}${exitNote(t)}`);
  }
  return lines;
}

function adviceLines(timed: TimedHook[]): string[] {
  const flagged = timed.filter((t) => t.verdict !== 'ok' || t.exitCode === 127);
  if (flagged.length === 0) return ['Nothing to fix: no blocking hook is slow.'];
  const lines = ['What to do (wmux changes none of this for you):'];
  const plugins = new Set<string>();
  const files = new Set<string>();
  for (const t of flagged) {
    if (t.hook.sourceKind === 'plugin') plugins.add(t.hook.source);
    else files.add(t.hook.source);
  }
  for (const name of plugins) {
    lines.push(`  - plugin ${name}: disable it with /plugin if you do not use it.`);
  }
  if (plugins.size > 0) {
    lines.push('    Editing a plugin\'s hooks.json works until its next update puts the file back.');
  }
  for (const file of files) {
    lines.push(`  - ${file}: add "async": true to a flagged hook that only observes.`);
  }
  if (files.size > 0) {
    lines.push('    An async hook can no longer block a tool or send text to the agent, so leave a gate as it is.');
  }
  return lines;
}

function untimedLines(report: PerfReport): string[] {
  const lines: string[] = [];
  if (report.untimed.length > 0) {
    lines.push('', 'Blocking tool-call hooks that were not timed:');
    for (const { hook, reason } of report.untimed) {
      lines.push(`  ${hook.event} [${hook.matcher || '*'}]  ${sourceLabel(hook)}  (${reason})`);
    }
  }
  const others = Object.entries(report.otherSync);
  if (others.length > 0) {
    const summary = others.map(([event, count]) => `${event} ${count}`).join(', ');
    lines.push('', `Blocking hooks on other events, counted and not run: ${summary}`);
  }
  return lines;
}

/** Pure: the text `wmux perf` prints. */
export function formatReport(report: PerfReport): string {
  const lines = ['wmux perf: what Claude Code\'s hooks add to every tool call', ''];
  if (report.shell) {
    lines.push(
      `Hook shell: ${report.shell}`,
      `Floor: ${Math.round(report.floorMs ?? 0)} ms for an empty hook (one shell start). Median of ${report.runs} runs each.`,
      '',
    );
  } else {
    lines.push('No hook was run, so there are no timings below.', '');
  }
  if (report.timed.length > 0) {
    lines.push(...timedLines(report.timed), '', 'Blocking time added per call:');
    for (const t of report.perTool) {
      const count = t.hooks === 1 ? '1 hook' : `${t.hooks} hooks`;
      lines.push(`  ${t.tool.padEnd(5)} ${String(Math.round(t.ms)).padStart(5)} ms  (${count})`);
    }
  } else if (report.shell) {
    lines.push('No blocking hook runs on tool calls.');
  }
  if (report.statusline) {
    lines.push('', `Statusline: ${Math.round(report.statusline.ms)} ms per refresh (does not block tool calls).`);
  }
  lines.push(...untimedLines(report), '', `Async hooks (cost nothing here): ${report.asyncCount}`);
  if (report.shell) lines.push('', ...adviceLines(report.timed));
  return lines.join('\n');
}
