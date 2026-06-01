# wmux ↔ OpenCode Compatibility — Design

**Date:** 2026-06-01
**Goal:** Make wmux officially, fully compatible with OpenCode (SST `opencode`, v1.2.6+), at parity with the existing Claude Code integration: live activity sidebar, auto-injected wmux instructions, tool/hook tracking, and parallel orchestration of OpenCode worker agents.

## Background & Key Discovery

wmux's agent layer is already half generic:
- `agent-manager.ts` spawns whatever `--cmd` it is given (agent-agnostic).
- The named-pipe CLI (`wmux <command>`) is agent-agnostic.

The Claude-specific half:
- `claude-observer.ts` — regex-scrapes Claude's TUI output to build `ClaudeActivity` for the sidebar.
- `claude-context.ts` — injects wmux usage into `~/.claude/CLAUDE.md`, registers PostToolUse hooks in `~/.claude/settings.json`, installs the orchestrator plugin, configures chrome-devtools-mcp.
- `wmux-orchestrator/` — a Claude Code plugin whose worker scripts spawn `claude`.

**Discovery that shapes this design:** OpenCode exposes an official **plugin API** (`@opencode-ai/plugin`), not just TUI output. Confirmed against the live docs (updated 2026-05-31) and the locally installed `@opencode-ai/plugin@1.2.6` type definitions:

- Plugins are `.js`/`.ts` files auto-loaded at startup from the global plugin directory. **Verified empirically against the installed 1.2.6 binary: the directory is `plugin/` (singular) — `~/.config/opencode/plugin/` global and `.opencode/plugin/` project.** The published docs say `plugins/` (plural); they are wrong for this build. Install target is therefore `~/.config/opencode/plugin/wmux.js`. No config entry required.
- Relevant hooks: `tool.execute.before` / `tool.execute.after` (tool name, sessionID, args, output), `event` (full event stream), `shell.env` (inject env vars into every shell OpenCode spawns).
- Relevant events: `session.idle` (response complete), `session.error`, `session.status`, `message.part.updated`, `tool.execute.before/after`, `todo.updated`, `permission.asked/replied`. Also `tui.toast.show`.
- OpenCode CLI: `opencode run "<message>" --agent <a> --model <m> --dir <d> [--format json]` runs headless; `opencode agent` manages agents.

**Design principle:** Drive OpenCode integration through the official plugin API + config injection, NOT TUI scraping. This is what makes the integration genuinely "official" and version-proof. The plugin only activates inside wmux (`WMUX=1`), so it is a harmless no-op everywhere else.

## Scope (agreed)

1. Live activity sidebar — IN.
2. Auto-inject wmux instructions — IN.
3. Hooks / tool tracking — IN.
4. Parallel orchestration — IN, scoped to **spawning OpenCode worker agents** in panes (parametrized worker command + `session.idle`-driven wave transitions). Re-authoring `/wmux:orchestrate` as a *native OpenCode command* (so OpenCode itself is the orchestrator) is explicitly **out of scope** for this pass.

Verification: **live test inside running wmux** (build → hot-swap asar → launch `opencode` in a pane → confirm sidebar activity, hook events, and an orchestrated OpenCode worker spawn).

## Architecture

### Component 1 — Bundled wmux OpenCode plugin

