// wmux-plugin-version: 5
// wmux OpenCode CLI-side (TUI) plugin — the half that runs in the TUI process,
// so a pane is attributable even when the server is remote or shared (#310).
// Installed by `wmux opencode-tui` to <config>/plugins/wmux-cli/tui.js.
// No-ops entirely outside wmux (WMUX !== '1').
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createRoot } from "solid-js";
import { callWmux, callWmuxSync, createActivityReporter, createBlockedReporter, createPromptReporter, createSessionReporter, createSessionSeeder, eventSessionID, isHostedSession, makeLogger, resolveDebugLog, resolveNodeRuntime, routeFromTabs, tabSessionIds } from "./core.js";

export default Plugin.define({
  id: "wmux.cli",
  setup(ctx) {
    // Resolved before the WMUX gate so "the plugin loaded but did nothing" is
    // itself a visible log line — otherwise the commonest failure is silence.
    const log = makeLogger(resolveDebugLog(process.env.WMUX_PLUGIN_DEBUG));
    const surface = process.env.WMUX_SURFACE_ID;
    if (process.env.WMUX !== "1" || !surface) {
      log("init: inactive", { WMUX: process.env.WMUX, surface });
      return;
    }

    const runtime = resolveNodeRuntime();
    log("init", {
      surface,
      runtime: runtime.file,
      cli: process.env.WMUX_CLI,
      pid: process.pid,
    });

    const send = (argv, done) => callWmux(runtime, argv, log, process.env, process.platform, done);
    const sendSync = (argv) => callWmuxSync(runtime, argv, log, process.env, process.platform);
    const reporter = createSessionReporter({ surface, callWmux: send, callWmuxSync: sendSync, log });
    const prompts = createPromptReporter({ callWmux: send, log });
    const blockedState = createBlockedReporter({ surface, callWmux: send, log });
    const activity = createActivityReporter({ surface, callWmux: send, log });
    let currentSession = null;

    /** The root a session belongs to — a viewed subagent is not the pane's run. */
    const rootOf = (id) => {
      try {
        return ctx.data && ctx.data.session && typeof ctx.data.session.root === "function"
          ? ctx.data.session.root(id)
          : id;
      } catch {
        return id;
      }
    };

    /**
     * Read the route and report the session it names.
     *
     * Returns whether a handle was actually sent, so the startup seeder below
     * can stop on success. The catch is deliberate: a TUI that is still
     * mounting can throw from the router read, and that must never escape into
     * OpenCode.
     */
    const reportCurrentRoute = () => {
      try {
        const route = ctx && ctx.ui && ctx.ui.router ? ctx.ui.router.current() : null;
        const tabs = ctx && ctx.ui && ctx.ui.tabs && typeof ctx.ui.tabs.list === "function"
          ? ctx.ui.tabs.list()
          : [];
        // A `--server` TUI can display a restored conversation while the router
        // still answers home/null. A single open tab is that conversation;
        // with several, only the router can say which one is on screen.
        const candidate = routeFromTabs(route, tabs);
        currentSession = candidate && candidate.type === "session" && typeof candidate.sessionID === "string"
          ? candidate.sessionID
          : null;
        const reported = reporter.observe(candidate, rootOf);
        if (!reported && !reporter.hasSession()) {
          let root;
          try {
            root = candidate && candidate.type === "session" ? rootOf(candidate.sessionID) : undefined;
          } catch (err) {
            root = (err && err.message) || String(err);
          }
          log("route: none", { route, tabs: tabSessionIds(tabs), root });
        }
        // A report sent now, or one already held, is success for the seeder:
        // retrying after a handle exists only burns timers and logs "gave up".
        return reported || reporter.hasSession();
      } catch (err) {
        log("route: threw", (err && err.message) || String(err));
        return false;
      }
    };

    // A viewed session is a store read, so the reporter follows navigation
    // reactively — no polling, and no lag behind the tab the user is on. The
    // view can change while a report is in flight; `report-session` is
    // last-writer-wins on main's side, so the newest call settles it.
    const stopRoute = createRoot((dispose) => {
      createEffect(reportCurrentRoute);
      return dispose;
    });

    // A session the TUI auto-opens (or a `-s` conversation that loads slowly)
    // can become current after that first effect read. Re-read on a short
    // bounded schedule until a handle is sent; the effect above owns every
    // later navigation.
    const seeder = createSessionSeeder({ reportCurrent: reportCurrentRoute, log });
    seeder.start();

    // The event stream is the connected server's, which with a shared or
    // remote server also carries other panes' sessions. Only the session this
    // TUI is viewing, or one open in a tab, belongs to this pane.
    const hostedNow = (sessionID) => {
      let tabs = [];
      try {
        if (ctx && ctx.ui && ctx.ui.tabs && typeof ctx.ui.tabs.list === "function") {
          tabs = tabSessionIds(ctx.ui.tabs.list());
        }
      } catch {}
      return isHostedSession(sessionID, { current: currentSession, tabs });
    };

    // Prompt admission (#310 phase 2): `session.inbox.enqueued` is the
    // client-side announcement, and its `user` item carries the text the server
    // half would have read from `session.prompt` (#304). Synthetic, compaction
    // and move items are excluded by the core.
    let stopInbox = () => {};
    try {
      if (ctx && ctx.data && typeof ctx.data.on === "function") {
        stopInbox = ctx.data.on("session.inbox.enqueued", (evt) => {
          try {
            const payload = evt && evt.data;
            prompts.observe(payload, hostedNow(payload && payload.sessionID));
          } catch (err) {
            log("inbox: threw", (err && err.message) || String(err));
          }
        }) || (() => {});
      }
    } catch (err) {
      log("inbox: subscribe failed", (err && err.message) || String(err));
    }

    // A deleted conversation must not stay a restore handle. The server half
    // already handles `session.deleted`; the TUI half needs it too, because in
    // a remote/shared pane this is the only half holding the handle.
    let stopDeleted = () => {};
    try {
      if (ctx && ctx.data && typeof ctx.data.on === "function") {
        stopDeleted = ctx.data.on("session.deleted", (evt) => {
          try {
            const id = eventSessionID("session.deleted", evt && evt.data);
            if (id && id === currentSession) currentSession = null;
            reporter.forget(id);
          } catch (err) {
            log("deleted: threw", (err && err.message) || String(err));
          }
        }) || (() => {});
      }
    } catch (err) {
      log("deleted: subscribe failed", (err && err.message) || String(err));
    }

    // Blocked state (#310 phase 3a): the v2 forms and permissions that the
    // server half reports as question/permission asks. Scoped to hosted
    // sessions like prompts; tool and streaming events are deliberately absent
    // — they are not "the human dealt with it" (#189).
    const stopBlocked = [];
    for (const type of [
      "permission.asked",
      "permission.replied",
      "form.created",
      "form.replied",
      "form.cancelled",
      "session.execution.interrupted",
      "session.execution.failed",
    ]) {
      try {
        if (ctx && ctx.data && typeof ctx.data.on === "function") {
          const stop = ctx.data.on(type, (evt) => {
            try {
              const data = evt && evt.data;
              blockedState.observe(type, data, hostedNow(eventSessionID(type, data)));
            } catch (err) {
              log(`blocked: ${type} threw`, (err && err.message) || String(err));
            }
          });
          if (typeof stop === "function") stopBlocked.push(stop);
        }
      } catch (err) {
        log(`blocked: ${type} subscribe failed`, (err && err.message) || String(err));
      }
    }

    // Working/idle (#310 phase 3b): absolute `--run-depth` values from the
    // execution events. An end always clears its session id, even after the
    // view moved — hosting only gates a start.
    const stopActivity = [];
    for (const type of [
      "session.execution.started",
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
    ]) {
      try {
        if (ctx && ctx.data && typeof ctx.data.on === "function") {
          const stop = ctx.data.on(type, (evt) => {
            try {
              const data = evt && evt.data;
              activity.observe(type, data, hostedNow(rootOf(eventSessionID(type, data))));
            } catch (err) {
              log(`activity: ${type} threw`, (err && err.message) || String(err));
            }
          });
          if (typeof stop === "function") stopActivity.push(stop);
        }
      } catch (err) {
        log(`activity: ${type} subscribe failed`, (err && err.message) || String(err));
      }
    }

    // The raw event stream is also the trigger for a manual session switch:
    // the router effect above does not reliably re-run for an existing
    // conversation, and `session.viewed` is carried here rather than by
    // `data.on`. The event stream is the whole server's, so the event's id is
    // deliberately NOT used — only the route this TUI is on is re-read.
    let stopEvents = () => {};
    try {
      if (ctx && ctx.data && typeof ctx.data.listen === "function") {
        const seen = new Set();
        stopEvents = ctx.data.listen((payload) => {
          const type = payload && payload.details && payload.details.type;
          if (type === "session.viewed") {
            try {
              reportCurrentRoute();
            } catch (err) {
              log("viewed: threw", (err && err.message) || String(err));
            }
          }
          if (type && !seen.has(type)) {
            seen.add(type);
            log("event", type);
          }
        }) || (() => {});
      }
    } catch (err) {
      log("events: hook failed", (err && err.message) || String(err));
    }

    let tornDown = false;
    /**
     * Stop this plugin instance's work WITHOUT releasing the session.
     *
     * The host calls this on a clean shutdown and on a plugin RELOAD after
     * `wmux opencode-tui` writes new files. Releasing here made every open pane
     * lose its restore handle the moment the plugin was updated, so the
     * release belongs to the real process exit below.
     */
    const teardown = () => {
      if (tornDown) return;
      tornDown = true;
      seeder.stop();
      try { stopInbox(); } catch {}
      try { stopDeleted(); } catch {}
      for (const stop of stopBlocked) { try { stop(); } catch {} }
      for (const stop of stopActivity) { try { stop(); } catch {} }
      try { stopEvents(); } catch {}
      try { stopRoute(); } catch {}
    };
    // The one path that releases: an actual OpenCode exit. Synchronous because
    // an async spawn dies with the process; `opencode run` has been seen to
    // neither exit nor dispose cleanly (#290), and this is the backstop the
    // server half also carries.
    process.once("exit", () => { try { reporter.releaseOnExit(); } catch {} });
    return teardown;
  },
});
