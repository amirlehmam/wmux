# wmux PowerShell Integration
# Injected automatically by wmux

$env:WMUX = "1"

# UTF-8 I/O so multi-byte input (Korean, Japanese, Chinese, emoji, accents)
# survives the conpty round-trip cleanly.
try {
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
    $OutputEncoding = [System.Text.UTF8Encoding]::new()
    $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
} catch {}

# wmux CLI shortcut — Claude Code and users can just type: wmux browser open <url>
function wmux { node "$env:WMUX_CLI" @args }

# Named pipe client helper. State updates carry an "auth <token> " prefix —
# wmux injects WMUX_PIPE_TOKEN into every shell it spawns, and the pipe server
# rejects unauthenticated V1 commands (issue #72).
function Send-WmuxMessage {
    param([string]$Message)
    try {
        if ($env:WMUX_PIPE_TOKEN) { $Message = "auth $($env:WMUX_PIPE_TOKEN) $Message" }
        $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "wmux", [System.IO.Pipes.PipeDirection]::InOut)
        $pipe.Connect(1000)
        $writer = New-Object System.IO.StreamWriter($pipe)
        $writer.AutoFlush = $true
        $writer.WriteLine($Message)
        $pipe.Close()
    } catch {
        # Silently ignore pipe errors
    }
}

# Report CWD
function Report-Cwd {
    $surfaceId = $env:WMUX_SURFACE_ID
    if ($surfaceId) {
        Send-WmuxMessage "report_pwd $surfaceId $PWD"
    }
}

# Publish the live cwd for the PR poller.
#
# The poller runs in a child runspace, which takes the location it was created
# in and keeps it, so it needs to be told where the pane has got to. An env var
# cannot carry that: the job is already running by the time the pane moves.
#
# Nor can the pipe, which is the obvious candidate and the one to rule out
# explicitly. It runs one direction — shell to wmux — and the consumer here is
# another *shell* process, not wmux. The prompt already sends this exact value
# over as report_pwd; routing the hand-off through the pipe would mean adding
# currentCwd to the surface listing, a V2 method and a CLI verb to read it back,
# then spawning node on every 45s tick, so that the shell can ask wmux for
# something the shell itself just told it. This is a shell-to-shell hand-off, so
# it stays between the shells.
#
# The directory is the one wmux-bash-integration.sh already uses for its own
# hand-off, rather than a second scratch location.
$global:_wmux_cwd_file = if ($env:WMUX_SURFACE_ID) {
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) "wmux"
    try { $null = New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop } catch {}
    Join-Path $dir "cwd-$($env:WMUX_SURFACE_ID).txt"
} else { $null }

function Update-WmuxCwdFile {
    if (-not $global:_wmux_cwd_file) { return }
    try {
        Set-Content -LiteralPath $global:_wmux_cwd_file -Value $PWD.ProviderPath -Encoding UTF8 -ErrorAction Stop
    } catch {
        # Nothing to do — the poller just keeps its last known location.
    }
}

# What the shell owes on the way out: its own hand-off file, so a pane that
# closes leaves nothing behind. Parameterized so it can be driven directly in
# a test instead of only through a real process exit.
#
# The PR badge is deliberately NOT this function's business. A shell that is
# killed rather than asked to leave (Ctrl+W, `wmux close-pane`, closing the
# workspace) runs no exit handler at all, and a last-gasp pipe write is
# best-effort by nature — so the badge is dropped where the renderer already
# learns the process is gone: the `pty:exit` handler in useTerminal.ts, which
# heals the stuck "Running" badge and the leftover progress indicator for
# exactly the same reason. That path covers the graceful `exit` too, so there
# is nothing left here for it to do.
function Invoke-WmuxExitCleanup {
    param([string]$CwdFile)
    if ($CwdFile) {
        Remove-Item -LiteralPath $CwdFile -Force -ErrorAction SilentlyContinue
    }
}

# Hand-off files outlive panes that were killed rather than closed: a kill
# runs no exit handler, so nothing removes theirs and `<temp>\wmux` grows one
# small file per pane, forever.
#
# Age is what separates the two, and a live pane keeps its own file young from
# both ends: the prompt rewrites it on every command, and its poller touches it
# on every tick — 45 seconds apart, whether or not anyone is typing. So a file
# nothing has touched for a day belonged to a pane that is gone, and none of
# this requires asking wmux which surfaces still exist.
function Remove-StaleWmuxCwdFiles {
    param(
        [string]$Directory,
        [datetime]$OlderThan
    )
    if (-not $Directory) { return }
    try {
        Get-ChildItem -LiteralPath $Directory -Filter 'cwd-*.txt' -File -ErrorAction Stop |
            Where-Object { $_.LastWriteTime -lt $OlderThan } |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    } catch {
        # The directory may not exist yet, or may be unreadable — either way
        # there is nothing to prune and nothing worth reporting.
    }
}

