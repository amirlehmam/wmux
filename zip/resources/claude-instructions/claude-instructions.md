<!-- wmux:start — AUTO-MANAGED BY wmux. Do not edit this section manually. -->

# wmux Environment

You are running inside **wmux**, a terminal multiplexer with an embedded browser panel and sub-agent support. You can control the browser and spawn agent terminals using the `wmux` CLI.

## wmux CLI

```bash
node "$WMUX_CLI" <command> [args]
```

The `WMUX_CLI` env var points to the CLI script. You can verify you're in wmux by checking `WMUX=1`.

## Browser Control

wmux has a browser panel on the right side. You can control it — the user sees every action in real-time.

**Always snapshot first to get element refs, then interact.**

| Command | Description |
|---------|-------------|
| `browser open <url>` | Navigate to a URL |
| `browser snapshot` | Get accessibility tree with @eN refs |
| `browser click @eN` | Click an element by ref |
| `browser type @eN <text>` | Type into an element (keystrokes) |
| `browser fill @eN <value>` | Set input value directly |
| `browser get-text` | Get page text (or `get-text @eN` for element) |
| `browser screenshot` | Capture screenshot (add `--full` for full page) |
| `browser eval <js>` | Run JavaScript in the page |
| `browser wait @eN` | Wait for element to appear |
| `browser back/forward/reload` | Navigation |

### Browser Workflow

1. `browser open <url>` — navigate
2. `browser snapshot` — get accessibility tree
3. Find the element ref you need in the tree
4. `browser click/type/fill @eN` — interact
5. `browser snapshot` again after mutations (refs expire on page change)

Refs (`@e1`, `@e2`, ...) are ephemeral — always re-snapshot after any page change.
If the browser panel is closed, ask the user to open it with `Ctrl+Shift+I`.

## Agent Spawning

Spawn visible sub-agent terminals distributed across panes:

```bash
node "$WMUX_CLI" agent spawn --cmd "claude --resume abc" --label "Research"
node "$WMUX_CLI" agent spawn-batch --json '[{"cmd":"...","label":"A1"},{"cmd":"...","label":"A2"}]'
node "$WMUX_CLI" agent list
node "$WMUX_CLI" agent status <agentId>
node "$WMUX_CLI" agent kill <agentId>
```

## Notifications & Status

```bash
node "$WMUX_CLI" notify --body "Done!"
node "$WMUX_CLI" set-status build "passing"
node "$WMUX_CLI" set-progress 0.75 --label "Deploying..."
node "$WMUX_CLI" log info "Migration finished"
```

## Terminal

```bash
node "$WMUX_CLI" read-screen        # Read visible terminal content
node "$WMUX_CLI" send "npm test"    # Send text to active terminal
node "$WMUX_CLI" send-key Enter     # Send a keypress
```

<!-- wmux:end -->
