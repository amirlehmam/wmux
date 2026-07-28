# Driving the wmux browser panel from the CLI

Field notes for agents that automate the wmux browser panel (`wmux browser …`). The panel is a real
Chromium webview the user watches live — everything you do is visible, which is the point. These are
the sharp edges that cost time when discovered by trial and error.

## Core workflow

```bash
wmux browser open <url>      # navigate
wmux browser snapshot        # accessibility tree with element refs (eN)
wmux browser click e45       # click element by ref
wmux browser type e3 "text"  # type into element
wmux browser get-text        # page text
wmux browser eval "<js>"     # run JavaScript in the page
wmux browser screenshot      # capture PNG
```

## Sharp edges

- **Write refs bare: `wmux browser click e45`.** Both `e45` and `@e45` resolve since 0.36.0 (before
  that, only the `@` form did — which is why every ref command used to fail, issue #121). Keep using
  the bare form anyway: in PowerShell a leading `@` is the splatting operator, so `@e45` is mangled
  by the shell before wmux ever sees it.

- **Refs can go stale on SPAs.** Against client-rendered apps (React/Vue with re-renders), even a
  fresh-from-snapshot ref may return `ref_not_found`. Reliable fallback: `wmux browser eval` with
  DOM queries — `document.querySelectorAll('[role=radio]')[3].click()`. The user still sees every
  action live in the panel.

- **`eval` shares ONE persistent JS scope across calls.** A second `const x = …` throws
  `Uncaught SyntaxError` (redeclaration). Always wrap snippets in an IIFE:
  `(() => { …; return 'result' })()`.

- **`reload` may be rejected by the app** even though CLI usage lists it — use
  `wmux browser eval "location.reload()"` instead.

- **`snapshot` prints JSON** with the whole accessibility tree as a single `\n`-escaped string.
  Don't grep it raw — parse it with a real JSON parser (node/python/jq), and write it to a file
  first if it's large.

- **Shell quoting eats `$` in double-quoted eval one-liners.** `"…t.match(/\$611/)…"` gets `$6`
  expanded as a positional parameter and silently matches nothing. Single-quote any eval snippet
  containing `$` (money regexes!), or write the snippet to a file.

- **wmux binds a CDP endpoint on port 9222.** Don't point other CDP clients (e.g. a chrome-devtools
  MCP configured for `127.0.0.1:9222`) at it during a session — whoever binds 9222 first wins, the
  attachment target is nondeterministic, and teardown from another client can disrupt the wmux
  window. Use `wmux browser …` for panel automation.

## Framework-specific input recipes

- **React controlled inputs** ignore a plain `.value =` assignment. Use the native setter, then
  dispatch an input event:
  ```js
  (() => {
    const el = document.querySelector('#email');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, 'user@example.com');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()
  ```
  A node's React handlers/props are reachable under its `__reactProps$…` key when you need them.

- **Radix UI / shadcn primitives ignore synthetic `.click()` and `.focus()`.** Plain buttons and
  links are fine with `.click()`; Radix primitives need real-looking event sequences:
  - **Tabs**: dispatch `pointerdown → mousedown → pointerup → mouseup → click` (PointerEvent with
    `pointerId: 1`) on the trigger. The `data-state` flip is **async** — verify it in a *later*
    eval call, not the same snippet.
  - **Tooltip**: gates on focus-visible; programmatic `.focus()` never opens it. Open via hover:
    `pointerover → pointerenter → pointermove` with `pointerType: "mouse"`.
  - **Select**: try the full pointer sequence on the trigger and then on the chosen
    `[data-slot=select-item]` / `[role=option]` first — in some Radix versions that works. If it
    does nothing, call the React handlers directly via `__reactProps$…`: `onPointerDown` on the
    trigger to open (`{button: 0, ctrlKey: false, pointerType: 'mouse', target: trigger,
    currentTarget: trigger, preventDefault(){}, stopPropagation(){}, defaultPrevented: false,
    nativeEvent: {}}`), then `onKeyDown` with `{key: 'Enter', code: 'Enter', …}` on the option to
    commit (its `onPointerUp` does NOT commit). Verify by re-reading the trigger's text in a later
    eval.

## Don't trust eval-polling for transient UI

Toasts, animations, and other short-lived UI can appear perfectly to the human watching the panel
while repeated `eval`/`get-text` polls report them absent (the poll cadence misses the
add/remove window). If transient UI "looks broken" only under polling: ask the user what they see
in the panel, or re-test with a long duration (e.g. `toast('x', { duration: 60000 })`) before
concluding the app is broken.