$null = Register-EngineEvent -SourceIdentifier ([System.Management.Automation.PSEngineEvent]::Exiting) -Action {
    Invoke-WmuxExitCleanup -CwdFile $global:_wmux_cwd_file
}

# What a poller tick should send. Pure so the decision can be tested without a
# job, a pipe, or a GitHub repo. An empty result means "say nothing".
function Get-WmuxPrMessage {
    param(
        [string]$SurfaceId,
        [string]$PrJson,
        [int]$ExitCode,
        [bool]$InRepo,
        [bool]$Reported
    )
    # A pane standing outside a repo knows nothing about anyone else's PR, so it
    # must not speak for the workspace at large — but it does still answer for
    # the claim it made itself. Leaving that claim up is how a badge outlives
    # the repo it came from: `cd ~` clears the branch off the row and leaves the
    # PR sitting next to it. The ownership gate on the renderer side
    # (`applyPrCommand`) drops a clear from any pane that isn't the recorded
    # owner, so retracting here can only ever take down this pane's own badge.
    if (-not $InRepo) {
        if ($Reported) { return "clear_pr $SurfaceId" }
        return ""
    }

    if ($ExitCode -eq 0 -and $PrJson) {
        try {
            $pr = $PrJson | ConvertFrom-Json -ErrorAction Stop
            if ($null -ne $pr -and $pr.number) {
                return "report_pr $SurfaceId $($pr.number) $($pr.state) $($pr.title)"
            }
        } catch {
            # Fall through: unreadable output tells us nothing about the PR, and
            # whatever this pane last claimed may no longer hold.
        }
    }

    # We are looking at a branch and gh found no PR on it. Only retract a claim
    # this pane actually made: PR metadata is workspace-scoped and every pwsh
    # pane polls, so a pane clearing unconditionally would speak for panes it
    # knows nothing about — two panes in one workspace would take turns
    # reporting and clearing every 45 seconds.
    if ($Reported) { return "clear_pr $SurfaceId" }
    return ""
}

# What the poller should trust as "the pane is here" this tick. Pure other
# than reading the hand-off file, so it can be tested directly against real
# files rather than only through the job.
#
# Anything that leaves genuine doubt about where the pane currently is — the
# file missing, empty, unreadable, or naming a path that Set-Location would
# reject outright (deleted since the write, or a non-filesystem provider
# location such as `cd Env:` whose ProviderPath is not a directory at all) —
# returns $null rather than a best guess. A caller that fell back to "wherever
# the job runspace last was" would go on polling (and reporting on) a stale
# repo, which is the frozen-cwd bug this file exists to fix — the exit handler
# above deletes this same file when the shell closes, so this also stops a job
# that briefly outlives its shell from reporting on it.
function Resolve-WmuxPaneCwd {
    param([string]$CwdFile)
    if (-not $CwdFile) { return $null }
    if (-not (Test-Path -LiteralPath $CwdFile -PathType Leaf)) { return $null }
    try {
        $live = Get-Content -LiteralPath $CwdFile -Raw -ErrorAction Stop
    } catch {
        return $null
    }
    if (-not $live) { return $null }
    $live = $live.Trim()
    if (-not $live) { return $null }
    try {
        if (-not (Test-Path -LiteralPath $live -PathType Container -ErrorAction Stop)) { return $null }
    } catch {
        return $null
    }
    return $live
}

# Carries out one tick's send and updates the "did I claim this PR" flag from
# the outcome, not from the decision. The send is handed in as a scriptblock
# so this can be exercised without a live pipe: production passes the real
# named-pipe write, tests pass a stub that can be made to fail on demand.
#
# The flag must only advance on a send that actually landed. The earlier shape
# flipped it right after deciding what to send, before attempting the write —
# so a clear_pr that failed to go out (pipe not up yet, wmux busy, connect
# timeout) still left the pane believing it had nothing left to retract, and
# no later tick would ever try that clear again: the badge this file exists to
# unstick would get stuck the same way, just on the send instead of the
# decision. Leaving the flag where it was makes the next tick recompute the
# same message and retry it.
function Invoke-WmuxPrTick {
    param(
        [string]$Message,
        [bool]$CurrentlyReported,
        [scriptblock]$Send
    )
    if (-not $Message) { return $CurrentlyReported }
    $ok = $false
    try {
        $ok = [bool](& $Send $Message)
    } catch {
        $ok = $false
    }
    if (-not $ok) { return $CurrentlyReported }
    return $Message.StartsWith('report_pr')
}

