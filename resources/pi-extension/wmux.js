// wmux-plugin-version: 4
// wmux pi extension — scoped instructions and independently gated status reporting.
// Auto-installed by wmux to ~/.pi/agent/extensions/wmux/index.js.
// No-ops entirely outside wmux (WMUX !== '1').
//
// ── Why this exists ──────────────────────────────────────────────────────────
//
// Without it a pi pane reads "Running" for as long as pi is open. That is the
// shell integration telling the truth about a long-lived foreground process,
// and it is useless for the one question the sidebar exists to answer: with ten
// panes open, which one is waiting for me? wmux stopped GUESSING agent state in
// 0.39.0 (#128) — no screen scraping — so the only honest fix is for pi to
// declare it, and pi's event surface maps onto the declared-state protocol
// almost one for one.
//
// ── The two mappings that are not obvious ────────────────────────────────────
//
// 1. Depth is set ABSOLUTELY, never incremented.
//
//    The tempting mapping is agent_start -> `--run-start`, agent_end -> `--run-end`,
//    reusing wmux's refcount. It leaks. pi's own docs are explicit that
//    `agent_end` "fires when that run ends, but Pi may still auto-retry,
//    auto-compact and retry, or continue with queued follow-up messages", and
//    tells status integrations to use `agent_settled` instead. So one settle
//    can follow several starts, the refcount never returns to zero, and the
//    pane is pinned on "working" for the rest of the session — the exact bug
//    this extension was written to fix, reintroduced one layer down.
//    `--run-depth 1` / `--run-depth 0` states the fact instead of accumulating
//    a guess, and is idempotent under any number of repeats.
//
// 2. `blocked` comes from ui_prompt_start/ui_prompt_end and nothing else.
//
//    Those events exist in pi precisely so that "host/status integrations can
//    report 'waiting for user' instead of just 'running'", they coalesce nested
//    prompts into one outer span, and pi guarantees the matching end. Nothing
//    else in the event stream means "parked on a human": pi has no built-in
//    per-tool approval prompt (see its security.md — no sandbox, no gate), so
//    there is no second source to merge in, and inventing one from tool
//    activity is #189 all over again (OpenCode's ask STREAMS, so treating
//    streaming as "the agent resumed" cleared the block one frame after it
//    appeared).
//
//    The one extra clear is `agent_start`: a new run cannot begin unless the
//    human came back, so it is a sound self-heal if a ui_prompt_end is ever
//    lost. It cannot fire spuriously mid-prompt, because a prompt raised during
//    a run is strictly inside that run's already-emitted agent_start.
//
// No `--choices` are declared. pi's ui_prompt_start carries a kind and a title,
// never the options — and wmux's back-channel relays bytes the AGENT named
// (agent-state.ts), so a choice wmux invented would be a button that sends the
// wrong key. A blocked pane with no buttons is still the signal that matters.
//
// ── Session restore (#382) ───────────────────────────────────────────────────
//
// The extension also reports which session FILE the pane is on, so a restored
// wmux can reopen it with `pi --session <path>`. Three rules, each from how pi
// behaves rather than how it reads:
//
// - A session has a path before it has a file: pi writes the file with the
//   first assistant message. So the path is reported only once the file exists
//   and is non-empty — at session_start for a resumed or forked session, after
//   a turn for a new one — never a path that may never exist.
// - session_shutdown fires for /reload, /new, /resume and /fork too. Only
//   `reason: "quit"` releases; on a switch the next session reports its own
//   file. The release names the file it is leaving, so wmux drops it only if
//   it is still the pane's current one.
// - Every report and release carries a clock-derived `--seq`, so a message
//   from a previous session (or a previous pi in the same pane) that lands
//   late is dropped instead of overwriting a newer one.
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import * as path from "node:path";

/** Basenames that can execute a .js file we hand them. */
const JS_RUNTIME_RE = /^(node|bun)(\.exe)?$/i;

