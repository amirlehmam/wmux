<p align="center">
  <img src="resources/icons/icon.png" alt="" width="72" height="72" />
</p>

<h1 align="center">wmux</h1>

<p align="center">
  <strong>Six agents. Which one needs you?</strong><br />
  A Windows terminal for running several coding agents at once.
</p>

<p align="center">
  <a href="https://github.com/amirlehmam/wmux/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/amirlehmam/wmux?style=flat-square&label=release&color=1e90ff" /></a>
  <a href="https://github.com/amirlehmam/wmux/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/amirlehmam/wmux/total?style=flat-square&color=1e90ff" /></a>
  <img alt="Windows x64" src="https://img.shields.io/badge/platform-Windows%20x64-1e90ff?style=flat-square" />
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-1e90ff?style=flat-square" /></a>
</p>

<p align="center">
  <a href="https://github.com/amirlehmam/wmux/releases/latest"><strong>Download for Windows</strong></a> ·
  <a href="https://wmux.org">wmux.org</a> ·
  <a href="#install">Install</a> ·
  <a href="#keyboard-shortcuts">Shortcuts</a> ·
  <a href="#documentation">Docs</a>
</p>

https://github.com/user-attachments/assets/0c2f9a1e-5deb-4794-b01e-7c66ae1f1ece

<p align="center"><sub>The one-minute wmux film. Terminal output is staged for the demo.</sub></p>

---

Run Claude Code in one pane, Codex in the next, your tests below them and the dev server in a browser on the right. The sidebar tells you which agents are working and which one is waiting for you, and one shortcut takes you there.

wmux runs the command-line tools you already have, with the accounts you already pay for. It sells no agent and adds no account.

## Install

Download the latest **Windows x64** release:

