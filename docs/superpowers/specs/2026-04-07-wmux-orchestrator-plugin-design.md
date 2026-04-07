# wmux-orchestrator — Claude Code Plugin Design

**Date:** 2026-04-07  
**Status:** Approved  
**Author:** amirlehmam + Claude  

## Overview

A Claude Code plugin that decomposes complex dev tasks into parallel sub-tasks, spawns multiple Claude Code instances across wmux terminal panes, and orchestrates them through dependency-aware waves with a final automated reviewer. Works standalone (marketplace) with degraded mode, or fully integrated when wmux auto-configures it.

## Problem

When Claude Code runs subagents in parallel, the user sees a single spinner with minimal info. No visibility into what each agent does, no ability to intervene mid-flight, no structured coordination between dependent sub-tasks. wmux already provides multi-pane terminals — this plugin bridges the gap.

## Architecture: Hybrid (Skills + Hooks + Scripts)

- **Skills** handle intelligence: task analysis, decomposition, plan presentation, review
- **Hooks** handle reactivity: track tool uses, detect agent completion, trigger wave transitions
- **Scripts** handle wmux operations: create panes, spawn agents, update dashboard, manage state
- **State file** (JSON) is the shared coordination layer between all components

No daemon, no persistent process. Event-driven via Claude Code hooks.

---

## Plugin Structure

```
wmux-orchestrator/
├── .claude-plugin/
│   └── plugin.json              # Manifest
├── commands/
│   └── wmux:orchestrate.md      # Slash command entry point
├── skills/
│   ├── orchestrate/
│   │   ├── SKILL.md             # Task decomposition + launch
│   │   ├── references/
│   │   │   └── decomposition-guide.md
│   │   └── scripts/
│   │       ├── spawn-agents.sh
│   │       ├── check-status.sh
│   │       └── cleanup.sh
│   ├── reviewer/
│   │   ├── SKILL.md             # Final review agent
│   │   └── scripts/
│   │       └── collect-results.sh
│   └── wmux-detect/
│       ├── SKILL.md             # wmux detection + fallback
│       └── scripts/
│           └── detect-wmux.sh
├── hooks/
│   └── hooks.json               # PostToolUse, SubagentStop, Stop, SessionStart
├── agents/
│   └── wmux-worker.md           # Worker agent template
├── scripts/
│   ├── orchestration-state.sh   # State file management
│   ├── on-tool-use.sh           # Hook: update state on tool use
│   ├── on-agent-stop.sh         # Hook: detect agent finish, trigger next wave
│   ├── on-stop.sh               # Hook: protect against accidental close
│   └── on-session-start.sh      # Hook: crash recovery
└── package.json
```

---

## Orchestration Flow

### Phase 1 — Deep Analysis

When the user runs `/wmux:orchestrate "Refactor the auth system"`:

1. **Codebase exploration**: Glob/Grep/Read to map files related to the task
2. **Dependency analysis**: Trace imports/exports between files to identify conflict zones
3. **Subtask decomposition**: Break task into independent units with file boundaries
4. **Dependency graph**: Identify which subtasks block others
5. **Wave planning**: Group subtasks into sequential waves. Within each wave, agents run in parallel. Between waves, results are chained.

```
Wave 1: [Agent A]              ← foundation work, no dependencies
Wave 2: [Agent B] [Agent D]    ← parallel, both depend on A
Wave 3: [Agent C]              ← depends on B and D
```

6. **Agent count decision**: Based on task complexity AND wmux layout capacity. Not arbitrary — real parallelism only. The plugin uses `wmux list-panes` to assess available space, and can create more panes via `wmux split` / `wmux new-workspace` as needed.

### Phase 2 — Plan Presentation

The plugin presents a structured plan showing:
- All waves with their agents
- File assignments per agent (allowed + excluded)
- Dependencies between waves
- Options: `--worktree` for git isolation, `--review` for final reviewer (default: on)

User can: validate, adjust (merge/split/reorder subtasks), or cancel.

### Phase 3 — Orchestrated Execution

On validation:

1. **Layout creation**: Scripts use wmux CLI to create a dedicated workspace with panes for each agent in the current wave, plus a dashboard pane (markdown type)