/**
 * Values stay valid until the next report, and pi sends one at every turn_end,
 * every settle and every model change — so the TTL is a crash net, not a
 * refresh interval. Long enough that an idle pane keeps showing its model;
 * short enough that a pi killed with -9 does not leave numbers up all day.
 */
const METADATA_TTL_MS = 600_000;

/** Minimum gap between activity pings, so a parallel tool batch is one spawn. */
const ACTIVITY_THROTTLE_MS = 1000;

/** How long a shutdown report may hold pi's exit before it is abandoned. */
const SHUTDOWN_DEADLINE_MS = 2000;

/**
 * Tools whose completion can have changed the working tree, and therefore the
 * diff view. Sent as a PostToolUse hook, the same signal Claude Code's hook
 * gives (#141's coalescing is downstream of this, in diff-provider).
 *
 * A denylist would be wrong here: an unknown tool is most likely a
 * user-registered one doing who-knows-what, and a spurious diff refresh costs a
 * coalesced git call while a missed one leaves the panel stale. But `read`,
 * `ls`, `grep` and `find` are pi's built-in read-only four and are by far the
 * most frequent, so they are worth naming to keep the common case free.
 */
const READ_ONLY_TOOLS = new Set(["read", "ls", "grep", "find"]);

/**
 * The last `--seq` handed out by this process. Module-level, not per factory:
 * pi rebinds the extension on /new, /resume, /fork and /reload, and the
 * session reports of two instances must still be ordered. Derived from the
 * clock so a NEW pi in the same pane starts above everything an older one sent
 * — wmux keeps the newest seq per pane even after a quit forgot the pane.
 * Microseconds since the epoch stay a safe integer until the year 2255.
 */
let lastSeq = 0;
function nextSeq(now = Date.now()) {
  lastSeq = Math.max(lastSeq + 1, now * 1000);
  return lastSeq;
}

/** The file pi's session manager names, or null. Never throws into pi. */
function namedSessionFile(ctx) {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    return typeof file === "string" && file ? file : null;
  } catch {
    return null;
  }
}

/**
 * The session file pi is writing, or null while it does not exist yet — or is
 * empty: `pi --session` on an empty file starts a new session in its place, so
 * such a file is no handle at all.
 */
function sessionFileOnDisk(ctx, stat = statSync) {
  const file = namedSessionFile(ctx);
  if (!file) return null;
  try {
    const info = stat(file);
    return info.isFile() && info.size > 0 ? file : null;
  } catch {
    return null;
  }
}

/**
 * Find something that can run `$WMUX_CLI` (issue #187).
 *
 * Keep the installed extension self-contained rather than depending on wmux's
 * application modules. Tests compare this resolver with the OpenCode plugin's
 * copy so the two cannot quietly drift.
 *
 * Order matters. `WMUX_NODE` comes first because wmux resolved it in its own
 * process, where it could also fall back to its Electron binary — so it is the
 * only link in the chain that cannot come up empty. The rest covers a pi
 * launched from a shell wmux did not spawn. `process.execPath` is checked, not
 * assumed: pi also ships as a compiled single-executable binary, where
 * execPath is `pi` and handing it a .js file prints pi's help and exits — the
 * silent failure #187 describes.
 */
function resolveNodeRuntime(
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  exists = existsSync,
) {
  const declared = env.WMUX_NODE;
  if (declared && exists(declared)) {
    return { file: declared, electron: env.WMUX_NODE_ELECTRON === "1" };
  }
  if (execPath && JS_RUNTIME_RE.test(path.basename(execPath))) {
    return { file: execPath, electron: false };
  }
  const win = platform === "win32";
  const names = win ? ["node.exe", "bun.exe"] : ["node", "bun"];
  const found = firstExisting(candidateDirs(env, win), names, exists);
  return found ? { file: found, electron: false } : { file: "node", electron: false };
}

