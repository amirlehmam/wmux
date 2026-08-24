// wmux-plugin-version: 5
// wmux OpenCode plugin — bridges OpenCode hooks/events to the wmux sidebar.
// Auto-installed by wmux to ~/.config/opencode/plugin/wmux.js.
// No-ops entirely outside wmux (WMUX !== '1').
import { execFile } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Basenames that can execute a .js file we hand them. */
const JS_RUNTIME_RE = /^(node|bun)(\.exe)?$/i;

/**
 * Find something that can run `$WMUX_CLI` (issue #187).
 *
 * v2 used `process.execPath`, which is only a JS runtime by accident of the
 * host: under Claude Code it is node.exe, under OpenCode it is the compiled
 * `opencode.exe`. That turned every call into
 * `opencode.exe wmux.js agent-activity --active`, which prints OpenCode's help
 * and exits 1 — invisibly, so the sidebar sat on "Running" forever.
 *
 * Order matters. `WMUX_NODE` comes first because wmux resolved it in its own
 * process, where it could also fall back to its Electron binary — so it is the
 * only link in this chain that cannot come up empty. The rest is for a plugin
 * installed by an older wmux that does not declare it yet.
 *
 * Not exported — see the WmuxPlugin.__wmuxInternals note at the end of the file.
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
  // node can be installed and still absent from the PATH a plugin inherits —
  // which is precisely what #187 reported.
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
 * Where `WMUX_PLUGIN_DEBUG` should write, or null when debugging is off (#190).
 *
 * v3 logged to `console.error`, which is unreadable by design here: OpenCode is
 * a TUI that owns the terminal, and the agent running inside it cannot read its
 * own process's stderr. So the one flag meant for diagnosing the plugin could
 * only be used from a second terminal — which is why #189's 17 ms race went
 * unseen until someone hand-patched `appendFileSync` into an installed copy.
 *
 * `1`/`true` picks the default location; anything else is taken as a path, so a
 * user can drop the log somewhere they are already tailing.
 *
 * Not exported — see the WmuxPlugin.__wmuxInternals note at the end of the file.
 */
function resolveDebugLog(value, tmpdir = os.tmpdir) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v || v === "0" || v.toLowerCase() === "false") return null;
  if (v === "1" || v.toLowerCase() === "true") {
    try {
      return path.join(tmpdir(), "wmux-plugin-debug.log");
    } catch {
      return null;
    }
  }
  return v;
}

/** One-line, length-capped rendering of anything, including circular values. */
function summarize(value, max = 300) {
  let s;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = null;
  }
  if (typeof s !== "string") s = String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Appender for `file`, or a no-op when debugging is off.
 *
 * Synchronous on purpose: the ordering between an event and the CLI call it
 * caused is the whole diagnostic value, and an async write reorders exactly the
 * millisecond-scale races this exists to catch. It swallows every error — a
 * full disk must not take OpenCode down with it.
 */
function makeLogger(file) {
  if (!file) return () => {};
  return (label, data) => {
    try {
      const suffix = data === undefined ? "" : ` ${summarize(data)}`;
      appendFileSync(file, `${new Date().toISOString()} [wmux] ${label}${suffix}\n`);
    } catch {}
  };
}

/**
 * OpenCode event names that park the pane on a human, and those that free it.
 *
 * Matched exactly rather than by prefix: `permission.updated` fires on both
 * sides of the exchange in some builds, and a mis-classified one would leave a
 * pane reading "Needs you" for the rest of the session.
 */
const ASK_EVENTS = new Set(["question.asked", "permission.asked", "permission.requested"]);
const REPLY_EVENTS = new Set([
  "question.replied",
  "permission.replied",
  "question.answered",
  "permission.answered",
]);

/** Best available human-readable reason for a blocked pane; never throws. */
function askReason(event) {
  const p = (event && event.properties) || {};
  const nested = p.question || p.permission || {};
  for (const c of [p.title, p.text, nested.title, nested.text, nested.type, p.pattern]) {
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, 200);
  }
  return String(event.type).startsWith("permission")
    ? "Permission requested"
    : "Waiting for your answer";
}

