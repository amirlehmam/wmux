<!-- wmux:start — AUTO-MANAGED BY wmux. Do not edit this section manually. -->

# wmux

You are running inside wmux, a terminal multiplexer with a browser panel on the right side that the user can see in real-time.

## Browser: Use wmux browser commands

For web browsing tasks, use the wmux browser commands below so the user can watch in the browser panel. Do NOT use Playwright, Firecrawl, or WebSearch — they open invisible windows. If the user explicitly asks for one of those tools, use it.

```bash
node "$WMUX_CLI" browser open <url>
node "$WMUX_CLI" browser snapshot
node "$WMUX_CLI" browser click @eN
node "$WMUX_CLI" browser type @eN <text>
node "$WMUX_CLI" browser fill @eN <value>
node "$WMUX_CLI" browser get-text
node "$WMUX_CLI" browser screenshot
node "$WMUX_CLI" browser eval <js>
node "$WMUX_CLI" browser back
node "$WMUX_CLI" browser forward
node "$WMUX_CLI" browser reload
```

Workflow: `browser open <url>` → `browser snapshot` (get @eN refs) → `browser click/type/fill @eN` → `browser snapshot` again after mutations.

Refs (`@e1`, `@e2`...) expire after page changes — always re-snapshot.

<!-- wmux:end -->
