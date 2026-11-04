#!/bin/sh
# wmux: Claude Code hook for a WSL distro (#428).
#
# wmux registers this in the distro's ~/.claude/settings.json (wsl-claude-hooks.ts),
# so Claude Code running INSIDE a WSL pane reports to wmux the way it does on
# Windows. Every hook command there reads
#
#   [ ! -f "${WMUX_BASH_SCRIPT%/*}/wmux-hook-wsl.sh" ] || sh "${WMUX_BASH_SCRIPT%/*}/wmux-hook-wsl.sh" <args>
#
# Outside a wmux WSL pane WMUX_BASH_SCRIPT is unset, no such file exists and the
# hook ends at once, so Claude in another terminal pays nothing. Inside one it is
# this file's /mnt path neighbour, so the command stays right when wmux moves or
# updates. The existence test, rather than `[ -z "$WMUX_BASH_SCRIPT" ]`, matters
# under a wmux that predates this file: dash exits 2 when it cannot open a
# script, and Claude Code reads exit 2 from a PreToolUse hook as "block the tool".
#
# The transport is the one the bash integration uses for its reports: Linux
# node cannot open the Windows pipe, so the Windows runtime wmux resolved for the
# pane (WMUX_WSL_NODE, a /mnt path) runs the Windows wmux-hook.js through
# interop. WSLENV carries WMUX_SURFACE_ID, WMUX_PIPE and the token back out
# (pane-browser-env.ts). Claude's payload arrives on stdin and goes straight
# through to the hook.
#
# POSIX sh, not bash: Claude Code runs hook commands with /bin/sh, which is dash
# on Debian and Ubuntu. Always exits 0 when it cannot report, as wmux-hook.js
# does when wmux is gone, so a hook never fails a Claude turn.

[ -n "${WMUX_WSL_NODE-}" ] && [ -x "$WMUX_WSL_NODE" ] && [ -n "${WMUX_CLI-}" ] || exit 0

_wmux_hook_js="$(wslpath -w "${WMUX_CLI%/*}/wmux-hook.js" 2>/dev/null)"
[ -n "$_wmux_hook_js" ] || exit 0

# wmux's own binary as the runtime (no node installed, #187) runs a script only
# under ELECTRON_RUN_AS_NODE, and interop hands it only what WSLENV names.
if [ -n "${WMUX_NODE_ELECTRON-}" ]; then
    ELECTRON_RUN_AS_NODE=1
    WSLENV="${WSLENV:+$WSLENV:}ELECTRON_RUN_AS_NODE"
    export ELECTRON_RUN_AS_NODE WSLENV
fi

exec "$WMUX_WSL_NODE" "$_wmux_hook_js" "$@"