**File:** `resources/opencode-plugin/wmux.js` (plain JS; no build step, no external deps so OpenCode's `bun install` is never required).

**Install:** new `ensureOpencodePlugin()` in `claude-context.ts` (called from `index.ts` startup alongside the Claude setup), copying the file to `~/.config/opencode/plugins/wmux.js`. Idempotent: overwrite only when content/version differs (embed a `// wmux-plugin-version: <v>` marker line and compare).

**Behavior:**
- On init: if `process.env.WMUX !== '1'`, return `{}` (no-op).
- Read `WMUX_SURFACE_ID`, `WMUX_CLI` (path to `wmux.js`/CLI), `WMUX_PIPE` from env (already set by wmux when spawning the pane shell).
- `tool.execute.after(input)` → invoke `wmux hook --event PostToolUse --tool <input.tool> [--agent <sessionID>]` (parity with Claude PostToolUse). Must be fire-and-forget and complete fast; failures swallowed.
- `event({ event })` → maintain lightweight per-session activity and push to wmux via the new `agent.activity` pipe method (Component 2):
  - `session.idle` → `{ isDone: true }`
  - `session.error` → mark error/done
  - `message.part.updated` / `tool.execute.before` → `{ isDone: false, lastTool }`
  - `todo.updated` → optional progress
- `shell.env(input, output)` → re-assert `WMUX=1`, `WMUX_PIPE`, `WMUX_CLI`, `WMUX_SURFACE_ID` into `output.env` so nested shells/sub-tools inherit wmux context.

**How the plugin reaches wmux:** it shells out to the existing `wmux` CLI (via Bun `$` or node), which speaks the named pipe. No new transport. The CLI gets a new lightweight subcommand (or reuses `hook`) for pushing activity — see Component 2.

### Component 2 — Agent-agnostic activity into the existing sidebar

- New V2 pipe method `agent.activity` in `src/main/index.ts`, payload `{ surfaceId, activity: { lastTool?, activeSkill?, isDone, agents? } }`.
- Handler updates the same per-surface activity map used by `claude-observer` and broadcasts on the **existing** `IPC_CHANNELS.CLAUDE_ACTIVITY` channel. The sidebar UI is unchanged — it simply gains a second producer.
- New CLI command in `src/cli/wmux.ts`, e.g. `wmux agent-activity --surface <id> [--tool T] [--done]`, that emits this pipe method. The plugin calls it. (Surface id comes from `WMUX_SURFACE_ID`; CLI defaults to that env var when `--surface` omitted.)
- `claude-observer.ts` keeps working unchanged for Claude. Both paths converge on the same store/IPC, so the sidebar shows OpenCode activity identically.

### Component 3 — Instruction injection

- New `ensureOpencodeContext()` in `claude-context.ts`, mirroring `ensureClaudeContext()`.
- Target file: `~/.config/opencode/AGENTS.md` (OpenCode's global rules file).
- Reuse the **same** wmux instructions source (`resources/claude-instructions/claude-instructions.md`) since the wmux CLI usage is agent-agnostic. Use the identical `<!-- wmux:start -->` / `<!-- wmux:end -->` marker block so user content is never clobbered; create the file/dir if missing.
- Called from `index.ts` startup.

### Component 4 — Orchestration with OpenCode workers

- `resources/wmux-orchestrator/scripts/spawn-agents.sh`: introduce a `WMUX_AGENT_CMD` indirection. Default `claude`. When set to OpenCode, the worker command becomes `opencode run "<prompt>" --agent <role> --dir <zone>` (exact flag mapping finalized in the plan). The script builds the `wmux agent spawn --cmd ...` invocation from this template.
- Wave transitions: today driven by Claude's `SubagentStop` hook → `on-agent-stop.sh`. For OpenCode workers, the bundled plugin's `session.idle` event calls the same `on-agent-stop.sh` driver (via a new `wmux` CLI passthrough or by invoking the script path from env), so wave logic is shared.
- The orchestration *driver* (the `/wmux:orchestrate` skill) continues to run inside whichever agent the user invoked it from. Only the *workers* become OpenCode.

## Data Flow

```
OpenCode (in wmux pane)
  └─ wmux.js plugin (WMUX=1)
       ├─ tool.execute.after ─→ `wmux hook --tool …`        ─┐
       └─ event(session.idle/…) ─→ `wmux agent-activity …`  ─┤
                                                              ▼
                                              named pipe \\.\pipe\wmux
                                                              │
                                              src/main/index.ts (V2 handlers)
                                                              │
                                       agent activity map + CLAUDE_ACTIVITY IPC
                                                              │
                                                    Sidebar (renderer) — unchanged
```

## Components & Boundaries

| Unit | Purpose | Depends on | Testable by |
|------|---------|-----------|-------------|
| `resources/opencode-plugin/wmux.js` | Translate OpenCode hooks/events → wmux CLI calls | `wmux` CLI on PATH, env vars | Run `opencode` in pane, observe sidebar |
| `ensureOpencodePlugin()` | Install/update plugin file | filesystem | Unit: temp dir install/idempotency |
| `ensureOpencodeContext()` | Inject AGENTS.md block | filesystem | Unit: marker insert/update/no-clobber |
| `agent.activity` pipe + CLI | Agent-agnostic activity push | pipe server, store | Unit: pipe handler updates store |
| `spawn-agents.sh` `WMUX_AGENT_CMD` | Build worker command per agent type | wmux CLI | Live orchestrate w/ opencode worker |

## Error Handling

- Plugin: every wmux call is fire-and-forget with errors swallowed; never block or crash OpenCode. No-op when `WMUX!=1`.
- `ensureOpencode*()`: wrapped in try/catch with `console.warn`, exactly like existing `ensureClaude*()` — startup must never fail because OpenCode isn't installed/configured.
- Missing `~/.config/opencode/` dir: created on demand (plugin install + AGENTS.md).

## Testing

- **Unit (Vitest):** `ensureOpencodeContext` marker logic (insert / update / preserve user content); `ensureOpencodePlugin` install + idempotency; `agent.activity` pipe handler updates the activity store and broadcasts.
- **Live (primary acceptance):** build:main + vite build → hot-swap asar into running wmux → open a pane, run `opencode` → confirm: (a) sidebar shows tool/idle activity, (b) `wmux hook` events arrive, (c) `/wmux:orchestrate` with `WMUX_AGENT_CMD=opencode` spawns an OpenCode worker in a new pane and a wave advances on `session.idle`.

## Out of Scope (YAGNI)

- TUI-regex fallback observer for OpenCode (plugin is authoritative; we control install).
- Re-authoring `/wmux:orchestrate` as a native OpenCode command.
- chrome-devtools-mcp / browser-CDP wiring for OpenCode (separate concern; revisit only if requested).
- Any change to the Claude Code path.

## Open Questions for Implementation Plan

1. Exact `opencode run` flag mapping for worker prompts (multi-line prompt handling, `--agent` role names vs. wmux worker roles).
2. Whether to add a dedicated `wmux agent-activity` CLI verb or extend `wmux hook` with an activity payload (leaning dedicated verb for clarity).
3. ~~Confirm `plugins/` vs `plugin/`~~ — RESOLVED: installed 1.2.6 binary uses `plugin/` (singular). Install target locked to `~/.config/opencode/plugin/wmux.js`.
