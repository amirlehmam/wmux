# wmux — Development Guide

Electron-based Windows terminal multiplexer for AI agents. TypeScript, React 19, Zustand, xterm.js, node-pty.

**Owner**: amirlehmam (GitHub) — speaks French, prefers fast pragmatic solutions, tests live.
**Repo**: github.com/amirlehmam/wmux | **Site**: wmux.org (Netlify, static from `site/`)

---

## Build & Dev

```bash
npm run dev            # Vite (port 5199) + Electron hot-reload
npm run build:main     # tsc main/preload/cli only (fast iteration)
npm run build:renderer # Vite production build: BOTH entries (desktop index.html + remote/index.html), writes dist/renderer/remote-manifest.json (the console server refuses to serve without it)
npm run build          # Full: tsc + vite + electron-builder
npm test               # Vitest unit tests
npm run test:watch     # Vitest watch mode
npm run lint           # ESLint src/
```

### Known Build Gotcha

Project lives in `OneDrive - Pulsa` (path with spaces). This breaks:
- `npm link` / `node-gyp` (can't build node-pty)
- `electron-builder` winCodeSign (symlink errors)

Releases are built by CI on a clean path, so this only affects local builds.

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
  wmux-orchestrator/  Claude Code plugin — DEPRECATED, no longer installed (#239)
site/             Landing page (static HTML, Netlify)
tests/            Unit + e2e (Vitest)
docs/             Planning docs
```

### Main Process (`src/main/`)

One line per module: what it is for, plus any rule that code in other files must follow. The design notes, and the history behind them, are in the module's own comments, starting with its header (for `remote-console/`, its own `AGENTS.md`). Read them before changing the module.

| File | Role |
|------|------|
| `index.ts` | Entry point, AppUserModelId, auto-save (30s), pipe server startup, V2 pipe handlers (workspace/pane/surface/markdown/sidebar/notification) |
| `git-worktree.ts` | Git worktree workspaces (#366): creates a checkout on a new branch under `%LOCALAPPDATA%\wmux\wt`; only the close dialog may remove one, never any other close path |
| `pty-manager.ts` | PTY lifecycle (create with surfaceId, write, resize, kill) and shell-spec resolution, including a Store PowerShell's App Execution Alias (#299) |
| `pty-crash-guard.ts` | Keeps a node-pty error from killing main and every pane (#150); must be installed at module load, before the first `pty.spawn` |
| `pipe-server.ts` | Named pipe `\\.\pipe\wmux`: V1 text (shell hooks) and V2 JSON-RPC (CLI/agents); one request per connection, closed with `destroy()`, never `end()` |
| `cdp-bridge.ts` | Browser webview control via Chrome DevTools Protocol |
| `cdp-proxy.ts` | CDP WebSocket proxy and probe endpoints for the browser panel; it impersonates Chrome, so its routes accept what real Chrome accepts |
| `browser-keep-rendering.ts` | Leases that keep a hidden browser surface painting while an agent drives it; hidden panes must use `visibility`, never `display: none` |
| `cdp-browser-domain.ts` | The browser-level CDP protocol (`Target.*`, `Browser.*`), answered by wmux over its single page so puppeteer and chrome-devtools-mcp can connect (#237) |
| `agent-browser-cli.ts` | Finds the `agent-browser` binary and runs it with `spawn` resolved on exit, never `execFile` and never a `.cmd` shim |
| `agent-browser-verbs.ts` | Pure wmux browser verb → agent-browser argv table, and where the one engine divergence (`wait` drops its timeout) is recorded |
| `agent-browser-session.ts` | surfaceId → ephemeral agent-browser session name and wmux-allocated stream port; only `isWmuxSessionName` decides what wmux may close |
| `agent-browser-daemon.ts` | Refcounts the agent-browser dashboard by live agent-mode surfaces, and never stops a dashboard it adopted rather than started |
| `agent-browser-runtime.ts` | The single `SessionRegistry` and `DashboardDaemon` plus their impure hooks and teardown; never construct another, and take dashboard refs only here |
| `dashboard-content-type.ts` | Relabels the agent-browser dashboard's octet-stream deep-link response as `text/html`, so restoring an agent-mode pane opens no Save dialog (#269) |
| `agent-spawn-target.ts` | Which (pane, workspace) pair a spawn means (#242): a named pane is authoritative, else the named workspace, else the caller's, else the active one; pane and surface lookups ask every window |
| `agent-manager.ts` | Agent PTY spawning and round-robin distribution across panes; the agent command is a `startupCommands` entry that PtyManager delivers |
| `startup-commands.ts` | When a startup command may be typed into a shell with no init seam (#251). PtyManager owns delivery; no caller may type startup commands itself |
| `git-bash.ts` | What a bare `bash.exe` / `git-bash.exe` spec means (#252): an honest PATH bash, else Git for Windows' `binash.exe` with its login flags; the WSL launcher only as the last resort |
| `remote-console/*` | The phone Remote Console (#254): watch and answer agent panes from a phone browser. **Off by default, loopback by default.** Before changing anything here, read `src/main/remote-console/AGENTS.md`: the seven invariants (I1–I7), the lazy-loaded runtime, teardown on `will-quit`, and the binding replay |
| `pty-keys.ts` | Named key → raw PTY bytes, shared by `surface.send_key`, the `pane.answer_agent` writer and the phone key bar so all three type the same bytes (#254) |
| `window-manager.ts` | Electron BrowserWindow creation/management |
| `ipc-handlers.ts` | All IPC channel handlers |
| `claude-context.ts` | Writes and removes the Claude Code integration: wmux skill + CLAUDE.md stub, hooks, the chrome-devtools MCP entry, and the deprecated orchestrator's cleanup |
| `agent-integration.ts` | Consent gate for every write outside `%APPDATA%\wmux` (#132); the agent `*-context.ts` writers are never called from startup directly, only through here |
| `kiro-context.ts` | Kiro CLI support (#148): writes wmux's own global steering file `~/.kiro/steering/wmux.md`; no hooks, since Kiro's are per-project |
| `grok-context.ts` | Grok Build support: a hooks file mirroring the Claude hooks byte for byte, and a rules file only when Grok won't read CLAUDE.md; runs after `ensureClaudeContext` |
| `opencode-context.ts` | Installs the OpenCode plugin and AGENTS.md block; `wmux.js` must export only `WmuxPlugin` + the default, and any plugin change needs a version-marker bump |
| `pi-context.ts` | Pi instructions and status reporting share `~/.pi/agent/extensions/wmux/index.js`, with independent consent. Only wmux sessions receive compact rules; `reference.md` beside it holds the on-demand command guide. Settings changes need Pi `/reload` or restart |
| `claude-observer.ts` | Monitors Claude Code activity for sidebar display |
| `claude-resume.ts` | `claude --resume` on restore (#186): stamps session ids into session.json; ids validated at `reportAgentSession` and in the renderer, never recorded on `SessionEnd` |
| `codex-launcher.ts` / `codex-resume.ts` | Codex restore (#261): a PATH shim + app-server relay capture the thread id. Off = no shim, no `where codex.exe`; PowerShell gets only the `.ps1`; relay loads lazily |
| `opencode-resume.ts` | OpenCode restore (#290) as `opencode -s <id>`; strict `ses_<base62>` / `ses_loop_<base62>` ids from wmux's plugin (no subagent sessions; remote/shared servers are captured by the TUI half when installed); release refused while wmux quits |
| `agy-resume.ts` / `agy-context.ts` | Antigravity CLI restore as `agy --conversation <id>`, via wmux's own agy plugin; released when the shell returns to its prompt (refused for an out-of-sequence prompt or while wmux quits) |
| `qwen-context.ts` / `qwen-resume.ts` | Qwen Code at Claude parity: wmux block, hooks and browser MCP in `$QWEN_HOME`, restore as `qwen --resume <id>`; hook commands unquoted where possible (through a stub in `$QWEN_HOME`) and tagged `--provider qwen` |
| `pi-resume.ts` | pi restore (#382) as `pi --session <file>`; `isValidPiSessionFile` guards report, prune and renderer; `PiSeqGate` stops a late report outliving a quit |
| `agent-state.ts` | Declared agent run state (#128): blocked/working/idle, run refcount, `seq` dedupe, metadata TTL, plus the answer back-channel (answering never clears `blocked`) and resumable session handles (a PTY exit keeps them) |
| `agent-state-rpc.ts` | `pane.report_agent` & friends, routed off the main V2 switch |
| `awake-manager.ts` | Keep Windows awake (#363): one `powerSaveBlocker`, modes smart/always/off, owned and persisted by main; renderers read it via `awake.getState`, never a copy |
| `agent-hook-bridge.ts` | Claude Code hooks → declared state, so it works with no plugin to install |
| `quit-sequence.ts` | When quit may let the process leave (#214): drain ConPTY exit callbacks, then `app.exit()`, so a quit with live PTYs cannot crash in Node's teardown |
| `close-guard.ts` | Opt-in "ask before the window closes" (#227), pref `confirmAppClose`: the allow/ask/swallow decision; quits, relaunches and programmatic closes never prompt |
| `gpu-watchdog.ts` | Self-heal for a wedged GPU process (#229): main decides on the renderer's rAF-stall report and restarts the GPU process; the renderer never acts |
| `icon-cache.ts` | Stale taskbar icon (#137, #226): one notice after an icon change, and a user-confirmed Explorer restart that clears the icon cache |
| `changelog.ts` | Release notes in the app (#211): fetches GitHub `/releases`, caches every success in wmux's own dir, and falls back to that cache on any failure |
| `chromium-profile.ts` | Electron's userData (`%APPDATA%\wmux\chromium`) and its one-time migration (#282). wmux's own files: `getAppDataDir()`, never `app.getPath('userData')` |
| `workspace-manifest.ts`, `workspace-open.ts`, `workspace-scheduler.ts`, `workspace-trust.ts`, `workspace-manifest-v2.ts`, `wait-probes.ts`, `surface-env.ts` | Project-local workspace manifests (#284): validate, trust, schedule, open. No `--trust` flag; manifest commands never enter the store or session.json |
| `session-persistence.ts` | Auto-save/restore of window state: atomic `session.json` writes, named sessions, version-change backups and the scheduled `Auto-save …` snapshot ring |
| `session-flush.ts` | The last save before the last window closes or the app quits (#285): that close, or the quit, waits for each window's `session:save`, bounded to 1 s |
| `webview-prefs.ts` | The hardened prefs (and gesture-gated autoplay, #287) every browser-panel `<webview>` attaches with, applied from the HOST window's `will-attach-webview` |
| `browser-history-restore.ts` | Restores a browser pane's Back/Forward stack across a restart or split-tree remount (#315), via a sentinel `<webview>` src and three Electron events |
| `exit-watchdog.ts` | Arms a detached watchdog process at `will-quit` that ends a quit wedged in native teardown (#289). Never a .cmd or PowerShell helper |
| `renderer-recovery.ts` | Offers a window reload when the renderer hangs or dies (#289); PTYs live in main, so a reload reconnects every pane. Never automatic |
| `git-view.ts` | Main half of the read-only project Git view (#362): worktrees, changes, branch diff and commit graph over the `git:view` IPC channel |
| `port-scanner.ts` | Active port detection for running dev servers |
| `powershell-shim.ts` | The `wmux.ps1` gate (#154): its dir goes on PATH only after a probe script there has run in every installed PowerShell host |
| `node-runtime.ts` | Which binary can run a `.js` file (#187), handed to shells as `WMUX_NODE`; with `WMUX_NODE_ELECTRON` set it must run under `ELECTRON_RUN_AS_NODE=1` |
| `ssh-argv.ts` | Parses an ssh command line into what scp needs to reach the same host (#195). Pure, the single funnel for every detection source; null when unsure |
| `ssh-detect.ts` | Is this surface inside ssh, and where: managed, reported and probed layers; the process probe may only corroborate a session, never establish one |
| `remote-upload.ts` | scp/ssh argv construction and the transfer itself: `BatchMode=yes`, one private `/tmp/wmux-drop-<uuid>/` per batch, all-or-nothing |
| `remote-insert.ts` | What a paste or drop types into a terminal. Lives in main because every input to the decision does (clipboard, detector, filesystem, scp, config). Quoting is per-side: Windows-conditional locally, always single-quoted for a remote sh |
| `clipboard-image.ts` | A pasted image as a PNG, fast (#381): the pure downscale to what Claude Code keeps (`fitImageSize`) and a level-1 PNG encode off the main thread (`encodeBgraPng`) |
| `win32-process.ts` | One `Get-CimInstance Win32_Process` invocation for both the orphan reaper and the ssh probe. Shared so the security-relevant part — resolving `powershell.exe` by ABSOLUTE path, so a writeable PATH dir cannot shadow it — is stated once |
| `system32.ts` | Absolute paths to Windows-owned tools that a user-writable PATH entry must not shadow, including the Windows OpenSSH a bare `ssh` spec resolves to |
| `shell-context-menu.ts` | "Open in wmux" Explorer verb — HKCU shell keys for Directory/Directory\Background/Drive, plus `directoryFromArgv` for the launch path. Win11 places it under "Show more options"; the modern menu needs a signed MSIX, which unsigned wmux cannot ship |
| `theme-loader.ts` | Theme loading |
| `explorer-fs.ts` | The file explorer's jailed directory listing, and `resolveInRoot`, the path jail every explorer and code read goes through; the renderer sends only relative paths |
| `explorer-roots.ts` | surfaceId → the explorer root for a pane: its terminal's reported cwd, normalized and realpath'd so main jails against one spelling |
| `terminal-file-link.ts` | What a Ctrl+click on a path printed in a terminal may open: the printed path goes through the explorer jail, and past it only markdown-whitelisted files |
| `code-file.ts` | Which files the code viewer reads and writes, and how. Not the security boundary: `code:read-file` applies `explorer-fs.ts`'s jail first |
| `file-grants.ts` | The single gate for every renderer→disk write (`markdown:save-file`, `code:write-file`): only a path opened into a live pane in this window and session through the jail, unchanged on disk since; the unjailed `markdown:read-file` never grants |
| `markdown-image.ts` | Local images in the markdown pane (#380), behind `markdown:read-image`: a `data:` URL, where the boundary is the file's type, not its location. Read-only |
| `config-loader.ts` | WT/Ghostty config import. Reachable from Settings → Terminal → Import. WT spells opacity two ways — modern `opacity` (0-100, independent of `useAcrylic`) and pre-1.12 `acrylicOpacity` (0-1, only with `useAcrylic`) |
| `shell-detector.ts` | Available shells detection |
| `updater.ts` | Auto-update, routed by install layout: NSIS → `electron-updater`, portable zip → `zip-updater.ts`, Scoop → a `scoop update wmux` dialog |
| `zip-updater.ts` | In-place update for portable zip extracts (#184): download, extract, then a detached cmd helper that waits for wmux to quit, copies over the install and relaunches. Detection keys on electron-builder's `Uninstall wmux.exe`, so renaming `productName`/`executableName` breaks it |

### Renderer (`src/renderer/`)

As in the main-process table: what each area or module is for, plus any rule other files must follow. The design notes are in the module's own comments. Read them before changing it.

**Components** (in `components/`):
- `SplitPane/` — PaneWrapper, SplitContainer, SplitDivider, SurfaceTabBar. `surface-label.ts` is the one tab-caption chain; `customTitle` is only for names a human chose. `use-osc-title.ts` is the single reader of a program's window title (#221), so its pref gate cannot differ between callers
- `Terminal/` — TerminalPane, FindBar, CopyMode, NotificationRing, ResetNotice and the prompt-log views (#207). Anything floating over the xterm container is `position: absolute`, never a flow sibling, or the PTY keeps its old row count and the bottom rows hide underneath (#82). `PromptsPane` is a surface rather than an overlay, so that rule does not apply to it
- `Browser/` — BrowserPane, AddressBar, AgentBrowserSetup. `utils/browser-start-page.ts` is the one rule for what a surface opens on when nobody said (#232): blank, never a page on the internet
- `Sidebar/` — Sidebar, WorkspaceRow, SessionMenu, SidebarResizeHandle. `workspace-status.ts` holds the three chains that must agree about one row (status words, status colour, state dot), so a priority added to one belongs in all three. `workspace-label.ts` is the row's name. Every UI place that names a workspace reads it through `use-osc-title.ts` (`useWorkspaceLabel(s)` / `getStoredWorkspaceLabel`), never `ws.title`; it is display only, and the CLI still answers the stored title
- `Titlebar/` — Titlebar, NotificationBell, NotificationPanel
- `Settings/` — SettingsWindow + per-category panels. `ChangelogSettings` (#211) shows notes from the network, so they only go through `renderMarkdown`, where DOMPurify runs
- `CommandPalette/` — CommandPalette
- `Markdown/` — MarkdownPane. `markdown-document.ts` and `markdown-hydrate.ts` add math, mermaid and local images (#380) as inert placeholders filled in after sanitizing. `renderMarkdown` stays without them because it also renders the changelog
- `Tutorial/` — Tutorial
- `Explorer/` — ExplorerPanel, ExplorerTree, and pure helpers kept out of the components so they are testable without a DOM. `explorer-diff.ts` is the `+N/-N` rollup and `use-explorer-diff.ts` its fetching and poll
- `Diff/` — DiffPane. The explorer opens it through `openDiffView` (`open-diff.ts`, #325), which pins the tab to the explorer's root
- `Git/` — GitPane, the project Git view (#362). Its review context lives on the surface, never on focus, so clicking into another agent's pane never moves it. Diffs render through `Diff/diff-render.tsx`, shared with DiffPane
- `Code/` — CodePane, the file view and its plain `<textarea>` editor

**Remote Console phone UI** (`renderer/remote/`, #254): a SECOND Vite entry (`remote/index.html`), served by main's console server and never loaded by the desktop window. Before changing it, read `src/renderer/remote/AGENTS.md`: the import-graph rule, the chunk it shares with the desktop window, `npm run dev` not serving it, and the mirror's clipping and key-bar rules.

**Hooks** (in `hooks/`):
- `useTerminal.ts` — xterm.js lifecycle, PTY connection, OSC notifications, WebGL renderer, OSC 133 prompt marks (#207), touch pan → wheel (#243)
- `utils/ime-composition.ts` — the IME composition view (#301)
- `utils/wheel-forward.ts` — how many app-level reports one scroll gesture is worth (#245)
- `utils/touch-pan.ts` — gesture recognition for a finger drag, which `useTerminal.ts` turns into a synthetic `WheelEvent` (#243)
- `utils/touch-fling.ts` — the physics of momentum after a touch flick (#248); the rAF driver is in `useTerminal.ts`
- `useKeyboardShortcuts.ts` — the shortcut actions and safe interception
- `utils/shortcut-binding.ts` — `claimsKeyEvent`, the one answer to "does wmux take this keystroke?" (#225). `useKeyboardShortcuts` and `useTerminal`'s key handler must both use it, or a key reaches nobody

**Pipe Bridge** (`pipe-bridge.ts`): exposes store operations as `window.__wmux_*` globals, which main calls through `executeJavaScript` for V2 pipe commands. The split tree lives only in the store, so main asks here for a surface's browser engine before routing a `browser.*` verb.

**Store** (Zustand, in `store/`):
- `workspace-slice.ts` — Workspace CRUD, split tree updates
- `surface-slice.ts` — Surface/tab add/close/move/navigate
- `settings-slice.ts` — Shortcuts, sidebar prefs, theme
- `notification-slice.ts` — Notification lifecycle (max 200)
- `agent-slice.ts` — Agent metadata tracking
- `osc-title-slice.ts` — surfaceId → the OSC 0/2 window title the pane's program set (#221). Never a `SurfaceRef` field, which would persist it into `session.json`
- `prompt-slice.ts` — Per-surface prompt log (#207). `line: null` means "not jumpable"; a view must never read it as line 0
- `prompt-actions.ts` — The prompt commands. The shortcut table and the command palette both go through it, because the palette hands an action it does not recognise to a `console.log`
- `split-utils.ts` — Immutable split tree helpers, plus `buildWorkspaceTree(panes, layout)` (#212): what a new workspace opens as

### Preload API (`window.wmux`)

```
pty:      create, write, resize, kill, has, onData, onExit
system:   platform, getShells, openExternal, toggleDevTools, pickFolder,
          getContextMenu, setContextMenu   # "Open in wmux" Explorer verb (HKCU)
config:   getTheme, getThemeList, importWindowsTerminal, importGhostty
metadata: onUpdate
notification: fire, onFocusSurface
browser:  navigate
agentBrowser: status, enable, disable, currentUrl, open, install
                                     # WHICH engine a browser surface runs on, not
                                     # what it does — the `cdp` verbs below act on
                                     # whichever engine a surface already has.
                                     # `{installed:false}` from enable is a normal
                                     # answer (show the setup card), not a failure.
                                     # currentUrl exists because the address bar was
                                     # lying: in agent mode the agent navigates the
                                     # real Chrome, so the last URL the PANE asked for
                                     # stops being true. open is its counterpart — the
                                     # pane used to reuse enable to mean "navigate",
                                     # re-acquiring the dashboard and re-binding the
                                     # stream on every address-bar Enter
agent:    list, status, onUpdate
gpu:      reportStall, onRestarted   # GPU watchdog (#229): the renderer reports
                                     # "no frames", main decides and restarts
changelog: get   # release notes (#211). Takes only a refresh flag — no repo,
                 # no URL, no token, so a compromised renderer cannot point it
                 # somewhere else. Its own namespace rather than a member of
                 # `update`: this answers "what changed", including in versions
                 # already installed, and works when there is no update at all
clipboard: writeText, readText    # no pasteImage since 1.12.0 — see remote below
remote:   resolvePaste, resolveDrop  # what should this gesture type? Main answers
                                     # the WHOLE question (clipboard read, ssh
                                     # detection, scp, quoting) because only main
                                     # can act on any of it. resolveDrop takes DOM
                                     # File objects, never path strings: accepting
                                     # paths would be an arbitrary local-file
                                     # upload API for a compromised renderer
remoteConsole: getState, setConfig, pairStart, pairCancel, revoke, revokeAll,
          rename, dismissRejectedOrigin, onState, onRendererRequest, replyRenderer
                                     # Settings → Remote (#254) — the ONLY place a
                                     # phone credential is minted (I2). Every invoke
                                     # answers {error:'unavailable'} when the runtime
                                     # did not load, never a throw. onState and
                                     # onRendererRequest return an unsubscribe;
                                     # replyRenderer answers a snapshot/modes request
hook:     onEvent
claudeActivity: onUpdate
agentState: onUpdate   # declared blocked/working/idle (issue #128)
session:  save, load, list, delete
cdp:      attach, detach
explorer: listDir, reveal, openInApp,  # a surfaceId and a RELATIVE path,
          diffStats, readMarkdown,     # never an absolute one — main derives
          resolveTerminalLink          # the root itself, or it is not a jail.
code:     readFile, writeFile
git:      view   # the project Git view (#362): one tagged read-only request, validated in main
                                       # diffStats takes ONLY a surfaceId (the
                                       # pre-#210 `diff:get-files` takes a cwd
                                       # and is deliberately not reused).
                                       # readMarkdown is the JAILED markdown
                                       # read and mints a save grant;
                                       # markdown.readFile is the unjailed one
                                       # and mints nothing. writeFile carries
                                       # the mtime the buffer was READ at —
                                       # omitting it doesn't force the write,
                                       # it removes the only thing standing
                                       # between two writers and silent loss.
                                       # resolveTerminalLink is the exception
                                       # that takes the path as PRINTED; main
                                       # jails it (see terminal-file-link.ts)
window:   create, close, focus, list, minimize, maximize, isMaximized, setProgress,
          setBackdrop, supportsBackdrop,    # window transparency (clear/acrylic/mica)
          closeSelf, isFrameless, relaunch  # clear mode is frameless: own caption
                                            # buttons, and the restart banner
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

### Keep-Alive Terminals (issue #346)
A split-tree change (split, close a sibling, zoom, drag a tab to another pane) remounts the
panes it moves. It used to rebuild their xterm too, so every piece of emulator state had to
be replayed by hand (#49 buffer, #164 mouse modes, #216/#256 ConPTY cursor row, #345 alt
screen) and markers, cursor style and scroll region were simply lost. Now `TerminalHost`
(mounted once in `App.tsx`) portals ONE `TerminalPane` per terminal surface into an element
owned by `components/Terminal/terminal-keepalive.ts`, and a pane renders only a
`KeptAliveTerminal` slot that the element is MOVED into. A slot-less terminal whose surface
still exists (the other panes of a zoomed workspace) is parked off-screen at its last pixel
size — a 0×0 fit would resize the PTY to 2 columns — with `visible:false`; it is disposed
only when its surface leaves the store. Two consequences to remember: React events from
inside a terminal bubble through the HOST, not the pane, so the leaf's click-to-focus is a
native listener on the slot (`onActivate`); and a same-commit move changes no prop, so
`attachGeneration` re-runs the show path (refit, repaint, refocus — removing the element
blurred its textarea). The snapshot/replay machinery stays as the fallback for a terminal
that genuinely is rebuilt on a live PTY (the root ErrorBoundary's retry; StrictMode and Fast
Refresh in dev). It snapshots only a surface still in the store and replays only into a
reused PTY: Load session keeps saved surface ids, so a closed pane's id can come back on a
fresh shell (`RemountSnapshotCache` in `utils/remount-snapshot.ts`).

### Split Tree
Pane layouts use an immutable binary tree (`SplitNode`). Each leaf = one pane with N surfaces (tabs).
Mutations go through `splitNode()`, `removeLeaf()`, `findLeaf()`, `getAllPaneIds()` in `split-utils.ts`.

### Prompt Boundaries — One Producer, Four Views (issue #207)

Highlighting a prompt, pinning it, anchoring the view at the start of an answer and
listing prompts as jump marks are four consumers of ONE fact: where a user prompt
starts. So there is one producer (`utils/prompt-log.ts`) and four independent,
individually-toggleable views — not four detectors.

The same parse has one non-view consumer: `handlePromptMark` reports A, C and D marks
to `utils/alt-screen-owner.ts` (#357), which uses those seen on the alternate buffer to
decide whether Reset terminal state may leave it. Reported whatever the prompt prefs say,
and through this parse — never a second OSC 133 handler.

Two sources feed it, **ranked and never merged**, the shape `ssh-detect.ts` uses:

| Source | Carries | Where |
|--------|---------|-------|
| `agent` | The prompt TEXT, verbatim | Claude Code's `UserPromptSubmit` hook → `wmux-hook.js` → pipe → `App.tsx`; since #304 also the OpenCode plugin's v2 prompt-admission hook → `wmux hook --prompt` → the same `App.tsx` handler; and the CLI-side (TUI) half's `session.inbox.enqueued` (remote/shared servers, #310) → the same CLI path |
| `shell` | A boundary, no text | OSC 133 (FinalTerm) from the shell integration → the xterm parser |

There is deliberately **no heuristic third source**. wmux stopped guessing agent state
from screen scraping in 0.39.0 (#128) and this does not reintroduce it: with neither
source present the log stays empty and every view is inert. That is the honest outcome —
a mis-detected boundary pins the wrong text and anchors the view to the wrong line, and
the user has no way to tell it happened.

Four things about this are easy to get wrong and expensive to rediscover:

- **`layer: 'bottom'` does NOT put a decoration under the glyphs, and cannot.** xterm
  gives its decoration container `z-index: 6` while the renderer's canvas is `z-index: 2`,
  so a decoration's DOM element always paints OVER the text; `layer` orders decorations
  against each other and nothing else. 2.4.0 tinted the prompt rows with a CSS
  `::before` on that element, which therefore had to sit at `opacity: .12` or it washed
  out the text it was pointing at — and at 12% over a terminal background every hue
  collapses to the same near-neutral grey. The colour picker in Settings → Prompts
  worked perfectly and looked completely broken; users reported it as "the rail is
  always grey whatever colour I pick". The tint is now the decoration's
  `backgroundColor`, which both renderers composite into the CELL background before
  drawing glyphs — the layer the CSS was only pretending to be on. Two consequences:
  the alpha must be **pre-blended in JS** against `terminal.options.theme.background`
  (xterm IGNORES the alpha channel there — `#ff2d5540` and `#ff2d55` paint identically),
  and the rail stays in CSS as the one element carrying the user's colour at full
  saturation. If you are ever tempted to style a decoration's background in CSS again,
  this is why it does not work.
- **The prompt text is read out of the BUFFER for a shell**, never sent over the pipe.
  Main already refuses to broadcast `report_command` to a renderer because a command
  line is where a credential reliably shows up (`index.ts`, the `report_command`
  hard-stop). The renderer is already displaying those bytes, so lifting them from the
  buffer adds no new crossing. Only the agent source sends text, and only because an
  agent TUI repaints over its own input box — nothing that reads the screen afterwards
  can recover it.
- **Markers survive a split-tree restructure since #346** — the xterm is no longer rebuilt
  (see Keep-Alive Terminals). Only a terminal that really IS rebuilt (the snapshot
  fallback) replays its buffer as serialized TEXT (`snapshotSurfaceBuffer`), which carries
  no markers; those prompts stay in the outline with `line: null` and a disabled jump,
  rather than scrolling the user somewhere arbitrary.
- **The anchor's pending-line count is NOT in the store.** It changes on every PTY chunk;
  a store write there re-renders every subscriber at PTY speed, which is the shape of
  #141. It lives in a module map like `surfaceMouseModes`, and the pill subscribes to a
  throttled DOM event.
- **A marker binds a highlight to a LINE, which is only the same as binding it to
  CONTENT for a shell** (#230, 2.10.5). A command row in scrollback is never rewritten;
  an agent TUI repaints its input box and status row over the same lines several times a
  second, and the submit-time cursor — the only line wmux has when `UserPromptSubmit`
  arrives — sits inside that region. `refineMark` gets out of it by finding the echoed
  row, but it MISSES on a prompt under `MIN_NEEDLE` or one the TUI reflowed, and the
  band then tinted `✳ Germinating… (1m 15s)`. So the tint is a claim about text, checked
  before registering AND in `onRender` — which fires when a row is laid out and only
  then, so scrollback costs nothing and a timer would be #141. A failed check drops the
  tint and the rail, keeps the ruler tick, and an *uncheckable* prompt falls back to what
  its SOURCE can promise (`confirmed`: true for OSC 133, false for an agent's guess). The
  match is stored as an OFFSET from the marker so the re-check is one row; termination is
  structural, not a retry count — the degraded re-apply registers no `onRender`.
  `refreshHighlights` also runs on resize, and not because the marks die: xterm 6 reflows
  markers with their content (verified — narrowing 80→40 moved `marker.line` 20→40 still
  pointing at the same text). It is the decoration that goes stale, since its `width` was
  `terminal.cols` at registration time.

Defaults: `highlight` and `anchor` ON, `pin` OFF (it costs vertical space), `outline`
available but closed, and `anchorScope: 'agent'` — anchoring applies to AGENT answers
only. That last one is the load-bearing default: a shell following its own output is
not the problem #207 describes, it is what every terminal has done for forty years, and
silently holding `npm run build` back from streaming reads as a freeze rather than as a
feature. `'all'` opts shell command lines in.

Governed by `promptDefaultRev` — changing any of them later needs a rev bump plus a
`PROMPT_PROMOTIONS` entry, or it reaches nobody (prefs persist as whole blocks). Adding
a NEW field is free (`{...DEFAULTS, ...stored}` fills it in); only changing an existing
default needs the rev.

**The outline has two presentations, and `outlineMode` picks which one the command
opens.** `'overlay'` is the docked panel from 2.4.0 — it floats over the terminal it
lists, which is right for a glance and wrong for anything you keep open, because it
covers the output it is describing. `'pane'` opens a `prompts` SURFACE instead, which
lives in the split tree and so splits, resizes and persists like any other pane.
`'overlay'` stays the default: a preference that silently changes what an existing key
does is a bug report. Both are always reachable — the tab bar's `+` menu and
`wmux new-surface --type prompts` make a pane regardless of the setting, and
`outlineSide` is greyed out under `'pane'` because the split tree already decides that.
Neither is a second implementation: both read the same per-surface prompt log and jump
through the same marks.

**Anchoring is armed before it is engaged, and the distinction is the whole design.**
A prompt is submitted at the BOTTOM of the buffer, so its line is `>= ydisp`.
`scrollToLine` on such a line takes xterm's "already at the bottom" branch: it sets
`isUserScrolling = false`, clamps, and does not move. The next write then scrolls, and
`BufferService` does `if (!isUserScrolling) ydisp = ybase` before firing `onScroll` — so
a naive listener sees `viewportY === baseY`, reads it as "the user caught up", and
releases. Every time, on the first line of output. The first implementation did exactly
that and the feature held nothing; the tests missed it because the fake terminal let
`scrollToLine` move the viewport anywhere. So: **armed** = recorded but the prompt is
still on the last screen and nothing is hidden; **engaged** = the buffer has grown past
it and the viewport is genuinely held. The release-on-bottom rule applies only while
engaged. `tests/unit/prompt-anchor.test.ts` models xterm's real clamp and its
fill-the-screen-then-grow-baseY behaviour, and pins this.

The anchor holds a **resolver**, not a line number: an absolute buffer line stops meaning
the same row once the scrollback fills and lines are trimmed off the top. The prompt's
xterm marker tracks that; a snapshot does not. A resolver answering null (the marker
died) is the anchor's cue to let go rather than hold a row that no longer exists.

---

## Release Process

CI builds and publishes every release when a `v<version>` tag is pushed (`.github/workflows/release.yml`): the NSIS installer, the portable zip and `latest.yml`. Never build or upload one by hand, and never dispatch the workflow to test: every run publishes. The `wmux-release` skill (`.agents/skills/wmux-release/SKILL.md`) covers the version bump and tag, what each CI gate checks, release notes and the Scoop bucket, what to do when a run fails, packaging changes, and checking that a fix shipped.

---

## Named Pipe V2 Handlers

The pipe server in `index.ts` handles V2 JSON-RPC methods. Most delegate to the renderer via `executeJavaScript('window.__wmux_*(...)')`. The renderer's `pipe-bridge.ts` exposes Zustand store operations as these globals.

**Fully implemented V2 methods:**
- `system.identify`, `system.capabilities`, `system.tree`
- `workspace.create`, `workspace.close`, `workspace.select`, `workspace.rename`, `workspace.list`, `workspace.current`
- `pane.split`, `pane.close`, `pane.focus`, `pane.zoom`, `pane.list`
- `layout.grid`, `layout.agents` — both bridged by `v2-bridge.ts`. `layout.agents` (#255) splits ONLY the anchor's pane into `[anchor | worker grid]` (`buildAgentLayout` in `split-utils.ts`, anchor and size resolved by `store/agent-layout-target.ts`), where `layout.grid` rebuilds the whole workspace. It is the one bridge spec with a `validate`: a bad `count` (1-16) or a non-finite `coordinatorRatio` is -32602 from main before any window is looked up, because a renderer that received `count: null` would have to guess. The CLI side (`layoutAgentsParams`) goes through `parseFlagArgs` like `layout grid`
- `surface.create`, `surface.close`, `surface.focus`, `surface.rename`, `surface.list`
- `surface.send_text`, `surface.send_key`, `surface.read_text`, `surface.trigger_flash`
- `surface.list_prompts` — the prompt log (#207). Diverges from `surface.read_text` on the multi-window lookup, deliberately: `read_text` can tell "this window does not own that terminal" from "the screen is blank" and so takes the first window that answers without an error, but a prompt log cannot — an unowned surface and a surface with nothing recorded both answer `[]`. So the targeted form takes the first NON-EMPTY answer, and the untargeted form MERGES across windows rather than reading the first reply, since "every tracked surface" is a fact about the app and each window keeps its own store
- `markdown.set_content`, `markdown.load_file`, `markdown.get_content`
- `notification.list`, `notification.clear`
- `sidebar.set_status`, `sidebar.set_progress`, `sidebar.log`, `sidebar.get_state`
- `browser.*` — routed per surface by its engine: `web` → the CDP bridge, `agent` → the agent-browser CLI. `engineForSurface` asks the RENDERER (the split tree lives in the Zustand store, main has no copy) and asks EVERY window, first affirmative wins — the surface may be in window 2, the #143 "window ≠ workspace" mistake. A renderer that has never heard of `__wmux_getBrowserEngine`, or a rejected `executeJavaScript`, answers `web`: this runs on the hot path of every browser command, where it previously did no renderer IPC at all. The engine is re-checked on **every** outcome of target resolution, not only when there was no wcId — a surface toggled web→agent keeps a valid CDP registration (nothing detaches on a toggle), so the null-branch-only shortcut drives CDP against agent-browser's own dashboard SPA and silently corrupts the pane the user is watching
- `browser.get_engine`, `browser.set_engine` — matched BEFORE the generic `browser.*` passthrough, or they fall into the verb switch and come back as `Unknown: browser.get_engine` (-32601). `set_engine` validates `web`/`agent` and refuses a surface that is not a browser surface
- `agent.spawn`, `agent.spawn_batch`, `agent.status`, `agent.list`, `agent.kill`
- `pane.report_agent`, `pane.report_agent_session`, `pane.report_metadata`, `pane.release_agent`, `pane.agent_state`
- `pane.answer_agent` — the back-channel (issue #128). The only non-`report_*` method: it WRITES into a pane's PTY. Guarded — refuses unless the pane is currently `blocked`, and only ever sends a payload the agent itself declared
- `hook.event`, `diff.refresh`
- `agent.subagent` — `wmux report-subagent` (#272): a declared subagent line under the caller's pane, upserted by id in `claude-observer.ts`. Display only — it never touches the declared blocked/working state. Claude Code subagents arrive the same way with no CLI call: `wmux-hook.js` forwards the payload's `agent_id`/`agent_type` (present only inside a subagent, and on the `SubagentStart` hook wmux now registers), and `applyHookLifecycle` tracks them by id. A declared subagent is ended ONLY by its own stop or `SessionEnd`, never by the parent's `Stop` — a background subagent outlives the turn that launched it, which is the whole bug. Ghost guard: a running declared line silent for `DECLARED_SUBAGENT_TTL_MS` (10 min) is not drawn
- `remote.status` — the Remote Console's ONLY pipe method (#254, I2), read-only: `{enabled, running, bind, port, publicUrl, deviceCount, connectedCount, lastError}`. Matched as the FIRST statement of `routeSpecialV2`, by exact name, and deliberately NOT in `PUBLIC_V2_METHODS`, so it needs the pipe token. Pairing, enabling, rebinding and revoking have no pipe method at all, on purpose — `tests/unit/remote-console-wiring.test.ts` pins that `index.ts` names exactly one `remote.` method

---

## wmux-orchestrator Plugin

**DEPRECATED in 2.12.0 (issue #239). wmux no longer installs this, and removes it if a previous version did.**

It never loaded: `ensurePluginRegistered()` wrote Claude Code's `installed_plugins.json` at the top level as an object, while that file is v2 (`{version:2, plugins:{"<plugin>@<marketplace>":[…]}}`) and its cache is `cache/<marketplace>/<plugin>/<version>`, not wmux's `cache/<plugin>/<version>`. Claude Code listed nothing, loaded no skill or command, and wrote `.orphaned_at` through the copied tree — while `enabledPlugins` said `true` and wmux logged an install. The supported repair is a local marketplace; it was not worth doing, because Claude Code now runs parallel agents natively.

The source still ships in `resources/wmux-orchestrator/` — `scripts/launch-agent.js` is the shared agent-command registry that `omp-context`/`pi-context` tests read, and the plugin remains installable standalone from `github.com/amirlehmam/wmux-orchestrator`. Unaffected by the deprecation: the sidebar orchestration panel (`orchestration-watcher.ts` reads a run's `state.json` and does not care who wrote it), `wmux agent spawn`, and the OpenCode plugin, which installs correctly and is what the `orchestrator` consent feature still controls.

**What it does:** Decomposes complex dev tasks into parallel Claude Code agents coordinated through dependency-aware waves with automated review. With wmux: each agent in its own visible terminal pane. Without wmux: falls back to native subagents.

**Plugin structure:**
```
resources/wmux-orchestrator/
  .claude-plugin/plugin.json    Manifest (name, version, author)
  skills/orchestrate/SKILL.md   Core: codebase analysis, wave planning, agent spawning. Invoked as
                                /wmux-orchestrator:orchestrate <task>; there is deliberately no command
                                of the same name (a command and a skill sharing it loop into each other)
  skills/reviewer/SKILL.md      Post-orchestration review and auto-fix
  skills/wmux-detect/SKILL.md   Detects wmux availability for degraded mode
  agents/wmux-worker.md         Worker template with file zone enforcement
  hooks/hooks.json              PostToolUse, SubagentStop, Stop, SessionStart
  scripts/json-tool.js          Node.js JSON helper (replaces jq)
  scripts/orchestration-state.sh  State file management library
  scripts/spawn-agents.sh       Creates panes (`layout agents`) + launches Claude Code agents
  scripts/reap-wave.sh          Kills a wave's agents and closes their tabs; also run by the Stop hook,
                                which reaps only a `complete` run whose recorded coordinator is the
                                hook's OWN pane (it fires in every session, workers included). Never
                                closes the caller's or the coordinator's surface; a failed close is
                                left unstamped so it is retried. failed/aborted runs: cleanup.sh only
  scripts/on-agent-stop.sh      Wave transition driver (core orchestration)
  scripts/check-status.sh       Markdown dashboard generator
  scripts/*.sh                  Other utilities (cleanup, collect-results, etc.)
```

**Key design:** Skills handle intelligence (prompts), hooks handle reactivity (events), scripts handle wmux operations (CLI). State shared via JSON file in TMPDIR. No daemon.

---

## CLI Reference

`wmux help` lists every command, and `wmux <command> --help` (or `wmux help <command>`) prints the usage text kept in `COMMAND_SPECS` in `src/cli/wmux.ts`. Read those rather than a copy here. The one verb that behaves differently on the two browser engines (`wmux browser wait <ref> [ms]` drops the timeout in agent mode) is documented at `KNOWN ENGINE DIVERGENCE` in `src/main/agent-browser-verbs.ts`.

---

## IPC Channels

Every channel is defined in `IPC_CHANNELS` in `src/shared/types.ts`; read the list there.

---

## Shell Integration

The scripts live in `src/shell-integration/`. `resources/shell-integration/` is a byte-identical mirror that `tests/unit/resources-sync.test.ts` enforces, so every edit is made in both. Before changing either, load the `wmux-shell-integration` skill (`.agents/skills/wmux-shell-integration/SKILL.md`). It covers what each script reports, the OSC 133 traps and the off-thread git report.

Env vars set by wmux in spawned shells: `WMUX=1`, `WMUX_SURFACE_ID`, `WMUX_PIPE`, `WMUX_CLI`,
`WMUX_NODE` (+ `WMUX_NODE_ELECTRON` when it is wmux's own binary — issue #187).

---

## Website (wmux.org)

Static site in `site/`. Deployed to Netlify (`netlify.toml` at repo root).

```bash
# Deploy
npx netlify deploy --prod --dir site
```

`site/index.html` — Landing page with i18n (21 languages, including RTL Arabic).
`site/i18n.js` — Language switching via URL hash (`#<code>`, e.g. `#ar`, `#fr`, `#pt`, `#ja`).

---

## Testing

```bash
npm test                    # Run all unit tests
npm run test:watch          # Watch mode
npx vitest run tests/unit/pty-manager.test.ts  # Single file
```

---

## Agent Skills

Task procedures live in repo skills, loaded only when a task matches. `.agents/skills/<name>/SKILL.md` is the source of truth, and Codex reads it there. `.claude/skills/` is a generated copy for Claude Code: edit `.agents/skills/`, then run `npm run sync:skills`. `npm test` fails while the two differ, and when a `SKILL.md` uses frontmatter outside the Agent Skills spec (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`), since the same file has to load in both agents.

---

## Conventions

- **State**: Zustand slices in `src/renderer/store/`, composed in `index.ts`
- **IPC**: Channels defined in `src/shared/types.ts`, never use magic strings
- **CSS**: `src/renderer/styles/`, class prefix per component (`.pane-wrapper__*`, `.surface-tab__*`)
- **Immutable trees**: Split tree mutations always produce new objects via `patchLeaf()`
- **PTY IDs = Surface IDs**: Always pass `surfaceId` when creating PTYs for reliable re-attachment
- **No MCP**: All Claude Code integration via CLI commands
- **French comms**: User communicates in French, code/docs in English
- **This file**: a module's design notes and post-mortems go in its own comments or the PR description, not here. Add text here only for a rule that crosses modules, and keep each module's entry to a short summary: what it is for, plus any rule other files must follow. Older entries outside the main-process table and the renderer list still carry notes; move them into the code when you touch one rather than adding to them