/** PATH, then the default install locations PATH may not mention. */
function candidateDirs(env, win) {
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path");
  const fromPath = pathKey && env[pathKey] ? env[pathKey].split(path.delimiter) : [];
  const defaults = win
    ? [
        env.ProgramFiles && path.join(env.ProgramFiles, "nodejs"),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "nodejs"),
        env.USERPROFILE && path.join(env.USERPROFILE, ".bun", "bin"),
      ]
    : [
        "/usr/local/bin",
        "/usr/bin",
        "/opt/homebrew/bin",
        env.HOME && path.join(env.HOME, ".bun", "bin"),
      ];
  return [...fromPath, ...defaults].filter(Boolean);
}

/** First `dir/name` that exists, or null. Never throws on a malformed entry. */
function firstExisting(dirs, names, exists) {
  for (const dir of dirs) {
    for (const name of names) {
      try {
        const candidate = path.join(dir, name);
        if (exists(candidate)) return candidate;
      } catch {}
    }
  }
  return null;
}

/**
 * What to show while a pane is parked on a pi prompt.
 *
 * The title when there is one, because that is what the user is being asked;
 * the prompt KIND otherwise, because "wmux is waiting on a confirm" is still
 * more than "Running". Capped, since this lands in a sidebar row.
 */
function promptReason(event) {
  const title = typeof event?.title === "string" ? event.title.trim() : "";
  if (title) return title.slice(0, 200);
  const kind = typeof event?.kind === "string" ? event.kind : "";
  return kind ? `Waiting for your ${kind}` : "Waiting for you";
}

/**
 * `provider/id`, or whatever part of it pi actually has.
 *
 * Returns null rather than a placeholder: `report-metadata` omits a flag it is
 * not given, and an omitted model leaves the previous one standing, which beats
 * overwriting a real name with "unknown".
 */
function modelLabel(model) {
  if (!model) return null;
  const id = typeof model.id === "string" ? model.id : "";
  if (!id) return null;
  const provider = typeof model.provider === "string" ? model.provider : "";
  return provider ? `${provider}/${id}` : id;
}

/** `report-metadata` argv for what ctx knows right now, or null if nothing. */
function metadataArgs(ctx) {
  const args = [];
  const model = modelLabel(ctx?.model);
  if (model) args.push("--model", model);
  let usage;
  try {
    usage = ctx?.getContextUsage?.();
  } catch {
    usage = undefined;
  }
  // `tokens` and `percent` are independently nullable in pi — they go null
  // right after a compaction, before the next response re-establishes them.
  if (usage && typeof usage.tokens === "number") args.push("--tokens", String(usage.tokens));
  if (usage && typeof usage.percent === "number") {
    args.push("--context-pct", String(Math.round(usage.percent)));
  }
  if (args.length === 0) return null;
  args.push("--ttl", String(METADATA_TTL_MS));
  return args;
}

