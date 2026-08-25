/**
 * agent-argv.ts — which coding agent, if any, is this command line?
 *
 * wmux knows a pane's declared state only when the agent reports it, which
 * means Claude Code, OpenCode and Kiro. Everything else — Codex, Gemini, Aider,
 * Amp, Cursor, Copilot — runs in a pane wmux cannot name. This module is the
 * first half of fixing that: turn a command line into an agent kind.
 *
 * Pure, and deliberately free of every Electron and Node API so it can be
 * exercised straight from vitest. It is also the single place where "is this an
 * agent?" is decided, so the three sources that feed it (the shell-integration
 * preexec report, the pane's own shell spec, the process probe) cannot drift
 * into three different answers about the same string.
 *
 * The refusals matter as much as the matches. An interpreter handed an inline
 * program can mention anything: `python -c "…" /tmp/codex` has an argument that
 * looks exactly like an agent path. A wrong answer here does not fail loudly —
 * it mislabels a pane, and every layer above trusts the label.
 */
import { splitCommandLine, normalizedExecutableName } from './ssh-argv';

/**
 * Canonical agent kind → every executable name that means it.
 *
 * Names are lowercase and extension-free; `executableKey` below normalizes a
 * token the same way before looking it up, so `CLAUDE.EXE`, `claude.cmd` and
 * `C:\npm\claude.ps1` all land on the same entry. Matching is EXACT, never a
 * prefix: `claude-monitor` is not Claude.
 */
export const AGENT_ALIASES: Record<string, string[]> = {
  claude: ['claude', 'claude-code'],
  codex: ['codex'],
  opencode: ['opencode'],
  kiro: ['kiro', 'kiro-cli'],
  gemini: ['gemini'],
  cursor: ['cursor', 'cursor-agent'],
  copilot: ['copilot'],
  aider: ['aider'],
  amp: ['amp'],
  grok: ['grok'],
  droid: ['droid'],
  qwen: ['qwen', 'qwen-code'],
  goose: ['goose'],
  crush: ['crush'],
  cline: ['cline'],
};

/** Reverse index, built once. */
const ALIAS_TO_KIND = new Map<string, string>();
for (const [kind, names] of Object.entries(AGENT_ALIASES)) {
  for (const name of names) ALIAS_TO_KIND.set(name, kind);
}

/**
 * Extensions stripped before lookup.
 *
 * `.cmd` and `.ps1` are how npm global installs land on Windows; `.js`/`.mjs`
 * are what a `node <script>` unwrap hands back; `.py` likewise for python.
 * `.exe` is already removed by normalizedExecutableName.
 */
const STRIPPED_EXTENSIONS = /\.(cmd|bat|ps1|js|mjs|cjs|py)$/;

/** Bounds the unwrap recursion. Real nests are 1–2 deep; 8 is pure paranoia. */
const MAX_UNWRAP_DEPTH = 8;

/**
 * A token → the lowercase, path-free, extension-free name to look up.
 *
 * Reuses normalizedExecutableName so the ssh detector and this module agree on
 * what "the executable part of a token" means.
 */
function executableKey(token: string): string {
  return normalizedExecutableName(token).replace(STRIPPED_EXTENSIONS, '');
}

/**
 * Flags that turn an interpreter into "run this string", after which no
 * remaining argument can be trusted to name a program.
 *
 * Matched with the flag's own `=value` form stripped, so `--eval=…` is caught
 * alongside `--eval …`.
 */
const INLINE_PROGRAM_FLAGS = new Set([
  '-c', '-e', '-p', '--eval', '--print', '--command',
]);

function isInlineProgramFlag(token: string): boolean {
  const flag = token.toLowerCase().split('=')[0];
  return INLINE_PROGRAM_FLAGS.has(flag);
}

/**
 * PowerShell's own inline-program flags, which it accepts as any unambiguous
 * PREFIX — `-Command` answers to `-c`, `-co`, `-comm`, and `-EncodedCommand` to
 * `-e`, `-en`, `-enc`, `-ec`. A fixed list would let `powershell -comm "…"`
 * through, and everything after it is an arbitrary expression.
 *
 * `-ec` is spelled out because it is a documented alias rather than a prefix of
 * either word.
 */
function isPowerShellInlineFlag(token: string): boolean {
  const flag = token.toLowerCase().replace(/^-+/, '').split(':')[0];
  if (!flag) return false;
  if (flag === 'ec') return true;
  return 'command'.startsWith(flag) || 'encodedcommand'.startsWith(flag);
}

/** `-Foo` / `--foo` / `/c` — anything that is not the next positional token. */
function isFlag(token: string): boolean {
  return /^[-/]/.test(token);
}