export const WmuxPlugin = async () => {
  // Resolved before the WMUX gate so "the plugin loaded but did nothing" is
  // itself a visible log line — otherwise the commonest failure is silence.
  const log = makeLogger(resolveDebugLog(process.env.WMUX_PLUGIN_DEBUG));
  const surface = process.env.WMUX_SURFACE_ID;
  if (process.env.WMUX !== "1" || !surface) {
    log("init: inactive", { WMUX: process.env.WMUX, surface });
    return {};
  }

  const runtime = resolveNodeRuntime();
  log("init", {
    surface,
    runtime: runtime.file,
    electron: runtime.electron,
    cli: process.env.WMUX_CLI,
    pid: process.pid,
  });

  function wmux(args) {
    // Fire-and-forget; never block or throw into OpenCode.
    try {
      const cli = process.env.WMUX_CLI;
      const opts = { windowsHide: true };
      let file;
      let argv;
      if (cli) {
        file = runtime.file;
        argv = [cli, ...args];
        // wmux's own Electron binary is Node only with this set; without it the
        // same exe opens a second wmux window.
        if (runtime.electron) opts.env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
      } else if (process.platform === "win32") {
        // The PATH shim is `wmux.cmd`, which execFile cannot spawn without a
        // shell. Nothing to do — WMUX_CLI is always set alongside WMUX=1.
        log("cli: skipped (no WMUX_CLI on win32)", args);
        return;
      } else {
        file = "wmux";
        argv = args;
      }
      log("cli", args);
      execFile(file, argv, opts, (err, _stdout, stderr) => {
        // v2 passed `() => {}` here, which is how #187 stayed silent for a
        // whole release line. Still non-fatal, but no longer unobservable —
        // and since #190 it lands somewhere the agent itself can read.
        if (err || stderr) {
          log(`cli: ${args[0]} failed`, (err && err.message) || String(stderr).trim());
        } else {
          log(`cli: ${args[0]} ok`);
        }
      });
    } catch (err) {
      log("cli: threw", (err && err.message) || String(err));
    }
  }

  // message.part.updated fires per streaming delta (many per second). Throttle
  // the "active" pings so we don't spawn a CLI process for every token.
  let lastActivePing = 0;
  let blocked = false;

  /**
   * Real work by the agent also proves it is NOT waiting on a human.
   *
   * The self-heal matters because the unblock depends on OpenCode emitting a
   * matching `*.replied`. If a build renames it, or the user answers in a way
   * that fires nothing, the pane would otherwise claim "Needs you" forever —
   * the one failure mode that makes the whole indicator untrustworthy.
   *
   * "Real work" is deliberately narrower since #189: a running tool, a reply,
   * an edited file, a session error. Streaming message parts are NOT in the
   * set, because the ask itself streams one.
   */
  const clearBlocked = () => {
    if (!blocked) return;
    blocked = false;
    wmux(["report-agent", "--surface", surface, "--unblocked"]);
  };
  /** Tell wmux the pane is alive. Says nothing about whether it is blocked. */
  const ping = () => {
    const now = Date.now();
    if (now - lastActivePing < 1000) return;
    lastActivePing = now;
    wmux(["agent-activity", "--surface", surface, "--active"]);
  };
  const pingActive = () => {
    clearBlocked();
    ping();
  };
  const activeTool = (input) => {
    log("tool", { tool: input && input.tool, blocked });
    clearBlocked();
    const tool = String((input && input.tool) || "");
    const args = ["agent-activity", "--surface", surface, "--active"];
    if (tool) args.push("--tool", tool);
    wmux(args);
  };

  return {
    "tool.execute.after": async (input) => {
      const tool = String((input && input.tool) || "");
      if (tool) wmux(["hook", "--event", "PostToolUse", "--tool", tool]);
      activeTool(input);
    },
    "tool.execute.before": async (input) => {
      activeTool(input);
    },
    event: async ({ event }) => {
      if (!event || !event.type) return;
      const type = event.type;
      log("event", { type, properties: event.properties });
      if (type === "session.idle") {
        // NOT an unblock: a pane waiting on a permission prompt is idle by
        // definition, and clearing here would erase "Needs you" the moment it
        // appeared.
        wmux(["agent-activity", "--surface", surface, "--done"]);
      } else if (type === "session.error") {
        clearBlocked();
        wmux(["agent-activity", "--surface", surface, "--done"]);
      } else if (type === "message.part.updated") {
        // Activity ping ONLY — never an unblock (#189).
        //
        // This fires for tool status transitions, and the ask's own tool part
        // goes to "running" ~17 ms after question.asked. Treating that as "the
        // agent resumed" cleared the block within one frame, so "Needs you"
        // flashed and vanished ten seconds before the user actually answered.
        // The question being presented is not the question being answered.
        //
        // The self-heal that motivated the old clearBlocked() here still holds
        // through tool.execute.before/after (real tool work), the *.replied
        // events, and session.error — all of which mean the agent moved on.
        ping();
      } else if (type === "session.created") {
        pingActive();
      } else if (ASK_EVENTS.has(type)) {
        // Issue #188: the sidebar's whole point is telling a user with ten
        // panes open which one is waiting for them.
        blocked = true;
        wmux(["report-agent", "--surface", surface, "--blocked", askReason(event)]);
      } else if (REPLY_EVENTS.has(type)) {
        clearBlocked();
        pingActive();
      } else if (type === "file.edited") {
        // Feeds the diff view the same way Claude Code's PostToolUse hook does.
        wmux(["hook", "--event", "PostToolUse", "--tool", "Edit"]);
        pingActive();
      }
    },
    "shell.env": async (input, output) => {
      output.env.WMUX = "1";
      output.env.WMUX_SURFACE_ID = surface;
      if (process.env.WMUX_PIPE) output.env.WMUX_PIPE = process.env.WMUX_PIPE;
      if (process.env.WMUX_CLI) output.env.WMUX_CLI = process.env.WMUX_CLI;
      // Children need the runtime too, or they re-derive it and hit #187.
      if (process.env.WMUX_NODE) output.env.WMUX_NODE = process.env.WMUX_NODE;
      if (process.env.WMUX_NODE_ELECTRON) output.env.WMUX_NODE_ELECTRON = process.env.WMUX_NODE_ELECTRON;
    },
  };
};

/**
 * The helpers above, reachable by wmux's own test suite (issue #191).
 *
 * They are a property rather than four exports because OpenCode's
 * auto-discovery loader calls EVERY export of a plugin file as if it were a
 * plugin factory, then invokes a `config` hook on whatever came back. v3 and v4
 * exported these four, so the loader called e.g. `summarize(ctx)`, got a string,
 * and dereferenced `null.config` — taking OpenCode down at startup with
 * "Unexpected server error" for anyone launching it OUTSIDE wmux. Inside wmux it
 * crashed just the same, but the WMUX gate meant nobody testing wmux ever saw
 * the export loop as the cause.
 *
 * `WmuxPlugin` must stay the only export in this file. A test asserts it.
 */
WmuxPlugin.__wmuxInternals = { resolveNodeRuntime, resolveDebugLog, summarize, askReason };
