#!/usr/bin/env bash
# orchestration-state.sh — State management library for wmux orchestrations.
# Source this file in other scripts: source "${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-state.sh"

ORCH_BASE="${TMPDIR:-/tmp}"

# Find the active orchestration directory (most recent state.json with status "running")
find_active_orch() {
  local latest=""
  local latest_time=0
  for dir in "$ORCH_BASE"/wmux-orch-*/; do
    [ -d "$dir" ] || continue
    local state="$dir/state.json"
    [ -f "$state" ] || continue
    local status
    status=$(jq -r '.status' "$state" 2>/dev/null)
    if [ "$status" = "running" ]; then
      local mtime
      mtime=$(stat -c %Y "$state" 2>/dev/null || stat -f %m "$state" 2>/dev/null || echo 0)
      if [ "$mtime" -gt "$latest_time" ]; then
        latest="$dir"
        latest_time="$mtime"
      fi
    fi
  done
  echo "$latest"
}

# Get orchestration dir by ID
get_orch_dir() {
  local id="$1"
  echo "$ORCH_BASE/wmux-orch-$id"
}

# Create a new orchestration directory
create_orch_dir() {
  local id="$1"
  local dir="$ORCH_BASE/wmux-orch-$id"
  mkdir -p "$dir"
  echo "$dir"
}

# Acquire lock (simple file-based, 2s timeout)
acquire_lock() {
  local dir="$1"
  local lockfile="$dir/state.lock"
  local timeout=20  # 20 * 100ms = 2s
  local i=0
  while [ -f "$lockfile" ] && [ $i -lt $timeout ]; do
    sleep 0.1
    i=$((i + 1))
  done
  echo $$ > "$lockfile"
}

# Release lock
release_lock() {
  local dir="$1"
  rm -f "$dir/state.lock"
}

# Read state JSON field using jq
read_state() {
  local dir="$1"
  local query="$2"
  jq -r "$query" "$dir/state.json" 2>/dev/null
}

# Update state JSON using jq
update_state() {
  local dir="$1"
  local jq_expr="$2"
  acquire_lock "$dir"
  local tmp="$dir/state.tmp.json"
  jq "$jq_expr" "$dir/state.json" > "$tmp" && mv "$tmp" "$dir/state.json"
  release_lock "$dir"
}

# Check if all agents in a wave are completed
wave_complete() {
  local dir="$1"
  local wave_idx="$2"
  local pending
  pending=$(jq -r ".waves[$wave_idx].agents[] | select(.status != \"completed\" and .status != \"failed\") | .id" "$dir/state.json" 2>/dev/null)
  [ -z "$pending" ]
}

# Get the next pending wave index
next_pending_wave() {
  local dir="$1"
  jq -r '.waves | to_entries[] | select(.value.status == "pending") | .key' "$dir/state.json" 2>/dev/null | head -1
}

# Check if all waves are done
all_waves_done() {
  local dir="$1"
  local pending
  pending=$(jq -r '.waves[] | select(.status == "pending" or .status == "running") | .index' "$dir/state.json" 2>/dev/null)
  [ -z "$pending" ]
}
