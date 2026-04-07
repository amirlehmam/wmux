# wmux — Development Guide

Electron-based Windows terminal multiplexer for AI agents. TypeScript, React 19, Zustand, xterm.js, node-pty.

**Owner**: amirlehmam (GitHub) — speaks French, prefers fast pragmatic solutions, tests live.
**Repo**: github.com/amirlehmam/wmux | **Site**: wmux.org (Netlify, static from `site/`)
**Version**: 0.5.8

---

## Build & Dev

```bash
npm run dev            # Vite (port 5199) + Electron hot-reload
npm run build:main     # tsc main/preload/cli only (fast iteration)
npm run build:renderer # Vite production build (renderer only)
npm run build          # Full: tsc + vite + electron-builder
npm test               # Vitest unit tests
npm run test:watch     # Vitest watch mode
npm run lint           # ESLint src/
```

### Known Build Gotcha

Project lives in `OneDrive - Pulsa` (path with spaces). This breaks:
- `npm link` / `node-gyp` (can't build node-pty)
- `electron-builder` winCodeSign (symlink errors)

**Workaround**: Don't use `electron-builder` for the final package. Use ASAR-based manual packaging (see Release Process below).

---

## Architecture

```
src/
  main/           Electron main process
  renderer/       React UI (Vite)
  preload/        contextBridge (window.wmux)
  cli/            CLI → named pipe (\\.\pipe\wmux)
  shared/         Shared types (IPC channels, branded IDs)
  shell-integration/  Shell hooks (bash/zsh/PowerShell/cmd)

resources/        Runtime assets (icons, themes, sounds, shell-integration, CLI)
  wmux-orchestrator/  Claude Code plugin (auto-installed on startup)
site/             Landing page (static HTML, Netlify)
tests/            Unit + e2e (Vitest)
docs/             Planning docs
```

### Main Process (`src/main/`)

| File | Role |
|------|------|
| `index.ts` | Entry point, AppUserModelId, auto-save (30s), pipe server startup, V2 pipe handlers (workspace/pane/surface/markdown/sidebar/notification) |
| `pty-manager.ts` | PTY lifecycle (create with surfaceId, write, resize, kill) |
| `pipe-server.ts` | Named pipe `\\.\pipe\wmux` — V1 text (shell hooks), V2 JSON-RPC (CLI/agents) |
| `cdp-bridge.ts` | Browser webview control via Chrome DevTools Protocol |
| `cdp-proxy.ts` | CDP WebSocket proxy |
| `agent-manager.ts` | Agent PTY spawning, round-robin distribution across panes |
| `window-manager.ts` | Electron BrowserWindow creation/management |
| `ipc-handlers.ts` | All IPC channel handlers |
| `claude-context.ts` | Auto-injects wmux instructions into `~/.claude/CLAUDE.md`, configures hooks, installs wmux-orchestrator plugin |
| `claude-observer.ts` | Monitors Claude Code activity for sidebar display |
| `session-persistence.ts` | Auto-save/restore window state |
| `git-poller.ts` | Git branch/dirty status polling |
| `pr-poller.ts` | GitHub PR status polling |
| `port-scanner.ts` | Active port detection for running dev servers |
| `theme-loader.ts` | Theme loading |
| `config-loader.ts` | WT/Ghostty config import |
| `shell-detector.ts` | Available shells detection |
| `updater.ts` | Auto-update (electron-updater) |

### Renderer (`src/renderer/`)

**Components** (in `components/`):
- `SplitPane/` — PaneWrapper, SplitContainer, SplitDivider, SurfaceTabBar
- `Terminal/` — TerminalPane, FindBar, CopyMode, NotificationRing
- `Browser/` — BrowserPane, AddressBar
- `Sidebar/` — Sidebar, WorkspaceRow, SessionMenu, SidebarResizeHandle
- `Titlebar/` — Titlebar, NotificationBell, NotificationPanel
- `Settings/` — SettingsWindow + per-category panels
- `CommandPalette/` — CommandPalette
- `Markdown/` — MarkdownPane
- `Tutorial/` — Tutorial

**Hooks** (in `hooks/`):
- `useTerminal.ts` — xterm.js lifecycle, PTY connection, OSC notifications, WebGL renderer
- `useKeyboardShortcuts.ts` — 51+ shortcut actions, safe interception

**Pipe Bridge** (`pipe-bridge.ts`):
- Exposes Zustand store operations as `window.__wmux_*` globals
- Called by main process via `executeJavaScript` to bridge V2 pipe commands to renderer
- Covers: workspace CRUD, pane split/close/list, surface CRUD, markdown content, notifications

**Store** (Zustand, in `store/`):
- `workspace-slice.ts` — Workspace CRUD, split tree updates
- `surface-slice.ts` — Surface/tab add/close/move/navigate
- `settings-slice.ts` — Shortcuts, sidebar prefs, theme
- `notification-slice.ts` — Notification lifecycle (max 200)
- `agent-slice.ts` — Agent metadata tracking
- `split-utils.ts` — Immutable split tree helpers

### Preload API (`window.wmux`)

```
pty:      create, write, resize, kill, has, onData, onExit
system:   platform, getShells, openExternal, toggleDevTools
config:   getTheme, getThemeList, importWindowsTerminal, importGhostty
metadata: onUpdate
notification: fire, onFocusSurface
browser:  navigate
agent:    list, status, onUpdate
clipboard: pasteImage
hook:     onEvent
claudeActivity: onUpdate
session:  save, load, list, delete
cdp:      attach, detach
window:   create, close, focus, list, minimize, maximize, isMaximized
```

---

## Key Design Decisions

### No MCP — CLI Only
Do NOT build MCP servers. Use the wmux CLI (`wmux <command>`) via Bash instead.
The CLI talks to the named pipe, which is simpler and more reliable.
For new Claude Code integrations, add CLI commands in `src/cli/wmux.ts`.

### Branded ID Types
`WorkspaceId`, `PaneId`, `SurfaceId`, `WindowId` — branded string types in `src/shared/types.ts`.
Pattern: `surf-{uuid}`, `pane-{uuid}`, `ws-{uuid}`, `win-{uuid}`.

### Keep-Alive Tabs
Terminal tabs in a pane are ALL rendered simultaneously (hidden with `visibility: hidden`).
When switching tabs, only CSS changes — the xterm instance stays alive, no PTY reconnection needed.
The `surfaceId` is passed to `pty.create()` so PTY ID = Surface ID (enables reliable re-attachment).

### Split Tree
Pane layouts use an immutable binary tree (`SplitNode`). Each leaf = one pane with N surfaces (tabs).
Mutations go through `splitNode()`, `removeLeaf()`, `findLeaf()`, `getAllPaneIds()` in `split-utils.ts`.

---

## Release Process (CRITICAL)

wmux is distributed as a **portable zip** (not NSIS installer) because without code-signing, Windows SmartScreen flags installers more aggressively than zip extractions.

### Step-by-step

```bash
# 1. Build everything
npm run build:main        # Compile TS → dist/main/, dist/preload/, dist/cli/
npx vite build            # Build renderer → dist/renderer/

# 2. Verify compiled code
# Check that fixes are in the compiled output:
python -c "import re; f=open('dist/renderer/assets/index-*.js').read(); print('OK' if 'your_fix_marker' in f else 'MISSING')"
grep -c 'your_fix_string' dist/main/index.js

# 3. Create ASAR staging
rm -rf .asar-staging
mkdir -p .asar-staging
cp -r dist .asar-staging/
cp package.json .asar-staging/
cd .asar-staging && npm install --omit=dev --ignore-scripts && cd ..

# 4. Pack ASAR (with native module unpacking)
npx asar pack .asar-staging resources/app.asar --unpack "**/*.node"

# 5. Verify native modules are unpacked
ls resources/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/
# Must contain: conpty.node, conpty_console_list.node, pty.node

# 6. Create release staging (copy from running Electron binary)
# The Electron binary lives in wmux_v_extracted/ (or wherever it was extracted)
rm -rf ../wmux-release-staging
cp -r ../wmux_v_extracted ../wmux-release-staging

# 7. Copy ASAR + resources into release staging
cp resources/app.asar ../wmux-release-staging/resources/
rm -rf ../wmux-release-staging/resources/app.asar.unpacked
cp -r resources/app.asar.unpacked ../wmux-release-staging/resources/
cp resources/icon.png ../wmux-release-staging/resources/
cp -r resources/themes ../wmux-release-staging/resources/
cp -r resources/sounds ../wmux-release-staging/resources/
cp dist/cli/wmux.js ../wmux-release-staging/resources/cli/
cp -r src/shell-integration/* ../wmux-release-staging/resources/shell-integration/
cp -r resources/wmux-orchestrator ../wmux-release-staging/resources/wmux-orchestrator

# 8. Embed icon + metadata in exe (rcedit)
node -e "
  const { rcedit } = require('rcedit');
  rcedit('../wmux-release-staging/wmux.exe', {
    icon: 'resources/icons/icon.ico',
    'version-string': {
      ProductName: 'wmux',
      FileDescription: 'wmux - Windows Terminal Multiplexer',
      CompanyName: 'wmux',
      InternalName: 'wmux',
      OriginalFilename: 'wmux.exe',
      LegalCopyright: 'Copyright (c) 2025 wmux'
    },
    'file-version': '0.4.0',
    'product-version': '0.4.0'
  }).then(() => console.log('rcedit done'));
"
# NOTE: rcedit CANNOT modify a running exe. Close wmux first or use a copy.

# 9. Create zip
cd .. && powershell -Command "Compress-Archive -Path 'wmux-release-staging/*' -DestinationPath 'wmux-0.4.0-win-x64.zip'"

# 10. Upload to GitHub
cd wmux
gh release delete-asset v0.4.0 wmux-0.4.0-win-x64.zip --yes
gh release upload v0.4.0 ../wmux-0.4.0-win-x64.zip

# 11. Also update running release (optional, for immediate testing)
cp resources/app.asar ../wmux_v_extracted/resources/
cp -r resources/app.asar.unpacked ../wmux_v_extracted/resources/
# Then restart wmux to pick up changes

# 12. Cleanup
rm -rf .asar-staging ../wmux-release-staging
```

### Release Checklist

- [ ] `npm run build:main` succeeds
- [ ] `npx vite build` succeeds
- [ ] Compiled code verified (grep for key changes in dist/)
- [ ] ASAR packed with `--unpack "**/*.node"`
- [ ] node-pty native modules present in `app.asar.unpacked`
- [ ] wmux-orchestrator plugin copied to release staging
- [ ] rcedit applied (icon + version metadata)
- [ ] Zip created and uploaded to GitHub release
- [ ] Mark of the Web: remind user to right-click > Unblock after download

### Important Notes

- **rcedit can't modify a running exe** — always work on a copy
- **MOTW (Mark of the Web)**: Downloaded zips get `Zone.Identifier` NTFS stream. Fix: `powershell "Get-ChildItem -Recurse | Unblock-File"`
- **Windows taskbar pinning** uses PE `FileDescription` for the shortcut name — ensure rcedit sets it to "wmux"
- **AppUserModelId** is set to `com.wmux.app` in `src/main/index.ts` for proper taskbar grouping

---

## Named Pipe V2 Handlers

The pipe server in `index.ts` handles V2 JSON-RPC methods. Most delegate to the renderer via `executeJavaScript('window.__wmux_*(...)')`. The renderer's `pipe-bridge.ts` exposes Zustand store operations as these globals.

**Fully implemented V2 methods:**
- `system.identify`, `system.capabilities`, `system.tree`
- `workspace.create`, `workspace.close`, `workspace.select`, `workspace.rename`, `workspace.list`
- `pane.split`, `pane.close`, `pane.focus`, `pane.zoom`, `pane.list`
- `surface.create`, `surface.close`, `surface.focus`, `surface.list`
- `surface.send_text`, `surface.send_key`, `surface.trigger_flash`
- `markdown.set_content`, `markdown.load_file`
- `notification.list`, `notification.clear`
- `sidebar.set_status`, `sidebar.set_progress`, `sidebar.log`, `sidebar.get_state`
- `browser.*` (via CDP bridge)
- `agent.spawn`, `agent.spawn_batch`, `agent.status`, `agent.list`, `agent.kill`
- `hook.event`, `diff.refresh`

**Partially implemented:** `surface.read_text` (stub — needs xterm serializer addon)

---

## wmux-orchestrator Plugin

Claude Code plugin bundled in `resources/wmux-orchestrator/`. Auto-installed into `~/.claude/plugins/cache/` on startup by `ensureOrchestratorPlugin()` in `claude-context.ts`. Also published standalone: `github.com/amirlehmam/wmux-orchestrator`.

**What it does:** Decomposes complex dev tasks into parallel Claude Code agents coordinated through dependency-aware waves with automated review. With wmux: each agent in its own visible terminal pane. Without wmux: falls back to native subagents.

**Plugin structure:**
```
resources/wmux-orchestrator/
  .claude-plugin/plugin.json    Manifest (name, version, author)
  commands/orchestrate.md       /wmux:orchestrate slash command
  skills/orchestrate/SKILL.md   Core: codebase analysis, wave planning, agent spawning
  skills/reviewer/SKILL.md      Post-orchestration review and auto-fix
  skills/wmux-detect/SKILL.md   Detects wmux availability for degraded mode
  agents/wmux-worker.md         Worker template with file zone enforcement
  hooks/hooks.json              PostToolUse, SubagentStop, Stop, SessionStart
  scripts/json-tool.js          Node.js JSON helper (replaces jq)
  scripts/orchestration-state.sh  State file management library
  scripts/spawn-agents.sh       Creates panes + launches Claude Code agents
  scripts/on-agent-stop.sh      Wave transition driver (core orchestration)
  scripts/check-status.sh       Markdown dashboard generator
  scripts/*.sh                  Other utilities (cleanup, collect-results, etc.)
```

**Key design:** Skills handle intelligence (prompts), hooks handle reactivity (events), scripts handle wmux operations (CLI). State shared via JSON file in TMPDIR. No daemon.

---

## CLI Reference

```bash
# System
wmux ping | identify | capabilities

# Workspaces
wmux new-workspace [--title T] [--shell S] [--cwd D]
wmux close-workspace | select-workspace | rename-workspace | list-workspaces

# Surfaces (tabs within a pane)
wmux new-surface [--type terminal|browser|markdown]
wmux close-surface | focus-surface | list-surfaces

# Panes
wmux split [--down] [--type T] | close-pane | focus-pane | zoom-pane | list-panes | tree

# Terminal I/O
wmux send <text> | send-key <key> [--ctrl] [--shift] [--alt]
wmux read-screen [--lines N] | trigger-flash

# Browser (CDP)
wmux browser open <url> | snapshot | click @eN | type @eN <text>
wmux browser fill @eN <value> | get-text | screenshot | eval <js>
wmux browser back | forward | reload

# Agents
wmux agent spawn [--cmd C] [--label L] [--cwd D] [--pane P]
wmux agent spawn-batch --json '[...]' [--strategy distribute|stack|split]
wmux agent status <id> | list | kill <id>

# Notifications & Sidebar
wmux notify <text> | list-notifications | clear-notifications
wmux set-status <key> <value> | set-progress <val> [--label L]
wmux log <level> <message> | sidebar-state

# Hooks
wmux hook --event <type> --tool <name> [--agent <id>]
```

---

## IPC Channels

All defined in `src/shared/types.ts` → `IPC_CHANNELS`:

```
PTY:     pty:create, pty:write, pty:resize, pty:kill, pty:has, pty:data, pty:exit
Window:  window:create/close/focus/list/minimize/maximize/isMaximized
Config:  config:getTheme/getThemeList/importWindowsTerminal/importGhostty
System:  system:getShells/openExternal
Notify:  notification:fire/list/clear/jump
Agent:   agent:spawn/spawn-batch/status/list/kill/update
CDP:     cdp:attach/detach
Session: session:save-named/load-named/list-named/delete-named
Meta:    metadata:update, hook:event, claude:activity
```

---

## Shell Integration

Scripts in `src/shell-integration/` (deployed to `resources/shell-integration/`):

| Script | Reports |
|--------|---------|
| `wmux-powershell-integration.ps1` | cwd, git branch/dirty, shell state, PR polling (45s) |
| `wmux-bash-integration.sh` | cwd, git branch/dirty, shell state, ports |
| `wmux-cmd-integration.cmd` | Basic OSC 9 escape sequences |

Env vars set by wmux in spawned shells: `WMUX=1`, `WMUX_SURFACE_ID`, `WMUX_PIPE`, `WMUX_CLI`.

---

## Website (wmux.org)

Static site in `site/`. Deployed to Netlify (`netlify.toml` at repo root).

```bash
# Deploy
npx netlify deploy --prod --dir site
```

`site/index.html` — Landing page with i18n (English, French, Arabic, Japanese).
`site/i18n.js` — Language switching via URL hash (`#ar`, `#fr`, `#ja`).

---

## Testing

```bash
npm test                    # Run all unit tests
npm run test:watch          # Watch mode
npx vitest run tests/unit/pty-manager.test.ts  # Single file
```

Test files in `tests/unit/`: agent-manager, cdp-bridge, config-loader, notification-slice, pipe-server, port-scanner, pty-manager, session-persistence, shell-detector, split-tree.

---

## Conventions

- **State**: Zustand slices in `src/renderer/store/`, composed in `index.ts`
- **IPC**: Channels defined in `src/shared/types.ts`, never use magic strings
- **CSS**: `src/renderer/styles/`, class prefix per component (`.pane-wrapper__*`, `.surface-tab__*`)
- **Immutable trees**: Split tree mutations always produce new objects via `patchLeaf()`
- **PTY IDs = Surface IDs**: Always pass `surfaceId` when creating PTYs for reliable re-attachment
- **No MCP**: All Claude Code integration via CLI commands
- **French comms**: User communicates in French, code/docs in English
