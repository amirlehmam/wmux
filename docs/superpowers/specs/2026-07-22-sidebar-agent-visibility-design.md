# Sidebar Agent & Workflow Visibility — Design

**Date:** 2026-07-22 · **Status:** approved · **Owner request:** show what agents/workflows (ultracode, multi-agent runs, orchestrator) are doing per workspace, in the sidebar, in detail but compact.

## Problem

When Claude Code runs parallel subagents or workflows (or the wmux orchestrator spawns agents in panes), the sidebar shows a single opaque status line ("Running"/tool label). The data to do better partly exists — `claude-observer.ts` already parses per-agent lines (`├─ name · N tool uses · Xk tokens`) into `claudeActivity[surfaceId].agents` — but nothing displays it.

## Approach (chosen: hybrid C)

Observer output provides **richness** (names, tool uses, tokens); Claude Code hooks provide **lifecycle truth** (turn/subagent end). Parsing may drift with Claude Code UI changes; hooks guarantee we never strand ghost "running" agents (same failure class as the v0.29.1 shellState bug).

Rejected: observer-only (fragile, no reliable end signal), hooks-only (no names/progress — too poor for the requested detail).

## Components

### 1. Unified agent list (renderer, pure helper)

`agentsForWorkspace(workspace, claudeActivity, wmuxAgents): WorkspaceAgent[]` in a new `src/renderer/store/agent-view.ts`:

- Merges observer agents (all surfaces of the workspace) + wmux-spawned agents (`agent-slice`) owned by the workspace's panes.
- `WorkspaceAgent = { key: string; name: string; detail: string; done: boolean; paneId?: PaneId }` — `detail` is preformatted ("⚒12 · 45k" or "✓").
- Applies the display cap: max 4 lines; if more, 3 agents (running first) + summary line `+N more · ⚒<sum>`.
- Pure function, unit-tested (merge, cap, ordering, dedup).

### 2. Observer modernization (`src/main/claude-observer.ts`)

- Tool/agent markers accept `●` and `⏺`; agent-detail regex tolerant to current Claude Code output (name · tool uses · tokens, optional variations).
- New pattern tests in `tests/unit/claude-observer.test.ts` using captured real Claude Code output fixtures.
- Per-surface agent array capped at 32 entries (malformed/hostile output can't grow unbounded).

### 3. Lifecycle truth (hooks)

- Add `SubagentStop` to the hook set written by `claude-context.ts` (`applyWmuxHooks`) — same `wmux-hook.js --event SubagentStop` mechanism shipped in v0.29.1.
- Renderer on `SubagentStop`: mark the most recent non-done observer agent for that surface as done.
- Renderer on `Stop` (turn over): mark ALL observer agents of that surface done → triggers collapse.
- Fallback TTL: any agent list with no update for 5 minutes collapses regardless (covers killed/crashed sessions; PTY exit already clears via `clearActivity`).

### 4. UI (`WorkspaceRow.tsx` + CSS)

```
● Session 1                        ✕
Orchestrating · 3 agents
 ├ review:bugs      ⚒12 · 45k
 ├ review:perf      ⚒8 · 30k
 └ verify:auth      ✓
master* · ~/Bureau/wmux
```

- Sub-lines render between the status line and the progress bar, only while the agent list is non-empty.
- Status line becomes `Orchestrating · N agents` (N = total in the current run) while ≥1 agent is not done; otherwise existing behavior unchanged.
- Each line: tree glyph (`├`/`└`), name truncated with ellipsis, right-aligned detail. Running agents get a small pulsing dot (reuse state-dot animation); done agents show `✓`.
- After ALL agents are done (hook-driven or observer-driven): lines stay 10 s (with ✓), then collapse. Height animates (max-height transition) both ways.
- Click on an agent line with a `paneId` (wmux-spawned) → select workspace + focus that pane. Observer-only agents are not clickable.
- CSS: `.workspace-row__agents`, `.workspace-row__agent`, `.workspace-row__agent--done`, in `src/renderer/styles/` per existing conventions.

## Error handling

- Malformed observer lines: ignored (regex no-match), never throw.
- Agent arrays capped (32 tracked / 4 displayed).
- Missing hook events: TTL collapse guarantees convergence.

## Testing

- Unit: `agent-view.ts` (merge/cap/order), observer patterns (real output fixtures), collapse timing helper (pure, injectable clock).
- No Electron-launch smoke tests (collides with live instance — see project memory).

## Out of scope (v1)

Workflow phase breakdown, per-agent history after collapse, hover popover, non-Claude harness agent feeds (OpenCode plugin can push via the existing `applyExternalActivity` pipe path — already compatible with this design, no extra work).
