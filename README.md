<p align="center">
  <img src="./docs/assets/wmux_logo.png" alt="wmux logo" width="120" />
</p>
<h1 align="center">wmux</h1>
<p align="center">A Windows terminal with vertical tabs and notifications for AI coding agents</p>

<p align="center">
  Built on Electron + xterm.js. Inspired by <a href="https://github.com/manaflow-ai/cmux">cmux</a>. 
</p>

<p align="center">
  <a href="https://github.com/amirlehmam/wmux"><img src="https://img.shields.io/badge/platform-Windows-0078D4?logo=windows" alt="Windows" /></a>
  <a href="https://github.com/amirlehmam/wmux/releases"><img src="https://img.shields.io/github/v/release/amirlehmam/wmux?label=release&color=555" alt="Release" /></a>
  <a href="https://github.com/amirlehmam/wmux/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-555" alt="License" /></a>
</p>

<p align="center">
  <img src="./docs/assets/wmux-full.png" alt="wmux screenshot" width="900" />
</p>

## Features

<table>
<tr>
<td width="40%" valign="middle">
<h3>Notification rings</h3>
Panes get a blue ring and tabs light up when coding agents need your attention. Supports OSC 9/99/777, <code>wmux notify</code> CLI, and idle detection.
</td>
<td width="60%">
<img src="./docs/assets/wmux-terminals.png" alt="Terminal panes with notification rings" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Vertical tabs</h3>
See all your sessions at a glance in a sidebar. Git branch, PR status, working directory, listening ports, and notification text. Double-click to rename. Right-click for colors and workspace management.
</td>
<td width="60%">
<img src="./docs/assets/wmux-sidebar.png" alt="Sidebar with workspace metadata" width="50%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>In-app browser</h3>
Split a browser alongside your terminals. Scriptable API for clicking, filling forms, evaluating JS, and snapshotting the accessibility tree. Preview localhost next to the terminal that runs it.
</td>
<td width="60%">
<img src="./docs/assets/wmux-browser.png" alt="In-app browser panel" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>First-launch tutorial</h3>
Interactive onboarding walks you through workspaces, splits, tabs, browser, and notifications. Reopen anytime from the <code>?</code> button in the title bar.
</td>
<td width="60%">
<img src="./docs/assets/wmux-tutorial.png" alt="First-launch tutorial" width="100%" />
</td>
</tr>
</table>

- **Scriptable** -- Named pipe server (`\\.\pipe\wmux`) with a JSON-RPC API. Create workspaces, split panes, send keystrokes, read terminal content, and control the browser programmatically.
- **Windows native** -- ConPTY for proper terminal emulation, Windows toast notifications, taskbar flash on alerts, native title bar overlay.
- **Windows Terminal + Ghostty compatible** -- Import your themes, fonts, and colors from Windows Terminal `settings.json` or `~/.config/ghostty/config`. Ships with 450+ bundled Ghostty themes.
- **GPU-accelerated** -- xterm.js with WebGL rendering for smooth terminal output at any speed.

## Install

### From source

```bash
git clone https://github.com/amirlehmam/wmux.git
cd wmux
npm install
npm run build:main
npm run dev
```

### Portable / Installer

```bash
npm run build
# Produces: release/wmux-setup.exe and release/wmux-portable.exe
```

## Why wmux?

