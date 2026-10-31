// wmux OpenCode CLI-side (TUI) plugin — the parts wmux's test suite can load.
//
// The installed entry (tui.js) imports @opencode/plugin/tui and solid-js,
// which only exist inside the TUI host; this module deliberately imports node
// builtins only, so routing and reporting rules stay unit-testable in wmux's
// own suite. Installed beside the entry as core.js (issue #310).
//
// No version marker here: the marker on tui.js is what the installer compares,
// and the pair is always written together (core first, entry last).
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * OpenCode session ids are `ses_` + base62. Same rule as the server half
 * (resources/opencode-plugin/wmux.js) and main's validator: strict because the
 * value ends up on a restored pane's command line, and the two halves are
 * installed separately so neither can import the other.
 */
export const SESSION_ID_RE = /^ses_[A-Za-z0-9_]{8,120}$/;

/** Basenames that can execute a .js file we hand them. */
const JS_RUNTIME_RE = /^(node|bun)(\.exe)?$/i;

/**
 * Find something that can run `$WMUX_CLI` (issue #187).
 *
 * `process.execPath` is only a JS runtime by accident of the host: under
 * Claude Code it is node.exe, under OpenCode it is the compiled `opencode.exe`,
 * and under a TUI running in WSL `WMUX_NODE` is a Windows path that does not
 * exist in the distro. Fall back to the host, then to PATH and the well-known
 * install directories — the same order the server half uses.
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
 * Where `WMUX_PLUGIN_DEBUG` should write, or null when debugging is off
 * (issue #190). A file, not the console: the TUI owns the terminal, and an
 * agent working inside it cannot read its own stderr.
 */
export function resolveDebugLog(value, tmpdir = os.tmpdir) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v || v === "0" || v.toLowerCase() === "false") return null;
  if (v === "1" || v.toLowerCase() === "true") {
    try {
      return path.join(tmpdir(), "wmux-tui-plugin-debug.log");
    } catch {
      return null;
    }
  }
  return v;
}

/** One-line, length-capped rendering of anything, including circular values. */
export function summarize(value, max = 300) {
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
 * caused is the diagnostic. Swallows every error — a full disk must not take
 * the TUI down with it.
 */
export function makeLogger(file) {
  if (!file) return () => {};
  return (label, data) => {
    try {
      const suffix = data === undefined ? "" : ` ${summarize(data)}`;
      appendFileSync(file, `${new Date().toISOString()} [wmux-tui] ${label}${suffix}\n`);
    } catch {}
  };
}

/** How long one CLI call may run before execFile kills it and reports done. */
const CLI_TIMEOUT_MS = 10_000;

/**
 * Run the wmux CLI without ever blocking or throwing into OpenCode.
 *
 * argv is passed through untouched: `params` come from wmux itself and no
 * shell is involved unless the PATH fallback names `wmux`, which on Windows is
 * why the .cmd shim is refused (#154/#187).
 */
export function callWmux(runtime, argv, log = () => {}, env = process.env, platform = process.platform, done = () => {}) {
  // `done` fires exactly once, on every path, when this call can no longer
  // reach the pipe — which is what lets a reporter order its own calls.
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    try { done(); } catch {}
  };
  try {
    const cli = env.WMUX_CLI;
    // Bounded: the activity reporter keeps one call in flight and waits on
    // `done`, so a CLI that never returned would silence every later report.
    const opts = { windowsHide: true, timeout: CLI_TIMEOUT_MS };
    let file;
    let args;
    if (cli) {
      file = runtime.file;
      args = [cli, ...argv];
      // wmux's own Electron binary is Node only with this set; without it the
      // same exe opens a second wmux window.
      if (runtime.electron) opts.env = { ...env, ELECTRON_RUN_AS_NODE: "1" };
    } else if (platform === "win32") {
      // The PATH shim is `wmux.cmd`, which execFile cannot spawn without a
      // shell. Nothing to do — WMUX_CLI is always set alongside WMUX=1.
      log("cli: skipped (no WMUX_CLI on win32)", argv);
      finish();
      return;
    } else {
      file = "wmux";
      args = argv;
    }
    log("cli", args);
    execFile(file, args, opts, (err, _stdout, stderr) => {
      if (err || stderr) {
        log(`cli: ${argv[0]} failed`, (err && err.message) || String(stderr).trim());
      } else {
        log(`cli: ${argv[0]} ok`);
      }
      finish();
    });
  } catch (err) {
    log("cli: threw", (err && err.message) || String(err));
    finish();
  }
}