2. **Agent spawning**: Each agent is a Claude Code instance launched via `wmux agent spawn` with a generated prompt file containing:
   - Specific mission description
   - Allowed files list (strict zone)
   - Excluded files list (other agents' zones)
   - Results from previous waves (if wave 2+)
   - Result file path for self-reporting
   - Orchestration constraints ("don't git commit, don't modify files outside your zone")

3. **Real-time dashboard**: A markdown pane updated continuously by hooks showing:
   - Wave progress
   - Per-agent status, tool use count, files touched
   - Recent activity log

4. **User interaction**: User can focus any agent pane and type directly into the terminal to give feedback, correct course, or provide additional context — while other agents continue working.

### Phase 4 — Wave Transitions

Driven by the `on-agent-stop.sh` hook (SubagentStop event):

1. Update agent status in state JSON
2. Check if all agents in current wave are done
3. If yes, check if next wave's dependencies are satisfied
4. If yes, create new panes and spawn next wave's agents
5. Inject previous wave results into new agents' prompts
6. Update dashboard

**Failure handling**: If an agent fails (non-zero exit), the hook notifies the user with options: retry (same or adjusted prompt), skip, or abort orchestration.

### Phase 5 — Automated Reviewer

When all waves complete, the `reviewer` skill launches automatically in a new pane:

1. Reads all agent result files
2. Runs `git diff` to see full changeset
3. Checks consistency: types compatible, imports correct, no orphaned files
4. Runs tests if configured (`npm test`, `pytest`, etc.)
5. Detects conflicts or inconsistencies between agents
6. Fixes minor issues directly (missing imports, type mismatches) using Edit/Write
7. Produces a review report in the dashboard
8. For major issues, escalates to the user

If worktree mode was used, the reviewer proposes branch merges with conflict visualization.

### Phase 6 — Finalization

Summary displayed with:
- Total time, agents used, waves completed
- Files modified/created, lines added/removed
- Test results
- Reviewer corrections
- Action buttons: commit, view diff, abort changes

---

## State File

**Location:** `{TMPDIR}/wmux-orch-{orchestrationId}/state.json`

```json
{
  "id": "orch-a1b2c3",
  "task": "Refactor the auth system",
  "status": "running|completed|failed|aborted",
  "startedAt": "2026-04-07T21:30:00Z",
  "workspaceId": "ws-xxx",
  "dashboardSurfaceId": "surf-xxx",
  "useWorktrees": false,
  "waves": [
    {
      "index": 0,
      "status": "pending|running|completed|failed",
      "blockedBy": [],
      "agents": [
        {
          "id": "agent-aaa",
          "label": "Migrate User model",
          "subtask": "description",
          "files": ["src/models/user.ts"],
          "excludeFiles": ["src/routes/*"],
          "paneId": "pane-xxx",
          "surfaceId": "surf-xxx",
          "status": "pending|running|completed|failed",
          "exitCode": null,
          "toolUses": 0,
          "resultFile": "/tmp/wmux-orch-a1b2c3/agent-aaa-result.md",
          "startedAt": null,
          "finishedAt": null
        }
      ]
    }
  ],
  "reviewer": {
    "status": "pending|running|completed|skipped",
    "agentId": null,
    "reportFile": "/tmp/wmux-orch-a1b2c3/review-report.md"
  }
}
```

**Orchestration directory:**
```
/tmp/wmux-orch-{id}/
├── state.json
├── state.lock
├── agent-{id}-prompt.md    # Generated prompt per agent
├── agent-{id}-result.md    # Self-reported result per agent
├── dashboard.md            # Live dashboard content
└── review-report.md        # Reviewer output
```

**Write responsibilities:**

| Component | Reads | Writes |
|-----------|-------|--------|
| Skill `orchestrate` | — | Creates initial state with waves/agents |
| `spawn-agents.sh` | waves | paneId, surfaceId, status → running |
| `on-tool-use.sh` | agent status | toolUses++, last activity |
| `on-agent-stop.sh` | agent, wave | status → completed/failed, triggers next wave |
| `check-status.sh` | everything | nothing (read-only, feeds dashboard) |
| Skill `reviewer` | everything | reviewer status, report |

**Concurrency:** Hooks execute sequentially in Claude Code. Lock file (`state.lock`, 2s timeout) for safety.

**Script runtime:** All `.sh` scripts target bash, which is available on Windows via Git Bash/MSYS2 (Claude Code's default shell on Windows). No PowerShell or `.cmd` scripts needed.

---

## Hooks

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Bash|Read|Write|Edit|Grep|Glob|Agent",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/on-tool-use.sh",
        "timeout": 5
      }]
    }],
    "SubagentStop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/on-agent-stop.sh",
        "timeout": 15
      }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/on-stop.sh",
        "timeout": 15
      }]
    }],
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/on-session-start.sh",
        "timeout": 5
      }]
    }]
  }
}
```

**Hook roles:**

- **`on-tool-use.sh`** (PostToolUse): Increments agent toolUses counter, updates dashboard. <100ms, non-blocking.
- **`on-agent-stop.sh`** (SubagentStop): Core orchestration logic. Updates agent status, checks wave completion, spawns next wave via wmux CLI, triggers reviewer when all done.
- **`on-stop.sh`** (Stop): Warns user if orchestration is active before Claude Code exits.
- **`on-session-start.sh`** (SessionStart): Detects wmux availability, checks for interrupted orchestrations (crash recovery).

---

## Worker Agent Template

**`agents/wmux-worker.md`:**

Each spawned Claude Code receives a dynamically generated prompt built from this template:

- **Mission**: Specific subtask description
- **File zone**: Explicit allowed and excluded file lists
- **Previous wave context**: Results from completed agents (injected for wave 2+)
- **Constraints**: No git commits, no files outside zone, no global installs
- **Result format**: Standardized markdown with summary, files modified, interfaces changed, tests run, risks identified
- **Result path**: `/tmp/wmux-orch-{id}/agent-{agentId}-result.md`

The wave chaining is what makes multi-wave orchestration coherent: each subsequent wave's agents have full knowledge of what previous waves produced.

---

## Degraded Mode (without wmux)

Detection via `wmux ping`. Fallback behavior:

| Feature | With wmux | Without wmux |
|---------|-----------|-------------|
| Task decomposition | Same | Same |
| Plan presentation | Same | Same |
| Agent launch | `wmux agent spawn` in visible panes | Native `Agent` tool (invisible subagents) |
| Multi-pane layout | Dynamic via CLI | N/A |
| Real-time dashboard | Markdown pane | Text summary in terminal |
| User intervention | Focus pane, type directly | Not possible |
| Wave transitions | Hook → wmux CLI spawn | Hook → Agent tool |
| Reviewer | Dedicated pane | Native subagent |

The plugin is useful standalone for task decomposition + wave orchestration even without wmux. The visual multi-pane experience is the wmux differentiator.

---

## Auto-configuration by wmux

wmux bundles the plugin in `resources/wmux-orchestrator/` and auto-installs it on startup:

1. Copy plugin to `~/.claude/plugins/cache/wmux-orchestrator/{version}/`
2. Register in `~/.claude/plugins/installed_plugins.json`
3. Enable in `~/.claude/settings.json` under `enabledPlugins`

Version follows wmux version. Updates automatically with wmux updates.

Standalone marketplace installation also available: `claude plugin install wmux-orchestrator`

---

## Claude Code Features Exploited

| Feature | Usage |
|---------|-------|
| Glob/Grep/Read | Codebase analysis for decomposition |
| Agent tool | Degraded mode worker spawning |
| Bash | wmux CLI execution, state management |
| Write | Generate agent prompts, dashboard |
| Edit | Reviewer auto-fixes |
| LSP | Post-orchestration type validation |
| TaskCreate/Update | Progress tracking in Claude Code UI |
| Skills system | Modular orchestration phases |
| Hooks system | Event-driven wave transitions |
| SubagentStop | Core wave transition trigger |
| PostToolUse | Real-time agent tracking |
| SessionStart | Crash recovery |

---

## V1 Scope

**In scope:**
- `/wmux:orchestrate` command
- Intelligent decomposition with dependency graph
- Sequential waves with intra-wave parallelism
- Real-time markdown dashboard
- Automated reviewer with auto-fix for minor issues
- Optional worktree isolation
- Degraded mode without wmux
- Crash recovery (resume interrupted orchestration)
- Strict file zone prompts per agent

**Out of scope (V2+):**
- Inter-agent real-time communication
- React-based dashboard UI
- Cross-repo orchestration
- Complex DAG dependencies (non-linear)
- Enforced filesystem sandboxing
- Orchestration history database
- ML-based conflict resolution
- Linux/macOS wmux support

**Known V1 limitations:**
1. No inter-agent communication during a wave
2. Wave dependencies are linear (wave N blocks wave N+1)
3. File zones are advisory (prompt-based, not enforced)
4. Single project/cwd only
5. Full experience Windows-only (wmux constraint)
