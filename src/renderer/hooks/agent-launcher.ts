// ─── Agent launchers in a pane's startup commands (#302) ─────────────────────
//
// A pane's startup commands can be setup ("nvm use", "cd packages/app") or the
// agent launch itself — a quick-launch profile that runs
// `opencode2 --server https://…`. The resume used to be appended in both cases,
// on the assumption it is always "setup first, resume last". When the command
// IS the launcher that inverts: the launcher takes the terminal, so the
// appended resume is read by the agent's TUI instead of the shell — the pane
// opens on the agent's default session and the resume text sits in its prompt.
//
// So the resume is MERGED into that command when it launches the same agent
// (`opencode2 --server <url> -s <id>`), dropped when the pane launches a
// DIFFERENT agent (typing one agent's resume into another's TUI is the same
// failure), and appended as before when every command is setup.
//
// Pure: no Electron, no Node, exercised straight from vitest.

export type ResumableAgent = 'claude' | 'codex' | 'opencode' | 'agy' | 'qwen' | 'omp' | 'pi';

/** Which quoting rules a pane's shell applies to the resume it is typed. */
export type ShellFamily = 'powershell' | 'posix' | 'cmd';

export function detectShellFamily(shell?: string, samplePath?: string): ShellFamily {
  if (!shell) {
    return samplePath?.startsWith('/') ? 'posix' : 'powershell';
  }
  const lower = shell.toLowerCase();
  if (/\b(pwsh|powershell)\b/.test(lower)) return 'powershell';
  if (/\b(cmd|command)\b/.test(lower)) return 'cmd';
  if (/\b(bash|zsh|sh|wsl|dash|ash)\b/.test(lower)) return 'posix';
  return samplePath?.startsWith('/') ? 'posix' : 'powershell';
}

/**
 * Shell-aware quoting for session-file handles (omp, pi):
 * - PowerShell: single quotes with '' escaping (verbatim: no $ or ` expansion)
 * - POSIX (bash/zsh/sh/wsl): single quotes with '\'' escaping
 * - cmd.exe: double quotes (cmd expands %VAR%, does not support single quotes)
 */
export function quoteOmpArg(id: string, shell?: string): string | null {
  const family = detectShellFamily(shell, id);
  if (family === 'powershell') {
    // PowerShell also closes a single-quoted string on the typographic quotes
    // U+2018-U+201B; doubling escapes each of them like a plain '.
    return `'${id.replace(/['‘’‚‛]/g, '$&$&')}'`;
  }
  if (family === 'posix') {
    return `'${id.replace(/'/g, "'\\''")}'`;
  }
  // cmd.exe expands %VAR% even inside quotes and has no escape for a double
  // quote inside one, so a path carrying either is refused rather than typed.
  if (id.includes('%') || id.includes('"')) {
    return null;
  }
  return `"${id}"`;
}

/**
 * The agents wmux can resume, how each takes a stored handle, and the
 * executable names that mean it.
 *
 * `\d*` accepts the numbered-alias convention people use to keep two majors
 * side by side (`opencode2`), which is how the pane in #302 is launched. It is
 * NOT a prefix match: `opencode-monitor` is a different program, and merging a
 * handle into its argv would corrupt arguments that belong to somebody else.
 */
const RESUMABLE = {
  claude: { executable: /^(claude|claude-code)\d*$/, args: (id: string) => `--resume ${id}` },
  codex: { executable: /^codex\d*$/, args: (id: string) => `resume ${id}` },
  opencode: { executable: /^opencode\d*$/, args: (id: string) => `-s ${id}` },
  agy: { executable: /^agy\d*$/, args: (id: string) => `--conversation ${id}` },
  qwen: { executable: /^(qwen|qwen-code)\d*$/, args: (id: string) => `--resume ${id}` },
  // Never called for omp: its handle is a path, which mergeResume quotes for
  // the pane's own shell (mergeOmpResume).
  omp: { executable: /^omp\d*$/, args: (id: string) => `--resume ${id}` },
  // Same for pi (#382): `pi --session <path>`, quoted by mergePiResume.
  pi: { executable: /^pi\d*$/, args: (id: string) => `--session ${id}` },
} satisfies Record<ResumableAgent, { executable: RegExp; args: (id: string) => string }>;
/** The command typed when nothing in the pane launches an agent. */
const LAUNCH_COMMAND: Record<ResumableAgent, string> = {
  claude: 'claude --resume',
  codex: 'codex resume',
  opencode: 'opencode -s',
  agy: 'agy --conversation',
  qwen: 'qwen --resume',
  omp: 'omp --resume',
  pi: 'pi --session',
};

