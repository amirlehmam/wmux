# wmux — Windows Terminal Multiplexer for AI Agents

**Date:** 2026-03-25
**Status:** Approved (v3 — second review fixes)
**Based on:** [cmux](https://github.com/manaflow-ai/cmux) (macOS)

## Overview

wmux is a Windows desktop application that replicates cmux's full feature set — a terminal multiplexer designed for running multiple AI coding agents (Claude Code) in parallel, with workspace-aware notifications, live sidebar metadata, split panes, an in-app browser, and a scriptable CLI.

**Tech stack:** Electron + React + TypeScript + xterm.js + node-pty + Zustand

### Terminology

Consistent naming throughout (matching cmux):
- **Window**: an OS-level window containing a sidebar and content area
- **Workspace**: a sidebar entry (also called "tab" in cmux) containing a split tree
- **Pane**: a region within the split tree that can hold multiple surfaces
- **Surface**: a single terminal or browser instance within a pane (tab within pane)
- **Panel**: generic term for either a terminal surface or browser surface

---

## 1. Application Architecture

### 1.1 Two-Process Electron Model

**Main process (Node.js):**
- PTY Manager — spawns shells via node-pty (ConPTY on Windows)
- Named Pipe Server — `\\.\pipe\wmux` for CLI and shell integration communication
- Port Scanner — detects listening TCP ports per pane via `netstat -ano` or Win32 `GetExtendedTcpTable`
- Git/PR Poller — runs `git rev-parse`, `git status --porcelain`, `gh pr view` per workspace
- Notification Manager — Windows toast notifications, taskbar flash
- Session Persister — saves/restores workspace state to `%APPDATA%\wmux\sessions\`
- Config Loader — parses Windows Terminal `settings.json` and Ghostty `~/.config/ghostty/config`
- Theme Loader — 450+ bundled Ghostty color themes
- Shell Detector — auto-detects available shells (pwsh, powershell, cmd, wsl)
- Window Manager — manages multiple BrowserWindow instances
- Auto-Updater — via electron-updater + GitHub Releases

**Renderer process (one per window, Chromium):**
- React app with Zustand state management
- xterm.js terminal instances with WebGL addon
- Split pane layout system (tree-based)
- Sidebar with live workspace metadata
- Browser panels via `WebContentsView` (Electron 30+)
- Markdown panel renderer
- Settings UI

**IPC:** Secure contextBridge API — no `nodeIntegration` in renderer. See Section 1.3 for the typed preload API contract.

### 1.2 Data Flow

- Terminal input: xterm.js `onData` → IPC → main → `pty.write()`
- Terminal output: `pty.onData` → IPC → renderer → xterm.js `write()`
- Metadata: shell integration → named pipe → main process → IPC → Zustand store → React UI

### 1.3 Preload API Contract (contextBridge)

```typescript
interface WmuxAPI {
  // PTY
  pty: {
    create(options: { shell: string; cwd: string; env: Record<string, string> }): Promise<string>; // returns ptyId
    write(ptyId: string, data: string): void;
    resize(ptyId: string, cols: number, rows: number): void;
    kill(ptyId: string): void;
    onData(ptyId: string, callback: (data: string) => void): () => void; // returns unsubscribe
    onExit(ptyId: string, callback: (code: number) => void): () => void;
  };
  // Workspace
  workspace: {
    create(options?: { title?: string; shell?: string; cwd?: string }): Promise<string>;
    close(id: string): void;
    select(id: string): void;
    rename(id: string, title: string): void;
    list(): Promise<WorkspaceInfo[]>;
    reorder(ids: string[]): void;
    moveToWindow(workspaceId: string, windowId?: string): void; // undefined = new window
  };
  // Surface (tabs within panes)
  surface: {
    create(paneId: string, type: 'terminal' | 'browser' | 'markdown'): Promise<string>;
    close(surfaceId: string): void;
    focus(surfaceId: string): void;
    list(paneId: string): Promise<SurfaceInfo[]>;
    readText(surfaceId: string, options?: { lines?: number }): Promise<string>;
    sendText(surfaceId: string, text: string): void;
    sendKey(surfaceId: string, key: string, modifiers?: string[]): void;
    triggerFlash(surfaceId: string): void;
  };
  // Split panes
  pane: {
    split(direction: 'right' | 'down', type: 'terminal' | 'browser' | 'markdown'): Promise<string>;
    close(paneId: string): void;
    focus(paneId: string): void;
    zoom(paneId: string): void;
    list(workspaceId: string): Promise<PaneInfo[]>;
  };
  // Browser
  browser: {
    navigate(surfaceId: string, url: string): void;
    back(surfaceId: string): void;
    forward(surfaceId: string): void;
    reload(surfaceId: string): void;
    snapshot(surfaceId: string): Promise<AccessibilityTree>;
    click(surfaceId: string, selector: string): Promise<void>;
    fill(surfaceId: string, selector: string, value: string): Promise<void>;
    evaluate(surfaceId: string, script: string): Promise<unknown>;
  };
  // Notifications
  notification: {
    list(): Promise<NotificationInfo[]>;
    clear(id?: string): void;
    jumpToUnread(): void;
  };
  // Settings
  settings: {
    get<T>(key: string): Promise<T>;
    set(key: string, value: unknown): void;
    onChanged(callback: (key: string, value: unknown) => void): () => void;
  };
  // Window management
  window: {
    create(): Promise<string>;
    close(windowId: string): void;
    focus(windowId: string): void;
    list(): Promise<WindowInfo[]>;
    minimize(): void;
    maximize(): void;
    isMaximized(): Promise<boolean>;
  };
  // Config
  config: {
    getTheme(): Promise<ThemeConfig>;
    getThemeList(): Promise<string[]>;
    importWindowsTerminal(): Promise<ThemeConfig>;
    importGhostty(): Promise<ThemeConfig>;
  };
  // Sidebar metadata (for external tools)
  sidebar: {
    setStatus(workspaceId: string, key: string, value: string): void;
    setProgress(workspaceId: string, value: number, label?: string): void;
    log(workspaceId: string, level: 'info' | 'success' | 'warning' | 'error', message: string): void;
    getState(workspaceId: string): Promise<SidebarMetadata>;
  };
  // Markdown
  markdown: {
    setContent(surfaceId: string, content: string): void;
    loadFile(surfaceId: string, filePath: string): void;
  };
  // System
  system: {
    platform: 'win32';
    getShells(): Promise<ShellInfo[]>;
    openExternal(url: string): void;
  };
}
```

### 1.4 Multi-Window Architecture

- One main process manages all windows. Each `BrowserWindow` gets its own renderer process.
- The main process is the single source of truth for all state (workspaces, surfaces, notifications).
- Each renderer syncs a local Zustand store via IPC subscriptions (`settings.onChanged`, workspace events, etc.).
- The named pipe server runs in the main process — all windows share it.
- Session persistence saves all windows (bounds, workspaces, active state).
- Workspaces can be moved between windows via drag-and-drop or context menu → "Move Workspace to Window".

---

## 2. Window Layout & Chrome

**Window configuration:**
- `BrowserWindow` with `titleBarStyle: 'hidden'` and `titleBarOverlay: { color: '#1a1a1a', symbolColor: '#cccccc', height: 38 }`
- This gives native Windows minimize/maximize/close buttons in the top-right while we control the rest
- Custom drag region across the top bar (`-webkit-app-region: drag`)
- Toolbar height: 38px
- Toolbar shows focused surface command/title: 12px system font, medium weight, secondary color

**Layout:**
- Sidebar (left) + Content area (right)
- Sidebar default: 200px, min 180px, max 600px or 1/3 window width
- Resizable via drag handle on right edge
- Sidebar background: `#1a1a1a` at 92% opacity (solid fallback), with optional `backdrop-filter: blur(12px)` (configurable, off by default for GPU performance — see sidebar background presets in Settings)
- Toggle with `Ctrl+B`

**Presentation modes:**
- Standard: full titlebar with workspace controls
- Minimal: reduced 30px height strip, controls auto-hidden

---

## 3. Sidebar — Workspace Rows

Each workspace row displays live metadata from shell integration.

**Row layout (top to bottom):**
1. Title (12.5px semibold) + unread badge (16x16 blue circle) + close button (on hover)
2. Notification text (10px, secondary color, 2-line max)
3. Git branch (10px monospace, 75% opacity) with optional branch icon
4. Working directory (10px monospace, 75% opacity, `~` shortened)
5. PR info (10px semibold): status icon + underlined `#number` + state text
6. Listening ports (10px monospace, 75% opacity): `:3000, :8080`

**Dimensions:**
- Row padding: 10px horizontal, 8px vertical
- Row corner radius: 6px
- Row spacing: 2px
- Row margin from sidebar edge: 6px horizontal

**Active tab indicator (default "left rail"):**
- 3px wide colored capsule, 5px vertical padding, 4px leading offset
- Fill: accent blue `#0091FF`
- Alternative "solid fill": accent background + 1.5px border at white 50% opacity

**Selected row:**
- Background: accent blue `#0091FF`
- All text: white (title 100%, metadata 75%, secondary 60%)

**Unread badge:**
- 16x16px blue filled circle (`#0091FF` on inactive, `white @ 25%` on selected)
- Count text: 9px semibold white

**Close button:**
- `x` icon, 9px medium, 16px hit target, visible on hover only

**Context menu (right-click):**
1. Pin / Unpin Workspace
2. Rename Workspace...
3. Remove Custom Workspace Name
4. Workspace Color → submenu (16 presets + custom picker)
5. Move Up / Move Down / Move to Top
6. Move Workspace to Window → submenu (New Window + list of other windows)
7. Close Workspace / Close Other / Close Above / Close Below
8. Mark as Read / Mark as Unread

**Drag-to-reorder:** supported, multi-selection via Ctrl+click / Shift+click.

**16 preset workspace colors:**
Red `#C0392B`, Crimson `#922B21`, Orange `#A04000`, Amber `#7D6608`, Olive `#4A5C18`, Green `#196F3D`, Teal `#006B6B`, Aqua `#0E6B8C`, Blue `#1565C0`, Navy `#1A5276`, Indigo `#283593`, Purple `#6A1B9A`, Magenta `#AD1457`, Rose `#880E4F`, Brown `#7B3F00`, Charcoal `#3E4B5E`

---

## 4. Terminal Emulation

**xterm.js per surface:**
- WebGL addon for GPU-accelerated rendering
- FitAddon for auto-resize
- WebLinksAddon for clickable URLs
- SearchAddon for find-in-terminal
- Unicode11Addon for Unicode
- ImageAddon for inline images (Sixel/iTerm2)

**Shell spawning (node-pty, main process):**

| Shell | Command | Notes |
|---|---|---|
| PowerShell 7 | `pwsh.exe` | Preferred if available |
| PowerShell 5 | `powershell.exe` | Fallback |
| CMD | `cmd.exe` | Classic prompt |
| WSL | `wsl.exe -d <distro>` | Linux shell |

- Default: auto-detect (pwsh → powershell → cmd)
- Configurable per-workspace
- Environment injected: `WMUX=1`, `WMUX_PANE_ID`, `WMUX_WORKSPACE_ID`, `WMUX_SURFACE_ID`, `WMUX_PIPE`

**Theme/config loading (dual source):**
1. Windows Terminal `settings.json` at `%LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json`
2. Ghostty config at `~/.config/ghostty/config`
3. 450+ bundled Ghostty themes
4. Fallback defaults (Monokai): background `#272822`, foreground `#fdfff1`, cursor `#c0c1b5`, selection bg `#57584f`, selection fg `#fdfff1`

**Copy/paste:**
- `Ctrl+Shift+C` / `Ctrl+Shift+V` (primary)
- `Ctrl+C` with active selection: intercepted in xterm.js via `attachCustomKeyEventHandler` before reaching PTY. If selection exists → copy to clipboard. If no selection → write `\x03` to PTY (sends `CTRL_C_EVENT` to the console process via ConPTY). This requires careful handling since ConPTY receives raw bytes, not Unix signals.

---

## 5. Split Pane & Surface System

### 5.1 Hierarchy

```
Window → Workspace → Split Tree → Pane → Surface(s)
```

Each pane is a leaf in the split tree. Each pane can contain **multiple surfaces** (tabs), with one active/visible at a time. This matches cmux's surface concept.

### 5.2 Split Tree Data Structure

```typescript
type SplitNode =
  | { type: 'leaf'; paneId: string; surfaces: SurfaceRef[]; activeSurfaceIndex: number }
  | { type: 'branch'; direction: 'horizontal' | 'vertical';
      ratio: number; children: [SplitNode, SplitNode] }

type SurfaceRef = {
  id: string;
  type: 'terminal' | 'browser' | 'markdown';
}
```

### 5.3 Surface (Tab-Within-Pane) Operations

Each pane shows a small tab bar when it contains multiple surfaces:

| Action | Shortcut |
|---|---|
| New Surface (terminal tab in pane) | `Ctrl+T` |
| Next Surface | `Ctrl+Shift+]` |
| Previous Surface | `Ctrl+Shift+[` |
| Select Surface 1-9 | `Alt+1...9` |
| Close Surface | `Ctrl+W` (closes active surface; if last, closes pane) |

### 5.4 Split Operations

| Action | Shortcut |
|---|---|
| Split Right | `Ctrl+D` |
| Split Down | `Ctrl+Shift+D` |
| Split Browser Right | `Ctrl+Alt+D` |
| Split Browser Down | `Ctrl+Shift+Alt+D` |
| Toggle Pane Zoom | `Ctrl+Shift+Enter` |
| Focus Pane Left/Right/Up/Down | `Ctrl+Alt+Arrow` |

### 5.5 Divider

- 1px rendered line, 4-6px invisible hit target
- Color: terminal background darkened 40% (dark) or 8% (light)
- Configurable via Ghostty `split-divider-color`
- Cursor: `col-resize` / `row-resize` on hover

### 5.6 Behavior

- Min pane size: 80px in either dimension
- Resize triggers FitAddon recalculation + `pty.resize()` for all terminal surfaces in the pane
- Unfocused pane dimming: 30% opacity overlay (configurable, default `unfocused-split-opacity: 0.7`)
- Zoom: focused pane fills content area, others hidden
- Pane close: leaf removed, branch collapses if one child remains
- Last pane close in workspace: workspace closes (configurable)

---

## 6. Notification System

**Three input sources:**
1. OSC escape sequences (OSC 9/99/777) — parsed via xterm.js `parser.registerOscHandler()`
2. `wmux notify` CLI command — sent over named pipe
3. Shell integration detecting agent idle state

**Notification effects (in order):**

**1. Pane ring (blue glow):**
- 2.5px rounded-rect stroke, `#007AFF` (systemBlue), inset 2px from pane bounds
- Corner radius: 6px
- Shadow: `#007AFF`, opacity 0.35, radius 3px
- Flash animation: 0.9s double-pulse, opacity `[0, 1, 0, 1, 0]` at times `[0, 0.25, 0.5, 0.75, 1.0]`, ease-in/ease-out
- Ring stays visible until pane is focused

**2. Sidebar badge:**
- Blue circle `#0091FF`, 16x16px, white count text 9px semibold
- Workspace auto-reorders to top (configurable)

**3. Windows toast:**
- Electron `new Notification()` API
- Click: focuses window, switches to workspace
- Sound: configurable

**4. Taskbar flash:**
- `BrowserWindow.flashFrame(true)`
- Stops when window focused

**Two accent types:**
- Notification blue: `#007AFF`, glow opacity 0.6, radius 6px
- Navigation teal: `#5AC8FA`, glow opacity 0.14, radius 3px

**Clearing:** Focus pane = mark read. `Ctrl+Shift+U` = jump to latest unread.

---

## 7. Socket Server & CLI

### 7.1 Named Pipe Server (Main Process)

- Path: `\\.\pipe\wmux` (default), `\\.\pipe\wmux-<username>` for multi-user
- Current-user-only security descriptor (Windows named pipe ACLs)
- Multiple simultaneous clients
- Hosted in main process, shared across all windows

### 7.2 V1 Protocol (Text, Shell Integration)

```
report_pwd <surface_id> <path>
report_git_branch <surface_id> <branch> [dirty]
clear_git_branch <surface_id>
report_pr <surface_id> <number> <status> <label>
clear_pr <surface_id>
report_tty <surface_id> <tty_path>
report_shell_state <surface_id> idle|running
ports_kick <surface_id>
notify <surface_id> <text>
ping
```

### 7.3 V2 Protocol (JSON-RPC, CLI and Automation)

**Workspace methods:**
```json
{"method": "workspace.create", "params": {"title": "...", "shell": "pwsh"}}
{"method": "workspace.select", "params": {"id": "..."}}
{"method": "workspace.list", "params": {}}
{"method": "workspace.close", "params": {"id": "..."}}
{"method": "workspace.rename", "params": {"id": "...", "title": "..."}}
{"method": "workspace.move_to_window", "params": {"id": "...", "windowId": "..."}}
```

**Surface methods:**
```json
{"method": "surface.create", "params": {"paneId": "...", "type": "terminal"}}
{"method": "surface.close", "params": {"id": "..."}}
{"method": "surface.focus", "params": {"id": "..."}}
{"method": "surface.list", "params": {"paneId": "..."}}
{"method": "surface.read_text", "params": {"id": "...", "lines": 50}}
{"method": "surface.send_text", "params": {"id": "...", "text": "..."}}
{"method": "surface.send_key", "params": {"id": "...", "key": "Enter", "modifiers": ["ctrl"]}}
{"method": "surface.trigger_flash", "params": {"id": "..."}}
```

**Pane methods:**
```json
{"method": "pane.split", "params": {"direction": "right", "type": "terminal"}}
{"method": "pane.close", "params": {"id": "..."}}
{"method": "pane.focus", "params": {"id": "..."}}
{"method": "pane.list", "params": {"workspaceId": "..."}}
{"method": "pane.create", "params": {"workspaceId": "...", "type": "terminal"}}
{"method": "pane.zoom", "params": {"id": "..."}}
```

**Browser methods:**
```json
{"method": "browser.navigate", "params": {"surfaceId": "...", "url": "..."}}
{"method": "browser.back", "params": {"surfaceId": "..."}}
{"method": "browser.forward", "params": {"surfaceId": "..."}}
{"method": "browser.reload", "params": {"surfaceId": "..."}}
{"method": "browser.snapshot", "params": {"surfaceId": "..."}}
{"method": "browser.click", "params": {"surfaceId": "...", "selector": "..."}}
{"method": "browser.fill", "params": {"surfaceId": "...", "selector": "...", "value": "..."}}
{"method": "browser.evaluate", "params": {"surfaceId": "...", "script": "..."}}
```

**Notification methods:**
```json
{"method": "notification.list", "params": {}}
{"method": "notification.clear", "params": {"id": "..."}}
```

**Window methods:**
```json
{"method": "window.list", "params": {}}
{"method": "window.focus", "params": {"id": "..."}}
{"method": "window.create", "params": {}}
{"method": "window.close", "params": {"id": "..."}}
```

**Sidebar metadata methods:**
```json
{"method": "sidebar.set_status", "params": {"workspaceId": "...", "key": "...", "value": "..."}}
{"method": "sidebar.set_progress", "params": {"workspaceId": "...", "value": 0.5, "label": "..."}}
{"method": "sidebar.log", "params": {"workspaceId": "...", "level": "info", "message": "..."}}
{"method": "sidebar.get_state", "params": {"workspaceId": "..."}}
```

**Markdown methods:**
```json
{"method": "markdown.set_content", "params": {"surfaceId": "...", "markdown": "..."}}
{"method": "markdown.load_file", "params": {"surfaceId": "...", "filePath": "..."}}
```

**Workspace (additional):**
```json
{"method": "workspace.reorder", "params": {"ids": ["ws-1", "ws-3", "ws-2"]}}
```

**System methods:**
```json
{"method": "system.identify", "params": {}}
{"method": "system.capabilities", "params": {}}
{"method": "system.tree", "params": {}}
```

> **Convention note:** V2 protocol uses `snake_case` method names. The preload API (Section 1.3) uses `camelCase` equivalents. Surface IDs use the format `surf-<uuid>`, pane IDs `pane-<uuid>`, workspace IDs `ws-<uuid>`.

### 7.4 CLI (`wmux.exe`)

Full command set matching cmux:

**Workspace commands:**
```
wmux new-workspace [--title <name>] [--shell <shell>] [--cwd <path>]
wmux close-workspace [<id>]
wmux select-workspace <id>
wmux rename-workspace <id> <title>
wmux list-workspaces
wmux move-workspace-to-window <workspace-id> [--window <window-id>]
```

**Surface commands:**
```
wmux new-surface [--type terminal|browser|markdown]
wmux close-surface [<id>]
wmux focus-surface <id>
wmux list-surfaces [--pane <pane-id>]
```

**Pane commands:**
```
wmux split [--right|--down] [--type terminal|browser|markdown]
wmux close-pane [<id>]
wmux focus-pane <id>
wmux zoom-pane [<id>]
wmux list-panes [--workspace <workspace-id>]
wmux tree
```

**Terminal interaction (essential for AI agents):**
```
wmux send <text>                    # send text to focused surface
wmux send-key <key> [--ctrl] [--shift] [--alt]
wmux read-screen [--lines <n>]     # read terminal content
wmux trigger-flash [<surface-id>]
```

**Browser commands:**
```
wmux browser open <url>
wmux browser snapshot
wmux browser click <selector>
wmux browser fill <selector> <value>
wmux browser evaluate <script>
wmux browser back
wmux browser forward
wmux browser reload
```

**Markdown commands:**
```
wmux markdown set <surface-id> --content <text>
wmux markdown set <surface-id> --file <path>
```

**Notification commands:**
```
wmux notify [--title <t>] [--body <b>] <text>
wmux list-notifications
wmux clear-notifications [<id>]
```

**Sidebar commands:**
```
wmux set-status <key> <value>      # set sidebar metadata pill
wmux set-progress <value> [--label <text>]
wmux log <level> <message>         # add sidebar log entry
wmux sidebar-state                 # dump current sidebar metadata
```

**System commands:**
```
wmux ping
wmux identify
wmux capabilities
wmux list-windows
wmux focus-window <id>
```

**Authentication:** Windows named pipe security descriptors (current user only). Optional password file at `%APPDATA%\wmux\socket-password`.

---

## 8. Shell Integration

**Three integration scripts, auto-injected when wmux spawns a surface:**

### PowerShell (`wmux-powershell-integration.ps1`)
- Overrides `prompt` function
- Communicates with named pipe via `[System.IO.Pipes.NamedPipeClientStream]` .NET API
- Reports: CWD (`$PWD`), git branch + dirty, shell state (idle/running)
- PR polling: background job with `gh pr view` every 45 seconds
- Port scan kick after command completion
- Injected via `-NoExit -Command ". 'path\to\integration.ps1'"`

### CMD (`wmux-cmd-integration.cmd`)
- CWD reporting via OSC 9 escape sequences embedded in `PROMPT` variable
- Git branch detection: main process watches `.git/HEAD` via filesystem watcher (CMD lacks good hook support)
- Metadata beyond CWD is limited in CMD — the main process compensates by polling git state for CMD panes
- Injected via `cmd.exe /K "path\to\integration.cmd"`

### WSL Bash/Zsh (`wmux-bash-integration.sh`)
- Near-identical to cmux's bash/zsh integration
- `PROMPT_COMMAND` (bash) or `precmd`/`preexec` (zsh) hooks
- Communication: uses `npiperelay` (https://github.com/jstarks/npiperelay) + `socat` to bridge from a WSL Unix socket to the Windows named pipe. The relay is auto-configured by wmux on first WSL pane creation. Fallback: write to a temp file at `/mnt/c/Users/<user>/AppData/Local/Temp/wmux/` that the main process watches.
- Reports: CWD, git branch, PR status, shell state, port kicks
- Sourced via `WMUX_INTEGRATION=1` env var detection in `.bashrc`/`.zshrc`

**Environment variables injected into all shells:**

| Variable | Value | Purpose |
|---|---|---|
| `WMUX` | `1` | Detect running inside wmux |
| `WMUX_WORKSPACE_ID` | `ws-<uuid>` | Auto-detect calling workspace |
| `WMUX_PANE_ID` | `pane-<uuid>` | Pane identity |
| `WMUX_SURFACE_ID` | `<uuid>` | Surface ID for socket protocol |
| `WMUX_PIPE` | `\\.\pipe\wmux` | Named pipe path |

**Port scanning (main process):**
- `netstat -ano` parsed output or Win32 `GetExtendedTcpTable` API
- Coalesce pattern: 200ms after kick, burst at `[0.5, 1.5, 3, 5, 7.5, 10]` seconds
- Maps PIDs to panes via process tree tracking

---

## 9. Browser Panel

**Electron `WebContentsView`** (Electron 30+) — preferred over deprecated `<webview>` tag. Each browser surface gets its own `WebContentsView` instance managed by the main process.

**Positioning strategy:** The renderer sends pane bounds (x, y, width, height) to the main process via IPC whenever panes resize, split, or zoom. The main process calls `webContentsView.setBounds()` to position the browser within the window. The React component renders a transparent placeholder div that reserves space in the layout — the actual browser content is overlaid by the main process. This is the same pattern VS Code uses for its webview panels.

**Address bar (omnibar):**
- Back/Forward/Refresh-Stop buttons
- URL pill: corner radius 10px, editable
- DevTools toggle: 11px icon, 16 icon options, configurable
- Button size: 22px, hit target: 26px, vertical padding: 4px
- Hover state: rounded rect, corner radius 8, bg opacity 0.08, pressed 0.16
- Chrome background: terminal bg color, pill darkened 5% (dark) / 4% (light)

**Scriptable API (via named pipe V2):**
- `browser.navigate` — go to URL
- `browser.snapshot` — dump accessibility tree (for AI agents)
- `browser.click` — click by CSS selector
- `browser.fill` — fill input by selector
- `browser.evaluate` — execute JS, return result
- `browser.back` / `browser.forward` / `browser.reload`

**Accessibility snapshot:** injected script walks DOM, extracts roles/labels/text as structured data. Enables Claude Code to "see" pages without screenshots.

**Search engine:** configurable (Google default), suggestions toggle.

---

## 10. Markdown Panel

A dedicated surface type for rendering markdown files in a split pane. Used by AI agents to display plans, documentation, or reports.

- Renders markdown to HTML using a bundled parser (e.g., `marked` or `markdown-it`)
- Supports GitHub Flavored Markdown (tables, task lists, fenced code with syntax highlighting)
- Read-only display — no editing
- Can be opened via:
  - `wmux split --type markdown` CLI command
  - `Ctrl+Alt+M` to open markdown panel
  - Programmatically via V2 protocol: `{"method": "pane.split", "params": {"type": "markdown"}}`
- Content can be set via V2: `{"method": "markdown.set_content", "params": {"surfaceId": "...", "markdown": "..."}}`
- Content can be loaded from file: `{"method": "markdown.load_file", "params": {"surfaceId": "...", "filePath": "..."}}`
- CLI: `wmux split --type markdown --file README.md` opens a pane with file content
- Styling matches the terminal theme (dark/light background, monospace code blocks)

---

## 11. Session Persistence

**Saved to `%APPDATA%\wmux\sessions\session.json`:**
- All windows: bounds (position, size), sidebar width
- All workspaces per window: id, title, color, pin state, shell type
- Split tree per workspace (directions, ratios, pane IDs)
- Surfaces per pane (type, terminal CWD, browser URL, markdown content path)
- Active workspace, pane, and surface per window
- Terminal scrollback (optional, configurable max)

**NOT restored:** running processes, shell state/history, notifications, port state, git/PR state.

**Save triggers:** auto-save every 30s (debounced), on workspace/split changes, on window resize, on quit.

**Crash recovery:** atomic write (temp file + rename). Corrupted file → single default workspace fallback.

---

## 12. Settings & Preferences

Settings window via `Ctrl+,`. Stored at `%APPDATA%\wmux\settings.json`.

**Sidebar tab:**
- Toggle: git branch, branch icon, branch vertical layout, working directory, PR, SSH, ports, log, progress, status pills, notification message, hide all details
- Active tab indicator: Left Rail / Solid Fill
- Background opacity slider, background preset dropdown (6 presets)
- Blur effect toggle (off by default for GPU performance)

**Workspace tab:**
- New workspace placement: After Current / Top / End
- Auto-reorder on notification, close on last pane, presentation mode, button fade, titlebar visible
- Default shell: PowerShell / CMD / WSL / Auto-detect

**Terminal tab:**
- Font family picker, font size, theme (450+ themes with preview), background opacity, unfocused pane opacity, cursor style/blink, scrollback lines
- Import from Windows Terminal / Import from Ghostty buttons

**Notifications tab:**
- Toggle: toast notifications, taskbar flash, pane ring, pane flash animation
- Sound: Default / None / Custom file

**Browser tab:**
- Search engine, suggestions, DevTools icon, PR links in wmux browser

**Keyboard Shortcuts tab:**
- All shortcuts listed, each with record button for rebinding
- Conflict detection, Reset All button
- Stored in `%APPDATA%\wmux\keybindings.json`

---

## 13. Keyboard Shortcuts

cmux `Cmd` → `Ctrl` on Windows. Some shortcuts adjusted to avoid Windows system conflicts (noted below).

**Workspace:**
| Action | Shortcut | Notes |
|---|---|---|
| New Workspace | `Ctrl+N` | |
| New Window | `Ctrl+Shift+N` | |
| Close Workspace | `Ctrl+Shift+W` | |
| Close Window | `Ctrl+Alt+W` | cmux uses Cmd+Ctrl+W; Ctrl+Ctrl impossible on Windows |
| Open Folder | `Ctrl+O` | |
| Toggle Sidebar | `Ctrl+B` | |
| Next Workspace | `Ctrl+PageDown` | cmux uses Cmd+Ctrl+]; PageDown is Windows convention |
| Previous Workspace | `Ctrl+PageUp` | cmux uses Cmd+Ctrl+[; PageUp is Windows convention |
| Select Workspace 1-9 | `Ctrl+1...9` | |
| Rename Surface (tab) | `F2` | cmux uses Cmd+R; Ctrl+R conflicts with shell reverse-search |
| Rename Workspace | `Ctrl+Shift+R` | |

**Panes:**
| Action | Shortcut |
|---|---|
| Split Right | `Ctrl+D` |
| Split Down | `Ctrl+Shift+D` |
| Split Browser Right | `Ctrl+Alt+D` |
| Split Browser Down | `Ctrl+Shift+Alt+D` |
| Toggle Zoom | `Ctrl+Shift+Enter` |
| Focus Left/Right/Up/Down | `Ctrl+Alt+Arrow` |
| Close Active Surface / Pane | `Ctrl+W` | Closes active surface first; if last surface, closes pane |

**Surfaces (tabs within pane):**
| Action | Shortcut |
|---|---|
| New Surface | `Ctrl+T` |
| Next Surface | `Ctrl+Shift+]` |
| Previous Surface | `Ctrl+Shift+[` |
| Select Surface 1-9 | `Alt+1...9` |

**Notifications:**
| Action | Shortcut |
|---|---|
| Jump to Unread | `Ctrl+Shift+U` |
| Show Notifications | `Ctrl+Shift+I` | cmux uses Cmd+I; Ctrl+I sends TAB in terminals, so we add Shift |
| Flash Focused | `Ctrl+Shift+H` |

**Browser:**
| Action | Shortcut |
|---|---|
| Open Browser | `Ctrl+Shift+L` |
| Browser DevTools | `Ctrl+Alt+I` |
| Browser Console | `Ctrl+Alt+C` |

**Terminal:**
| Action | Shortcut |
|---|---|
| Find | `Ctrl+F` |
| Copy Mode | `Ctrl+Shift+M` |
| Copy | `Ctrl+Shift+C` |
| Paste | `Ctrl+Shift+V` |
| Font Size +/- | `Ctrl+=` / `Ctrl+-` |
| Reset Font Size | `Ctrl+0` |

**General:**
| Action | Shortcut |
|---|---|
| Settings | `Ctrl+,` |
| Command Palette | `Ctrl+Shift+P` |
| Open Markdown Panel | `Ctrl+Alt+M` |

All shortcuts fully rebindable.

### Command Palette (`Ctrl+Shift+P`)

A fuzzy-search overlay (similar to VS Code's) that provides quick access to:
- All keyboard shortcut actions (by name)
- Workspace switching (type workspace name)
- Theme switching
- Shell selection for new workspaces
- Settings navigation
- Recent notifications

Rendered as a centered overlay with text input, filtered results list, and keyboard navigation (up/down arrows, Enter to select, Escape to close).

---

## 14. Project Structure

```
wmux/
├── package.json
├── tsconfig.json
├── electron-builder.json
├── .gitignore
├── README.md
├── src/
│   ├── main/
│   │   ├── index.ts                # app entry, window creation, menu
│   │   ├── window-manager.ts       # multi-window lifecycle
│   │   ├── pty-manager.ts          # node-pty spawning & lifecycle
│   │   ├── pipe-server.ts          # named pipe server (V1 + V2)
│   │   ├── port-scanner.ts         # netstat-based port detection
│   │   ├── git-poller.ts           # git branch + dirty detection
│   │   ├── pr-poller.ts            # gh pr view polling
│   │   ├── notification-manager.ts # toast + taskbar flash
│   │   ├── session-persistence.ts  # save/restore state
│   │   ├── config-loader.ts        # Windows Terminal + Ghostty parsing
│   │   ├── theme-loader.ts         # 450+ bundled themes
│   │   ├── shell-detector.ts       # auto-detect shells
│   │   ├── ipc-handlers.ts         # contextBridge registration
│   │   └── updater.ts              # auto-update
│   ├── renderer/
│   │   ├── index.html
│   │   ├── index.tsx
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Sidebar/
│   │   │   │   ├── Sidebar.tsx
│   │   │   │   ├── WorkspaceRow.tsx
│   │   │   │   ├── UnreadBadge.tsx
│   │   │   │   ├── PrStatusIcon.tsx
│   │   │   │   ├── WorkspaceContextMenu.tsx
│   │   │   │   └── SidebarResizeHandle.tsx
│   │   │   ├── SplitPane/
│   │   │   │   ├── SplitContainer.tsx
│   │   │   │   ├── SplitDivider.tsx
│   │   │   │   ├── PaneWrapper.tsx
│   │   │   │   └── SurfaceTabBar.tsx   # tab bar for multiple surfaces in a pane
│   │   │   ├── Terminal/
│   │   │   │   ├── TerminalPane.tsx
│   │   │   │   ├── NotificationRing.tsx
│   │   │   │   ├── UnfocusedOverlay.tsx
│   │   │   │   ├── FindBar.tsx
│   │   │   │   └── CopyMode.tsx
│   │   │   ├── Browser/
│   │   │   │   ├── BrowserPane.tsx
│   │   │   │   ├── AddressBar.tsx
│   │   │   │   └── DevToolsToggle.tsx
│   │   │   ├── Markdown/
│   │   │   │   └── MarkdownPane.tsx
│   │   │   ├── Titlebar/
│   │   │   │   └── Titlebar.tsx
│   │   │   ├── CommandPalette/
│   │   │   │   └── CommandPalette.tsx
│   │   │   └── Settings/
│   │   │       ├── SettingsWindow.tsx
│   │   │       ├── SidebarSettings.tsx
│   │   │       ├── WorkspaceSettings.tsx
│   │   │       ├── TerminalSettings.tsx
│   │   │       ├── NotificationSettings.tsx
│   │   │       ├── BrowserSettings.tsx
│   │   │       ├── KeyboardSettings.tsx
│   │   │       └── ShortcutRecorder.tsx
│   │   ├── store/
│   │   │   ├── index.ts
│   │   │   ├── workspace-slice.ts
│   │   │   ├── split-slice.ts
│   │   │   ├── surface-slice.ts        # surface state per pane
│   │   │   ├── notification-slice.ts
│   │   │   ├── settings-slice.ts
│   │   │   └── terminal-slice.ts
│   │   ├── hooks/
│   │   │   ├── useTerminal.ts
│   │   │   ├── useSplitPane.ts
│   │   │   ├── useKeyboardShortcuts.ts
│   │   │   └── useIpc.ts
│   │   └── styles/
│   │       ├── global.css
│   │       ├── sidebar.css
│   │       ├── terminal.css
│   │       ├── browser.css
│   │       ├── markdown.css
│   │       ├── command-palette.css
│   │       ├── settings.css
│   │       └── titlebar.css
│   ├── preload/
│   │   └── index.ts
│   ├── cli/
│   │   └── wmux.ts
│   └── shell-integration/
│       ├── wmux-powershell-integration.ps1
│       ├── wmux-bash-integration.sh
│       └── wmux-cmd-integration.cmd
├── resources/
│   ├── icons/
│   ├── themes/                     # 450+ Ghostty themes
│   └── sounds/
└── tests/
    ├── unit/
    └── e2e/
```

**Build tooling:** Vite (renderer), electron-builder (packaging), electron-updater (auto-update)

**Key dependencies:** electron, node-pty, @xterm/xterm, @xterm/addon-webgl, @xterm/addon-fit, @xterm/addon-web-links, @xterm/addon-search, @xterm/addon-unicode11, @xterm/addon-image, react, react-dom, zustand, vite, electron-builder, electron-updater, marked (markdown rendering)
