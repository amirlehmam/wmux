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

# One git spawn per prompt, not two. `status --porcelain=v2 --branch` carries
# both facts the row shows — the branch as a `# branch.head` header, dirtiness
# as any non-header line — where `rev-parse --abbrev-ref HEAD` followed by
# `status --porcelain` paid a second fork for the same answer. The wire text is
# unchanged; the translation back to the old tokens is spelled out below:
# `(detached)` is what rev-parse printed as `HEAD`, and `# branch.oid (initial)`
# is an unborn repo, where rev-parse had nothing to resolve and the row showed
# no branch — v2 exits 0 there and would name a branch that does not exist yet.
# Untracked files count as dirty, exactly as before: no `-uno`.
#
# --no-optional-locks because this runs unasked on every prompt, and a status
# that refreshes the index takes .git/index.lock — the lock the `git commit`
# being typed needs. Parsed with builtins: the whole point is fewer forks.
_wmux_report_git() {
    local surface_id="${WMUX_SURFACE_ID}"
    [ -z "$surface_id" ] && return
    local out line branch="" dirty=""
    if out=$(git --no-optional-locks status --porcelain=v2 --branch 2>/dev/null); then
        while IFS= read -r line; do
            case "$line" in
                '# branch.oid (initial)') branch=""; break ;;
                '# branch.head '*) branch="${line#'# branch.head '}" ;;
                '# '*) ;;
                *) dirty="dirty" ;;
            esac
        done <<< "$out"
    fi
    if [ -n "$branch" ]; then
        [ "$branch" = "(detached)" ] && branch="HEAD"
        _wmux_report "report_git_branch $surface_id $branch $dirty"
    else
        _wmux_report "clear_git_branch $surface_id"
    fi
}

# ---------------------------------------------------------------------------
# OSC 133 — semantic prompt marks (issue #207)
#
# Everything above this point reports out of band, through the temp-file drop or
# the bridge, and that is the right shape for facts wmux only has to learn
# eventually. Prompt boundaries are not one of those. Their consumer is xterm's
# parser, which has to know where the prompt ended at the exact byte offset in
# the stream; a message that arrives a few milliseconds later can no longer say
# which row that was, because rows keep arriving in between.
#
# The spelling is FinalTerm's — the same marks iTerm2, VS Code, WezTerm, kitty
# and Windows Terminal emit — so a pane running somebody else's integration
# feeds wmux exactly the boundaries this file does.
# ---------------------------------------------------------------------------

_wmux_esc=$'\033'

# The non-printing brackets — and the ST spelling that survives the prompt
# decoder — for the shell we are actually in.
#
# ST is ESC \ throughout and never BEL. Both close an OSC string, but BEL is a
# bell on every terminal that takes it at face value, and a prompt that dings
# once per command is not a feature. That choice is what makes the rest of this
# comment necessary: BEL would have been a single unremarkable byte.
#
# This is the part of the feature that can do real damage. A and B live INSIDE
# PS1, and readline sizes the prompt by counting what is in it: escape bytes
# counted as printable make it believe the cursor sits further right than it
# does, and the first command line long enough to reach the right margin gets
# redrawn on top of itself. `\[ \]` in bash and `%{ %}` in zsh are how each shell
# is told "these bytes occupy no columns" — they are not decoration, and a mark
# emitted without them is worse than no mark at all.
#
# Bracketing alone is not enough in bash, which is the trap here. bash decodes
# the CONTENTS of `\[ \]` as well, and there a lone backslash starts an escape:
# ST's trailing `\` pairs with the `\` of the `\]` that should close the region,
# leaving the region OPEN to the end of the prompt. readline then treats the
# whole prompt as zero-width and produces exactly the wrapping corruption the
# brackets exist to prevent. `\\` decodes to the single backslash ST needs and
# leaves `\]` intact. zsh's prompt expansion is `%`-based and passes backslashes
# through untouched, so there the plain form is the correct one.
if [ -n "$ZSH_VERSION" ]; then
    _wmux_np_open='%{'
    _wmux_np_close='%}'
    _wmux_ps1_st="${_wmux_esc}\\"
else
    _wmux_np_open='\['
    _wmux_np_close='\]'
    _wmux_ps1_st="${_wmux_esc}\\\\"
fi
_wmux_mark_a="${_wmux_esc}]133;A${_wmux_ps1_st}"
_wmux_mark_b="${_wmux_esc}]133;B${_wmux_ps1_st}"

