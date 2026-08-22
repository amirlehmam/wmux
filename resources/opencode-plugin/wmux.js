// wmux-plugin-version: 3
// wmux OpenCode plugin — bridges OpenCode hooks/events to the wmux sidebar.
// Auto-installed by wmux to ~/.config/opencode/plugin/wmux.js.
// No-ops entirely outside wmux (WMUX !== '1').
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
 * Exported for wmux's tests; OpenCode ignores extra exports.
 */
export function resolveNodeRuntime(
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
export function askReason(event) {
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
  if (process.env.WMUX !== "1") return {};
  const surface = process.env.WMUX_SURFACE_ID;
  if (!surface) return {};

  const runtime = resolveNodeRuntime();
  const debug = process.env.WMUX_PLUGIN_DEBUG === "1";

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
        return;
      } else {
        file = "wmux";
        argv = args;
      }
      execFile(file, argv, opts, (err, _stdout, stderr) => {
        // v2 passed `() => {}` here, which is how #187 stayed silent for a
        // whole release line. Still non-fatal, but no longer unobservable.
        if (debug && (err || stderr)) {
          console.error(`[wmux] ${args[0]} failed:`, (err && err.message) || String(stderr).trim());
        }
      });
    } catch {}
  }

  // message.part.updated fires per streaming delta (many per second). Throttle
  // the "active" pings so we don't spawn a CLI process for every token.
  let lastActivePing = 0;
  let blocked = false;

  /**
   * Any sign of the agent doing work also proves it is NOT waiting on a human.
   *
   * The self-heal matters because the unblock depends on OpenCode emitting a
   * matching `*.replied`. If a build renames it, or the user answers in a way
   * that fires nothing, the pane would otherwise claim "Needs you" forever —
   * the one failure mode that makes the whole indicator untrustworthy.
   */
  const clearBlocked = () => {
    if (!blocked) return;
    blocked = false;
    wmux(["report-agent", "--surface", surface, "--unblocked"]);
  };
  const pingActive = () => {
    clearBlocked();
    const now = Date.now();
    if (now - lastActivePing < 1000) return;
    lastActivePing = now;
    wmux(["agent-activity", "--surface", surface, "--active"]);
  };
  const activeTool = (input) => {
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
      if (type === "session.idle") {
        // NOT an unblock: a pane waiting on a permission prompt is idle by
        // definition, and clearing here would erase "Needs you" the moment it
        // appeared.
        wmux(["agent-activity", "--surface", surface, "--done"]);
      } else if (type === "session.error") {
        clearBlocked();
        wmux(["agent-activity", "--surface", surface, "--done"]);
      } else if (type === "message.part.updated") {
        pingActive();
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