# Report git branch
function Report-GitBranch {
    $surfaceId = $env:WMUX_SURFACE_ID
    if (-not $surfaceId) { return }

    try {
        $branch = git rev-parse --abbrev-ref HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $branch) {
            $dirty = ""
            $status = git status --porcelain 2>$null
            if ($status) { $dirty = "dirty" }
            Send-WmuxMessage "report_git_branch $surfaceId $branch $dirty"
        } else {
            Send-WmuxMessage "clear_git_branch $surfaceId"
        }
    } catch {
        Send-WmuxMessage "clear_git_branch $surfaceId"
    }
}

# Sequence the reports that define an SSH session's lifetime. PowerShell sends
# them synchronously today, but using the same wire shape as Bash keeps ordering
# explicit across every transport and lets the receiver reject late arrivals.
$script:WmuxSshEventSequence = 0

function Get-WmuxSshEventMarker {
    $script:WmuxSshEventSequence++
    return "seq=$($script:WmuxSshEventSequence)"
}

# Report shell state
function Report-ShellState {
    param([string]$State)
    $surfaceId = $env:WMUX_SURFACE_ID
    if ($surfaceId) {
        $sequence = Get-WmuxSshEventMarker
        Send-WmuxMessage "report_shell_state $surfaceId $sequence $State"
    }
}

# Report the command line itself, so wmux can tell that this pane just ssh'd
# somewhere. That is what lets a pasted screenshot be uploaded to the remote
# host instead of having a local Windows path typed into a remote shell.
#
# No once-per-cycle guard is needed here: unlike bash's DEBUG trap, the Enter
# handler fires exactly once per submitted line.
function Report-Command {
    $surfaceId = $env:WMUX_SURFACE_ID
    if (-not $surfaceId) { return }
    $line = $null
    $cursor = $null
    try {
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
    } catch {
        return
    }
    if (-not $line) { return }
    # Only ssh. Every report opens its own named-pipe connection from inside
    # the Enter handler, before AcceptLine, so reporting every command would
    # tax every command in every pane to learn something only ssh can tell
    # us. Staleness is handled by the prompt, which fires report_shell_state.
    # Accept bare ssh, quoted paths (including spaces), unquoted absolute paths,
    # and PowerShell's call operator. Keep the executable token exact so words
    # such as `myssh.exe` are not mistaken for the OpenSSH client.
    if ($line -notmatch '^\s*(?:&\s*"ssh(?:\.exe)?"|(?:&\s*)?"[^"]*[\\/]ssh(?:\.exe)?"|(?:&\s*)?[^\s"]*[\\/]ssh(?:\.exe)?|(?:&\s*)?ssh(?:\.exe)?)(?:\s|$)') { return }
    # The transport is line-based, so a multi-line command must arrive flat.
    $flat = $line -replace '\r?\n', ' '
    $sequence = Get-WmuxSshEventMarker
    Send-WmuxMessage "report_command $surfaceId $sequence $flat"
}

# Report "running" when user executes a command (pre-execution hook)
if (Get-Module -Name PSReadLine -ErrorAction SilentlyContinue) {
    Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
        # Report running state before the command executes
        Report-ShellState "running"
        # Read the buffer before AcceptLine clears it.
        Report-Command
        # Accept the line (execute the command)
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
}

# Override prompt (fires AFTER command completes)
$_wmux_original_prompt = $function:prompt
function prompt {
    Report-Cwd
    Update-WmuxCwdFile
    Report-GitBranch
    # Detect if last command was interrupted (Ctrl+C → exit code -1073741510 on Windows)
    if ($LASTEXITCODE -eq -1073741510 -or $LASTEXITCODE -eq 130) {
        Report-ShellState "interrupted"
    } else {
        Report-ShellState "idle"
    }
    Send-WmuxMessage "ports_kick $env:WMUX_SURFACE_ID"

    # Call original prompt or default
    if ($_wmux_original_prompt) {
        & $_wmux_original_prompt
    } else {
        "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
    }
}

