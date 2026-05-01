<h1 align="center">wmux</h1>
<p align="center">A visibility layer for Claude Code on Windows — see what your AI agent does in real-time</p>

<p align="center">
  Built on Electron + xterm.js. Forked from <a href="https://github.com/manaflow-ai/cmux">cmux</a>.
</p>

<p align="center">
  <a href="https://github.com/amirlehmam/wmux"><img src="https://img.shields.io/badge/platform-Windows-0078D4?logo=windows" alt="Windows" /></a>
  <a href="https://github.com/amirlehmam/wmux/releases"><img src="https://img.shields.io/github/v/release/amirlehmam/wmux?label=release&color=555" alt="Release" /></a>
  <a href="https://github.com/amirlehmam/wmux/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-555" alt="License" /></a>
</p>

<p align="center">
  <img src="./docs/assets/wmux-full.png" alt="wmux — terminal multiplexer with live browser panel" width="900" />
</p>

## Features

<table>
<tr>
<td width="40%" valign="middle">
<h3>Passive Claude Code integration</h3>
wmux observes Claude Code without changing how it works. Auto-configured hooks in <code>~/.claude/settings.json</code> report agent and tool activity to the sidebar. A CDP proxy on <code>localhost:9222</code> lets Claude Code's native <code>chrome-devtools-mcp</code> plugin control the wmux browser panel directly. Zero setup — everything is auto-injected on startup.
</td>
<td width="60%">
<img src="./docs/assets/wmux-sidebar.png" alt="Sidebar showing active Claude Code sessions" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Live browser visibility</h3>
When Claude Code browses the web, every action appears in the wmux browser panel in real-time. Navigate, click, type, take screenshots — Claude Code uses its own tools, wmux just shows what's happening. CDP proxy on <code>localhost:9222</code> bridges the connection transparently. Terminal and markdown links open in the panel too.
</td>
<td width="60%">
<img src="./docs/assets/wmux-browser.png" alt="Built-in browser panel showing live web activity" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Activity indicators</h3>
Sidebar dots show what each Claude Code session is doing at a glance. <b>Orange pulsing</b> = working. <b>Green</b> = done. <b>Red</b> = interrupted (Ctrl+C). Git branch, dirty state, working directory, open ports, and PR status update in real-time from shell integration hooks.
</td>
<td width="60%">
<img src="./docs/assets/wmux-sidebar.png" alt="Sidebar with live activity indicators" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Notification center</h3>
Panes get a blue ring and tabs light up when agents finish or need attention. Supports OSC 9/99/777, <code>wmux notify</code> CLI, and idle detection. Click the bell icon to see all pending notifications — jump to any with one click. Windows toast notifications and taskbar flash on alerts.
</td>
<td width="60%">
<img src="./docs/assets/wmux-notification.png" alt="Notification panel listing agent completions" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Shell tab labels</h3>
Terminal tabs display a shell-specific label — <b>PowerShell</b>, <b>bash</b>, <b>zsh</b>, or <b>cmd</b> — detected automatically from the spawned process. No configuration needed. Makes it easy to identify each pane at a glance when running multiple agents in different shells.
</td>
<td width="60%">
<img src="./docs/assets/wmux-shell-labels.png" alt="Tab strip with shell-specific labels" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Custom themes &amp; per-pane colors</h3>
450+ bundled Ghostty themes plus 17 curated wmux themes. Set a default color scheme in <code>~/.wmux/config.toml</code>, override per pane with <code>wmux split --color-scheme NAME</code>, or define custom named schemes directly in settings. Drag-imported from Windows Terminal or Ghostty configs.
</td>
<td width="60%">
<img src="./docs/assets/wmux-themes.png" alt="Settings panel showing color scheme selection" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>wmux-orchestrator plugin</h3>
Bundled Claude Code plugin that decomposes complex tasks into parallel agents coordinated through dependency-aware waves. Each agent runs in its own visible terminal pane with automated review and auto-fix. Activated via <code>/wmux:orchestrate</code> — no daemon, no config, no API keys.
</td>
<td width="60%">
<img src="./docs/assets/wmux-terminals.png" alt="Multiple agents running in split terminal panes" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Vertical + horizontal splits</h3>
Split any pane right or down. Resize dividers by dragging. Zoom a pane to full screen with <code>Ctrl+Shift+Enter</code>. Each pane supports multiple tabs — all rendered simultaneously with <code>visibility: hidden</code> so PTY sessions stay alive when switching. Workspace state is persisted across restarts.
</td>
<td width="60%">
<img src="./docs/assets/wmux-terminals.png" alt="Horizontal and vertical pane splits" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Saved sessions</h3>
Save your entire workspace layout (splits, working directories, browser URL, shell type) and restore it with one click. Click the save icon in the sidebar footer to name a session, the folder icon to load. On startup, wmux auto-loads your last session — no more manual <code>cd</code> and re-splitting every time.
</td>
<td width="60%">
<img src="./docs/assets/wmux-sidebar.png" alt="Sidebar with session save and load controls" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Clipboard image paste</h3>
Copy a screenshot (Win+Shift+S, Print Screen, Snipping Tool) and press <code>Ctrl+V</code> in a wmux terminal. The image is saved to a temp file and the path is injected into the terminal — Claude Code reads it directly, like pasting on claude.ai but from any screenshot tool.
</td>
<td width="60%">
<img src="./docs/assets/wmux-full.png" alt="Image paste workflow via clipboard" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>First-launch tutorial</h3>
Interactive 7-step onboarding walks you through workspaces, splits, tabs, the browser panel, and notifications. Designed to get a new user productive in under 2 minutes. Reopen anytime from the <code>?</code> button in the title bar.
</td>
<td width="60%">
<img src="./docs/assets/wmux-tutorial.png" alt="First-launch tutorial overlay" width="100%" />
</td>
</tr>
</table>

