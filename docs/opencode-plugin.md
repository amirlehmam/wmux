# The wmux OpenCode plugin

wmux drives its sidebar from what an agent *declares*, not from what its output
looks like on screen. For Claude Code that comes from hooks; for OpenCode it
comes from a plugin wmux installs for you, at:

```
~/.config/opencode/plugin/wmux.js
```

The plugin no-ops entirely outside wmux (`WMUX !== "1"`), and is only installed
once you have granted the agent-integration consent prompt. Removing that
consent deletes it again.

---

## What it reports

| OpenCode event | What wmux is told |
|---|---|
| `question.asked`, `permission.asked`, `permission.requested` | pane is **blocked** — sidebar shows "Needs you" |
| `question.replied` / `.answered`, `permission.replied` / `.answered` | unblocked |
| `tool.execute.before` / `.after` | active, with the tool name |
| `message.part.updated` | active (throttled to 1/s) |
| `file.edited` | active, and refreshes the diff view |
| `session.idle` | done |
| `session.error` | done, and unblocked |
| prompt admission, v2 (`ctx.session.hook("prompt")`) | the user's submitted prompt enters the **prompt log** — highlight, outline, `wmux prompts` |

**`message.part.updated` never unblocks a pane.** That looks like a missing
self-heal and is deliberate: OpenCode emits one for the ask's *own* tool part
going to `running`, roughly 17 ms after `question.asked`. Treating it as "the
agent resumed" cleared the block within a single frame, so "Needs you" appeared
and vanished ten seconds before the user answered ([#189][189]).

The self-heal that mattered — never leaving a pane stuck on "Needs you" if
OpenCode fails to emit a matching `*.replied` — still holds through
`tool.execute.before`/`.after`, the reply events, and `session.error`. All of
those mean the agent actually moved on.

---

## The prompt log

Since plugin version 8 ([#304][304]) a submitted prompt also reaches the prompt
log. The v2 plugin registers `ctx.session.hook("prompt")`, reads
`event.prompt.text`, and calls `wmux hook --event UserPromptSubmit --prompt …` —
the same event Claude Code's `UserPromptSubmit` hook produces, which is what
fills the prompt outline, the Prompts pane and `wmux prompts`. Before this the
log stayed empty for every OpenCode pane, because the shell integration's
OSC 133 marks end when a TUI takes the screen and nothing else ever sent the
event.

- The text is capped at 4000 chars, the same `MAX_PROMPT` `wmux-hook.js` uses.
- `event.messageID` dedupes admission: OpenCode documents the hook as
  retry-safe but not exactly-once, and two entries would put two jump marks on
  one line. A missing id falls back to the renderer's own identical-text window.
- OpenCode runs the hook for prompts a human submitted; synthetic messages,
  shell messages and compaction controls are excluded by OpenCode itself.
- Same shared-server caveat as the session handle below: on
  `opencode serve --service` the plugin's pane is the one that started the
  server.
- v1 gets no prompt log; only the v2 half registers the hook.

---

## The CLI-side (TUI) half

The plugin above runs in OpenCode's **server** process. When the TUI is a
client of a **remote server**, or of v2's shared `opencode serve --service` for
another pane, that process has no pane's environment and none of its reports
can be attributed — the docs above record that limit for the session handle.

Since the CLI-side (TUI) half exists it covers those setups: it runs in the
TUI process, against a remote server, with the pane's `WMUX_*` environment.

Install it from the pane that will host the TUI:

```bash
wmux opencode-tui            # install or update, into <config>/plugins/wmux-cli/
wmux opencode-tui --remove   # remove, only when the file carries our marker
```

- It writes `tui.js` and `core.js` to `<config>/plugins/wmux-cli/` — the
  directory form OpenCode's CLI resolves without a `package.json`. `<config>`
  is `$XDG_CONFIG_HOME/opencode` when that variable is absolute, else
  `~/.config/opencode`, resolved **in the environment the command runs in**.
  In a WSL pane that is the distro's home; in a devcontainer, the container's.
  Nothing on the Windows side writes into a WSL home.
- It is not installed automatically and does not need a wmux restart. Re-run
  the command after upgrading wmux: it compares the `// wmux-plugin-version:`
  marker on `tui.js` and rewrites both files when the shipped version differs.
- **Keep backups outside `plugins/`.** OpenCode loads *every* directory under
  `<config>/plugins/` as a plugin, so a copy such as
  `plugins/wmux-cli.bak/tui.js` registers the same `wmux.cli` id, shadows the
  live one, and the symptom is silence: no `init` line and no reports. Move an
  old copy to `~/wmux-cli.bak` instead of leaving it beside the plugin.
- **What it reports today** (issue #310): the viewed session handle —
  `wmux report-session <id> --provider opencode` — so *Resume OpenCode sessions
  on restore* works for remote/shared setups. The viewed tab is followed
  reactively; a viewed subagent resolves to its root; quitting the TUI releases
  the handle.
- **Prompts** (plugin v2): user prompts submitted in the pane enter the prompt
  log through the same `UserPromptSubmit` event the server half sends (#304).
  The source is v2's `session.inbox.enqueued` — only its `user` item counts, so
  synthetic messages, compaction controls and moves never appear as something a
  human typed. `inboxID` dedupes admission. The event stream is the connected
  server's, so a prompt is attributed only when its session is the one being
  viewed or is open in a tab — with several panes on one server, pane B's
  prompt cannot land in pane A's outline.
- **Blocked state** (plugin v3): a `permission.asked` or `form.created` on a
  hosted session marks the pane **blocked** — reason from the permission's
  `message`/`action` or the form's title. It is cleared only by an explicit
  `permission.replied`, `form.replied`/`form.cancelled`, or a turn-ending
  `session.execution.interrupted`/`.failed` — never by tool or streaming
  activity (#189). Each open ask is tracked by its id: overlapping asks need
  every one answered, a reply to an ask the pane raised counts even after its
  session left the screen, a turn failure clears only that session's asks,
  and a replay of an ask — answered or not — never raises "Needs you" twice.
- **Working/idle** (plugin v4): `session.execution.started` declares
  `report-agent --run-depth 1`; `succeeded`/`failed`/`interrupted` declare
  `--run-depth 0`. The values are absolute, so a second producer converges
  instead of inflating a refcount. Running sessions are tracked by id: an end
  still clears after the user switches tabs, and a subagent's end cannot return
  a pane to idle while its parent is still running. Tool labels stay out.
- `WMUX_PLUGIN_DEBUG` works as it does for the server half, into
  `wmux-tui-plugin-debug.log`, and logs each distinct TUI event type once —
  which is how the prompt-submission signal was identified.
- WSL needs the same prerequisites as any wmux CLI call from inside the
  distro: `WMUX_*` arrives via `WSLENV`, and the named pipe is reached through
  `npiperelay.exe` automatically (`docs/DEVCONTAINER.md`).

---

## Debugging it

Set `WMUX_PLUGIN_DEBUG` before launching OpenCode:

```bash
# on, default location: %TEMP%\wmux-plugin-debug.log (Windows), $TMPDIR/… (unix)
export WMUX_PLUGIN_DEBUG=1

# or point it wherever you are already tailing
export WMUX_PLUGIN_DEBUG=/tmp/wmux-debug.log
```

It logs plugin init (resolved JS runtime, surface id, CLI path), every event
received, every wmux CLI call, and each call's result — in order, written
synchronously, because the ordering between an event and the call it caused is
the entire diagnostic:

```
2026-08-23T08:55:02.188Z [wmux] event {"type":"question.asked",…}
2026-08-23T08:55:02.189Z [wmux] cli ["report-agent","--surface","surf-…","--blocked","Waiting for your answer"]
2026-08-23T08:55:02.205Z [wmux] event {"type":"message.part.updated",…}
2026-08-23T08:55:02.206Z [wmux] cli ["agent-activity","--surface","surf-…","--active"]
2026-08-23T08:55:12.519Z [wmux] cli ["report-agent","--surface","surf-…","--unblocked"]
```

**A file, not the console** ([#190][190]). OpenCode is a TUI that owns the
terminal, so `console.error` is swallowed there — and an agent running *inside*
OpenCode cannot read its own process's stderr. Logging to a file means the agent
can open the log with its own `Read` tool and diagnose the problem in the
session where it happened, which is how #189 was found. There is no cost when
the flag is off: the destination is resolved once at init and the logger becomes
a no-op.

Attach the log to a bug report — but read it first. It records event payloads,
so it can contain prompt text.

If the log is empty or absent entirely, the plugin never loaded. With the flag
on it writes `init: inactive` even when it decides to do nothing, so a truly
empty file means OpenCode did not pick it up.

---

## Session handle for restore

Since plugin version 7 ([#290][290]) the plugin also reports which OpenCode
session each pane is in, so **Settings → Workspace → Resume OpenCode sessions on
restore** can reopen it with `opencode -s <id>`. The rules, each checked
against real `opencode-ai` 1.18.35 and `@opencode/cli` 2.0.24:

- The pane's session is the last **top-level** session anything happened in.
  A task subagent is its own session firing events on the same pane; a session
  born with a parent (`info.parentID` on v1, `data.parentID` on v2's flat
  `session.created`) is never reported. `parentID` on `message.updated` is a
  *message* id and is ignored.
- A deleted session is forgotten: `session.deleted` releases the handle, so the
  next restore never types a dead id into `opencode -s`.
- Ids must match `ses_<base62>` or a loop session's `ses_loop_<base62>`;
  anything else is dropped here and again in main and in the renderer, since
  the id ends up on a command line.
- A real OpenCode exit releases the handle (`wmux release-agent --provider
  opencode --session <id>`), so a restore gives back the shell. A plugin reload
  after `wmux opencode-tui` does not: the pane is still running, and releasing
  there made every open pane lose its restore handle when the plugin was
  updated. Main refuses the release while wmux itself is quitting. OpenCode 2's
  `run` neither exits nor disposes its plugins cleanly, so there the handle may
  survive a quit.
- **OpenCode 2's shared background server cannot attribute a pane.** By default
  v2 runs one `opencode serve --service` for every TUI, plugins live in it, and
  its `WMUX_SURFACE_ID` names only the pane that started it — reporting from
  there would resume pane B's conversation in pane A. The CLI-side TUI half
  (`wmux opencode-tui`) runs in the TUI process instead, so it captures the
  viewed session for remote and shared servers; `--standalone` is no longer
  required when that half is installed. Re-run the installer after a wmux
  update so the installed marker matches.

---

## Links

wmux sets `BROWSER=wmux-open-url` in WSL panes. The shim calls `wmux open`,
which goes through the same destination rule as a terminal link click: the panel
by default, the system browser when **Settings → Browser → Open links in the
system browser** is on.

- Codex already honours `$BROWSER` through the Rust `webbrowser` crate, so its
  plain link clicks land in the panel as soon as a wmux build with the shim is
  running.
- OpenCode needs `$BROWSER` support in its own opener (OpenCode issue
  [#58526](https://github.com/anomalyco/opencode/issues/58526)). Until that
  ships, plain clicks in an OpenCode pane still open the system browser and
  Ctrl+click is the way to the panel.
- Mouse capture, wheel forwarding and touch-pan gain are unchanged: this routes
  where a link opens, not how the pane scrolls.
- `wmux-open-url` resolves through PATH, which relies on WSL's default
  `appendWindowsPath` interop — the same mechanism that makes `wmux` itself
  runnable in the pane. If interop is disabled, links fall back to the system
  browser.

---

## Versioning

The first line of `wmux.js` is a marker:

```js
// wmux-plugin-version: 4
```

wmux compares it against the installed copy on every launch and overwrites when
they differ. A plugin change that forgets to bump it reaches nobody who already
has the plugin. A `wmux.js` with no marker is assumed to be yours, and is
neither overwritten nor removed.

[189]: https://github.com/amirlehmam/wmux/issues/189
[190]: https://github.com/amirlehmam/wmux/issues/190
[290]: https://github.com/amirlehmam/wmux/issues/290
[304]: https://github.com/amirlehmam/wmux/issues/304
