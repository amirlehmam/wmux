<!-- wmux:start — AUTO-MANAGED BY wmux. Do not edit this section manually. -->

# wmux

wmux is a terminal multiplexer with a browser panel on the right that the user
watches in real time. It installs this guidance **globally** (an agent-context
file or a skill), so it reaches every session on this machine — including sessions that are
not running inside wmux at all (a desktop app, a plain terminal, CI, an SSH
session, a scheduled run). Whether it applies to you is a fact about *your*
session, so check it rather than assume it:

```bash
wmux ping     # "pong" → wmux is here
```

**If `wmux ping` answers `pong`**, everything below is available and preferred.

**If it answers anything else — command not found, an error, no output — do not
conclude yet.** wmux puts `wmux` on PATH only for terminals it starts itself, so
any session it did not spawn — a desktop app, a plain terminal, an SSH session, a
scheduled run, anything already open before wmux started — will not find it there
even while wmux is running normally. And a different program also called `wmux`
may be on PATH (another app by that name puts its own `wmux` command there), so a
bare `wmux` can be the wrong one. Ask this install directly:

```bash
"{{WMUX_CLI_BIN}}/wmux" ping
```

If that answers `pong`, wmux is running: use that absolute path in place of bare
`wmux` for every command below. If it too does not answer `pong`, wmux is not
running for this session. Ignore the whole section and use your normal tools.
Nothing here is a restriction on what you may otherwise do.

One check per session is enough; `wmux ping` needs no arguments and no auth, and
fails immediately when nothing is listening.

## Browser

For web browsing, prefer the `wmux browser` commands over Playwright, Firecrawl
or WebSearch: those open windows the user cannot see, while the browser panel
lets them watch what you are doing. Use whichever tool the user explicitly asks
for, and use your own web tools when `wmux ping` says wmux is absent.

```bash
wmux browser open <url>          # navigate
wmux browser snapshot            # get accessibility tree with eN refs
wmux browser click eN            # click element
wmux browser type eN <text>      # type into element
wmux browser fill eN <value>     # set input value
wmux browser get-text            # get page text
wmux browser screenshot          # capture screenshot
wmux browser eval <js>           # run JavaScript
wmux browser back                # go back
wmux browser forward             # go forward
wmux browser reload              # reload page
wmux browser <verb> --surface <id>   # drive a specific pane's browser
```

Workflow: `browser open <url>` → `browser snapshot` → read tree → `browser click/type eN` → `browser snapshot` again.

Refs (`e1`, `e2`...) expire after page changes — always re-snapshot.

## Markdown

To let the user review a markdown document — your plan-mode plan, a spec, a design doc, a README — open it in a read-only markdown view (like the diff view) instead of dumping it into the terminal:

```bash
wmux markdown <file>             # open a .md/.markdown/.mdx/.txt/.rst file in a new markdown view
wmux markdown set <id> --content "# Title\n..."   # set content of an existing markdown surface
wmux markdown set <id> --file <path>              # load a file into an existing markdown surface
wmux markdown set <id> --content "..." --title T # label the tab (pushed content stays pathless)
wmux markdown get <id>                           # read a surface's buffer back out
```

Relative paths resolve against your current working directory. Only text/markdown files up to 5 MB are accepted. Prefer this over pasting long markdown into the terminal so the user can read it comfortably in a pane.

## Asking the user something

When you stop to ask the user a question — a permission prompt, a choice, a
confirmation — tell wmux, and tell it what the answers are. The sidebar then
shows **"Needs you"** on your pane (so a user with ten panes open can see which
one is waiting), and renders your answers as buttons they can click **without
switching to your pane**.

```bash
wmux report-agent --blocked "Run the migration against prod?" --choices '[
  {"id":"yes","label":"Yes, run it","key":"1"},
  {"id":"no","label":"No, stop","key":"2","isDefault":true}
]'
```

Each choice needs an `id`, a human-readable `label`, and **exactly what to send**
— either `key` (a key name: `enter`, `esc`, `1`, `y`, …) or `text` (sent
literally). wmux relays those bytes verbatim; it does not know how to answer
your prompt and will never guess. A choice with neither is dropped, and the
reply tells you how many were kept.

Answering does **not** clear your blocked state — report it yourself once you
have acted on the answer, exactly as you would if the user had typed it:

```bash
wmux report-agent --unblocked
```

## Locked panes

The user can lock a pane to keep its tabs as they are. `wmux list-panes` and
`wmux tree` show `"locked": true` on it. `wmux agent spawn --pane <locked>` is
refused (`Pane <id> is locked`), and without `--pane` an agent, `agent spawn-batch`
and `wmux new-surface` all land in an unlocked pane, failing with `No unlocked
panes in workspace <id>` when every pane is locked. `wmux layout grid` refuses a
workspace that has a locked pane: use `wmux layout agents`, which leaves the
anchor and its lock alone. `wmux markdown <file>`, like any other placement you
don't aim at a pane, skips locked panes too. Don't try to work around a lock; ask
the user.

## Subagents and background tasks

Subagents that wmux already tracks through your agent's integration appear
under your pane in the sidebar on their own. If you run work of your own in
the background — a worker, a planner, a long task that outlives your turn —
declare it, so the pane does not read idle while it runs. Same id to update (each call is a heartbeat), `--done` to finish:

```bash
wmux report-subagent planner-1 --name planner --detail "calling create_file"
wmux report-subagent planner-1 --done
```

<!-- wmux:end -->
