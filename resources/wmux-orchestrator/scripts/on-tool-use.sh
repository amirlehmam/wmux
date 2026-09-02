#!/usr/bin/env bash
# PostToolUse hook: increment toolUses counter for the active agent.
# Called by Claude Code after each tool use. Must complete in <5s.

# Leave before sourcing anything when this session is not an orchestrated
# agent. Only panes spawned by spawn-agents.sh carry WMUX_AGENT_ID, and this
# hook fires on every tool call of every Claude session on the machine:
# sourcing orchestration-state.sh and scanning TMPDIR for a running state file
# cost a measured 133 ms per tool call in sessions that had no orchestration.
AGENT_ID="${WMUX_AGENT_ID:-}"
[ -z "$AGENT_ID" ] && exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/orchestration-state.sh"

ORCH_DIR=$(find_active_orch)
[ -z "$ORCH_DIR" ] && exit 0

# Find the agent's wave and index, then increment toolUses
WAVE_IDX=$(node "$JSON_TOOL" query "$ORCH_DIR/state.json" wave-of-agent "$AGENT_ID" 2>/dev/null)
[ -z "$WAVE_IDX" ] && exit 0

# Get the agent's index within the wave to build the path
AGENTS_JSON=$(node "$JSON_TOOL" query "$ORCH_DIR/state.json" wave-agents "$WAVE_IDX" 2>/dev/null)
AGENT_INDEX=""
if [ -n "$AGENTS_JSON" ]; then
  AGENT_INDEX=$(node -e "
    const agents = JSON.parse(process.argv[1]);
    for (let i = 0; i < agents.length; i++) {
      if (agents[i].id === process.argv[2]) { console.log(i); break; }
    }
  " "$AGENTS_JSON" "$AGENT_ID" 2>/dev/null)
fi

[ -z "$AGENT_INDEX" ] && exit 0

inc_state "$ORCH_DIR" ".waves[$WAVE_IDX].agents[$AGENT_INDEX].toolUses"

if command -v wmux &>/dev/null; then
  DASHBOARD_SID=$(read_state "$ORCH_DIR" '.dashboardSurfaceId')
  if [ "$DASHBOARD_SID" != "null" ] && [ -n "$DASHBOARD_SID" ]; then
    bash "$SCRIPT_DIR/check-status.sh" "$ORCH_DIR" > "$ORCH_DIR/dashboard.md"
    wmux markdown set "$DASHBOARD_SID" --file "$ORCH_DIR/dashboard.md" 2>/dev/null || true
  fi
fi
