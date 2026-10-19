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

export type ResumableAgent = 'claude' | 'codex' | 'opencode' | 'agy';

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
} satisfies Record<ResumableAgent, { executable: RegExp; args: (id: string) => string }>;

/** The command typed when nothing in the pane launches an agent. */
const LAUNCH_COMMAND: Record<ResumableAgent, string> = {
  claude: 'claude --resume',
  codex: 'codex resume',
  opencode: 'opencode -s',
  agy: 'agy --conversation',
};

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

/**
 * `base` with the resume added, or null when it must not be typed at all.
 *
 * Returns a NEW array whenever it adds anything, and never mutates `base`:
 * callers keep the original list for the pane's own record. A launcher the pane
 * names itself keeps its name and its flags — the resume rides on the same
 * command line, because a second line would be read by that agent's TUI.
 */
export function mergeResume(base: readonly string[] | undefined, agent: ResumableAgent, id: string): string[] | null {
  const commands = base ?? [];
  const launcher = lastAgentLauncher(commands);
  if (!launcher) return [...commands, `${LAUNCH_COMMAND[agent]} ${id}`];
  if (launcher.agent !== agent) return null;
  const next = [...commands];
  next[launcher.index] = `${next[launcher.index]} ${RESUMABLE[agent].args(id)}`;
  return next;
}
