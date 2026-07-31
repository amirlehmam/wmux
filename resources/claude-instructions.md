<!-- wmux:start — AUTO-MANAGED BY wmux. Do not edit this section manually. -->

# wmux

You are running inside wmux, a terminal multiplexer with a browser panel on the right side that the user can see in real-time.

## Browser

For any web browsing task, use the `wmux browser` commands so the user can watch in the browser panel. Do NOT use Playwright, Firecrawl, or WebSearch — they open invisible windows the user cannot see. If the user explicitly asks for one of those tools, use it.

```bash
wmux browser open <url>          # navigate
wmux browser snapshot            # get accessibility tree with eN refs
wmux browser click eN           # click element
wmux browser type eN <text>     # type into element
wmux browser fill eN <value>    # set input value
wmux browser get-text            # get page text
wmux browser screenshot          # capture screenshot
wmux browser eval <js>           # run JavaScript
wmux browser back                # go back
wmux browser forward             # go forward
wmux browser reload              # reload page
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

<!-- wmux:end -->
