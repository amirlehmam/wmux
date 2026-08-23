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