export default function wmuxExtension(pi) {
  const surface = process.env.WMUX_SURFACE_ID;
  // Outside wmux this file is inert. pi loads global extensions for every
  // session on the machine, including ones started from a plain terminal.
  if (process.env.WMUX !== "1" || !surface) return;

  // Pi cannot detect wmux's iTerm2 image support. Set this before its UI starts,
  // without overriding an explicit choice. Pi disables iTerm2 images in
  // fullscreen mode; use --tui-mode regular to display them.
  process.env.PI_IMAGE_PROTOCOL ??= "iterm2";

  // The installed module carries a consent snapshot, refreshed by Pi's /reload.
  const { instructions, hooks = true } = wmuxExtension.config ?? {};
  if (instructions) {
    pi.on("before_agent_start", (event) => {
      if (event.systemPromptOptions?.sections) {
        event.systemPromptOptions.sections.wmux = instructions;
      } else {
        return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
      }
    });
  }
  if (!hooks) return;

  const runtime = resolveNodeRuntime();

  /**
   * Run a wmux CLI verb. Fire-and-forget by default; never throws into pi.
   *
   * `wait: true` returns a promise that resolves when the call finishes or the
   * deadline passes, and is used only by session_shutdown — pi awaits that
   * handler, and without the wait the process can exit before the spawn lands,
   * leaving the pane declared "working" with nothing alive to correct it.
   * Bounded, because a wedged wmux must not be able to hang pi's exit.
   */
  function wmux(args, { wait = false, onExit } = {}) {
    const cli = process.env.WMUX_CLI;
    const done = wait ? deferred() : null;
    try {
      // WMUX_CLI is always set alongside WMUX=1 by any wmux that installed this
      // file. Without it the only PATH entry on Windows is `wmux.cmd`, which
      // execFile cannot spawn without a shell — and a shell is exactly what
      // #154 keeps out of this path.
      if (!cli) {
        if (process.platform === "win32") {
          onExit?.(new Error("WMUX_CLI is not set"));
          return settle(done);
        }
        return spawn("wmux", args, {}, done, onExit);
      }
      const opts = { windowsHide: true };
      // wmux's own Electron binary is Node only with this set; without it the
      // same exe opens a second wmux window.
      if (runtime.electron) opts.env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
      return spawn(runtime.file, [cli, ...args], opts, done, onExit);
    } catch (err) {
      onExit?.(err);
      return settle(done);
    }
  }

  function spawn(file, argv, opts, done, onExit) {
    let timer = null;
    if (done) {
      timer = setTimeout(() => settle(done), SHUTDOWN_DEADLINE_MS);
      // Never keep pi's event loop alive for a report nobody is waiting on.
      timer.unref?.();
    }
    execFile(file, argv, opts, (error) => {
      if (timer) clearTimeout(timer);
      onExit?.(error);
      settle(done);
    });
    return done ? done.promise : undefined;
  }

  function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve, settled: false };
  }

  function settle(done) {
    if (!done) return undefined;
    if (!done.settled) {
      done.settled = true;
      done.resolve();
    }
    return done.promise;
  }

  const report = (...args) => wmux(["report-agent", "--surface", surface, ...args]);

  let lastActivityPing = 0;

  /** The file this instance last reported successfully; a repeat sends nothing. */
  let reportedFile = null;
  /** A report in flight, so a burst of turn ends is one spawn. */
  let reportingFile = null;

  /**
   * Tell wmux which session file this pane is on, once it exists. A failed
   * call is retried at the next opportunity rather than remembered as sent.
   */
  const reportSession = (ctx) => {
    const file = sessionFileOnDisk(ctx);
    if (!file || file === reportedFile || file === reportingFile) return;
    reportingFile = file;
    const args = ["report-session", file, "--provider", "pi", "--seq", String(nextSeq()), "--surface", surface];
    wmux(args, {
      onExit: (error) => {
        if (reportingFile === file) reportingFile = null;
        if (!error) reportedFile = file;
      },
    });
  };

  /**
   * Unconditional, with no "am I currently blocked?" flag guarding it.
   *
   * Such a flag is the obvious optimisation and it is the wrong trade here. It
   * is per-EXTENSION-INSTANCE state, and pi rebinds extensions across `/new`,
   * `/resume`, `/fork` and `/reload` — so the instance asked to clear a block is
   * not always the instance that declared it, and a `false` it merely inherited
   * by being new makes the clear silently no-op. The pane then reads "Needs you"
   * for the rest of the session, which is the single worst failure this whole
   * feature can have: it is the state the sidebar exists to surface, so a stuck
   * one makes every other pane's indicator untrustworthy too.
   *
   * What the flag would buy is one extra CLI spawn per user prompt. Everywhere
   * else it would fire, the block is real: ui_prompt_end only follows a
   * ui_prompt_start (pi emits it from a `finally`), so nothing there is wasted.
   */
  const clearBlocked = () => report("--unblocked");

  const sendMetadata = (ctx) => {
    const args = metadataArgs(ctx);
    if (args) wmux(["report-metadata", "--surface", surface, ...args]);
  };

  // ── Run state ──────────────────────────────────────────────────────────────

  pi.on("agent_start", async (_event, ctx) => {
    clearBlocked();
    report("--run-depth", "1");
    sendMetadata(ctx);
  });

  // agent_end is deliberately NOT handled: pi may still retry, compact or drain
  // queued follow-ups after it, and calling the pane idle there makes the
  // sidebar flicker through "idle" in the middle of work that is still running.
  pi.on("agent_settled", async (_event, ctx) => {
    report("--run-depth", "0");
    sendMetadata(ctx);
    reportSession(ctx);
  });

  // ── Parked on a human ──────────────────────────────────────────────────────

  pi.on("ui_prompt_start", async (event) => {
    report("--blocked", promptReason(event));
  });

  pi.on("ui_prompt_end", async () => {
    clearBlocked();
  });

  // ── Activity, so the sidebar can say what it is doing ──────────────────────

  pi.on("tool_execution_start", async (event) => {
    const now = Date.now();
    if (now - lastActivityPing < ACTIVITY_THROTTLE_MS) return;
    lastActivityPing = now;
    const tool = typeof event?.toolName === "string" ? event.toolName : "";
    const args = ["agent-activity", "--surface", surface, "--active"];
    if (tool) args.push("--tool", tool);
    wmux(args);
  });

  pi.on("tool_execution_end", async (event) => {
    const tool = typeof event?.toolName === "string" ? event.toolName : "";
    if (!tool || READ_ONLY_TOOLS.has(tool)) return;
    // Feeds the explorer's diff rollup the same way Claude Code's PostToolUse
    // hook does. Coalesced downstream per cwd (#141).
    wmux(["hook", "--event", "PostToolUse", "--tool", tool]);
  });

  // The first turn_end of a new session is the first moment its file exists.
  pi.on("turn_end", async (_event, ctx) => {
    sendMetadata(ctx);
    reportSession(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    sendMetadata(ctx);
  });

  // ── Session boundaries ─────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // A restored or switched session starts idle: state it, rather than letting
    // whatever the previous session declared stand.
    clearBlocked();
    report("--run-depth", "0");
    sendMetadata(ctx);
    // A resumed or forked session already has its file; a new one does not,
    // and reports after its first turn instead.
    reportSession(ctx);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    const reason = typeof event?.reason === "string" ? event.reason : "quit";
    // A reload may disable hooks or remove the extension. Clear its live state
    // without releasing the session file used by the existing restore feature.
    if (reason === "reload") {
      await wmux(["report-agent", "--surface", surface, "--run-depth", "0", "--unblocked"], { wait: true });
      return;
    }
    // A switch (/new, /resume, /fork): the next instance reports its own file.
    if (reason !== "quit") return;
    // A pi release, not `--run-depth 0`: the pane stops having a declared
    // agent at all, so the sidebar falls back to the shell's own state rather
    // than showing a pi that is gone as "idle" forever. wmux refuses it while
    // wmux itself is quitting, so a pi killed by that keeps its handle.
    const args = ["release-agent", "--surface", surface, "--provider", "pi", "--reason", reason];
    const file = namedSessionFile(ctx);
    if (file) args.push("--session", file);
    args.push("--seq", String(nextSeq()));
    await wmux(args, { wait: true });
  });
}

/**
 * Reachable by wmux's own test suite.
 *
 * A property on the factory rather than extra exports. pi imports only the
 * default (`jiti.import(path, { default: true })`) so extra exports would in
 * fact be harmless here — but the OpenCode loader calls EVERY export as a
 * plugin factory and took OpenCode down at startup when this file's sibling did
 * it (#191), and "harmless in this host" is not a property worth relying on
 * twice.
 */
wmuxExtension.__wmuxInternals = {
  resolveNodeRuntime,
  promptReason,
  modelLabel,
  metadataArgs,
  sessionFileOnDisk,
  nextSeq,
  READ_ONLY_TOOLS,
  METADATA_TTL_MS,
};