I run a lot of Claude Code sessions in parallel. On macOS there is [cmux](https://github.com/manaflow-ai/cmux), and it is exactly what I needed -- vertical tabs with live metadata, notification rings when agents need attention, a scriptable browser, and a socket API for automation. But I work on Windows, and nothing like it existed.

Windows Terminal has tabs but no notification system. You have to manually check each tab to see if an agent finished or is waiting for input. tmux works in WSL but loses all Windows integration. Electron terminals exist but none focus on the AI agent workflow.

So I built wmux. It is a ground-up Windows reimplementation of cmux, built with Electron, React, xterm.js, and node-pty. Same design philosophy, same socket protocol, same UX patterns -- adapted for Windows with ConPTY, named pipes, PowerShell integration, and native toast notifications.

The sidebar shows exactly what each agent is doing -- the git branch it is on, the PR it opened, the ports it is listening on, and whether it needs your attention. When an agent finishes a task or hits a question, the pane gets a blue notification ring, the sidebar badge increments, and a Windows toast fires. Ctrl+Shift+U jumps to the most recent unread.

Shell integration scripts inject themselves into PowerShell, CMD, and WSL sessions. They report CWD changes, git branch switches, and PR status back to the sidebar via a named pipe. The main process polls for listening ports and forwards everything to the UI in real time.

The in-app browser is for previewing what your agents build. `localhost:3000` running in one terminal, visible in the browser panel next to it. The browser is scriptable -- AI agents can navigate, click, fill forms, and read the accessibility tree through the socket API.

Everything is automatable through the `wmux` CLI or the named pipe directly. The protocol matches cmux, so tools built for one work with the other.

## Shell Integration

wmux automatically injects integration scripts into your shells:

- **PowerShell** -- Overrides the `prompt` function. Reports CWD, git branch, dirty state, and shell idle/running status via `NamedPipeClientStream`. Background job polls `gh pr view` every 45 seconds.
- **CMD** -- Embeds OSC 9 escape sequences in the `PROMPT` variable for CWD reporting. Git branch detected via filesystem watcher on `.git/HEAD`.
- **WSL (Bash/Zsh)** -- `PROMPT_COMMAND` / `precmd` hooks, near-identical to cmux's integration. Communicates via temp file bridge.

Environment variables available in all shells:

| Variable | Description |
|----------|-------------|
| `WMUX` | Always `1` inside wmux |
| `WMUX_WORKSPACE_ID` | Current workspace ID |
| `WMUX_PANE_ID` | Current pane ID |
| `WMUX_SURFACE_ID` | Current surface ID |
| `WMUX_PIPE` | Named pipe path |

## Keyboard Shortcuts

All shortcuts are rebindable via Settings (Ctrl+,).

### Workspaces

| Shortcut | Action |
|----------|--------|
| Ctrl+N | New workspace |
| Ctrl+1-8 | Jump to workspace 1-8 |
| Ctrl+9 | Jump to last workspace |
| Ctrl+PageDown | Next workspace |
| Ctrl+PageUp | Previous workspace |
| Ctrl+Shift+W | Close workspace |
| Ctrl+Shift+R | Rename workspace |
| Ctrl+B | Toggle sidebar |

### Surfaces

| Shortcut | Action |
|----------|--------|
| Ctrl+T | New surface |
| Ctrl+Shift+] | Next surface |
| Ctrl+Shift+[ | Previous surface |
| Alt+1-8 | Jump to surface 1-8 |
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
| Ctrl+Shift+U | Jump to latest unread |
| Ctrl+Shift+H | Flash focused pane |

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
wmux browser open http://localhost:3000
wmux browser snapshot              # Accessibility tree for AI agents
wmux tree                          # Workspace/pane/surface hierarchy
```

## Socket API

Connect to `\\.\pipe\wmux` for programmatic control. Two protocols supported:

**V1** (text, used by shell integration):
```
report_pwd <surface_id> <path>
report_git_branch <surface_id> <branch> [dirty]
report_shell_state <surface_id> idle|running
notify <surface_id> <text>
ping
```

**V2** (JSON-RPC, used by CLI and automation):
```json
{"method": "workspace.create", "params": {"title": "Agent 1"}}
{"method": "workspace.list", "params": {}}
{"method": "surface.send_text", "params": {"id": "surf-...", "text": "npm test\n"}}
{"method": "surface.read_text", "params": {"id": "surf-...", "lines": 50}}
{"method": "browser.navigate", "params": {"surfaceId": "surf-...", "url": "http://localhost:3000"}}
{"method": "browser.snapshot", "params": {"surfaceId": "surf-..."}}
{"method": "system.tree", "params": {}}
```

## Session Restore

On relaunch, wmux restores:

- Window position and size
- Workspace layout (titles, colors, pin state)
- Split pane structure (directions and ratios)
- Working directory per terminal
- Browser panel URLs
- Active workspace and pane selection

wmux does **not** restore live process state. Active Claude Code, tmux, or vim sessions are not resumed after restart. Shells are respawned fresh in the saved working directories.

## Config

wmux reads configuration from two sources:

1. **Windows Terminal** -- `%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_...\LocalState\settings.json`
2. **Ghostty** -- `~/.config/ghostty/config`

Import either via Settings > Terminal > Import. Extracts font family, font size, color scheme, and palette. Default theme is Monokai. 450+ Ghostty themes bundled.

## Architecture

Two-process Electron model. Main process manages PTY spawning (node-pty/ConPTY), named pipe server, port scanning, git/PR polling, notifications, session persistence, and multi-window lifecycle. Renderer process runs React/Zustand with xterm.js (WebGL), recursive split pane layout, and the sidebar.

```
src/
  main/               # Electron main process
  renderer/            # React app (sidebar, splits, terminals, browser)
  preload/             # contextBridge API
  cli/                 # wmux CLI tool
  shared/              # Types shared between main and renderer
  shell-integration/   # PowerShell, CMD, WSL scripts
```

## Based on cmux

wmux is a Windows reimplementation of [cmux](https://github.com/manaflow-ai/cmux), the macOS terminal for multitasking. Same design, same socket protocol, same philosophy. Tools built for cmux's API work with wmux.

## Contributing

- [GitHub Issues](https://github.com/amirlehmam/wmux/issues) -- bug reports and feature requests
- [GitHub Discussions](https://github.com/amirlehmam/wmux/discussions) -- questions and ideas

## License

wmux is open source under [AGPL-3.0-or-later](LICENSE).
