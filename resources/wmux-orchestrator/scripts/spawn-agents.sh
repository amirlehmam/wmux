#!/usr/bin/env bash
# spawn-agents.sh <orch-dir> <wave-index>
# Creates a balanced grid of wmux panes (orchestrator + N agents) and spawns
# one Claude Code agent per new pane. Uses `wmux layout grid` so all panes are
# laid out in one atomic split-tree mutation instead of cascading splits.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/orchestration-state.sh"

# winpath: convert MSYS/Cygwin paths to mixed Windows form (C:/...) so Windows
# binaries spawned via `wmux agent spawn --cmd` can resolve them. No-op on Linux/macOS.
winpath() {
  if command -v cygpath &>/dev/null; then
    cygpath -m "$1" 2>/dev/null || echo "$1"
  else
    echo "$1"
  fi
}

ORCH_DIR="$1"
WAVE_IDX="$2"
LAUNCHER="$(winpath "$SCRIPT_DIR/launch-agent.js")"

[ -z "$ORCH_DIR" ] || [ -z "$WAVE_IDX" ] && { echo "Usage: spawn-agents.sh <orch-dir> <wave-index>"; exit 1; }

WMUX_AVAILABLE=false
if command -v wmux &>/dev/null; then
  PING_RESULT=$(wmux ping 2>&1)
  if [ "$PING_RESULT" = "pong" ]; then
    WMUX_AVAILABLE=true
  else
    echo "WARNING: wmux found but ping failed: $PING_RESULT" >&2
  fi
else
  echo "WARNING: wmux not found in PATH" >&2
fi

if [ "$WMUX_AVAILABLE" != "true" ]; then
  echo "wmux unavailable — writing pending spawn file for degraded mode" >&2
  node "$JSON_TOOL" query "$ORCH_DIR/state.json" wave-agents "$WAVE_IDX" > "$ORCH_DIR/wave-${WAVE_IDX}-pending-spawn.json"
  exit 0
fi

CWD=$(read_state "$ORCH_DIR" '.cwd')
[ -z "$CWD" ] || [ "$CWD" = "null" ] && CWD="$(pwd)"

# Count agents in this wave so we know how many new panes to request.
AGENT_COUNT=$(node "$JSON_TOOL" query "$ORCH_DIR/state.json" wave-agents-each "$WAVE_IDX" | grep -c . || true)
AGENT_COUNT=${AGENT_COUNT:-0}

if [ "$AGENT_COUNT" -eq 0 ]; then
  echo "No agents in wave $WAVE_IDX — nothing to spawn"
  exit 0
fi

# Request a balanced grid: 1 cell for the orchestrator pane + 1 cell per agent.
# The orchestrator pane stays as top-left; N new panes are returned in newPaneIds
# in row-major order. The CLI picks up $WMUX_SURFACE_ID as anchor automatically.
GRID_COUNT=$((AGENT_COUNT + 1))
echo "Creating $GRID_COUNT-cell grid layout (1 orchestrator + $AGENT_COUNT agents)"

LAYOUT_RESULT=$(wmux layout grid --count "$GRID_COUNT" --type terminal 2>&1)
FIRST_PANE=$(parse_json "$LAYOUT_RESULT" '.newPaneIds[0]')
if [ -z "$FIRST_PANE" ] || [ "$FIRST_PANE" = "null" ]; then
  echo "ERROR: wmux layout grid failed: $LAYOUT_RESULT" >&2
  exit 1
fi

# Spawn each agent into its assigned new pane.
# Process substitution keeps IDX in the parent shell (unlike `node ... | while`).
IDX=0
while IFS= read -r agent; do
  [ -z "$agent" ] && continue
  AGENT_ID=$(parse_json "$agent" '.id')
  AGENT_LABEL=$(parse_json "$agent" '.label')
  PROMPT_FILE="$(winpath "$ORCH_DIR/agent-${AGENT_ID}-prompt.md")"

  PANE_ID=$(parse_json "$LAYOUT_RESULT" ".newPaneIds[$IDX]")
  if [ -z "$PANE_ID" ] || [ "$PANE_ID" = "null" ]; then
    echo "ERROR: No pane at index $IDX for agent $AGENT_ID. Layout result: $LAYOUT_RESULT" >&2
    IDX=$((IDX + 1))
    continue
  fi

  # launch-agent.js uses execFileSync with '--' separator to pass the prompt
  # as a positional arg — full interactive TUI, user can watch and intervene.
  # --replace-tab: the agent surface takes over the grid pane's default idle
  # terminal tab instead of being appended next to it (single-tab agent panes).
  SPAWN_RESULT=$(wmux agent spawn \
    --cmd "node \"$LAUNCHER\" \"$PROMPT_FILE\"" \
    --label "$AGENT_LABEL" \
    --cwd "$CWD" \
    --pane "$PANE_ID" \
    --replace-tab 2>&1)

  SPAWNED_AGENT_ID=$(parse_json "$SPAWN_RESULT" '.agentId')
  SPAWNED_SURFACE_ID=$(parse_json "$SPAWN_RESULT" '.surfaceId')

  if [ -z "$SPAWNED_AGENT_ID" ] || [ "$SPAWNED_AGENT_ID" = "null" ]; then
    echo "ERROR: Failed to spawn agent $AGENT_ID in pane $PANE_ID. Result: $SPAWN_RESULT" >&2
    IDX=$((IDX + 1))
    continue
  fi

  echo "Spawned $AGENT_ID ($AGENT_LABEL) in pane $PANE_ID"

  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  update_agent "$ORCH_DIR" "$AGENT_ID" \
    "paneId=$PANE_ID" \
    "surfaceId=$SPAWNED_SURFACE_ID" \
    "status=running" \
    "startedAt=$NOW"

  IDX=$((IDX + 1))
done < <(node "$JSON_TOOL" query "$ORCH_DIR/state.json" wave-agents-each "$WAVE_IDX")
