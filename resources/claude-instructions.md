<!-- wmux:start — AUTO-MANAGED BY wmux. Do not edit this section manually. -->

# wmux

You are running inside wmux, a terminal multiplexer with a browser panel on the right side that the user can see in real-time.

## Browser

For any web browsing task, use the `wmux browser` commands so the user can watch in the browser panel. Do NOT use Playwright, Firecrawl, or WebSearch — they open invisible windows the user cannot see. If the user explicitly asks for one of those tools, use it.

```bash
wmux browser open <url>          # navigate
wmux browser snapshot            # get accessibility tree with @eN refs
wmux browser click @eN           # click element
wmux browser type @eN <text>     # type into element
wmux browser fill @eN <value>    # set input value
wmux browser get-text            # get page text
wmux browser screenshot          # capture screenshot
wmux browser eval <js>           # run JavaScript
wmux browser back                # go back
wmux browser forward             # go forward
wmux browser reload              # reload page
```

Workflow: `browser open <url>` → `browser snapshot` → read tree → `browser click/type @eN` → `browser snapshot` again.

Refs (`@e1`, `@e2`...) expire after page changes — always re-snapshot.

<!-- wmux:end -->