/**
 * Synchronous sibling of `callWmux`, for the process-exit hook.
 *
 * An async spawn dies with the process, so a handle released from `exit` must
 * be sent synchronously. Bounded like the async path: quitting OpenCode is not
 * worth hanging on, and a failed release is better than a stuck process. The
 * server half uses the same shape.
 */
export function callWmuxSync(runtime, argv, log = () => {}, env = process.env, platform = process.platform) {
  try {
    const cli = env.WMUX_CLI;
    let file;
    let args;
    let childEnv = env;
    if (cli) {
      file = runtime.file;
      args = [cli, ...argv];
      if (runtime.electron) childEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
    } else if (platform === "win32") {
      log("cli: sync skipped (no WMUX_CLI on win32)", argv);
      return false;
    } else {
      file = "wmux";
      args = argv;
    }
    log("cli: sync", args);
    execFileSync(file, args, { windowsHide: true, timeout: 1500, stdio: "ignore", env: childEnv });
    return true;
  } catch (err) {
    log("cli: sync failed", (err && err.message) || String(err));
    return false;
  }
}

/**
 * The session id a route names, or null when there is nothing to report.
 *
 * A viewed subagent is not a resumable handle — the server half skips a
 * session born with a `parentID`, and the TUI-side equivalent is to report the
 * root the child belongs to. A root lookup that fails or answers nothing
 * leaves the viewed id alone; dropping the handle on a transient store miss
 * would make restore forget the session for good.
 */
export function planSessionReport(route, rootOf) {
  if (!route || route.type !== "session" || typeof route.sessionID !== "string") return null;
  let id = route.sessionID;
  try {
    const root = typeof rootOf === "function" ? rootOf(id) : undefined;
    if (typeof root === "string" && SESSION_ID_RE.test(root)) id = root;
  } catch {}
  return SESSION_ID_RE.test(id) ? id : null;
}

/**
 * Reports the viewed session to wmux, once per session. `releaseOnExit` is the
 * synchronous release for `process.once("exit")`; `dispose` remains the async
 * form for a caller that is still alive.
 *
 * `last` is intentionally sticky across navigation to a non-session route:
 * the pane's conversation is still the last one it was in, and restore should
 * reopen it. `disposed` is sticky too — a disposed TUI must not resurrect a
 * handle when a late store update fires.
 */
export function createSessionReporter({ surface, callWmux: send, callWmuxSync: sendSync, log = () => {} }) {
  let last = null;
  let disposed = false;

  /**
   * Release the last handle. `sync` is for the process-exit hook: an async
   * spawn dies with the process, so only the synchronous CLI can land there.
   * The host's plugin DISPOSE is deliberately NOT treated as an exit — it also
   * runs on a reload after `wmux opencode-tui` writes new files, and releasing
   * there made every open pane lose its restore handle.
   */
  const release = (sync) => {
    if (disposed) return false;
    disposed = true;
    if (!last) return false;
    const id = last;
    last = null;
    const argv = ["release-agent", "--provider", "opencode", "--session", id, "--surface", surface];
    if (sync && typeof sendSync === "function") sendSync(argv);
    else send(argv);
    return true;
  };

  return {
    observe(route, rootOf) {
      if (disposed) return false;
      const id = planSessionReport(route, rootOf);
      if (!id || id === last) return false;
      last = id;
      log("session", id);
      send(["report-session", id, "--provider", "opencode", "--surface", surface]);
      return true;
    },
    /**
     * Drop a handle the agent deleted. A deleted session must never become a
     * restore command: OpenCode would open an empty home screen and the saved
     * id would stay in the tree forever. Only the handle this reporter holds
     * is released, matching the server half's `session.deleted` rule.
     */
    forget(id) {
      if (disposed || typeof id !== "string" || !id || id !== last) return false;
      last = null;
      log("session deleted", id);
      send(["release-agent", "--provider", "opencode", "--session", id, "--surface", surface]);
      return true;
    },
    /** Whether a handle is currently held, so a seeder can stop retrying. */
    hasSession() {
      return last !== null;
    },
    /** Asynchronous release, for a caller that is still alive. */
    dispose() {
      release(false);
    },
    /** Synchronous release, for `process.once("exit")`. */
    releaseOnExit() {
      return release(true);
    },
  };
}

