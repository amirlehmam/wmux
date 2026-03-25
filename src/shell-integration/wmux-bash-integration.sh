#!/bin/bash
# wmux Bash/Zsh Integration
# Sourced via WMUX_INTEGRATION=1 detection

export WMUX=1

_wmux_report() {
    local msg="$1"
    # Write to temp file for main process to pick up
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
    _wmux_report_cwd
    _wmux_report_git
    _wmux_report "report_shell_state ${WMUX_SURFACE_ID} idle"
    _wmux_report "ports_kick ${WMUX_SURFACE_ID}"
}

# Install hooks
if [ -n "$ZSH_VERSION" ]; then
    # Zsh
    autoload -Uz add-zsh-hook
    add-zsh-hook precmd _wmux_precmd
elif [ -n "$BASH_VERSION" ]; then
    # Bash
    PROMPT_COMMAND="_wmux_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
