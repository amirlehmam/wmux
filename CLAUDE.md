# wmux — Development Guide

Electron-based Windows terminal multiplexer for AI agents. TypeScript, React 19, Zustand, xterm.js, node-pty.

**Owner**: amirlehmam (GitHub) — speaks French, prefers fast pragmatic solutions, tests live.
**Repo**: github.com/amirlehmam/wmux | **Site**: wmux.org (Netlify, static from `site/`)
**Version**: 2.0.0

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
| `pty-crash-guard.ts` | Keeps a PTY-side error from killing the whole app (issue #150). Every pane's PTY lives in main, so a throw there takes the window down: wraps node-pty's `_$onProcessExit` (a throw there becomes an unhandled C++ `Napi::Error` in `conpty.node` → `abort()`) and claims each terminal's `error` event (node-pty re-throws socket errors when fewer than 2 listeners exist, and registers none). Installed at module load — after `pty.spawn` is too late |
| `pipe-server.ts` | Named pipe `\\.\pipe\wmux` — V1 text (shell hooks), V2 JSON-RPC (CLI/agents) |
| `cdp-bridge.ts` | Browser webview control via Chrome DevTools Protocol |
| `cdp-proxy.ts` | CDP WebSocket proxy |
| `agent-browser-cli.ts` | Where `agent-browser` is on this machine, and how to run it. Two traps, both found by running the real binary rather than by reading its docs. (1) **`execFile` never returns.** Its callback fires on stdio CLOSE, not on process exit, and every command that starts the daemon — the first `open` of a session, `dashboard start` — leaves that daemon holding the inherited stdout pipe open for as long as it lives. Measured against 0.35.0: an identical cold `open` had the child exit 0 at **787 ms** while `execFile`'s callback had still not fired at 3 min, so the verb burned its whole timeout and was reported as a FAILURE despite having succeeded. Hence `spawn`, resolving on `'exit'` (the event that actually means "done"), with a 50 ms drain window so output is not truncated — `'close'` lands right behind `'exit'` when nothing holds the pipe, so the wait is only ever paid by the daemon-spawning commands. Anyone "simplifying" this back to `execFile` breaks agent mode completely and silently. (2) **Never a `.cmd`.** Node refuses to spawn `.bat`/`.cmd` without `shell: true` (the CVE-2024-27980 mitigation) and throws a **synchronous** `EINVAL` — in main that is an uncaught throw, not a failed command. `shell: true` is not available as a fix: argv carries agent-controlled URLs and `eval` snippets, and routing them through cmd.exe's parser is the exact trap `powershell-shim.ts` documents (#154). The npm package ships real per-platform binaries under its own `node_modules/agent-browser/bin/`, so resolution targets those first and the shim is never a candidate. Memoised like `node-runtime.ts` (#187) because it is read on the pane path (#176), and keyed on the configured path so a Settings change invalidates without every caller remembering to ask |
| `agent-browser-verbs.ts` | The pure wmux-verb → argv table. I/O-free on purpose: it is the piece most likely to drift as agent-browser's CLI evolves, so it must be exhaustively testable with no daemon, no Chrome, no Electron. Returns an ARRAY, never a joined string — `params` arrive from a pipe command an agent controls. A missing `ref` on `click`/`type`/`fill` throws -32602 rather than putting `undefined` on a command line, and an unknown verb throws the same -32601 the web engine does so a caller cannot tell the engines apart by their error. Also where the **one engine divergence** is recorded in code: `wait` has no per-call timeout in agent-browser, so a caller `ms` sent alongside a ref is unrepresentable in argv and deliberately dropped — see CLI Reference |
| `agent-browser-session.ts` | surfaceId → session name + wmux-allocated stream port. Sessions are **ephemeral** — nothing persisted, no profile dir, a session's process lifetime equals its surface's — and that is what makes orphan handling correct by construction rather than by heuristic: no wmux-owned session can legitimately survive, so any prefixed session with no live surface is garbage. That is the property the #139 post-mortem wanted and did not have. But the registry is in-memory and starts EMPTY, so it is **not ground truth after a crash** — the sessions that actually survived are precisely the ones it cannot see, and reconciliation asks `agent-browser session list` instead. wmux allocates the stream port ITSELF (9300+, above the CDP proxy's 9222-9230) because the dashboard deep-links by `?port=`, and discovering an OS-assigned port after the fact races the webview load; `ensureBindable` verifies each candidate with a real `listen` first, since the registry tracks only what it handed out and never what the OS holds — an orphan from a previous run may still be bound. `isWmuxSessionName` is a security boundary, not tidiness: names come out of a machine-global namespace anyone can write into and go straight back onto a command line as `--session <name> close`, so both the instance prefix AND the full `surf-<uuid>` shape are required. `WMUX_INSTANCE` gets its own prefix — a side-by-side wmux is exactly as much "not us" as a human's hand-made session |
| `agent-browser-daemon.ts` | The observability dashboard, refcounted by live agent-mode surfaces: first acquire starts it, last release stops it. **Adopt, never fight** — if :4848 already answers, a human or another wmux started it, so wmux uses it, records `adopted`, and NEVER stops it: not on the last release, not on shutdown. `adopted` is a getter with deliberately no setter, since anything that could write it could make teardown kill a dashboard wmux does not own. A failed `acquire()` rolls back its own increment (clamped — `refs` must never go negative) so a phantom ref cannot strand a dashboard no later release can reach zero on, and `release()`/`shutdown()` wait out an in-flight start before deciding there is nothing to stop — otherwise a start that settles just after shutdown leaks a child process that outlives wmux entirely |
| `agent-browser-runtime.ts` | The single home for the singletons — exactly one `SessionRegistry`, exactly one `DashboardDaemon` — plus the impure halves the pure modules take by injection. A second copy silently corrupts both: two registries hand 9300 to two surfaces, two daemons each believe they own the dashboard and the first `release()` to hit zero stops it out from under the other. It also owns the **per-surface** dashboard reference, because two paths take one for the SAME surface (the renderer enabling agent mode, and a `wmux browser` verb arriving for that pane) and when each kept its own Set the pane took two references and gave back one, so the dashboard outlived every agent pane until quit. Readiness is the PORT, never the exit: `dashboard start` exits at 58 ms having daemonised while :4848 does not accept a connection for ~500 ms, and in some configurations it does not exit at all. `reconcileOrphanSessions` runs at startup off `session list` because a crash reaches none of the other teardown paths and Windows reparents rather than kills (#139); a `close` that hangs (observed after a daemon version-mismatch restart) is deadlined and left for the next launch rather than resolved by killing a PID — agent-browser exposes no per-session PID and its daemon fronts several sessions, so leaking one Chrome beats killing somebody else's browser |
| `agent-manager.ts` | Agent PTY spawning, round-robin distribution across panes |
| `window-manager.ts` | Electron BrowserWindow creation/management |
| `ipc-handlers.ts` | All IPC channel handlers |
| `claude-context.ts` | Injects wmux instructions into `~/.claude/CLAUDE.md`, configures hooks, installs wmux-orchestrator plugin — **and the inverse of each**, since 0.40.0 |
| `agent-integration.ts` | Consent gate for every write outside `%APPDATA%\wmux` (issue #132). Asks on first launch, stores `unset`/`granted`/`declined` in wmux's own settings.json, and reconciles `~/.claude` + `~/.config/opencode` + `~/.kiro` to match. Nothing in `claude-context.ts`, `opencode-context.ts` or `kiro-context.ts` may be called directly from startup any more — route it through here |
| `kiro-context.ts` | Kiro CLI support (issue #148). Writes `~/.kiro/steering/wmux.md` — a dedicated global steering file, since Kiro loads every `.md` in that dir, so there is no shared file to splice into. No hooks: Kiro's are per-project (`.kiro/hooks/`), and writing into every repo the user opens is the #132 mistake. State comes from `wmux report-agent` instead |
| `opencode-context.ts` | Installs `resources/opencode-plugin/wmux.js` into `~/.config/opencode/plugin/`, gated on the `// wmux-plugin-version:` marker (`pluginNeedsUpdate` compares it verbatim, so any change to the plugin needs a bump or it reaches nobody — every broken install already has the old file on disk). **That plugin file must export `WmuxPlugin` and nothing else** (#191): OpenCode's auto-discovery loader calls EVERY export as a plugin factory and then invokes a `config` hook on the result, so an exported helper returning a plain value crashes OpenCode at startup. Helpers hang off `WmuxPlugin.__wmuxInternals` for the tests; a source-level test pins the export count |
| `claude-observer.ts` | Monitors Claude Code activity for sidebar display |
| `claude-resume.ts` | `claude --resume` on workspace restore (#186), behind `workspacePrefs.restoreClaudeSessions` (**default off** — every such pane starts an agent at once). Stamps each terminal's live session id into the PERSISTED tree only, the way `freezeSurfaceCwds` stamps cwd; a live surface never carries one. Main-side rather than renderer-side because the id lives in `agent-state.ts`'s record map. The id reaches a command line, so `CLAUDE_SESSION_ID_RE` is a security boundary, enforced at `reportAgentSession` AND again in `claude-resume-command.ts` (session.json is user-editable). `handleHookEvent` must skip `SessionEnd`: it carries a session_id like every hook, but `releaseAgent()` has just run for it, and recording there would resume a Claude the user deliberately quit |
| `agent-state.ts` | Declared agent run state — blocked/working/idle, run refcount, `seq` dedupe, metadata TTL (issue #128). Also the back-channel: declared `choices` + `answerAgent`. **Answering never clears `blocked`** — the agent must confirm, or a mis-declared key silently stops a stuck pane asking for help |
| `agent-state-rpc.ts` | `pane.report_agent` & friends, routed off the main V2 switch |
| `agent-hook-bridge.ts` | Claude Code hooks → declared state, so it works with no plugin to install |
| `session-persistence.ts` | Auto-save/restore window state |
| `port-scanner.ts` | Active port detection for running dev servers |
| `powershell-shim.ts` | The `wmux.ps1` gate (issue #154). PowerShell resolves a .ps1 ahead of every PATHEXT entry, which is how cmd.exe's argument parser is kept out of the PowerShell path — but a .ps1 PowerShell refuses (Restricted policy, or Mark of the Web under RemoteSigned) is a hard error with NO fallback to the .cmd beside it. So the shim dir goes on PATH only after a probe script in that same dir has actually run in every installed host |
| `node-runtime.ts` | Which binary on this machine can run a `.js` file (#187). Everything wmux hands an agent is "a script plus something to run it", and every consumer had been assuming `node` was on PATH or that the host process was itself a JS runtime — false under OpenCode, whose `process.execPath` is a compiled `opencode.exe`. Resolved once (memoised: it is read on the synchronous pane-create path, see #176) and declared as `WMUX_NODE`. The last resort is wmux's own Electron binary, which is Node under `ELECTRON_RUN_AS_NODE=1`, so the chain never dead-ends — but that flag is what makes it a runtime instead of a second wmux window, hence the separate `WMUX_NODE_ELECTRON` signal |
| `ssh-argv.ts` | Parses an ssh command line into the facts scp needs to reach the same host (#195). Pure, and the single funnel for all three detection sources so they cannot disagree about what a command line means. Returning **null is the safe outcome** — a mis-parse does not fail loudly, it uploads a file to the wrong host — so port forwards (`-N`/`-W`), one-shot remote commands and `RequestTTY=no` all abandon the parse rather than guess |
| `ssh-detect.ts` | Is this surface sitting inside ssh, and where? Three layers: **managed** (`wmux ssh` put the command line in the shell spec), **reported** (shell-integration preexec hook), **probed** (`Win32_Process` ancestry sweep). The precedence rule is a security boundary, not a preference: Windows has no tty foreground process group, so a descendant `ssh.exe` may be a *background* process — the probe may only corroborate an authoritative layer, never establish one. `refresh()` short-circuits with no sweep when neither authoritative layer has an entry, because it runs on the paste path |
| `remote-upload.ts` | scp/ssh argv construction and the transfer itself. `BatchMode=yes` throughout: these run with no TTY, so a passphrase prompt would hang to the timeout. All-or-nothing — a failed batch deletes its private `/tmp/wmux-drop-<uuid>/` before returning, since half a batch gives the user remote paths and silence with no way to tell which is which |
| `remote-insert.ts` | What a paste or drop types into a terminal. Lives in main because every input to the decision does (clipboard, detector, filesystem, scp, config). Quoting is per-side: Windows-conditional locally, always single-quoted for a remote sh |
| `win32-process.ts` | One `Get-CimInstance Win32_Process` invocation for both the orphan reaper and the ssh probe. Shared so the security-relevant part — resolving `powershell.exe` by ABSOLUTE path, so a writeable PATH dir cannot shadow it — is stated once |
| `system32.ts` | Absolute paths to Windows-owned tools. `opensshPath()` prefers Program Files OpenSSH over System32 (#193): Git for Windows puts an MSYS2 ssh ahead of System32 on PATH, and it cannot talk to the Windows named-pipe ssh-agent — so a bare `ssh` spec died on "Permission denied (publickey)" wherever keys live only in an agent |
| `shell-context-menu.ts` | "Open in wmux" Explorer verb — HKCU shell keys for Directory/Directory\Background/Drive, plus `directoryFromArgv` for the launch path. Win11 places it under "Show more options"; the modern menu needs a signed MSIX, which unsigned wmux cannot ship |
| `theme-loader.ts` | Theme loading |
| `config-loader.ts` | WT/Ghostty config import. Reachable from Settings → Terminal → Import. WT spells opacity two ways — modern `opacity` (0-100, independent of `useAcrylic`) and pre-1.12 `acrylicOpacity` (0-1, only with `useAcrylic`) |
| `shell-detector.ts` | Available shells detection |
| `updater.ts` | Auto-update. Routes by install layout: NSIS → `electron-updater`, portable zip → `zip-updater.ts` (#184). `initAutoUpdater()` returns before registering `NsisUpdater` on a zip extract, so a portable install can never enter the #96 "update ready" loop |
| `zip-updater.ts` | In-place update for portable zip extracts (#184). Detection is the whole contract: `wmux.exe` present, `Uninstall wmux.exe` absent — that name is electron-builder's `Uninstall ${productFilename}.exe`, so it moves if `productName`/`executableName` ever change. Download via `net.request`, extract via System32 `tar.exe` (PowerShell `Expand-Archive` fallback), then a detached cmd helper waits on the old PID and robocopies over the install root. The helper's relaunch is **unconditional** — wmux has already quit, so bailing out on a copy failure is the one outcome the user can't recover from |

### Renderer (`src/renderer/`)

**Components** (in `components/`):
- `SplitPane/` — PaneWrapper, SplitContainer, SplitDivider, SurfaceTabBar
- `Terminal/` — TerminalPane, FindBar, CopyMode, NotificationRing
- `Browser/` — BrowserPane, AddressBar, AgentBrowserSetup (the `not-installed` vs `no-dashboard` cards — two genuinely different situations, never one card: the second means the agent browser works fine and only its optional viewer is missing)
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
- `split-utils.ts` — Immutable split tree helpers

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
clipboard: writeText, readText    # no pasteImage since 1.12.0 — see remote below
remote:   resolvePaste, resolveDrop  # what should this gesture type? Main answers
                                     # the WHOLE question (clipboard read, ssh
                                     # detection, scp, quoting) because only main
                                     # can act on any of it. resolveDrop takes DOM
                                     # File objects, never path strings: accepting
                                     # paths would be an arbitrary local-file
                                     # upload API for a compromised renderer
hook:     onEvent
claudeActivity: onUpdate
agentState: onUpdate   # declared blocked/working/idle (issue #128)
session:  save, load, list, delete
cdp:      attach, detach
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
# IMPORTANT: always run from the project root (use absolute paths or cd back
# after any `cd .asar-staging`). If cwd drifts into .asar-staging during this
# section, subsequent `mkdir build-out` lands INSIDE the staging dir and the
# next asar pack will recursively include its own previous output → 188M asar.
rm -rf .asar-staging build-out
mkdir -p .asar-staging build-out
cp -r dist .asar-staging/dist          # explicit dest path — trailing-slash form is flaky on Git Bash
cp package.json .asar-staging/package.json
( cd .asar-staging && npm install --omit=dev --ignore-scripts )   # subshell — cwd doesn't leak
rm -rf .asar-staging/node_modules/node-pty/build   # force prebuilds load path: conpty.dll (useConptyDll) resolves relative to the LOADED conpty.node, and only prebuilds/win32-x64/ has the conpty/ dir next to it

# 4. Pack ASAR (with native module unpacking)
# Use --unpack-dir (path-based), NOT --unpack "**/*.node" — the glob form
# silently fails on Git Bash for Windows (shell eats the pattern, asar produces
# the asar but creates no .unpacked dir, no error). Output to build-out/ so we
# never touch the live resources/app.asar while wmux may be running.
npx asar pack .asar-staging build-out/app.asar --unpack-dir "node_modules/node-pty/prebuilds"

# 5. Verify native modules are unpacked
ls build-out/app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/
# Must contain: conpty.node, conpty_console_list.node, pty.node
# Sanity: ASAR should be ~24M (natives unpacked). 80M+ means natives weren't
# moved out; 180M+ means staging got polluted (see step 3 warning).

# 5b. Verify the PRs/fixes you intended to ship are actually inside the ASAR.
# extract-file's stdout piping is unreliable on Windows — extract to /tmp instead.
rm -rf /tmp/asar-verify && mkdir -p /tmp/asar-verify
( cd /tmp/asar-verify && npx --prefix "$(pwd)" asar extract "$(pwd)/build-out/app.asar" . )
grep -c 'your_fix_marker' /tmp/asar-verify/dist/renderer/assets/index-*.js
grep -c 'your_fix_string' /tmp/asar-verify/dist/main/index.js

# 6. Create release staging
# Easiest base: the previous release zip. Avoids needing a separate
# wmux_v_extracted/ dir and avoids picking up stray files from the project root.
rm -rf ../wmux-release-staging
mkdir -p ../wmux-release-staging
( cd ../wmux-release-staging && unzip -q ../wmux/wmux-<PREV_VERSION>-win-x64.zip )

# 7. Copy ASAR + resources into release staging
cp build-out/app.asar ../wmux-release-staging/resources/app.asar
rm -rf ../wmux-release-staging/resources/app.asar.unpacked
cp -r build-out/app.asar.unpacked ../wmux-release-staging/resources/app.asar.unpacked
cp resources/icon.png ../wmux-release-staging/resources/
rm -rf ../wmux-release-staging/resources/themes && cp -r resources/themes ../wmux-release-staging/resources/themes
rm -rf ../wmux-release-staging/resources/sounds && cp -r resources/sounds ../wmux-release-staging/resources/sounds
mkdir -p ../wmux-release-staging/resources/cli && cp dist/cli/wmux.js ../wmux-release-staging/resources/cli/wmux.js
cp dist/cli/wmux-hook.js ../wmux-release-staging/resources/cli/wmux-hook.js   # Claude hooks exec this via bare node — MUST ship outside the asar (missing until 0.29.1 → sidebar stuck on "Running", issue #81)
cp dist/cli/transport-deadline.js ../wmux-release-staging/resources/cli/transport-deadline.js   # required by BOTH files above; omitting it is MODULE_NOT_FOUND on the first line, not a degraded feature
cp dist/cli/wsl-network.js ../wmux-release-staging/resources/cli/wsl-network.js                 # required by wmux.js (bridge bind selection)
rm -rf ../wmux-release-staging/resources/shell-integration && mkdir -p ../wmux-release-staging/resources/shell-integration
cp -r src/shell-integration/* ../wmux-release-staging/resources/shell-integration/
rm -rf ../wmux-release-staging/resources/wmux-orchestrator && cp -r resources/wmux-orchestrator ../wmux-release-staging/resources/wmux-orchestrator
rm -rf ../wmux-release-staging/resources/opencode-plugin && cp -r resources/opencode-plugin ../wmux-release-staging/resources/opencode-plugin   # missing from every zip until 0.47.0 → OpenCode integration silently absent in installs (issue #149)
rm -rf ../wmux-release-staging/resources/cli-bin && cp -r src/cli-bin ../wmux-release-staging/resources/cli-bin
rm -rf ../wmux-release-staging/resources/cli-bin-ps && cp -r src/cli-bin-ps ../wmux-release-staging/resources/cli-bin-ps   # the PowerShell shim (issue #154); without it PowerShell falls back to wmux.cmd and loses argument quoting

# 8. Embed icon + metadata in exe (rcedit)
# CRITICAL: rcedit exports `{ rcedit }` (named export). `const rcedit =
# require('rcedit')` followed by `rcedit(...)` throws "rcedit is not a function".
# Always destructure: `const { rcedit } = require('rcedit')`.
node -e "
  const { rcedit } = require('rcedit');
  rcedit('../wmux-release-staging/wmux.exe', {
    icon: 'resources/icons/icon.ico',
    'version-string': {
      ProductName: 'wmux',
      FileDescription: 'wmux',
      CompanyName: 'wmux',
      InternalName: 'wmux',
      OriginalFilename: 'wmux.exe',
      LegalCopyright: 'Copyright (c) 2026 wmux'
    },
    'file-version': '0.7.20',
    'product-version': '0.7.20'
  }).then(() => console.log('rcedit done'), e => { console.error(e); process.exit(1); });
"
# NOTE: rcedit CANNOT modify a running exe. The staging copy is fine; never
# point rcedit at the wmux.exe living in the project root if it's running.

# 9. Create zip
powershell -NoProfile -Command "Compress-Archive -Path '..\wmux-release-staging\*' -DestinationPath '..\wmux-<VERSION>-win-x64.zip' -CompressionLevel Optimal"

# 9b. latest.yml — DO NOT generate one pointing at the zip for a manual
# release. Installed clients use NsisUpdater: a zip in latest.yml downloads
# but never installs (endless update loop, issue #96). latest.yml must point
# at an NSIS setup.exe, which only the CI build produces — so for a full
# release, prefer tagging and letting CI ship setup.exe + zip + latest.yml.
# A manual zip-only release simply ships WITHOUT latest.yml (the updater
# handles its absence gracefully since 0.28; the notify-only checker still
# surfaces the new version). Legacy snippet kept for reference:
node -e "
  const crypto = require('crypto'); const fs = require('fs');
  const version = '<VERSION>';
  const zip = '../wmux-' + version + '-win-x64.zip';
  const data = fs.readFileSync(zip);
  const sha512 = crypto.createHash('sha512').update(data).digest('base64');
  const yaml = ['version: ' + version, 'files:', '  - url: wmux-' + version + '-win-x64.zip',
    '    sha512: ' + sha512, '    size: ' + data.length, 'path: wmux-' + version + '-win-x64.zip',
    'sha512: ' + sha512, 'releaseDate: ' + JSON.stringify(new Date().toISOString()), ''].join('\n');
  fs.writeFileSync('../latest.yml', yaml);
  console.log('latest.yml written:', data.length, 'bytes,', sha512.slice(0, 16) + '...');
"

# 10. Tag, push, publish (zip AND latest.yml — both assets are required)
git add package.json package-lock.json && git commit -m "chore(release): bump to <VERSION>"
git push origin master
git tag -a v<VERSION> -m "wmux <VERSION>" && git push origin v<VERSION>
gh release create v<VERSION> ../wmux-<VERSION>-win-x64.zip ../latest.yml --repo amirlehmam/wmux --title "v<VERSION>" --notes "..."

# 11. (Optional) Hot-swap into the locally running wmux for immediate testing
cp build-out/app.asar resources/app.asar
rm -rf resources/app.asar.unpacked && cp -r build-out/app.asar.unpacked resources/app.asar.unpacked
# Then restart wmux to pick up changes

# 12. Cleanup
rm -rf .asar-staging build-out /tmp/asar-verify ../wmux-release-staging
```

### Release Checklist

- [ ] `npm run build:main` succeeds
- [ ] `npx vite build` succeeds
- [ ] Compiled code verified (grep for key changes in dist/)
- [ ] ASAR packed with `--unpack-dir node_modules/node-pty/prebuilds` (NOT `--unpack` glob)
- [ ] ASAR size is ~24M (natives unpacked). 80M+ ⇒ unpack didn't take. 180M+ ⇒ staging polluted.
- [ ] node-pty native modules present in `app.asar.unpacked/node_modules/node-pty/prebuilds/win32-x64/`
- [ ] PR-specific markers grep-confirmed inside the packed ASAR (extracted to /tmp)
- [ ] wmux-orchestrator plugin copied to release staging
- [ ] cli-bin + cli-bin-ps copied to release staging (issue #154)
- [ ] opencode-plugin copied to release staging (issue #149) — `npm test` now derives this from `process.resourcesPath` usage in `src/main/`, so a new runtime resource that isn't in `extraResources` fails the release build
- [ ] `resources/cli/` holds all four files — `wmux.js`, `wmux-hook.js`, `transport-deadline.js`, `wsl-network.js`. The CLI is packaged file-by-file, so a shared module has to be listed on its own; `npm test` derives this from the relative imports in `src/cli/`
- [ ] rcedit applied (icon + version metadata) — `{ rcedit }` destructured
- [ ] `latest.yml` generated (sha512 + size of the final zip) and uploaded as a release asset — electron-updater 404s without it (issue #68)
- [ ] Zip created and uploaded to GitHub release
- [ ] Mark of the Web: remind user to right-click > Unblock after download

### Important Notes

- **rcedit can't modify a running exe** — always work on a copy
- **rcedit named export**: `const { rcedit } = require('rcedit')`. Non-destructured `const rcedit = require('rcedit')` throws "rcedit is not a function" (different from older docs).
- **asar `--unpack` glob silently fails on Git Bash for Windows**: pattern like `"**/*.node"` gets shell-eaten and asar emits no `.unpacked/` dir, no error. Use `--unpack-dir node_modules/node-pty/prebuilds` (path-based) instead.
- **Bash cwd drift can recursively pollute staging**: if you `cd .asar-staging` and forget to come back, the next `mkdir build-out && asar pack` creates `.asar-staging/build-out/app.asar`, and a re-pack will swallow its own output into the new asar (188M). Always use subshells `( cd dir && cmd )` or absolute paths.
- **Don't pack ASAR directly to `resources/app.asar`** if wmux may be running — pack to `build-out/` and copy at step 7.
- **MOTW (Mark of the Web)**: Downloaded zips get `Zone.Identifier` NTFS stream. Fix: `powershell "Get-ChildItem -Recurse | Unblock-File"`
- **Windows taskbar pinning** uses PE `FileDescription` for the shortcut name — ensure rcedit sets it to "wmux"
- **AppUserModelId** is set to `com.wmux.app` in `src/main/index.ts` for proper taskbar grouping

---

## Named Pipe V2 Handlers

The pipe server in `index.ts` handles V2 JSON-RPC methods. Most delegate to the renderer via `executeJavaScript('window.__wmux_*(...)')`. The renderer's `pipe-bridge.ts` exposes Zustand store operations as these globals.

**Fully implemented V2 methods:**
- `system.identify`, `system.capabilities`, `system.tree`
- `workspace.create`, `workspace.close`, `workspace.select`, `workspace.rename`, `workspace.list`, `workspace.current`
- `pane.split`, `pane.close`, `pane.focus`, `pane.zoom`, `pane.list`
- `surface.create`, `surface.close`, `surface.focus`, `surface.rename`, `surface.list`
- `surface.send_text`, `surface.send_key`, `surface.read_text`, `surface.trigger_flash`
- `markdown.set_content`, `markdown.load_file`, `markdown.get_content`
- `notification.list`, `notification.clear`
- `sidebar.set_status`, `sidebar.set_progress`, `sidebar.log`, `sidebar.get_state`
- `browser.*` — routed per surface by its engine: `web` → the CDP bridge, `agent` → the agent-browser CLI. `engineForSurface` asks the RENDERER (the split tree lives in the Zustand store, main has no copy) and asks EVERY window, first affirmative wins — the surface may be in window 2, the #143 "window ≠ workspace" mistake. A renderer that has never heard of `__wmux_getBrowserEngine`, or a rejected `executeJavaScript`, answers `web`: this runs on the hot path of every browser command, where it previously did no renderer IPC at all. The engine is re-checked on **every** outcome of target resolution, not only when there was no wcId — a surface toggled web→agent keeps a valid CDP registration (nothing detaches on a toggle), so the null-branch-only shortcut drives CDP against agent-browser's own dashboard SPA and silently corrupts the pane the user is watching
- `browser.get_engine`, `browser.set_engine` — matched BEFORE the generic `browser.*` passthrough, or they fall into the verb switch and come back as `Unknown: browser.get_engine` (-32601). `set_engine` validates `web`/`agent` and refuses a surface that is not a browser surface
- `agent.spawn`, `agent.spawn_batch`, `agent.status`, `agent.list`, `agent.kill`
- `pane.report_agent`, `pane.report_agent_session`, `pane.report_metadata`, `pane.release_agent`, `pane.agent_state`
- `pane.answer_agent` — the back-channel (issue #128). The only non-`report_*` method: it WRITES into a pane's PTY. Guarded — refuses unless the pane is currently `blocked`, and only ever sends a payload the agent itself declared
- `hook.event`, `diff.refresh`

---

## wmux-orchestrator Plugin

Claude Code plugin bundled in `resources/wmux-orchestrator/`. Installed into `~/.claude/plugins/cache/` on startup by `ensureOrchestratorPlugin()` in `claude-context.ts` — but only when the user has granted the `orchestrator` feature (issue #132); `agent-integration.ts` owns that call. Also published standalone: `github.com/amirlehmam/wmux-orchestrator`.

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
wmux new-window | list-windows | focus-window <id>

# Workspaces
wmux new-workspace [--title T] [--shell S] [--cwd D]   # --shell accepts args: --shell "ssh user@host"
wmux close-workspace | select-workspace | rename-workspace | list-workspaces
wmux current-workspace [--surface <id>]                # alias: whoami — the caller's OWN
                                       # workspace {id,title,cwd,shell,surfaceId}.
                                       # Explicit error on an unknown surface, rather than the
                                       # focused workspace `list-workspaces` reports as active
wmux ssh [ssh options] <user@host> [--title T]         # remote terminal in a new workspace (issue #78)

# Remote wmux management (issue #78): drive another machine's wmux over an SSH tunnel
wmux bridge [--port P] [--host H]     # on the remote: expose its pipe on TCP (default 127.0.0.1:9787)
wmux token                            # on the remote: print its auth token
wmux --remote host[:port] --token T <any command>   # on the client (through `ssh -L port:127.0.0.1:port`)
                                      # env equivalents: WMUX_REMOTE, WMUX_REMOTE_TOKEN

# Markdown surfaces
wmux markdown <file> | markdown set <id> --content <text> [--title T] | --file <path>
wmux markdown get <id>                                 # read a surface's buffer back out

# Surfaces (tabs within a pane)
wmux new-surface [--type terminal|browser|markdown]
wmux close-surface | focus-surface | rename-surface | list-surfaces

# Panes
wmux split [--down] [--type T] | close-pane | focus-pane | zoom-pane | list-panes | tree

# Terminal I/O
wmux send <text> | send-key <key> [--ctrl] [--shift] [--alt]
wmux read-screen [--lines N] [--surface <id>] | trigger-flash

# Browser — the same verbs on either engine, so agents need no re-education
wmux browser open <url> | snapshot | click eN | type eN <text>
wmux browser fill eN <value> | get-text | screenshot | eval <js>
wmux browser wait <ref> [ms] | back | forward | reload
wmux browser <verb> [--surface <id>]   # whose browser to drive; defaults to
                                       # $WMUX_SURFACE_ID inside a pane
wmux browser engine [web|agent] [--surface <id>]
                                       # print, or switch, which engine backs this
                                       # browser surface. `web` (the default, and
                                       # what every browser surface was before) is
                                       # the Electron <webview>, driven over CDP;
                                       # `agent` is vercel-labs/agent-browser — a
                                       # real Chrome the CLI drives, shown in the
                                       # pane through its own dashboard, deep-linked
                                       # to that surface's session. Every verb above
                                       # routes to whichever engine the surface is
                                       # on, which is why the global CLAUDE.md wmux
                                       # writes never has to mention any of this.
# ENGINE DIVERGENCE — the only one, so it is written down rather than discovered:
# `wmux browser wait <ref> [ms]` sends a ref AND a timeout. In `web` mode both reach
# cdpBridge.wait(ref, timeout) and the ms is honoured. agent-browser's `wait
# <selector>` has no per-call timeout flag at all — only the global
# AGENT_BROWSER_DEFAULT_TIMEOUT (25 s) — so in `agent` mode the caller's ms is
# DROPPED and the ref wins. Unrepresentable in argv, not fixable in the verb table;
# see the KNOWN ENGINE DIVERGENCE note in src/main/agent-browser-verbs.ts. Every
# other verb behaves identically on both engines.

# Declared agent state (issue #128) — blocked / working / idle, no screen scraping.
# Surface defaults to $WMUX_SURFACE_ID, so an agent inside a pane needs no id.
wmux report-agent --blocked "permission: Bash"   # parked on a human
wmux report-agent --blocked "Run it?" --choices '[{"id":"y","label":"Yes","key":"1"}]'
wmux answer-agent --surface <id> --choice y      # reply to ANOTHER pane, from yours
wmux report-agent --unblocked                    # the human answered
wmux report-agent --run-start | --run-end        # refcount, so nested subagents nest
wmux report-agent --run-depth N [--seq N]        # absolute depth; --seq drops replays
wmux report-metadata [--model M] [--tokens T] [--context-pct N] [--ttl ms]
wmux report-session <id> | release-agent
wmux agent-state [--surface <id>]                # no --surface → all panes + blocked list

# Agents
wmux agent spawn [--cmd C] [--label L] [--cwd D] [--pane P] [--replace-tab]
wmux agent spawn-batch --json '[...]' [--strategy distribute|stack|split]
wmux agent status <id> | list | kill <id>

# Notifications & Sidebar
wmux notify <text> | list-notifications | clear-notifications
wmux set-status <key> <value> | set-progress <val> [--label L]
wmux log <level> <message> | sidebar-state

# Hooks
wmux hook --event <type> --tool <name> [--agent <id>]

# Crash reports (issue #174) — needs no running wmux, which is the point
wmux crash-report [--events N] [--log-lines N]
# Event Log fingerprint (Application Error 1000 + Windows Error Reporting 1001,
# joined on report id) plus the tail of %APPDATA%\wmux\logs\main.log. Read from
# the events' positional Properties, never the rendered message: the message is
# LOCALISED (a French Windows says "Nom du module défaillant") and matching the
# exe by substring attributed a sibling project's crash to wmux. Never reads
# properties [10]/[11] — those are full paths, and the path carries the
# Windows username. See docs/crash-reports.md.
```

---

## IPC Channels

All defined in `src/shared/types.ts` → `IPC_CHANNELS`:

```
PTY:     pty:create, pty:write, pty:resize, pty:kill, pty:has, pty:data, pty:exit
Remote:  remote:resolve-paste, remote:resolve-drop   # ssh file upload (issue #195)
Window:  window:create/close/focus/list/minimize/maximize/isMaximized
Config:  config:getTheme/getThemeList/importWindowsTerminal/importGhostty
System:  system:getShells/openExternal
Notify:  notification:fire/list/clear/jump
Agent:   agent:spawn/spawn-batch/status/list/kill/update
CDP:     cdp:attach/detach
AgentBr: agent-browser:enable/disable/status/install/current-url/open   # engine control
Session: session:save-named/load-named/list-named/delete-named
Meta:    metadata:update, hook:event, claude:activity, agent:state
```

---

## Shell Integration

Scripts in `src/shell-integration/` (deployed to `resources/shell-integration/`):

| Script | Reports |
|--------|---------|
| `wmux-powershell-integration.ps1` | cwd, git branch/dirty, shell state, PR polling (45s) |
| `wmux-bash-integration.sh` | cwd, git branch/dirty, shell state, ports |
| `wmux-cmd-integration.cmd` | Basic OSC 9 escape sequences |

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
