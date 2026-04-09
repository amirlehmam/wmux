#!/usr/bin/env bash
# spawn-agents.sh <orch-dir> <wave-index>
# Creates wmux panes and spawns Claude Code agents for a wave.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/orchestration-state.sh"

ORCH_DIR="$1"
WAVE_IDX="$2"

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

if [ "$WMUX_AVAILABLE" = "true" ]; then
  PANE_IDX=0
  CWD=$(read_state "$ORCH_DIR" '.cwd')
  [ -z "$CWD" ] || [ "$CWD" = "null" ] && CWD="$(pwd)"

  node "$JSON_TOOL" query "$ORCH_DIR/state.json" wave-agents-each "$WAVE_IDX" | while IFS= read -r agent; do
    [ -z "$agent" ] && continue
    AGENT_ID=$(parse_json "$agent" '.id')
    AGENT_LABEL=$(parse_json "$agent" '.label')
    PROMPT_FILE="$ORCH_DIR/agent-${AGENT_ID}-prompt.md"

    if [ $PANE_IDX -eq 0 ]; then
      RESULT=$(wmux split --right --type terminal 2>&1)
    else
      RESULT=$(wmux split --down --type terminal 2>&1)
    fi

    PANE_ID=$(parse_json "$RESULT" '.paneId')
    if [ -z "$PANE_ID" ] || [ "$PANE_ID" = "null" ]; then
      echo "ERROR: Failed to create pane for agent $AGENT_ID. wmux split returned: $RESULT" >&2
      continue
    fi

    # Interactive mode: full TUI visible in pane, user can watch and intervene
    # Step 1: spawn claude with system prompt + auto-approved tools (no initial message)
    # Step 2: after claude TUI starts, send the trigger message via wmux send
    SPAWN_RESULT=$(wmux agent spawn \
      --cmd "claude --system-prompt-file \"$PROMPT_FILE\" --allowedTools \"Read,Write,Edit,Grep,Glob,Bash\"" \
      --label "$AGENT_LABEL" \
      --cwd "$CWD" \
      --pane "$PANE_ID" 2>&1)

    SPAWNED_AGENT_ID=$(parse_json "$SPAWN_RESULT" '.agentId')
    SPAWNED_SURFACE_ID=$(parse_json "$SPAWN_RESULT" '.surfaceId')

    if [ -z "$SPAWNED_AGENT_ID" ] || [ "$SPAWNED_AGENT_ID" = "null" ]; then
      echo "ERROR: Failed to spawn agent $AGENT_ID in pane $PANE_ID. wmux agent spawn returned: $SPAWN_RESULT" >&2
      continue
    fi

    echo "Spawned agent $AGENT_ID (wmux=$SPAWNED_AGENT_ID) in pane $PANE_ID surface=$SPAWNED_SURFACE_ID"

    NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    update_agent "$ORCH_DIR" "$AGENT_ID" \
      "paneId=$PANE_ID" \
      "surfaceId=$SPAWNED_SURFACE_ID" \
      "status=running" \
      "startedAt=$NOW"

    PANE_IDX=$((PANE_IDX + 1))
  done

  # Wait for all Claude TUIs to start, then send trigger messages
  echo "Waiting for Claude TUI to initialize..."
  sleep 5

  node "$JSON_TOOL" query "$ORCH_DIR/state.json" wave-agents-each "$WAVE_IDX" | while IFS= read -r agent; do
    [ -z "$agent" ] && continue
    AGENT_ID=$(parse_json "$agent" '.id')
    SURFACE_ID=$(parse_json "$agent" '.surfaceId')
    RESULT_FILE=$(parse_json "$agent" '.resultFile')
    [ -z "$SURFACE_ID" ] || [ "$SURFACE_ID" = "null" ] && continue

    wmux send "Execute your mission. Read the relevant files, implement all changes, then write your result file at $RESULT_FILE" --surface "$SURFACE_ID" 2>&1
    sleep 1
    wmux send-key enter --surface "$SURFACE_ID" 2>&1
    echo "Sent trigger to agent $AGENT_ID on surface $SURFACE_ID"
  done
else
  echo "wmux unavailable — writing pending spawn file for degraded mode" >&2
  node "$JSON_TOOL" query "$ORCH_DIR/state.json" wave-agents "$WAVE_IDX" > "$ORCH_DIR/wave-${WAVE_IDX}-pending-spawn.json"
fi