/**
 * Reports a session that becomes current while the TUI is still starting.
 *
 * The Solid effect in the entry file is the ordinary trigger, and a session
 * opened after startup reaches it reliably. The gap is the session the TUI
 * restores or auto-opens during its own startup: the effect's first read can
 * happen before the route exists, and a route assigned afterwards is not
 * guaranteed to re-run it. A bounded re-read is the backstop — it is not a
 * poll for the life of the TUI, and it stops the moment a handle is reported.
 *
 * `reportCurrent` is injected so the schedule and the read are both testable
 * without an OpenCode host. It must return true when a handle was sent.
 */
export function createSessionSeeder({
  reportCurrent,
  log = () => {},
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (timer) => clearTimeout(timer),
  delays = [250, 1000, 2000, 4000],
}) {
  let stopped = false;
  let timer = null;
  let next = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      try { cancel(timer); } catch {}
      timer = null;
    }
  };

  const attempt = () => {
    timer = null;
    if (stopped) return;
    let reported = false;
    try {
      reported = reportCurrent() === true;
    } catch (err) {
      log("seed: threw", (err && err.message) || String(err));
    }
    if (reported) {
      stop();
      return;
    }
    const delay = delays[next++];
    if (delay === undefined) {
      log("seed: gave up");
      return;
    }
    try {
      timer = schedule(attempt, delay);
    } catch (err) {
      log("seed: schedule failed", (err && err.message) || String(err));
      return;
    }
    // A pending seed must not keep a quitting TUI alive.
    if (timer && typeof timer.unref === "function") timer.unref();
  };

  return {
    /** Read once now, then on the declared schedule until a report succeeds. */
    start() {
      if (!stopped) attempt();
    },
    stop,
  };
}

/**
 * The cap `wmux-hook.js` and the server half apply to a prompt (#304). argv
 * borne here rather than stdin, so it must stay well under the Windows
 * command-line limit; 4000 is the number the other producers use.
 */
const MAX_PROMPT = 4000;

/**
 * The user prompt an inbox event carries, or null when it is not one (#310
 * phase 2).
 *
 * OpenCode v2 announces prompt admission client-side as `session.inbox.enqueued`
 * with `{ sessionID, inboxID, item }` and a tagged `item`: only `user` is
 * something a human typed — synthetic messages, compaction controls and moves
 * are the same set the server-side `session.prompt` hook excludes by itself.
 * `inboxID` is the dedupe key; a replay of the same admission must not put two
 * jump marks on one line.
 */
export function planPromptReport(payload) {
  if (!payload || typeof payload !== "object") return null;
  const { sessionID, inboxID, item } = payload;
  if (!SESSION_ID_RE.test(sessionID)) return null;
  if (!item || item.type !== "user") return null;
  const text = item.payload && typeof item.payload.text === "string" ? item.payload.text : "";
  if (!text.trim()) return null;
  return { sessionID, inboxID: typeof inboxID === "string" && inboxID ? inboxID : null, text };
}

/**
 * Whether a session belongs to THIS TUI: the one being viewed, or one open in
 * a tab. The event stream is the connected server's, which with a shared or
 * remote server carries other panes' sessions too — attributing those to this
 * pane would put pane B's prompt in pane A's outline.
 */
export function isHostedSession(sessionID, { current, tabs } = {}) {
  if (typeof sessionID !== "string" || !sessionID) return false;
  if (sessionID === current) return true;
  return Array.isArray(tabs) && tabs.includes(sessionID);
}

/** Session ids from `ui.tabs.list()`, defensively — the host shape is not ours. */
export function tabSessionIds(list) {
  if (!Array.isArray(list)) return [];
  const ids = [];
  for (const tab of list) {
    const id = tab && (tab.sessionID || tab.sessionId || tab.id);
    if (typeof id === "string" && id) ids.push(id);
  }
  return ids;
}

