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
# on Debian and Ubuntu. Always exits 0, whatever happened, so a hook never fails
# or blocks a Claude turn (see the last line).

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

# `--host wsl` marks the session id as living in this distro's ~/.claude, not
# Windows'. Startup prunes ids without a transcript, and it can only read the
# Windows one; without the mark every WSL conversation looked dead there and
# restore never typed its `claude --resume` (#428).
#
# Not `exec`: the runtime's status must never become the hook's. With interop
# off (`[interop] enabled=false`, or systemd dropping the WSLInterop binfmt) the
# kernel refuses the Windows binary, and dash and busybox then retry it as a
# shell script, which ends in a syntax error: exit 2, which Claude Code reads as
# "block the tool" on PreToolUse and "do not stop" on Stop.
"$WMUX_WSL_NODE" "$_wmux_hook_js" "$@" --host wsl
exit 0