| Format | How to use it |
| --- | --- |
| [Installer](https://github.com/amirlehmam/wmux/releases/latest) | Download `wmux-<version>-setup.exe` and run it. |
| [Portable ZIP](https://github.com/amirlehmam/wmux/releases/latest) | Download `wmux-<version>-win-x64.zip`, extract it, and run `wmux.exe`. |
| [Scoop](https://scoop.sh) | Run the commands below. |

```powershell
scoop bucket add wmux https://github.com/amirlehmam/wmux
scoop install wmux/wmux
```

Installer and ZIP installs update through **Settings → Help → Check for updates**; Scoop installs use `scoop update wmux`. Settings and saved sessions live in `%APPDATA%\wmux`, including for the ZIP.

Releases are not signed with a publicly trusted certificate yet, so Windows may show a SmartScreen warning. Only download wmux from this repository's releases.

<details>
<summary>Update controls</summary>

Set `WMUX_DISABLE_UPDATER=1` to disable the updater. For unattended installer downloads, `WMUX_MIN_RELEASE_AGE_DAYS` sets the minimum release age (3 days by default). A manual update check bypasses that delay. Installing an update still requires confirmation.

</details>

## Your first five minutes

1. Open wmux and pick a shell: PowerShell, Command Prompt, Git Bash or WSL.
2. Open your project with **Ctrl+O** and start your agent as usual.
3. Split right with **Ctrl+D** or down with **Ctrl+Shift+D**. Put tests, a dev server or a second agent beside the first.
4. Press **Ctrl+Shift+A** for the agent navigator, or **Ctrl+Shift+B** to jump to the agent waiting for you.

On first launch you choose which agent integrations to turn on, and you can change them later in **Settings → General**. wmux asks before it installs a hook or writes any configuration outside its own folder.

## What it does

### Every agent, one window

Split panes in any direction, drag tabs between them and zoom the one you are reading. Group the terminals of a project into a workspace, and save the layout to reuse it. Each pane keeps its own shell, folder and colours. wmux ships dark and light appearances, bundled terminal themes and an importer for Windows Terminal and Ghostty settings.

For a setup the whole team shares, commit a [`wmux.workspace.json`](docs/workspace-manifest.md). It opens the panes, folders, commands and browser tabs your project needs:

```powershell
wmux workspace open
```

### See who needs you

The sidebar gathers agent activity, working folders, Git branches and listening ports. The agent navigator lists blocked agents first, and a notification brings you back when an agent finishes or asks something.

Activity comes from agent integrations and, for supported tools, from reading the screen. How much wmux can report depends on the agent: a recognized agent does not always expose a reliable working or waiting state.

### A browser beside the code

Open a local dev server or the docs in the browser panel with **Ctrl+Shift+I**. Agents drive it from the CLI: navigate, read the page, click elements and take screenshots, while you watch it happen. Links open in wmux or in your system browser, as set in **Settings → Browser**.

### Review without leaving the terminal

Open the file explorer with **Ctrl+Shift+X** or the Git view with **Ctrl+Alt+G**. Browse working changes, compare a branch against its base and read the commit graph. The Git view stays on the repository you opened while you move between agent panes.

The file viewer handles quick edits, and Markdown panes render plans and docs with diagrams and math. Git worktree workspaces give parallel tasks their own checkout when they touch the same repository.

### Script it from any pane

Every terminal wmux opens has the `wmux` CLI on its PATH, so you, your scripts and your agents can open workspaces, read a pane, drive the browser or send a notification. See [CLI](#cli) below.

### Pick up where you left off

wmux restores workspace layouts, tabs and working folders. Shells start again; running processes do not survive a restart.

Agent conversation restore has its own opt-in switches in **Settings → Workspace**. See the notes for [Codex](docs/codex-session-restore.md) and [omp](docs/omp-session-restore.md).

Keeping terminal output across restarts is also opt-in, under **Settings → Terminal → Scrollback**. That output is stored locally as unencrypted text and can contain anything printed in the terminal. Named sessions never archive it.

### Check in from your phone

The optional Remote Console shows agent activity and mirrors terminal panes in a phone browser. Send text, use the key bar, or answer a choice an agent is waiting on.

Turn it on in **Settings → Remote**, reach it through Tailscale or an SSH tunnel, then pair your phone. It is off by default and listens on loopback only. The settings page has the connection steps and lets you revoke a device.

## Bring your own agents

**Integrated.** wmux installs hooks, plugins or instructions so the sidebar knows each agent's state, and asks first.

| Agent | What wmux adds |
| --- | --- |
| Claude Code | Hooks for state and notifications, session resume, hooks inside running WSL distros |
| Codex | Opt-in conversation restore through a launcher, without hooks |
| OpenCode | A plugin and an `AGENTS.md` block, plus session resume ([details](docs/opencode-plugin.md)) |
| Qwen Code | Hooks, instructions and session resume |
| Kiro | A wmux steering file in your Kiro folder |
| pi | An extension, scoped instructions and session resume |
| omp (Oh My Pi) | An extension, an `AGENTS.md` block and session resume |
| Grok Build | Hooks and a rules file, only when the `grok` CLI is installed |
| Antigravity CLI | A plugin and conversation resume for `agy` |

**Recognized.** wmux labels the pane as an agent from its command line and installs nothing: Gemini CLI, Cursor Agent, Copilot CLI, Cline, Aider, Amp, Droid, Goose and Crush.

Any other command-line tool runs in a pane as usual.

## Keyboard shortcuts

| Action | Default shortcut |
| --- | --- |
| Open a project folder | **Ctrl+O** |
| New workspace | **Ctrl+N** |
| New tab | **Ctrl+T** |
| Split right / down | **Ctrl+D** / **Ctrl+Shift+D** |
| Move focus between panes | **Ctrl+Alt+Arrow** |
| Zoom the current pane | **Ctrl+Shift+Enter** |
| Agent navigator | **Ctrl+Shift+A** |
| Jump to a waiting agent | **Ctrl+Shift+B** |
| File explorer | **Ctrl+Shift+X** |
| Project Git view | **Ctrl+Alt+G** |
| Browser panel | **Ctrl+Shift+I** |
| Markdown pane | **Ctrl+Shift+M** |
| Command palette | **Ctrl+Shift+P** |
| Settings | **Ctrl+,** |
| Shortcut reference | **Ctrl+F1** |

Rebind any of them in **Settings → Keyboard**, where the workspace and tab number-row shortcuts can also be changed or turned off.

## CLI

`wmux` is available inside the terminals it opens and talks to the running app over a named pipe.

```powershell
wmux ping
wmux new-workspace --title "Frontend" --panes 2 --layout columns
wmux list-workspaces
wmux tree

# Inspect agent activity and terminal output
wmux agent-state
wmux read-screen --lines 50

# Open a plan or a local preview
wmux markdown docs/plan.md
wmux browser open http://localhost:3000
wmux browser snapshot

# Notify yourself when a script finishes
wmux notify "Tests finished"

# Open an SSH workspace
wmux ssh user@host --title "Remote"
```

Run `wmux help` for the command list, or `wmux <command> --help` for usage. Commands that target a terminal accept a surface ID where documented, so a script can address one specific tab.

For containers and remote machines, see the [devcontainer guide](docs/DEVCONTAINER.md). Paste and drop can upload files into direct SSH panes; [configuration and limitations](docs/config.md#remote-file-upload) explain when that applies.

## Documentation

| Guide | What it covers |
| --- | --- |
| [Configuration](docs/config.md) | `~/.wmux/config.toml`, themes, key remaps and file uploads |
| [Workspace manifests](docs/workspace-manifest.md) | Project layouts, startup commands and dependencies |
| [WSL file explorer](docs/wsl-explorer.md) | Directory reporting and files across Windows and WSL |
| [Devcontainers](docs/DEVCONTAINER.md) | Connecting container shells to the desktop app |
| [OpenCode integration](docs/opencode-plugin.md) | Plugin behavior, compatibility and troubleshooting |
| [Codex session restore](docs/codex-session-restore.md) | Resuming the right conversation in each tab |
| [ChatGPT Web dictation](docs/chatgpt-web-dictation.md) | Account setup, microphones and dictating into a terminal |
| [omp session restore](docs/omp-session-restore.md) | Transcript tracking and restore behavior |
| [Crash reports](docs/crash-reports.md) | Collecting a useful report without sending a memory dump |

Looking for a recent change? Read the [release notes](https://github.com/amirlehmam/wmux/releases).

## Build and contribute

wmux is built with Electron, React, TypeScript, Zustand, xterm.js and node-pty/ConPTY.

On Windows, with Git and a current Node.js LTS:

```powershell
git clone https://github.com/amirlehmam/wmux.git
cd wmux
npm ci
npm run build:main
npm run dev
```

Clone into a short path without spaces, such as `C:\dev\wmux`, to avoid native build and packaging issues.

```powershell
npm test
npm run typecheck
npm run lint
npm run build:renderer
```

The main process lives in `src/main`, the UI in `src/renderer` and the CLI in `src/cli`. [AGENTS.md](AGENTS.md) describes the module boundaries and conventions. Release builds run in GitHub Actions when a version tag is pushed.

[Open an issue](https://github.com/amirlehmam/wmux/issues) for a bug or a feature request, or start a [discussion](https://github.com/amirlehmam/wmux/discussions). For a bug, include the wmux version, the shell, the steps to reproduce and what you expected. For a crash, start with `wmux crash-report`, and never attach a memory dump: it can contain credentials.

## Credits and license

wmux is an independent Windows implementation inspired by [cmux](https://github.com/manaflow-ai/cmux), and reuses none of its code. The agent visibility model was also influenced by [herdr](https://github.com/herdrdev/herdr).

Licensed under [MIT](LICENSE).