- **Release update badge** — A badge in the title bar notifies you when a new GitHub release is available. Click to open the releases page. No auto-update, no background downloads.
- **Clickable links** — URLs in terminal output and markdown panes open directly in the wmux browser panel. Ctrl+click or just click (configurable).
- **Scriptable** — Named pipe server (`\\.\pipe\wmux`) with a JSON-RPC API. Create workspaces, split panes, send keystrokes, read terminal content, control the browser via CDP, and spawn sub-agent terminals programmatically.
- **Windows native** — ConPTY for proper terminal emulation, Windows toast notifications, taskbar flash on alerts, native title bar overlay.
- **Windows Terminal + Ghostty compatible** — Import your themes, fonts, and colors from Windows Terminal `settings.json` or `~/.config/ghostty/config`. Ships with 450+ bundled Ghostty themes.
- **GPU-accelerated** — xterm.js with WebGL rendering for smooth terminal output at any speed.

## Install

### Download (recommended)

Download [wmux-0.7.10-win-x64.zip](https://github.com/amirlehmam/wmux/releases/latest) from GitHub Releases, extract anywhere, and run `wmux.exe`. No installer, no code signing, no admin required.

> **Note:** After extracting, right-click the zip before extracting and select **Unblock** if Windows SmartScreen warns about the executable.

### From source

```bash
git clone https://github.com/amirlehmam/wmux.git
cd wmux
npm install
npm run build:main
npm run dev
```

## Why wmux?

I run a lot of Claude Code sessions in parallel. On macOS there is [cmux](https://github.com/manaflow-ai/cmux), and it is exactly what I needed — vertical tabs with live metadata, notification rings when agents need attention, a scriptable browser, and a socket API for automation. But I work on Windows, and nothing like it existed.

Windows Terminal has tabs but no notification system. You have to manually check each tab to see if an agent finished or is waiting for input. tmux works in WSL but loses all Windows integration. Electron terminals exist but none focus on the AI agent workflow.

So I built wmux — a visibility layer for AI coding agents. It doesn't replace Claude Code or change how it works. It passively observes and shows you what's happening. A CDP proxy on `localhost:9222` lets Claude Code's native browser tools control the wmux browser panel — you watch every page load, click, and form fill in real-time. Auto-configured hooks in `settings.json` report tool usage and agent activity to the sidebar. When a command finishes or is interrupted, the sidebar dot changes color and you get a notification.

The sidebar shows exactly what each agent is doing — the git branch it is on, the PR it opened, the ports it is listening on, and whether it needs your attention. Shell integration scripts inject themselves into PowerShell, CMD, and Bash sessions and report CWD changes, git branch switches, shell state, and PR status back to the sidebar via a named pipe in real time.

On first launch, wmux auto-configures itself: it injects a minimal informational block into `~/.claude/CLAUDE.md`, adds a `PostToolUse` hook to `~/.claude/settings.json`, installs the wmux-orchestrator Claude Code plugin, and starts a CDP proxy on `localhost:9222`. No API keys needed — everything runs through the user's existing Claude Code session.

Everything is automatable through the `wmux` CLI or the named pipe directly. The protocol matches cmux, so tools built for one work with the other.

## wmux-orchestrator

wmux ships with a bundled Claude Code plugin that enables parallel multi-agent orchestration. Activate it with `/wmux:orchestrate` in any Claude Code session.

**What it does:**
1. Analyzes your codebase and decomposes the task into independent work units
2. Assigns each unit to a Claude Code agent in its own wmux terminal pane
3. Runs agents in dependency-aware waves — later waves wait for earlier ones to finish
4. A reviewer agent inspects the combined output and triggers auto-fixes if needed

**Plugin commands:**
```
/wmux:orchestrate   Decompose and run a complex task across parallel agents
```

The plugin is auto-installed into `~/.claude/plugins/cache/` on wmux startup. It also works without wmux — agents fall back to native Claude Code subagents.

Also published standalone: [plugin.wmux.org](https://plugin.wmux.org) · [github.com/amirlehmam/wmux-orchestrator](https://github.com/amirlehmam/wmux-orchestrator)

## Shell Integration

wmux automatically injects integration scripts into your shells:

- **PowerShell** — Overrides the `prompt` function. Reports CWD, git branch, dirty state, and shell state (working/done/interrupted) via `NamedPipeClientStream`. Preexec hook via PSReadLine detects when commands start. Background job polls `gh pr view` every 45 seconds.
- **CMD** — Embeds OSC 9 escape sequences in the `PROMPT` variable for CWD reporting.
- **Bash/Zsh (WSL)** — `PROMPT_COMMAND` / `precmd` + `preexec` hooks. Detects interrupts via exit code 130. Communicates via temp file bridge.

Environment variables available in all shells:

| Variable | Description |
|----------|-------------|
| `WMUX` | Always `1` inside wmux |
| `WMUX_CLI` | Path to the wmux CLI script |
| `WMUX_SURFACE_ID` | Current surface (tab) ID |
| `WMUX_PIPE` | Named pipe path (`\\.\pipe\wmux`) |

## Keyboard Shortcuts

All shortcuts are rebindable via Settings (`Ctrl+,`).

### Workspaces

| Shortcut | Action |
|----------|--------|
| Ctrl+N | New workspace |
| Ctrl+1–8 | Jump to workspace 1–8 |
| Ctrl+9 | Jump to last workspace |
| Ctrl+PageDown | Next workspace |
| Ctrl+PageUp | Previous workspace |
| Ctrl+Shift+W | Close workspace |
| Ctrl+Shift+R | Rename workspace |
| Ctrl+B | Toggle sidebar |

### Surfaces (tabs)

| Shortcut | Action |
|----------|--------|
| Ctrl+T | New surface |
| Ctrl+Shift+] | Next surface |
| Ctrl+Shift+[ | Previous surface |
| Alt+1–8 | Jump to surface 1–8 |
| Ctrl+W | Close surface |

### Split Panes

| Shortcut | Action |
|----------|--------|
| Ctrl+D | Split right |
| Ctrl+Shift+D | Split down |
| Ctrl+Alt+Arrow | Focus pane directionally |
| Ctrl+Shift+Enter | Toggle pane zoom |
| Ctrl+Shift+H | Flash focused panel |

### Browser

| Shortcut | Action |
|----------|--------|
| Ctrl+Shift+I | Toggle browser panel |
| Ctrl+Alt+I | Toggle Developer Tools |
| Ctrl+Alt+C | Show JavaScript Console |

### Notifications

| Shortcut | Action |
|----------|--------|
| Ctrl+Alt+N | Toggle notification panel |
| Ctrl+Shift+U | Jump to latest unread |

### Find

| Shortcut | Action |
|----------|--------|
| Ctrl+F | Find |
| Enter / Shift+Enter | Find next / previous |
| Escape | Close find bar |

### Terminal

| Shortcut | Action |
|----------|--------|
| Ctrl+Shift+C | Copy |
| Ctrl+Shift+V | Paste |
| Ctrl+V | Paste (text or screenshot image path) |
| Ctrl+C | Copy (with selection) / interrupt (without) |
| Ctrl+= / Ctrl+- | Increase / decrease font size |
| Ctrl+0 | Reset font size |

### Window

| Shortcut | Action |
|----------|--------|
| Ctrl+Shift+N | New window |
| Ctrl+, | Settings |
| Ctrl+Shift+P | Command palette |

## CLI

The `wmux` CLI communicates with the running app over the named pipe.

```bash
wmux ping                          # Check if wmux is running
wmux notify "Build complete"       # Send a notification
wmux new-workspace --title "API"   # Create a workspace
wmux list-workspaces               # List all workspaces
wmux split --right                 # Split focused pane
wmux send "npm test"               # Send text to terminal
wmux send-key Enter --ctrl         # Send keystroke
wmux read-screen --lines 50        # Read terminal content

# Browser (CDP-powered)
wmux browser open http://localhost:3000
wmux browser snapshot              # Accessibility tree with @eN refs
wmux browser click @e5             # Click element by ref
wmux browser type @e3 "hello"      # Type into input by ref
wmux browser fill @e3 "value"      # Set input value directly
wmux browser screenshot            # Base64 PNG screenshot
wmux browser eval "document.title" # Run JavaScript

# Agents
wmux agent spawn --cmd "claude --resume abc" --label "Research"
wmux agent spawn-batch --json '[{"cmd":"claude","label":"Agent 1"},{"cmd":"claude","label":"Agent 2"}]'
wmux agent list                    # List all agents
wmux agent status <agent-id>       # Check agent status
wmux agent kill <agent-id>         # Kill an agent

wmux tree                          # Workspace / pane / surface hierarchy
```

## Socket API

Connect to `\\.\pipe\wmux` for programmatic control. Two protocols supported:

**V1** (text, used by shell integration):
```
report_pwd <surface_id> <path>
report_git_branch <surface_id> <branch> [dirty]
report_shell_state <surface_id> idle|running|interrupted
notify <surface_id> <text>
ping
```

**V2** (JSON-RPC, used by CLI and automation):
```json
{"method": "workspace.create", "params": {"title": "Agent 1"}}
{"method": "workspace.list", "params": {}}
{"method": "surface.send_text", "params": {"id": "surf-...", "text": "npm test\n"}}
{"method": "surface.read_text", "params": {"id": "surf-...", "lines": 50}}

// Browser control (CDP-powered)
{"method": "browser.navigate", "params": {"url": "http://localhost:3000"}}
{"method": "browser.snapshot", "params": {}}
{"method": "browser.click", "params": {"ref": "@e5"}}
{"method": "browser.screenshot", "params": {"fullPage": true}}
{"method": "browser.eval", "params": {"js": "document.title"}}

// Agent spawning
{"method": "agent.spawn", "params": {"cmd": "claude --resume abc", "label": "Research"}}
{"method": "agent.spawn_batch", "params": {"agents": [...], "strategy": "distribute"}}
{"method": "agent.list", "params": {}}
{"method": "agent.kill", "params": {"agentId": "agent-..."}}

{"method": "system.tree", "params": {}}
```

## Session Restore

On relaunch, wmux restores:

- Window position and size
- Workspace layout (titles, colors, pin state)
- Split pane structure (directions and ratios)
- Working directory per terminal
- Default shell per terminal
- Browser panel URLs
- Active workspace and pane selection

wmux does **not** restore live process state. Active Claude Code, tmux, or vim sessions are not resumed after restart. Shells are respawned fresh in the saved working directories.

## Config

### Terminal themes

Set a global default color scheme in `~/.wmux/config.toml`:

```toml
[terminal]
color_scheme = "Dracula"
```

Override per pane at split time or on the fly:

```bash
wmux split --color-scheme "Tokyo Night"
wmux set-color-scheme "Solarized Dark"
```

Define custom named schemes in Settings > Terminal > Custom Schemes.

### Import from existing terminal configs

wmux reads configuration from:

1. **Windows Terminal** — `%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_...\LocalState\settings.json`
2. **Ghostty** — `~/.config/ghostty/config`

Import either via Settings > Terminal > Import. Extracts font family, font size, color scheme, and palette. Default theme is Dracula. 450+ Ghostty themes bundled.

## Architecture

Two-process Electron model. Main process manages PTY spawning (node-pty/ConPTY), named pipe server, CDP browser bridge, port scanning, git/PR polling, notifications, Claude Code context injection, session persistence, and multi-window lifecycle. Renderer process runs React/Zustand with xterm.js (WebGL), recursive split pane layout, and the sidebar.

```
src/
  main/               # Electron main process
  renderer/           # React app (sidebar, splits, terminals, browser)
  preload/            # contextBridge API
  cli/                # wmux CLI tool
  shared/             # Types shared between main and renderer
  shell-integration/  # PowerShell, CMD, WSL scripts

resources/
  wmux-orchestrator/  # Bundled Claude Code plugin (auto-installed on startup)
  themes/             # Ghostty + wmux theme files
  sounds/             # Notification sounds
```

## Based on cmux

wmux is a Windows reimplementation of [cmux](https://github.com/manaflow-ai/cmux), the macOS terminal for multitasking. Same design, same socket protocol, same philosophy. Tools built for cmux's API work with wmux.

## Contributing

- [GitHub Issues](https://github.com/amirlehmam/wmux/issues) — bug reports and feature requests
- [GitHub Discussions](https://github.com/amirlehmam/wmux/discussions) — questions and ideas

## License

wmux is open source under [AGPL-3.0-or-later](LICENSE).
