#!/bin/bash
# wmux Bash/Zsh Integration
# Sourced via WMUX_INTEGRATION=1 detection

export WMUX=1

# Sequence the two reports that define an ssh session's lifetime. The remote
# transport deliberately starts one backgrounded CLI process per report, so
# process startup can otherwise deliver "back at the prompt" before the ssh
# command that just finished. The receiver accepts older, unsequenced reports;
# this counter only lets it discard a late arrival from this integration.
_wmux_ssh_event_seq=0

_wmux_next_ssh_event_seq() {
    _wmux_ssh_event_seq=$((_wmux_ssh_event_seq + 1))
}

# wmux CLI shortcut — Claude Code and users can just type: wmux browser open <url>
wmux() { node "$WMUX_CLI" "$@"; }
export -f wmux

_wmux_report() {
    local msg="$1"
    # Devcontainer transport (issue #19): a shell inside a Linux container can
    # reach neither the Windows named pipe nor the host's Temp dir, so the file
    # drop below is a no-op there and the pane never reports anything. When
    # WMUX_REMOTE is set, relay the same V1 line through `wmux raw-v1` instead —
    # the `wmux` shim resolves to `node "$WMUX_CLI"`, which already speaks TCP to
    # a `wmux bridge` (issue #78). No protocol is duplicated here.
    #
    # Fire-and-forget: backgrounded with output discarded, so a slow or absent
    # bridge delays no prompt and fails no command.
    if [ -n "${WMUX_REMOTE}" ] && command -v wmux &>/dev/null; then
        ( wmux raw-v1 "$msg" >/dev/null 2>&1 & )
        return
    fi
    # Native: write to temp file for the main process to pick up
    local tmpdir="/mnt/c/Users/${USER}/AppData/Local/Temp/wmux"
    mkdir -p "$tmpdir" 2>/dev/null
    echo "$msg" >> "$tmpdir/messages"
}

_wmux_report_cwd() {
    local surface_id="${WMUX_SURFACE_ID}"
    [ -z "$surface_id" ] && return
    _wmux_report "report_pwd $surface_id $(pwd)"
}

_wmux_report_git() {
    local surface_id="${WMUX_SURFACE_ID}"
    [ -z "$surface_id" ] && return
    local branch
    branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
    if [ $? -eq 0 ] && [ -n "$branch" ]; then
        local dirty=""
        [ -n "$(git status --porcelain 2>/dev/null)" ] && dirty="dirty"
        _wmux_report "report_git_branch $surface_id $branch $dirty"
    else
        _wmux_report "clear_git_branch $surface_id"
    fi
}

_wmux_precmd() {
    local exit_code=$?
    # Back at a prompt: re-arm the once-per-cycle command report.
    _wmux_command_reported=""
    _wmux_report_cwd
    _wmux_report_git
    # 130 = SIGINT (Ctrl+C), 137 = SIGKILL, 143 = SIGTERM
    _wmux_next_ssh_event_seq
    if [ $exit_code -eq 130 ] || [ $exit_code -eq 137 ] || [ $exit_code -eq 143 ]; then
        _wmux_report "report_shell_state ${WMUX_SURFACE_ID} seq=${_wmux_ssh_event_seq} interrupted"
    else
        _wmux_report "report_shell_state ${WMUX_SURFACE_ID} seq=${_wmux_ssh_event_seq} idle"
    fi
    _wmux_report "ports_kick ${WMUX_SURFACE_ID}"
}

# Report the command line itself, so wmux can tell that this pane just ssh'd
# somewhere. That is what lets a pasted screenshot be uploaded to the remote
# host instead of having a local Windows path typed into a remote shell.
#
# Once per prompt cycle: bash drives preexec from a DEBUG trap, which fires
# for every simple command — including the ones inside PROMPT_COMMAND — so an
# unguarded report would put several lines on the pipe per keypress.
# Report an ssh command line, so wmux can tell that this pane just connected
# somewhere. That is what lets a pasted screenshot be uploaded to the remote
# host instead of having a local Windows path typed into a remote shell.
#
# EVERY path out of this function must succeed. It runs from the DEBUG trap,
# and under `shopt -s extdebug` a non-zero return there tells bash to SKIP the
# command the user just typed — so a bare `return` after a non-matching test
# would silently swallow commands in any pane where extdebug is on.
_wmux_report_command() {
    local surface_id="${WMUX_SURFACE_ID}"
    [ -z "$surface_id" ] && return 0
    # Once per prompt cycle: bash drives preexec from a DEBUG trap, which fires
    # for every simple command, including the ones inside PROMPT_COMMAND.
    [ -n "$_wmux_command_reported" ] && return 0
    local cmdline="$1"
    [ -z "$cmdline" ] && return 0

    # Only ssh. Every report costs a forked mkdir (and a backgrounded node in
    # the devcontainer branch) on the keypress path between Enter and the
    # command starting, so reporting everything would tax every command in
    # every pane to learn something only ssh can tell us. Staleness is handled
    # by the prompt: _wmux_precmd fires report_shell_state, and that is what
    # clears the session on the far side.
    #
    # Compare the basename of the first word, so an absolute path in either
    # slash flavour — and the .exe Git Bash users type — all match, while
    # `sshuttle` and `echo ssh` do not.
    local first="${cmdline%% *}"
    local base="${first##*/}"
    base="${base##*\\}"
    case "$base" in
        ssh|ssh.exe) ;;
        *) return 0 ;;
    esac

    _wmux_command_reported=1
    # The transport is line-based, so a multi-line command must arrive flat.
    _wmux_next_ssh_event_seq
    _wmux_report "report_command $surface_id seq=${_wmux_ssh_event_seq} ${cmdline//$'\n'/ }"
    return 0
}

# Report "running" before a command executes (pre-execution hook)
_wmux_preexec() {
    local surface_id="${WMUX_SURFACE_ID}"
    [ -z "$surface_id" ] && return
    _wmux_next_ssh_event_seq
    _wmux_report "report_shell_state $surface_id seq=${_wmux_ssh_event_seq} running"
    _wmux_report_command "$1"
    return 0
}

# Install hooks
if [ -n "$ZSH_VERSION" ]; then
    # Zsh: native preexec + precmd
    autoload -Uz add-zsh-hook
    add-zsh-hook precmd _wmux_precmd
    add-zsh-hook preexec _wmux_preexec
elif [ -n "$BASH_VERSION" ]; then
    # Bash: DEBUG trap as preexec, PROMPT_COMMAND as precmd
    _wmux_bash_preexec_active=0
    trap '_wmux_bash_preexec_active=1; _wmux_preexec "$BASH_COMMAND"' DEBUG
    PROMPT_COMMAND="_wmux_precmd; _wmux_bash_preexec_active=0${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