# PR polling background job (every 45 seconds).
# DEFERRED: Start-Job spins up a whole child PowerShell runspace and costs
# several hundred ms — running it during init delayed the FIRST prompt. We
# instead start it on the shell's first idle (after the prompt is already on
# screen), so it never sits on the startup critical path. A global guard makes it
# fire exactly once; PR data isn't needed in the first 45s anyway.
$global:_wmux_pr_started = $false
$null = Register-EngineEvent -SourceIdentifier ([System.Management.Automation.PSEngineEvent]::OnIdle) -Action {
    if ($global:_wmux_pr_started) { return }
    $global:_wmux_pr_started = $true
    # Sweep hand-off files left behind by panes that were killed. Done here
    # rather than during init for the same reason the job is: the first prompt
    # should not wait on it.
    if ($global:_wmux_cwd_file) {
        Remove-StaleWmuxCwdFiles -Directory (Split-Path -Parent $global:_wmux_cwd_file) -OlderThan (Get-Date).AddDays(-1)
    }
    # A job runs in its own runspace and sees none of this session's functions,
    # so the tick's decision functions are carried across as its initialization.
    $_wmux_pr_init = [scriptblock]::Create("function Get-WmuxPrMessage {`n$(${function:Get-WmuxPrMessage})`n}`nfunction Resolve-WmuxPaneCwd {`n$(${function:Resolve-WmuxPaneCwd})`n}`nfunction Invoke-WmuxPrTick {`n$(${function:Invoke-WmuxPrTick})`n}")
    $global:_wmux_pr_job = Start-Job -InitializationScript $_wmux_pr_init -ScriptBlock {
        param($surfaceId, $pipeName, $pipeToken, $cwdFile)
        # Whether the PR currently on the row is this pane's own claim.
        $reported = $false
        while ($true) {
            Start-Sleep -Seconds 45
            $msg = ""
            try {
                # Follow the pane. This runspace's location is the one it was
                # created in and never moves on its own, so a pane that has
                # since cd'd into another repo would keep being answered for
                # the first one — unless the hand-off can't be trusted this
                # tick, in which case there is nothing to probe: staying on the
                # old location and reporting its PR would be answering for a
                # pane that may have moved on, or closed.
                $resolvedCwd = Resolve-WmuxPaneCwd -CwdFile $cwdFile
                if ($resolvedCwd) {
                    # Vouch for the pane. The prompt rewrites this file, but a
                    # pane can sit at an idle prompt for days, and the sweep in
                    # Remove-StaleWmuxCwdFiles reads age as "is anyone still
                    # here" — so a tick that just used the file says so, and a
                    # live pane can never be swept out from under itself.
                    try { (Get-Item -LiteralPath $cwdFile).LastWriteTime = Get-Date } catch {}
                    Set-Location -LiteralPath $resolvedCwd
                    $null = git rev-parse --git-dir 2>$null
                    $inRepo = $LASTEXITCODE -eq 0
                    $prJson = ""
                    $ghExit = 1
                    if ($inRepo) {
                        $prJson = (gh pr view --json number,state,title 2>$null) -join "`n"
                        $ghExit = $LASTEXITCODE
                    }
                    $msg = Get-WmuxPrMessage -SurfaceId $surfaceId -PrJson $prJson -ExitCode $ghExit `
                        -InRepo $inRepo -Reported $reported
                }
            } catch {
                # git or gh missing, or the location went away underneath us —
                # all of which say nothing about the PR on the row.
                $msg = ""
            }
            # The flag only moves if the send below actually lands — see
            # Invoke-WmuxPrTick for why that ordering matters.
            $reported = Invoke-WmuxPrTick -Message $msg -CurrentlyReported $reported -Send {
                param($m)
                try {
                    $line = if ($pipeToken) { "auth $pipeToken $m" } else { $m }
                    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
                    $pipe.Connect(1000)
                    $writer = New-Object System.IO.StreamWriter($pipe)
                    $writer.AutoFlush = $true
                    $writer.WriteLine($line)
                    $pipe.Close()
                    $true
                } catch {
                    $false
                }
            }
        }
    } -ArgumentList $env:WMUX_SURFACE_ID, "wmux", $env:WMUX_PIPE_TOKEN, $global:_wmux_cwd_file
}

# Quick-launch profile startup commands (issue #32).
# wmux passes these in WMUX_STARTUP_COMMANDS (newline-separated) so they run as
# part of init — before the first interactive prompt — rather than being injected
# as keystrokes afterward. Keystroke injection raced the shell's init-time
# Device Attributes query (ConPTY answers DA1 with "\e[?62;4;9;22c" on stdin);
# when that response landed on the prompt alongside an injected "<cmd>\r" the two
# merged into a bogus executed line (e.g. "62;4;9;22ccls"). Running here avoids
# that entirely. Runs last so the prompt override / PSReadLine handlers exist.
if ($env:WMUX_STARTUP_COMMANDS) {
    foreach ($_wmux_cmd in ($env:WMUX_STARTUP_COMMANDS -split "`n")) {
        $_wmux_cmd = $_wmux_cmd.Trim()
        if ($_wmux_cmd) {
            try { Invoke-Expression $_wmux_cmd } catch { Write-Error $_ }
        }
    }
    # One-shot: don't let it leak into child shells spawned from this session.
    Remove-Item Env:\WMUX_STARTUP_COMMANDS -ErrorAction SilentlyContinue
}