# C and D are written straight to the terminal rather than parked in a prompt,
# because neither one sits in a prompt: C goes out once the user's line has been
# echoed and before the command's first byte of output, D once the command has
# finished. printf is a builtin, so this adds no fork to the keypress path
# between Enter and the command starting — the same cost argument that keeps
# _wmux_report_command down to ssh.
_wmux_osc133() {
    [ -z "${WMUX_SURFACE_ID}" ] && return 0
    printf '\033]133;%s\033\\' "$1"
    return 0
}

# Whether the prompt hook is still allowed to open a command this cycle, and
# whether a C is currently waiting for its D.
#
# The two are initialised differently on purpose, because re-sourcing this file
# is a normal event for bash — the user owns the `source` line, so `source
# ~/.bashrc` re-runs everything here in the middle of a live session. At that
# moment the arm is genuinely spent: the `source` itself is the command that
# consumed it. But a C HAS gone out for that same `source`, and it still owes its
# D, so clearing the open flag here would strand it and leave every #207 consumer
# with a command that never ends. Keep whatever the running shell already knew.
_wmux_prompt_armed=""
_wmux_command_open="${_wmux_command_open-}"

# Wrap A and B around whatever the prompt currently is.
#
# Re-applied every cycle rather than once at source time, because a prompt
# framework — Starship, oh-my-posh, a bash theme — rebuilds PS1 from scratch
# inside PROMPT_COMMAND, long after this file was sourced, and would drop the
# marks on the floor. The `case` makes re-application a no-op once the marks are
# in place, so a PS1 nobody rewrites is wrapped exactly once instead of growing
# a fresh pair of marks per prompt.
_wmux_apply_prompt_marks() {
    [ -z "${WMUX_SURFACE_ID}" ] && return 0
    case "$PS1" in
        *"${_wmux_mark_a}"*) return 0 ;;
    esac
    PS1="${_wmux_np_open}${_wmux_mark_a}${_wmux_np_close}${PS1}${_wmux_np_open}${_wmux_mark_b}${_wmux_np_close}"
    return 0
}

# Open a command: the line was submitted, its output starts on this row.
#
# EVERY path out must succeed, for the reason spelled out on
# _wmux_report_command: this runs from the DEBUG trap, where a non-zero return
# under `shopt -s extdebug` tells bash to skip the command the user just typed.
_wmux_mark_output_start() {
    [ -z "$_wmux_prompt_armed" ] && return 0
    # bash announces PROMPT_COMMAND's own statements through the very same DEBUG
    # trap it announces the user's command through. The arm is therefore taken
    # away by _wmux_precmd, the first thing PROMPT_COMMAND runs — but the trap
    # fires for that call itself while the arm is still in place, and on an empty
    # Enter (nothing ran, so nothing consumed the arm) that would open a command
    # at the prompt and leave every consumer anchored on a row where no output
    # will ever appear. Naming the one statement that can reach here still armed
    # is exact, and far cheaper than bash-preexec's scan of every PROMPT_COMMAND
    # entry on each keypress.
    case "$1" in
        _wmux_precmd*) return 0 ;;
    esac
    _wmux_prompt_armed=""
    _wmux_command_open=1
    _wmux_osc133 "C"
    return 0
}

# Close it. Only ever the other half of a C: an empty Enter runs no command but
# does run the prompt, so an unconditional D would report a command that never
# existed, carrying the *previous* command's exit status.
_wmux_mark_command_end() {
    [ -z "$_wmux_command_open" ] && return 0
    _wmux_command_open=""
    _wmux_osc133 "D;$1"
    return 0
}

# Re-arm, and re-assert the prompt marks, as the last thing before the prompt is
# drawn. Both halves have to be last, for different reasons: PS1 so that a
# framework rebuilding it earlier in PROMPT_COMMAND does not win, and the arm so
# that none of PROMPT_COMMAND's own statements can consume it on the way past.
_wmux_arm_prompt() {
    _wmux_apply_prompt_marks
    _wmux_prompt_armed=1
}