/**
 * Unwrap `cmd /c …` and `cmd.exe /d /s /c "…"`.
 *
 * The payload may be a single quoted token holding a whole command line, or the
 * rest of the argv; both are handed back as a string to re-parse, so a nested
 * `cmd /c npx claude` resolves in one more pass rather than needing its own case.
 */
function unwrapCmd(argv: string[]): string | null {
  const cIndex = argv.findIndex((a) => a.toLowerCase() === '/c' || a.toLowerCase() === '/k');
  if (cIndex === -1) return null;
  const rest = argv.slice(cIndex + 1);
  return rest.length > 0 ? rest.join(' ') : null;
}

/**
 * Unwrap a PowerShell host.
 *
 * `-File <script>` is a real program on disk and resolvable. `-Command` and
 * `-EncodedCommand` are arbitrary expressions and are REFUSED — not scanned —
 * because everything after them is data, not an executable name.
 */
function unwrapPowerShell(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i].toLowerCase();
    if (isPowerShellInlineFlag(token)) return null;
    // `-File` is likewise prefix-matchable, but only down to `-f`: shorter is
    // ambiguous with nothing else PowerShell accepts here.
    if (/^-f(i(l(e)?)?)?$/.test(token)) return argv[i + 1] ?? null;
  }
  return null;
}

/**
 * Unwrap a script interpreter: `node app.js`, `python tool.py`, `py -3 x.py`.
 *
 * Bails on the first inline-program flag rather than skipping it, so the tokens
 * after `-c` are never inspected.
 */
function unwrapInterpreter(argv: string[]): string | null {
  for (const token of argv) {
    if (isInlineProgramFlag(token)) return null;
    if (isFlag(token)) continue;
    return token;
  }
  return null;
}

/**
 * Unwrap a package runner: `npx claude`, `npx -y opencode`, `pnpm dlx codex`.
 *
 * `-p`/`--package` takes a value that is a PACKAGE, not the binary that ends up
 * running (`npx -p @anthropic-ai/claude-code claude`), so its value is skipped
 * and the next bare token wins. A runner that names only a package resolves to
 * nothing rather than guessing the binary from the package name.
 */
function unwrapPackageRunner(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const lower = token.toLowerCase();
    if (lower === '-p' || lower === '--package' || lower === '-c' || lower === '--call') {
      i++; // skip its value
      continue;
    }
    if (isFlag(token)) continue;
    return token;
  }
  return null;
}

/** Interpreters and runners, and how to find the program they are about to run. */
const WRAPPERS: Record<string, (argv: string[]) => string | null> = {
  cmd: unwrapCmd,
  powershell: unwrapPowerShell,
  pwsh: unwrapPowerShell,
  node: unwrapInterpreter,
  bun: unwrapInterpreter,
  deno: unwrapInterpreter,
  python: unwrapInterpreter,
  python3: unwrapInterpreter,
  py: unwrapInterpreter,
  npx: unwrapPackageRunner,
  bunx: unwrapPackageRunner,
  pnpx: unwrapPackageRunner,
  dlx: unwrapPackageRunner,
};

/**
 * `pnpm dlx codex` / `yarn dlx codex` — the runner is the SECOND token.
 *
 * Kept apart from WRAPPERS because the key is a pair, and folding it in would
 * mean every lookup carried a two-token special case.
 */
const SUBCOMMAND_RUNNERS: Record<string, string> = { pnpm: 'dlx', yarn: 'dlx', npm: 'exec' };

/**
 * The agent kind this command line runs, or null.
 *
 * Null is the safe answer and is returned for everything uncertain: an unknown
 * program, an interpreter given an inline script, a wrapper with no payload, a
 * shell (`bash -lc "claude"` is a pane running bash). Callers treat null as
 * "not an agent", never as "no answer yet".
 */
export function identifyAgentCommand(commandLine: string, depth = 0): string | null {
  if (depth >= MAX_UNWRAP_DEPTH) return null;

  const argv = splitCommandLine(commandLine ?? '');
  if (argv.length === 0) return null;

  const key = executableKey(argv[0]);
  if (!key) return null;

  const direct = ALIAS_TO_KIND.get(key);
  if (direct) return direct;

  // `pnpm dlx <pkg>` and friends: drop both tokens and retry on the rest.
  const subcommand = SUBCOMMAND_RUNNERS[key];
  if (subcommand && argv[1]?.toLowerCase() === subcommand) {
    const inner = unwrapPackageRunner(argv.slice(2));
    return inner ? identifyAgentCommand(inner, depth + 1) : null;
  }

  const unwrap = WRAPPERS[key];
  if (!unwrap) return null;

  const payload = unwrap(argv.slice(1));
  return payload ? identifyAgentCommand(payload, depth + 1) : null;
}
