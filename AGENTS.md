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
| `opencode-resume.ts` | OpenCode restore (#290) as `opencode -s <id>`; strict `ses_<base62>` ids from wmux's plugin (no subagent or shared-server sessions); release refused while wmux quits |
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

**Components** (in `components/`):
- `SplitPane/` — PaneWrapper, SplitContainer, SplitDivider, SurfaceTabBar. `surface-label.ts` is the one tab-caption chain (customTitle → agent spawn label → OSC window title → defaultTitle → cwd → shell). `defaultTitle` is a TEMPLATE’s name — a quick-launch profile, a manifest pane `title` (#291) — which used to be written into `customTitle` and so outranked the program’s own title forever; `customTitle` is reserved for names a human chose, and `use-osc-title.ts` is the single reader of that title so the tab bar and the split-drag preview cannot apply the pref gate differently
- `Terminal/` — TerminalPane, FindBar, CopyMode, NotificationRing, PinnedPrompt, PromptOutline, NewOutputPill (the three prompt-log OVERLAYS, #207 — all `position: absolute` over the xterm container, never flow siblings: a flow sibling is pushed out of the container's `height:100%` box WITHOUT firing the ResizeObserver, so the PTY keeps its old row count and the bottom rows hide underneath, which is issue #82). `ResetNotice` (#357) floats the same way: Reset terminal state's "kept the alternate screen, press again" notice, a `role="status"` region that stays mounted so its text is announced. Also `PromptsPane` — the outline as a `prompts` SURFACE rather than an overlay, and the one file here the #82 warning does NOT apply to, because it owns its whole box instead of floating over somebody else's. It is the same prompt log seen from elsewhere in the split tree, so unlike the overlay it has to be TOLD which terminal it lists: `promptSourceSurface` (the last terminal to hold focus, written by App.tsx) unless a `promptPaneLocks` entry pins it. Focus landing on a non-terminal deliberately does not update that, or clicking into the panel would blank the list the user just clicked on
- `Browser/` — BrowserPane, AddressBar, AgentBrowserSetup (the `not-installed` vs `no-dashboard` cards — two genuinely different situations, never one card: the second means the agent browser works fine and only its optional viewer is missing). `utils/browser-start-page.ts` holds the one rule about what a surface opens on when nobody said (#232). A browser surface defaults to **blank**, never to a page on the internet: shipping `https://github.com/amirlehmam/wmux` as `BrowserPane`'s default parameter meant the panel opened the project's own repo on every launch (`openOnStartup` is true by default) — and then the panel's `onUrlChange`, which fires for the INITIAL load too, wrote that default into `workspace.browserUrl` as if a human had picked it. Confirmed on a real install: two workspaces carrying a `browserUrl` nobody typed. GitHub puts "Issues" one click away, so one click pinned wmux's own issue tracker as the start page forever. The read-time filter applies to `workspace.browserUrl` ONLY — that is the one URL wmux opens without being asked; a split-tree browser tab's `surface.url` is written directly by `openInWmuxBrowser` on a link click, and filtering there would blank a pane opened on wmux's issue tracker on purpose. `browserPrefs.defaultUrl` is never filtered: a configured start page is a choice, a remembered one is an inference. The blank state is a themed overlay rather than a bare `about:blank`, which paints WHITE whatever the app theme is
- `Sidebar/` — Sidebar, WorkspaceRow, SessionMenu, SidebarResizeHandle. `workspace-status.ts` holds the THREE chains that must agree about one row — the status words, the status colour, and the state dot — and they have drifted apart twice, which is why they sit in one file beside each other rather than inside the component. The rule that keeps them honest is `mergedAgentSignals` (#235): the agent roster's counts **join** the older hook/observer signals rather than outranking them, so the priority chain stays one chain. Both halves of that matter. A rollup ranked above the tool label coarsens "Reading file…" into "Running…" every time the two agree, and `unknown` — which means "an agent is here and has not said what it is doing" — must fall THROUGH to the heuristics (#128), never over them: as its own priority level it printed the word "Unknown" on a row whose shell knew it was running, and blanked the dot. `unknown` therefore contributes to no count at all, and the invariant is pinned as a PARITY (a silent agent renders byte-identically to no agent) rather than as an expected string — anything a silent agent changes, it changed by overriding a finer signal it knows nothing about. `workspace-label.ts` is the row's NAME: a title wmux picked (`titleIsDefault` — `Workspace N`, a layout instance, the tab-derived name) gives way to the OSC title of a pane whose shown tab is a titled terminal — the first in tree order whose surface has an agent, else the first in tree order, so a shell's `MINGW64:/c/repo` cannot hide the conversation title of the agent beside it — behind `terminalPrefs.oscTitleWorkspaces`; any rename clears the flag, and a session saved before it existed keeps its names fixed. "Has an agent" is `hasAgentLookup`, the one definition: an identity (`agentIdentities`) OR a session the agent's hooks reported (`agentStates[id].sessionId`). The identity alone is too narrow — its `report_command` source is sent by both shell integrations for `ssh` only and the process probe sweeps only while ssh detection is awake, so a `claude` typed into an ordinary pane usually has none — while every Claude Code hook but SessionEnd carries `session_id`, and main clears it only when it forgets the pane (SessionEnd, PTY exit, `release-agent`). Never the declared or detected STATE: it changes every turn, and the name must not. Every UI place that names a workspace (palette, notifications, titlebar, Hub, layout-save default) reads it through `use-osc-title.ts` (`useWorkspaceLabel(s)` / `getStoredWorkspaceLabel`), never `ws.title`, and the agent roster carries it as `workspaceTitle` when its caller passes `rollupAgents` those labels (`selectWorkspaceLabels` outside React), which every caller that shows the name does — the banner, the navigator, the Hub and the phone's remote roster. Display only — `list-workspaces`/`current-workspace` still answer the stored title
- `Titlebar/` — Titlebar, NotificationBell, NotificationPanel
- `Settings/` — SettingsWindow + per-category panels. `ChangelogSettings` (#211) is the "read the release notes without googling wmux" tab, and is mounted only while selected so opening Settings for a font change never fires a GitHub request. Its notes go through the SAME `renderMarkdown` as MarkdownPane — that function is where DOMPurify runs, and this is the one place in wmux where the markdown came off the network
- `CommandPalette/` — CommandPalette
- `Markdown/` — MarkdownPane. The PANE renders through `markdown-document.ts` (#380), a second Marked instance adding `$…$`/`$$…$$` math (pandoc's rules, so "$5 and $10" stays prose), mermaid fences and local images as INERT placeholders whose payload is escaped text. They pass the same DOMPurify policy (`sanitizeMarkdownHtml`, shared with `renderMarkdown`), then `markdown-hydrate.ts` fills them: KaTeX with `trust: false`, mermaid with `securityLevel: 'strict'` shown as an `<img src=data:>` (never inlined SVG), images from main (`markdown-image.ts`). KaTeX and mermaid are dynamic `import()`s, loaded only by a document that has math or a diagram, so neither is in the desktop entry chunk or the phone closure. Diagrams are cached by (theme, source) and follow `data-ui-theme`. `renderMarkdown` itself is untouched because it also renders the changelog, where `$` is prose. KaTeX is pinned to the 0.18 line mermaid depends on, so the build carries one copy
- `Tutorial/` — Tutorial
- `Explorer/` — ExplorerPanel, ExplorerTree, plus the pure halves kept out of the component so they are testable without a DOM: `explorer-state.ts` (tree/expansion/per-root cache), `explorer-keynav.ts`, `explorer-errors.ts`, `open-preview.ts` (the preview-tab state machine) and `explorer-diff.ts` (the `+N/-N` rollup and agent attribution). `use-explorer-diff.ts` is the impure half of that last one — fetching, the poll and the hook subscription. The rollup is a FLAT map keyed on POSIX rel-paths covering every changed file **and every ancestor directory**, precisely because the tree lists directories lazily: a rollup that could only see loaded rows would report `src/ +12/-3` because that is the part the user happened to have expanded. The poll runs only while the panel is open AND the window is focused, and hook events (not the timer) are the primary freshness signal — `diff-provider` coalesces per-cwd, but coalescing bounds the damage of a fast poll rather than making one correct (#141)
- `Diff/` — DiffPane, plus `open-diff.ts` (#325): the explorer's change bar, a changed row's *View changes* item and its `+N/-N` cell open the Diff view through `openDiffView` — focus a Diff tab already looking at the explorer's root (its pinned `cwd`, else the workspace cwd it follows), or open one PINNED to that root via `SurfaceRef.cwd`, so two panes in two repos cannot show each other's changes. The file to select is a one-shot hand-off (pending map + `wmux:diff-select` event), never store state, because the tab may not have mounted yet
- `Git/` — GitPane, the project Git view (#362): a `git` surface PINNED to a folder through `SurfaceRef.cwd` when it opens (`open-git.ts` — the focused terminal's live cwd), with the review context on the surface too (`gitWorktree`, `gitBase`, `gitMode`, `gitGraphScope`), so clicking into another agent's pane never moves it. Worktree list in a sidebar, then three modes: Working (staged/unstaged/untracked/conflicted), Branch (three-dot vs a chosen base, default from `origin/HEAD` then develop/main/master), Graph (`git-graph-layout.ts`, pure lane assignment — lanes never shift sideways, a branch JOINS a lane already awaiting the same parent; Ctrl+click compares two commits). Diffs render through `Diff/diff-render.tsx`, the parser and hunk markup shared with DiffPane. *Go to terminal* is `worktree-terminals.ts`: a terminal belongs to the DEEPEST worktree containing its cwd (linked worktrees usually live inside the main tree), with Git Bash `/c/` and WSL `/mnt/c/` spellings folded; it asks App through the `wmux:focus-surface` document event, because the focused pane is App state. `useGitQuery` keeps the last good answer when a refresh fails, so one slow git call never blanks the view or drops a selection. Polls every 4 s only while visible; branch and graph refetch on a new HEAD or the ↻ button, not on every tick. Opened by Ctrl+Alt+G (`openGitPanel`), the tab bar `+` menu, the explorer header's ⑂ button, or `wmux new-surface --type git`
- `Code/` — CodePane, the file view with a line-numbered gutter, editable since 2.7.0. Its header used to say read-only was a property of the component's SHAPE rather than a flag; that is rewritten rather than left to mislead. The editor is a plain `<textarea>` — **not** CodeMirror or Monaco, which roughly doubles a desktop renderer that already loads ~2 MB of JS (index-*.js plus the chunk it shares with the phone UI) to serve "edit a thing or two". `draft === null` IS the read-only mode, rather than a boolean beside the text that can disagree with it. Edit mode drops the line-number gutter on purpose: keeping numbers aligned against a textarea means matching its font metrics, padding, scroll position and wrapping exactly, and any drift points the numbers at the wrong lines

**Remote Console phone UI** (`renderer/remote/`, #254): a SECOND Vite entry (`remote/index.html`), served by main's console server and never loaded by the desktop window. Before changing it, read `src/renderer/remote/AGENTS.md`: the import-graph rule, the chunk it shares with the desktop window, `npm run dev` not serving it, and the mirror's clipping and key-bar rules.

**Hooks** (in `hooks/`):
- `useTerminal.ts` — xterm.js lifecycle, PTY connection, OSC notifications, WebGL renderer, OSC 133 prompt marks (#207), touch pan → wheel (#243)
- `utils/ime-composition.ts` — the IME composition view (#301). xterm draws a composition as a flat `#000/#FFF` block with no position in it; Chromium applies the IME's own SELECTION to xterm's textarea on every update (a caret for Bopomofo/Hangul, a range for an IME that selects its clause), so the view is redrawn from it — theme colours, underlined like conhost, caret or selected range visible. It redraws on `input`/`selectionchange`/`keyup` plus a 0 ms timer after `compositionupdate`, because xterm resets `textContent` on `compositionupdate` BEFORE the textarea changes, and a selection-only move fires no `input`. It never guesses a "target character": TSF clause attributes reach a page only through EditContext `textformatupdate`, and which character a caret means differs per IME. Verified against real xterm in Electron's Chromium by CDP `Input.imeSetComposition` — which only lands after a real `Input.dispatchMouseEvent` click on the webview (a DOM `focus()` plus focus emulation is not widget focus)
- `utils/wheel-forward.ts` — how many app-level reports one scroll gesture is worth (#245). The two forwarding branches speak **different units**, and conflating them was the bug: a mouse report is a STEP (the app decides how far a step goes — opencode's `scroll_speed`, 3 rows by default) while an arrow key IS one line and nobody scales it. `writeWheelToPty` emitted one report per LINE for both, and a Windows detent is ~100px of `deltaY` against a ~17px cell, so one detent became 5-6 reports and then 15-18 rows — ~5x every other terminal. Users worked around it by dropping `scroll_speed` to 0.25, which fixed the wheel by breaking the touch pan that shares the multiplier. So a mouse-tracking app now gets exactly **one report per wheel EVENT** and the line count is demoted to a gate ("did this cross a line at all?") — which is what xterm does: in `Terminal._bindMouse`, `case 'wheel'`, `consumeWheelEvent()` is only tested against 0 before a single `triggerMouseEvent`. The arrow branch keeps looping per line, and that is a **deliberate divergence** from xterm (which sends one arrow per event there too), not an oversight: wmux's own scrollback branch moves `lines` rows per event, so one arrow per detent would make a pager in an alt-screen pane crawl at a fifth of the speed of the scrollback in the pane beside it. #245 was the multiplier, and the arrow branch has none. **Touch keeps per-line reporting** — a finger is a position, not a detent, and deriving pan speed from a per-event report would tie it to the frame rate; wmux cannot know the app's rows-per-report multiplier, so one report per cell crossed is the closest it can get and is exact wherever that multiplier is 1. Where it is not (opencode's `scroll_speed` 3 outruns the finger, #267) the PAN has a gain: `terminalPrefs.touchPanGain` / `[terminal] touch-pan-gain`, reports per cell, default 1, with the fraction carried per surface (`touchPanReports`). It applies only to a pan forwarded to a mouse-tracking app — never to scrollback or the arrow branch, and never to the FLING, which is a third `WheelSource` (`'fling'`) precisely so the gain cannot shorten a glide whose distance was tuned in #248. The source is carried on the synthetic event by a private `Symbol` in `useTerminal.ts`, NOT by `ev.isTrusted`: trust answers "who dispatched this" rather than "what gesture is this", so the next synthetic wheel from anywhere else would silently inherit touch semantics — and a real-Chromium harness confirms both synthetic events read `isTrusted: false`, so trust is not even observable in a test. Pure, because the count is invisible in a screenshot and the machine that reproduces it is a touchscreen ThinkPad
- `utils/touch-pan.ts` — a finger dragged over a pane scrolled nothing (#243). Upstream: xterm 6.0.0 replaced its native overflow scroller (a finger could drag it) with the VS Code `SmoothScrollableElement`, a wheel-only overlay, and shipped no touch replacement (xtermjs/xterm.js#5489); the fix, #5563, is milestoned 7.0.0 and in no stable release. **A dependency bump would not have been the fix**, and this is the part worth keeping: upstream's repair only moves the scrollable position, which drives SCROLLBACK, and the alternate buffer has none — so a finger would still be inert in exactly the panes wmux exists to show (opencode, Claude Code, Codex all switch to `\x1b[?1049h`). wmux does not use xterm's wheel pipeline at all: `handleTerminalWheel` takes the wheel on the CAPTURE phase and already decides between scrollback, SGR wheel reports and arrow keys for a pager on the alt screen. So the whole fix is to put the gesture into that pipeline as a **synthetic `WheelEvent`** and inherit all three behaviours rather than re-derive any. That is also why this module measures nothing in cells — `wheelDeltaToLines` already keeps a per-surface fractional accumulator against the user's measured cell height, and a second one here would be a second answer to one question. What is left is gesture recognition, and it is pure because the machine that reproduces the bug (a touchscreen ThinkPad) is not the one CI runs on. States mirror the prompt anchor's armed/engaged split for the same reason: the interesting ones are before the feature acts — `tracking` (a finger is down but inside the 8px slop, so it may still be a tap, and a tap must never scroll), `panning`, `rejected` (broke out sideways, or a second finger landed). The axis lock is decided ONCE at slop-crossing and never revisited, or a diagonal drag flickers between scrolling and not. Direction is natural: dragging down reveals what is above, which is a NEGATIVE delta. POINTER events, not Touch events — Electron delivers those reliably while the Touch Events API may not be enabled — and `touch-action: none` on `.terminal-pane__container` is the other half of the fix: with anything else Chromium claims the vertical drag as its own scroll gesture and the pointermove stream stops being cancelable. `pointercancel` must be handled or the tracker keeps a finger down forever and the feature works exactly once. Verified against a real xterm 6.0.0 in real Chromium via a browser harness (the #230 technique), because a capture-phase listener receiving an event dispatched on its OWN element is the load-bearing assumption and no unit test proves it
- `utils/touch-fling.ts` — momentum after a touch flick (#248), the pure physics half; the rAF driver is in `useTerminal.ts` beside the pan. A fling is a pan that CONTINUES: its per-frame deltas go out through the same touch-tagged synthetic `WheelEvent` the pan dispatches, so scrollback, SGR reports and alt-screen arrows are inherited and fractional pixels land in `wheelDeltaToLines`' accumulator rather than a second one. Release velocity is a least-squares slope over the last `VELOCITY_WINDOW_MS` (100) of samples taken only while the pan is COMMITTED — never the last two samples, since the move before a lift is usually tiny noise. No fling if the finger paused > 80 ms before lifting, below 0.25 px/ms, on a pointercancel, or unless the tracker went panning → idle (a pinch never flings). Capped at 4 px/ms, decays `exp(-t/325ms)`, stops under 0.02 px/ms. Each step integrates the exponential EXACTLY (`v·τ·(1−e^(−dt/τ))`), which is what makes 60 Hz and 120 Hz carry a flick the same distance — Euler would not. A frame gap > 100 ms (window hidden, rAF stalled) ENDS the fling rather than delivering the rest in one jump. Cancelled by any pointerdown (mouse/pen too), a real wheel (`wheelSource === 'wheel'` in `onWheelCapture` — the source check is what stops a fling cancelling itself), the pane going hidden, and unmount
- `useKeyboardShortcuts.ts` — 54+ shortcut actions, safe interception
- `utils/shortcut-binding.ts` — `claimsKeyEvent`, the ONE answer to "does wmux take this keystroke?" (#225, 2.10.1). Two callers must agree or a key reaches nobody: the document-level listener in `useKeyboardShortcuts` decides whether to run an action, and `useTerminal`'s xterm custom key handler decides whether to let the event bubble out of the terminal at all — xterm ends every key it handles with `cancel(event, true)`, which is `stopPropagation()`, so a bare `Ctrl+<letter>` (and F1/F3) never reached `document` while a terminal was focused. `SAFE_CTRL_KEYS` (`b d n t w f ,`) lives here too and is load-bearing for the first time: from inside a terminal `Ctrl+D` is split-right, not EOF. A bare printable key is never claimed even if bound, or a rebind to `a` would eat every `a` typed into the shell

**Pipe Bridge** (`pipe-bridge.ts`):
- Exposes Zustand store operations as `window.__wmux_*` globals
- Called by main process via `executeJavaScript` to bridge V2 pipe commands to renderer
- Covers: workspace CRUD, pane split/close/list, surface CRUD, markdown content, notifications,
  browser engine get/set (`__wmux_getBrowserEngine` / `__wmux_setBrowserEngine` — the split tree
  lives in the store and main has no copy, so main asks the renderer before routing any
  `browser.*` verb. An unknown surface answers `web`, which is the safe answer, not a lazy one)

**Store** (Zustand, in `store/`):
- `workspace-slice.ts` — Workspace CRUD, split tree updates
- `surface-slice.ts` — Surface/tab add/close/move/navigate
- `settings-slice.ts` — Shortcuts, sidebar prefs, theme
- `notification-slice.ts` — Notification lifecycle (max 200)
- `agent-slice.ts` — Agent metadata tracking
- `osc-title-slice.ts` — surfaceId → the OSC 0/2 window title the pane's program set (#221). Deliberately NOT a `SurfaceRef` field: that type is what goes into `session.json`, so a title parked there restores onto a fresh shell that has set none — a plain `pwsh` pane relabelled with whatever the program that used to live in it was doing last week. A sibling map is live-only by construction rather than by remembering to strip a field in `freezeSurfaceCwds`, `saveCurrentLayoutAsPreset` and `handleSaveSession`. The setter no-ops on an unchanged title (several shells re-emit the same one every prompt) and the producer in `useTerminal.ts` throttles at 200 ms trailing — a spinner-in-the-title emits DISTINCT titles at ~10 Hz, and one store write per change is #141 again. `isConsoleDefaultTitle` (#286) publishes a console's DEFAULT title — its exe path, behind a localised `Administrator:` in an elevated wmux, which ConPTY forwards as OSC 0 — as NO title, so the tab keeps its cwd; agent detection still gets the raw value. `normalizeOscTitle`'s bidi strip is the load-bearing half, verified against a real xterm rather than read out of its source: xterm removes C0 itself and ABORTS on C1, but passes U+202E straight through, and that one character reorders the whole tab strip
- `prompt-slice.ts` — Per-surface prompt log (#207). Bounded twice: 200 prompts per surface, 64 surfaces. **Only the facts** — a marker is a live emulator object and lives in `utils/prompt-marks.ts` instead. `line: null` means "not jumpable"; a view must never read it as line 0
- `prompt-actions.ts` — The three prompt commands as functions of a surface id, because there are two callers (the shortcut table and the command palette) and they were about to disagree. The palette hands every action it does not recognise to a `console.log`, so an action wired only into the keyboard table appears in the palette, is selectable, and silently does nothing
- `split-utils.ts` — Immutable split tree helpers, plus `buildWorkspaceTree(panes, layout)` (#212): what a NEW workspace opens as. That shape used to be hard-coded in two places that disagreed — the sidebar `+` built a three-pane T, `wmux new-workspace` built one leaf — because `resolveDefaultSplitTree` took the fallback as a PARAMETER each caller filled in differently. It is now a setting with one resolution (a saved default layout first, then the configured count/arrangement), and `buildDefaultSplitTree()` is `buildWorkspaceTree(3, 'grid')` — byte-for-byte the shipped T, which is what lets it replace the old construction rather than sit beside it. `MAX_WORKSPACE_PANES` is a guard, not a limit: the value arrives from a hand-edited TOML file and over the pipe, and every pane it makes is a PTY

### Preload API (`window.wmux`)

`src/preload/index.ts` is the list of bridges, with the reason for each one's shape in its comments. A jailed bridge takes a surfaceId and a relative path, never an absolute one: main derives the root, or it is not a jail.

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

Highlighting a prompt, pinning it, anchoring the view at the start of an answer and listing prompts as jump marks all depend on one fact: where a user prompt starts. `utils/prompt-log.ts` is the one producer, and the four views are separate toggles. Rules for code outside it:

- **Two sources, ranked and never merged.** `agent` is a hook and carries the text. `shell` is OSC 133 and carries only a boundary. There is no heuristic third source: with neither present the log stays empty and every view is inert.
- **A shell's command text never crosses the pipe.** The renderer reads it out of the buffer, because a command line is where a credential reliably shows up.
- **One OSC 133 parse.** `utils/alt-screen-owner.ts` (#357) gets its marks from `handlePromptMark`, never from a second handler.
- **Changing an existing prompt default** needs a `promptDefaultRev` bump and a `PROMPT_PROMOTIONS` entry, or it reaches nobody.

The design notes are in `utils/prompt-marks.ts` (the tint and its content check), `utils/prompt-anchor.ts` (armed versus engaged), `store/prompt-slice.ts` and `PromptPrefs` in `store/settings-slice.ts` (the defaults). Read them before changing the feature.

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
- **This file**: a module's design notes and post-mortems go in its own comments or the PR description, not here. Add text here only for a rule that crosses modules, and keep each module's entry to a short summary: what it is for, plus any rule other files must follow. Older entries outside the main-process table still carry notes; move them into the code when you touch one rather than adding to them