# Everything bash's PROMPT_COMMAND owes at the tail of the cycle, as ONE
# statement.
#
# Folding is not tidiness. bash announces every TOP-LEVEL PROMPT_COMMAND
# statement through the very same DEBUG trap it announces the user's command
# through, and _wmux_preexec reports "running" — a forked mkdir under Git Bash
# and WSL, plus a message on the pipe — before any of its guards can apply. So a
# second top-level statement here is not free bookkeeping: it is one extra fork
# and one extra pipe message on every prompt, in every pane, forever. Statements
# INSIDE a function cost nothing, because bash does not propagate the DEBUG trap
# into functions unless functrace is on. That is the same cost argument that
# keeps _wmux_report_command down to ssh, and it is why the arming added for
# #207 lives in here rather than beside the flag reset.
_wmux_bash_precmd_tail() {
    _wmux_bash_preexec_active=0
    _wmux_arm_prompt
}

_wmux_precmd() {
    local exit_code=$?
    # Shut the gate for the whole of PROMPT_COMMAND — see _wmux_mark_output_start
    # — and settle the command that just finished before anything below runs a
    # subprocess of its own.
    _wmux_prompt_armed=""
    _wmux_mark_command_end "$exit_code"
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
    # First, and before any reporting: readline has already echoed the newline,
    # so the cursor is sitting exactly where the command's output will land.
    _wmux_mark_output_start "$1"
    _wmux_next_ssh_event_seq
    _wmux_report "report_shell_state $surface_id seq=${_wmux_ssh_event_seq} running"
    _wmux_report_command "$1"
    return 0
}

# Install hooks.
#
# Gated on whether the hooks are STILL INSTALLED, never on whether this file has
# run before. wmux does not own the `source` line for bash — the user puts it in
# their own .bashrc, and pty-manager.ts injects an integration script only for
# powershell and cmd — so `source ~/.bashrc` re-runs this file in the same shell.
# Any rc that ASSIGNS PROMPT_COMMAND (a prompt theme, or a plain
# `PROMPT_COMMAND='...'`) wipes the wrapper on the way past, and a "have I ever
# run" latch would then refuse to put it back. The damage is not a missing mark:
# the DEBUG trap survives, so _wmux_preexec keeps firing `report_shell_state
# running` while _wmux_precmd never runs again — the pane sticks on "running"
# with a frozen cwd and git branch forever, and _wmux_command_reported stays
# latched at 1 so ssh command lines stop being reported at all, which is the
# "reported" layer src/main/ssh-detect.ts relies on for remote paste and drop.
#
# Re-checking state keeps the property the latch existed for. Registering
# _wmux_precmd twice would hang a second precmd off every prompt, and with the
# OSC 133 marks in the picture (#207) that is no longer merely wasteful — two
# precmds mean the D for a command goes out twice — so a PROMPT_COMMAND that
# still names _wmux_precmd is left exactly as it is.
if [ -n "$ZSH_VERSION" ]; then
    # Zsh: native preexec + precmd. add-zsh-hook de-duplicates by function name,
    # so it is already idempotent and needs no gate of its own. zsh runs precmd
    # hooks in registration order, so _wmux_arm_prompt is registered last for the
    # same reason it is the last entry in bash's PROMPT_COMMAND below.
    autoload -Uz add-zsh-hook
    add-zsh-hook precmd _wmux_precmd
    add-zsh-hook precmd _wmux_arm_prompt
    add-zsh-hook preexec _wmux_preexec
elif [ -n "$BASH_VERSION" ]; then
    # Bash: DEBUG trap as preexec, PROMPT_COMMAND as precmd. The two are checked
    # separately because they are lost separately — an rc assignment takes
    # PROMPT_COMMAND and leaves the trap (the case above), while a framework that
    # installs its own preexec, as bash-preexec does, takes the trap and leaves
    # PROMPT_COMMAND. `trap -p` costs one fork, paid once per source rather than
    # once per prompt, which is the budget the rest of this file keeps to.
    case "$(trap -p DEBUG)" in
        *_wmux_preexec*) ;;
        *) trap '_wmux_bash_preexec_active=1; _wmux_preexec "$BASH_COMMAND"' DEBUG ;;
    esac
    case "${PROMPT_COMMAND-}" in
        *_wmux_precmd*) ;;
        *)
            _wmux_bash_preexec_active=0
            # The tail goes after any PROMPT_COMMAND the user already had, not
            # before it: see _wmux_bash_precmd_tail and _wmux_arm_prompt for why
            # everything it does has to be the last to happen before the prompt
            # appears.
            PROMPT_COMMAND="_wmux_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND};_wmux_bash_precmd_tail"
            ;;
    esac
fi