/**
 * The route to report: the router's session when it has one, else the only
 * session open in this TUI.
 *
 * A `--server` TUI that auto-opens the last conversation can show it while
 * `ui.router.current()` still answers home/null; the tab list knows the
 * session even when the route does not. Only a SINGLE tab is used: with
 * several, guessing which one is displayed would file the wrong conversation
 * as the pane's restore handle.
 */
export function routeFromTabs(route, tabs) {
  if (route && route.type === "session" && typeof route.sessionID === "string") return route;
  const ids = tabSessionIds(tabs);
  return ids.length === 1 ? { type: "session", sessionID: ids[0] } : route;
}

/**
 * Reports hosted user prompts through the same `hook.event` path the server
 * half uses (#305): `caller` is stamped by the CLI transport, and the renderer
 * resolves it for the prompt log only. `inboxID` dedupes admission; the
 * renderer's identical-text window is the backstop when both halves run.
 */
export function createPromptReporter({ callWmux: send, log = () => {} }) {
  const seen = new Set();
  return {
    observe(payload, hosted) {
      if (!hosted) return;
      const plan = planPromptReport(payload);
      if (!plan) return;
      if (plan.inboxID) {
        if (seen.has(plan.inboxID)) return;
        seen.add(plan.inboxID);
        if (seen.size > 200) seen.delete(seen.values().next().value);
      }
      const text = plan.text.trim().slice(0, MAX_PROMPT);
      if (!text) return;
      log("prompt", { chars: text.length });
      send(["hook", "--event", "UserPromptSubmit", "--prompt", text]);
    },
  };
}

/** The 200-char bound the server half's `askReason` applies to a block reason. */
const MAX_REASON = 200;

/** How many answered ask ids are remembered against a replay. */
const MAX_ANSWERED = 200;

/** Where a blocked-state event keeps its session id: forms nest it in `form`. */
export function eventSessionID(type, data) {
  if (!data || typeof data !== "object") return null;
  let id;
  if (type === "form.created") {
    id = data.form && data.form.sessionID;
  } else if (type === "session.deleted") {
    // v2 is flat (`data.sessionID`); the server half also accepts `info.id`.
    const info = data.info && typeof data.info === "object" ? data.info : null;
    id = data.sessionID || (info && info.id);
  } else {
    id = data.sessionID;
  }
  return typeof id === "string" && id ? id : null;
}

/**
 * Reports whether the pane is parked on a human (#310 phase 3a), from the TUI
 * side.
 *
 * v2 announces what the server half reads as `question.asked`/`permission.asked`
 * as `form.created` and `permission.asked`; replies and cancellations are the
 * explicit "the human dealt with it" events. Tool and streaming events are
 * deliberately NOT unblocks — the ask's own tool part transitions state within
 * a frame of the ask (#189), and a block that clears itself is worse than one
 * that lingers.
 *
 * Every open ask is tracked by its id, with the session it belongs to, so:
 * - two overlapping asks need two answers — the first reply does not clear a
 *   "Needs you" the second one still deserves;
 * - a reply to an ask this pane raised counts even when its session is no
 *   longer the one on screen (the user switched tabs to answer elsewhere);
 * - a replayed ask is one "Needs you", and a replay of one already answered is
 *   none.
 * An ask with no id is cleared by any reply of its kind, so it cannot strand
 * the pane. A turn that ends interrupted or failed clears its session's asks.
 */
