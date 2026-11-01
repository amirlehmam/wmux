# wmux — Development Guide

Electron-based Windows terminal multiplexer for AI agents. TypeScript, React 19, Zustand, xterm.js, node-pty.

**Owner**: amirlehmam (GitHub) — speaks French, prefers fast pragmatic solutions, tests live.
**Repo**: github.com/amirlehmam/wmux | **Site**: wmux.org (Netlify, static from `site/`)

## Build & Dev

```bash
npm run dev            # Vite (port 5199) + Electron hot-reload
npm run build:main     # tsc main/preload/cli only (fast iteration)
npm run build:renderer # Vite production build: BOTH entries (desktop index.html + remote/index.html), writes dist/renderer/remote-manifest.json (the console server refuses to serve without it)
npm run build          # Full: tsc + vite + electron-builder
npm test               # Vitest unit tests
npm run test:watch     # Vitest watch mode
npx vitest run tests/unit/pty-manager.test.ts  # Single file
npm run lint           # ESLint src/
```

### Known Build Gotcha

Project lives in `OneDrive - Pulsa` (path with spaces). This breaks:
- `npm link` / `node-gyp` (can't build node-pty)
- `electron-builder` winCodeSign (symlink errors)

Releases are built by CI on a clean path, so this only affects local builds.

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

By area: the rules code in other files must follow. `ls src/main` lists the modules, and each one's design notes are in its own comments, starting with its header. Read them before changing it.

- **App**: `index.ts` is the entry point, auto-save and the V2 pipe handlers; `ipc-handlers.ts` holds every IPC handler. `awake-manager.ts` owns Keep Windows awake, and renderers read it via `awake.getState`, never a copy. `gpu-watchdog.ts`: main decides, the renderer only reports a stall. `renderer-recovery.ts` offers a reload, never automatically. wmux's own files go in `getAppDataDir()`, never `app.getPath('userData')` (`chromium-profile.ts`).
- **Closing and quitting**: quits, relaunches and programmatic closes never prompt (`close-guard.ts`). `quit-sequence.ts` drains ConPTY exit callbacks before `app.exit()`. `session-flush.ts` holds the last close or the quit for each window's `session:save`, up to 1 s. `exit-watchdog.ts` is never a .cmd or PowerShell helper.
- **Terminals**: `pty-crash-guard.ts` must be installed at module load, before the first `pty.spawn`. `PtyManager` delivers startup commands (`startup-commands.ts`), and no caller may type them itself. `pty-keys.ts` is the one named-key table, shared by every writer. `powershell-shim.ts`: the `wmux.ps1` dir goes on PATH only after a probe has run in every installed PowerShell host. With `WMUX_NODE_ELECTRON` set, `WMUX_NODE` must run under `ELECTRON_RUN_AS_NODE=1` (`node-runtime.ts`).
- **Pipe**: `pipe-server.ts` serves V1 text (shell hooks) and V2 JSON-RPC (CLI and agents) on `\\.\pipe\wmux`: one request per connection, closed with `destroy()`, never `end()`.
- **Browser**: `cdp-proxy.ts` impersonates Chrome, so its routes accept what real Chrome accepts. Hidden panes must use `visibility`, never `display: none` (`browser-keep-rendering.ts`). Every browser `<webview>` gets its hardened prefs from the HOST window's `will-attach-webview` (`webview-prefs.ts`).
- **Agent browser** (`agent-browser-*.ts`): run the binary with `spawn` resolved on exit, never `execFile` or a `.cmd` shim. `agent-browser-runtime.ts` holds the single `SessionRegistry` and `DashboardDaemon`: never construct another, and take dashboard refs only there. Only `isWmuxSessionName` decides what wmux may close, and a dashboard it adopted is never stopped.
- **Agents**: `agent-integration.ts` is the consent gate for every write outside `%APPDATA%\wmux` (#132), and the `*-context.ts` writers are called only through it. Before changing `*-context.ts`, `*-resume.ts` or `codex-launcher.ts`, load the `wmux-agent-integration` skill (`.agents/skills/wmux-agent-integration/SKILL.md`). `agent-state.ts` is declared run state (#128): answering never clears `blocked`, and a PTY exit keeps session handles. `agent-spawn-target.ts`: a named pane is authoritative, and pane and surface lookups ask every window.
- **File access**: `resolveInRoot` in `explorer-fs.ts` is the jail every explorer and code read goes through; the renderer sends only relative paths. `file-grants.ts` is the single gate for every renderer→disk write: only a path opened into a live pane in this window and session through the jail, unchanged on disk since. The unjailed `markdown:read-file` never grants.
- **Remote**: `remote-console/*` is the phone Remote Console (#254), **off by default, loopback by default**. Before changing anything there, read `src/main/remote-console/AGENTS.md`: the seven invariants (I1–I7), the lazy-loaded runtime, teardown on `will-quit`, and the binding replay. `ssh-argv.ts` is the single funnel for every ssh detection source, and in `ssh-detect.ts` the process probe may only corroborate a session, never establish one.
- **Workspaces**: only the close dialog may remove a `git-worktree.ts` checkout, never any other close path. Manifests (`workspace-*.ts`, #284) have no `--trust` flag, and their commands never enter the store or session.json.
- **Windows**: `win32-process.ts` and `system32.ts` resolve Windows tools by absolute path, so a writable PATH entry cannot shadow them. `zip-updater.ts` detects a portable install by electron-builder's `Uninstall wmux.exe`, so renaming `productName` or `executableName` breaks it.

### Renderer (`src/renderer/`)

As above: the rules other files must follow, with the design notes in each module's comments.

**Components** (in `components/`):
- `SplitPane/`: `surface-label.ts` is the one tab-caption chain, and `customTitle` is only for names a human chose. `use-osc-title.ts` is the single reader of a program's window title (#221), so its pref gate cannot differ between callers
- `Terminal/`: anything floating over the xterm container is `position: absolute`, never a flow sibling, or the PTY keeps its old row count and the bottom rows hide underneath (#82). `PromptsPane` is a surface rather than an overlay, so that rule does not apply to it
- `Browser/`: `utils/browser-start-page.ts` is the one rule for what a surface opens on when nobody said (#232): blank, never a page on the internet
- `Sidebar/`: `workspace-status.ts` holds the three chains that must agree about one row (status words, status colour, state dot), so a priority added to one belongs in all three. Every UI place that names a workspace reads it through `use-osc-title.ts` (`useWorkspaceLabel(s)` / `getStoredWorkspaceLabel`), never `ws.title`; it is display only, and the CLI still answers the stored title
- `Settings/`: `ChangelogSettings` (#211) shows notes from the network, so they only go through `renderMarkdown`, where DOMPurify runs
- `Markdown/`: `markdown-document.ts` and `markdown-hydrate.ts` add math, mermaid and local images (#380) as inert placeholders filled in after sanitizing. `renderMarkdown` stays without them because it also renders the changelog
- `Git/`: its review context lives on the surface, never on focus, so clicking into another agent's pane never moves it (#362)
- `Diff/`: the explorer opens it through `openDiffView` (`open-diff.ts`, #325), which pins the tab to the explorer's root. `Diff/diff-render.tsx` is shared with `Git/`

**Remote Console phone UI** (`renderer/remote/`, #254): a SECOND Vite entry (`remote/index.html`), served by main's console server and never loaded by the desktop window. Before changing it, read `src/renderer/remote/AGENTS.md`: the import-graph rule, the chunk it shares with the desktop window, `npm run dev` not serving it, and the mirror's clipping and key-bar rules.

**Keystrokes**: `utils/shortcut-binding.ts`'s `claimsKeyEvent` is the one answer to "does wmux take this keystroke?" (#225): `useKeyboardShortcuts` and `useTerminal`'s key handler must both use it, or a key reaches nobody.

**Pipe Bridge** (`pipe-bridge.ts`): exposes store operations as `window.__wmux_*` globals, which main calls through `executeJavaScript` for V2 pipe commands. The split tree lives only in the store, so main asks here for a surface's browser engine before routing a `browser.*` verb.

**Store** (Zustand, in `store/`):
- `osc-title-slice.ts`: a program's window title is never a `SurfaceRef` field, which would persist it into `session.json`
- `prompt-slice.ts`: `line: null` means "not jumpable"; a view must never read it as line 0
- `prompt-actions.ts`: the shortcut table and the command palette both go through it, because the palette hands an action it does not recognise to a `console.log`

### Preload API (`window.wmux`)

`src/preload/index.ts` is the list of bridges, with the reason for each one's shape in its comments. A jailed bridge takes a surfaceId and a relative path, never an absolute one: main derives the root, or it is not a jail.

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
A split-tree change remounts the panes it moves, but not their terminals. `TerminalHost` (mounted once in `App.tsx`) portals one `TerminalPane` per terminal surface into an element owned by `components/Terminal/terminal-keepalive.ts`, and a pane renders only a `KeptAliveTerminal` slot that the element moves into. Two consequences for code outside it: React events from inside a terminal bubble through the host, not the pane, so the leaf's click-to-focus is a native listener on the slot (`onActivate`); and a same-commit move changes no prop, so `attachGeneration` re-runs the show path. `utils/remount-snapshot.ts` remains only as the fallback for a terminal that really is rebuilt. The design notes are in those files.

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

## Release Process

CI builds and publishes every release when a `v<version>` tag is pushed (`.github/workflows/release.yml`): the NSIS installer, the portable zip and `latest.yml`. Never build or upload one by hand, and never dispatch the workflow to test: every run publishes. For anything else about a release, load the `wmux-release` skill (`.agents/skills/wmux-release/SKILL.md`).

## Named Pipe V2 Handlers

`pipeServer.on('v2')` in `src/main/index.ts` answers V2 JSON-RPC, with `routeSpecialV2` and the `v2-bridge.ts` table in front of its switch. Most methods ask the renderer through the `window.__wmux_*` globals in `pipe-bridge.ts`. Before adding or changing a method or CLI verb, load the `wmux-pipe-method` skill (`.agents/skills/wmux-pipe-method/SKILL.md`).

## wmux-orchestrator Plugin

**Deprecated in 2.12.0 (#239). wmux no longer installs this Claude Code plugin, and removes it if a previous version did.** `removeOrchestratorPlugin` in `claude-context.ts` records why it never loaded.

The source still ships in `resources/wmux-orchestrator/`, with its layout in that README. `scripts/launch-agent.js` is the shared agent-command registry that the `omp-context` and `pi-context` tests read. The sidebar orchestration panel (`orchestration-watcher.ts`), `wmux agent spawn` and the OpenCode plugin, which the `orchestrator` consent feature still controls, aren't deprecated.

## CLI Reference

`wmux help` lists every command, and `wmux <command> --help` (or `wmux help <command>`) prints the usage text kept in `COMMAND_SPECS` in `src/cli/wmux.ts`. Read those rather than a copy here. The one verb that behaves differently on the two browser engines (`wmux browser wait <ref> [ms]` drops the timeout in agent mode) is documented at `KNOWN ENGINE DIVERGENCE` in `src/main/agent-browser-verbs.ts`.

## Shell Integration

The scripts live in `src/shell-integration/`. `resources/shell-integration/` is a byte-identical mirror that `tests/unit/resources-sync.test.ts` enforces, so every edit is made in both. Before changing either, load the `wmux-shell-integration` skill (`.agents/skills/wmux-shell-integration/SKILL.md`).

Env vars set by wmux in spawned shells: `WMUX=1`, `WMUX_SURFACE_ID`, `WMUX_PIPE`, `WMUX_CLI`,
`WMUX_NODE` (+ `WMUX_NODE_ELECTRON` when it is wmux's own binary — issue #187).

## Website (wmux.org)

Static site in `site/`, deployed to Netlify with `npx netlify deploy --prod --dir site`. `site/i18n.js` switches language by URL hash (`#<code>`).

## Agent Skills

Task procedures live in repo skills, loaded only when a task matches. `.agents/skills/<name>/SKILL.md` is the source of truth, and Codex reads it there. `.claude/skills/` is a generated copy for Claude Code: edit `.agents/skills/`, then run `npm run sync:skills`. `npm test` fails while the two differ, and when a `SKILL.md` uses frontmatter outside the Agent Skills spec, since the same file has to load in both agents.

## Conventions

- **State**: Zustand slices in `src/renderer/store/`, composed in `index.ts`
- **IPC**: Channels defined in `IPC_CHANNELS` in `src/shared/types.ts`, never use magic strings
- **CSS**: `src/renderer/styles/`, class prefix per component (`.pane-wrapper__*`, `.surface-tab__*`)
- **Immutable trees**: Split tree mutations always produce new objects via `patchLeaf()`
- **French comms**: User communicates in French, code/docs in English
- **This file**: a module's design notes and post-mortems go in its own comments or the PR description, not here. Add text only for a rule that crosses modules