/** Agents whose handle is a file path, quoted for the pane's own shell. */
function takesPath(agent: ResumableAgent): boolean {
  return agent === 'omp' || agent === 'pi';
}

/** Wrappers a launcher can hide behind: `npx -y opencode`, `pnpm dlx codex`. */
const RUNNERS = new Set(['npx', 'bunx', 'pnpm', 'yarn', 'npm', 'bun', 'deno']);

/**
 * Runner verbs that come before the launcher: `pnpm dlx codex`,
 * `npm exec claude`. `run` is deliberately absent — `npm run opencode` is a
 * package script named after the agent, and its arguments are npm's to route.
 */
const RUNNER_VERBS = new Set(['dlx', 'exec', 'x']);

/** Extensions npm installs and shells put on PATH. */
const EXT_RE = /\.(exe|cmd|bat|ps1|sh|mjs|cjs|js)$/;

/**
 * The executable name a token means: quotes off, path off, extension off,
 * lowercased. `"C:\Program Files\opencode.cmd"` → `opencode`.
 */
function executableName(token: string): string | undefined {
  const base = token.replace(/^["']|["']$/g, '').replace(/\\/g, '/').split('/').pop();
  if (!base) return undefined;
  return base.toLowerCase().replace(EXT_RE, '');
}

/** Which agent, if any, an executable name means. */
function agentNamed(name: string): ResumableAgent | undefined {
  for (const [agent, spec] of Object.entries(RESUMABLE) as Array<[ResumableAgent, (typeof RESUMABLE)[ResumableAgent]]>) {
    if (spec.executable.test(name)) return agent;
  }
  return undefined;
}

/**
 * Tokens of a command line, honouring a quoted FIRST token.
 *
 * Only the executable needs this: a launcher installed under a path with spaces
 * (`"C:\Program Files\opencode.cmd"`) is still the launcher. Everything after
 * it is flags and arguments we never interpret, so they are split on
 * whitespace and left alone.
 */
function tokensOf(command: string): string[] {
  const trimmed = command.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end > 0) {
      const rest = trimmed.slice(end + 1).trim();
      return [trimmed.slice(0, end + 1), ...(rest ? rest.split(/\s+/) : [])];
    }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

/**
 * The agent a startup command launches, or undefined.
 *
 * Deliberately narrow. The token is taken as written — no shell parsing beyond
 * a quoted executable — so a command that needs real quoting
 * (`bash -c "opencode …"`) reads as bash and is left alone. A package runner is
 * stepped over, with its own flags and verbs, because `npx -y opencode` and
 * `pnpm dlx codex` still start those agents.
 */
export function launchedAgent(command: string): ResumableAgent | undefined {
  const tokens = tokensOf(command);
  if (tokens.length === 0) return undefined;
  let index = 0;
  let name = executableName(tokens[index]);
  if (name && RUNNERS.has(name)) {
    // Step over the runner's own flags and verbs: `npx -y opencode`,
    // `pnpm dlx codex`, `npm exec claude`.
    while (index + 1 < tokens.length) {
      const next = tokens[index + 1];
      if (!next.startsWith('-') && !RUNNER_VERBS.has(next.toLowerCase())) break;
      index++;
    }
    if (index + 1 >= tokens.length) return undefined;
    name = executableName(tokens[index + 1]);
  }
  if (!name) return undefined;
  return agentNamed(name);
}

/** The last startup command that launches an agent, if there is one. */
export function lastAgentLauncher(commands: readonly string[]): { index: number; agent: ResumableAgent } | undefined {
  for (let index = commands.length - 1; index >= 0; index--) {
    const agent = launchedAgent(commands[index]);
    if (agent) return { index, agent };
  }
  return undefined;
}

/** A whitespace-separated token of a command line, quotes kept, with its offsets. */
interface CommandSpan {
  start: number;
  end: number;
  raw: string;
}

/** Where the token starting at `i` ends. A quoted run may hold spaces. */
function tokenEnd(command: string, i: number): number {
  let end = i;
  while (end < command.length && !/\s/.test(command[end])) {
    const ch = command[end];
    end++;
    if (ch !== '"' && ch !== "'") continue;
    const close = command.indexOf(ch, end);
    end = close === -1 ? command.length : close + 1;
  }
  return end;
}

export function scanCommandSpans(command: string): CommandSpan[] {
  const spans: CommandSpan[] = [];
  let i = 0;
  while (i < command.length) {
    if (/\s/.test(command[i])) {
      i++;
      continue;
    }
    const end = tokenEnd(command, i);
    spans.push({ start: i, end, raw: command.slice(i, end) });
    i = end;
  }
  return spans;
}

type Range = { start: number; end: number };

/** Flags that ask omp for something other than a resume: never merge into those. */
function forbidsOmpResume(raw: string): boolean {
  return raw === '--restore' || raw.startsWith('--restore=') || raw === '--no-session';
}

/** Session flags with no value, or with the value inline: removed on their own. */
function isSelfContainedSessionFlag(raw: string): boolean {
  return raw === '--continue' || raw.startsWith('--continue=') || raw === '-c'
    || raw.startsWith('--resume=') || raw.startsWith('--session=') || raw.startsWith('-r=');
}

/** Session flags whose value is the NEXT token, when that token is not a flag. */
function isSeparateValueSessionFlag(raw: string): boolean {
  return raw === '--resume' || raw === '-r' || raw === '--session';
}

/** Every session-selecting flag in an omp command line, with its value. */
function ompSessionFlagRanges(spans: CommandSpan[]): Range[] {
  const ranges: Range[] = [];
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (isSelfContainedSessionFlag(span.raw)) {
      ranges.push({ start: span.start, end: span.end });
    } else if (isSeparateValueSessionFlag(span.raw)) {
      const next = spans[i + 1];
      const takesValue = next !== undefined && !next.raw.startsWith('-');
      ranges.push({ start: span.start, end: takesValue ? next.end : span.end });
      if (takesValue) i++;
    }
  }
  return ranges;
}

/**
 * Widen each removal over the separator beside it, so a deleted flag cannot
 * leave a doubled space behind, and merge ranges that then touch. Only the
 * whitespace ADJACENT to a removal is touched: whitespace inside a kept
 * (quoted) argument stays byte-for-byte.
 */
function widenOverSeparator(command: string, range: Range): Range {
  let { start, end } = range;
  if (start > 0 && /\s/.test(command[start - 1])) {
    while (start > 0 && /\s/.test(command[start - 1])) start--;
  } else {
    while (end < command.length && /\s/.test(command[end])) end++;
  }
  return { start, end };
}

function absorbSeparators(command: string, ranges: Range[]): Range[] {
  const normalized: Range[] = [];
  for (const range of ranges) {
    const { start, end } = widenOverSeparator(command, range);
    const last = normalized[normalized.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else normalized.push({ start, end });
  }
  return normalized;
}

/** `command` with `ranges` cut out, each over the separator beside it. */
function withoutRanges(command: string, ranges: Range[]): string {
  let result = '';
  let lastIdx = 0;
  for (const range of absorbSeparators(command, ranges)) {
    result += command.slice(lastIdx, range.start);
    lastIdx = range.end;
  }
  return (result + command.slice(lastIdx)).trim();
}

/**
 * An omp launcher with its own session flags replaced by `--resume <path>`, or
 * null when it must not be resumed (`--restore`, `--no-session`, or a path the
 * pane's shell cannot quote). Everything outside the removed flags keeps its
 * exact original quoting and spacing.
 */
function mergeOmpResume(command: string, id: string, shell?: string): string | null {
  const spans = scanCommandSpans(command);
  if (spans.some(span => forbidsOmpResume(span.raw))) return null;
  const quoted = quoteOmpArg(id, shell);
  if (!quoted) return null;
  return `${withoutRanges(command, ompSessionFlagRanges(spans))} --resume ${quoted}`;
}

/**
 * Flags that make a pi launch something other than "this exact session"
 * (#382): no session at all, a fork of another one, or a session picked by id.
 * The pane asked for that on purpose, so the resume is not merged in.
 */
function forbidsPiResume(raw: string): boolean {
  return ['--no-session', '--fork', '--session-id'].some(flag => raw === flag || raw.startsWith(`${flag}=`));
}

/**
 * pi's other session selectors, removed so `--session <path>` is the only one.
 * Unlike omp's, pi's `--continue`/`-c` and `--resume`/`-r` take NO value
 * (`-r` opens a picker) — so the token after them is somebody else's argument
 * and stays. `--session` takes the next token, when that is not a flag.
 */
function piSessionFlagRanges(spans: CommandSpan[]): Range[] {
  const ranges: Range[] = [];
  for (let i = 0; i < spans.length; i++) {
    const { raw, start, end } = spans[i];
    if (['--continue', '-c', '--resume', '-r'].includes(raw) || raw.startsWith('--session=')) {
      ranges.push({ start, end });
    } else if (raw === '--session') {
      const next = spans[i + 1];
      const takesValue = next !== undefined && !next.raw.startsWith('-');
      ranges.push({ start, end: takesValue ? next.end : end });
      if (takesValue) i++;
    }
  }
  return ranges;
}

/** A pi launcher with its session selectors replaced by `--session <path>`, or null. */
function mergePiResume(command: string, id: string, shell?: string): string | null {
  const spans = scanCommandSpans(command);
  if (spans.some(span => forbidsPiResume(span.raw))) return null;
  const quoted = quoteOmpArg(id, shell);
  if (!quoted) return null;
  return `${withoutRanges(command, piSessionFlagRanges(spans))} --session ${quoted}`;
}

/**
 * `base` with the resume added, or null when it must not be typed at all.
 *
 * Returns a NEW array whenever it adds anything, and never mutates `base`:
 * callers keep the original list for the pane's own record. A launcher the pane
 * names itself keeps its name and its flags — the resume rides on the same
 * command line, because a second line would be read by that agent's TUI.
 */
export function mergeResume(
  base: readonly string[] | undefined,
  agent: ResumableAgent,
  id: string,
  shell?: string,
): string[] | null {
  // A Linux session path must not be reinterpreted by a Windows shell.
  if (agent === 'pi' && id.startsWith('/')) {
    const executable = tokensOf(shell ?? '')[0]?.replace(/^["']|["']$/g, '').replace(/\\/g, '/').split('/').pop();
    if (!/^wsl(?:\.exe)?$/i.test(executable ?? '')) return null;
  }
  const commands = base ?? [];
  const launcher = lastAgentLauncher(commands);
  if (!launcher) {
    const arg = takesPath(agent) ? quoteOmpArg(id, shell) : id;
    if (!arg) return null;
    return [...commands, `${LAUNCH_COMMAND[agent]} ${arg}`];
  }
  if (launcher.agent !== agent) return null;
  const next = [...commands];
  if (takesPath(agent)) {
    const cleaned = agent === 'pi'
      ? mergePiResume(next[launcher.index], id, shell)
      : mergeOmpResume(next[launcher.index], id, shell);
    if (!cleaned) return null;
    next[launcher.index] = cleaned;
    return next;
  }
  next[launcher.index] = `${next[launcher.index]} ${RESUMABLE[agent].args(id)}`;
  return next;
}