export function createBlockedReporter({ surface, callWmux: send, log = () => {} }) {
  /** `per:<id>` / `frm:<id>` → the session it was asked in (or null). */
  const pending = new Map();
  /** Ids already answered, so a replayed ask cannot raise "Needs you" again. */
  const answered = new Set();
  let blocked = false;

  const keyOf = (kind, id) => (typeof id === "string" && id ? `${kind}:${id}` : `${kind}:?`);
  const remember = (key) => {
    answered.add(key);
    if (answered.size > MAX_ANSWERED) answered.delete(answered.values().next().value);
  };

  const ask = (key, sessionID, reason, fallback) => {
    if (pending.has(key) || answered.has(key)) return;
    pending.set(key, sessionID);
    const text = ((typeof reason === "string" && reason.trim()) || fallback).slice(0, MAX_REASON);
    blocked = true;
    log("blocked", { chars: text.length });
    send(["report-agent", "--surface", surface, "--blocked", text]);
  };
  const settle = () => {
    if (!blocked || pending.size > 0) return;
    blocked = false;
    log("unblocked");
    send(["report-agent", "--surface", surface, "--unblocked"]);
  };
  const reply = (kind, id, hosted) => {
    const key = keyOf(kind, id);
    if (pending.has(key)) {
      pending.delete(key);
      if (!key.endsWith(":?")) remember(key);
    } else if (hosted) {
      // An answer to an ask we never identified: release the anonymous one.
      pending.delete(`${kind}:?`);
    } else {
      return;
    }
    settle();
  };
  const endTurn = (sessionID, hosted) => {
    let touched = false;
    for (const [key, owner] of pending) {
      if (owner === sessionID || (hosted && owner === null)) {
        pending.delete(key);
        touched = true;
      }
    }
    if (touched || hosted) settle();
  };

  return {
    observe(type, data, hosted) {
      if (!data || typeof data !== "object") return;
      const sessionID = eventSessionID(type, data);
      switch (type) {
        case "permission.asked":
          if (hosted) ask(keyOf("per", data.id), sessionID, data.message, data.action || "Permission requested");
          return;
        case "form.created": {
          const form = data.form && typeof data.form === "object" ? data.form : {};
          if (hosted) ask(keyOf("frm", form.id), sessionID, form.title, "Input requested");
          return;
        }
        case "permission.replied":
          reply("per", data.requestID, hosted);
          return;
        case "form.replied":
        case "form.cancelled":
          reply("frm", data.id, hosted);
          return;
        case "session.execution.interrupted":
        case "session.execution.failed":
          endTurn(sessionID, hosted);
          return;
        default:
          return;
      }
    },
  };
}

/**
 * Declares whether this pane is working (#310 phase 3b).
 *
 * v2 opens a busy period with `session.execution.started` and ends it with
 * exactly one of succeeded/failed/interrupted — the same pair the bundled TUI
 * notifications plugin uses. Depth is ABSOLUTE (`--run-depth 0|1`): the same
 * value means the same thing to every producer, so a second reporter converges
 * instead of inflating a refcount.
 *
 * Running sessions are tracked by id, for the reason 01df550 fixed in the
 * blocked reporter: the pane owns what it reported. An end clears its id even
 * when the view has moved — hosting only gates the start — and a subagent's end
 * cannot return the pane to idle while its parent is still running.
 *
 * Reports go out ONE AT A TIME. Each is its own CLI process, and two processes
 * spawned a few ms apart race to the pipe: a short turn's `--run-depth 0` could
 * land before its `1` and leave the pane "working" for the whole trust window —
 * the #151 race. The next report waits for the previous call to finish, and
 * whatever changed meanwhile collapses into the latest wanted depth.
 */
export function createActivityReporter({ surface, callWmux: send, log = () => {} }) {
  const running = new Set();
  let wanted = null;
  let sent = null;
  let inFlight = false;

  const flush = () => {
    if (inFlight || wanted === sent) return;
    const depth = wanted;
    sent = depth;
    inFlight = true;
    log(depth ? "working" : "idle");
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      inFlight = false;
      flush();
    };
    try {
      send(["report-agent", "--surface", surface, "--run-depth", depth ? "1" : "0"], finish);
    } catch {
      finish();
    }
  };

  const report = (depth) => {
    wanted = depth;
    flush();
  };

  return {
    observe(type, data, hosted) {
      if (!data || typeof data !== "object") return;
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
      if (!sessionID) return;
      if (type === "session.execution.started") {
        if (!hosted || running.has(sessionID)) return;
        running.add(sessionID);
        report(true);
        return;
      }
      if (
        type === "session.execution.succeeded" ||
        type === "session.execution.failed" ||
        type === "session.execution.interrupted"
      ) {
        if (!running.delete(sessionID)) return;
        if (running.size === 0) report(false);
      }
    },
  };
}
