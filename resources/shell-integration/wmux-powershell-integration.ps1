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
    Stop-WmuxGitWorker -Pipeline $global:_wmux_git_ps -Runspace $global:_wmux_git_runspace
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

# Which git the prompt runs, resolved once. The `git` on PATH under Git for
# Windows is the launcher in Git\cmd, which re-execs the real binary in
# Git\mingw64\bin and costs ~8 ms per spawn doing so — measured, on a prompt
# that runs git on every Enter. Going straight to the real binary skips that;
# anything else on the machine (scoop, a portable git, none at all) keeps the
# bare name and whatever PATH resolves it to.
$global:_wmux_git = if (Test-Path -LiteralPath "$env:ProgramFiles\Git\mingw64\bin\git.exe" -PathType Leaf) {
    "$env:ProgramFiles\Git\mingw64\bin\git.exe"
} else {
    'git'
}

# What the branch report should say, from ONE git spawn's output. Pure so the
# decision can be tested against captured text rather than a repo.
#
# `git status --porcelain=v2 --branch` carries both facts the row shows — the
# branch as a `# branch.head` header, dirtiness as any non-header line — where
# the previous shape spawned `rev-parse --abbrev-ref HEAD` and then `status
# --porcelain`, 49 ms of a 55 ms prompt. The wire text is unchanged, and the
# translation back to the old tokens is explicit:
#
#   * `(detached)` becomes `HEAD` — what rev-parse printed, and what App.tsx
#     stores as-is.
#   * `# branch.oid (initial)` — an unborn repo, `git init` with no commit yet
#     — clears. rev-parse had nothing to resolve there and exited 128, so the
#     row showed no branch; v2 exits 0 and would happily name the branch that
#     does not exist yet, which would change what the sidebar means.
#   * Untracked files count as dirty, exactly as before: no `-uno`.
#
# Header lines are the only ones that begin `# `; every entry line begins with
# its own type letter (`1`, `2`, `u`, `?`, `!`), so a path can never be read as
# a header.
function Get-WmuxGitBranchMessage {
    param(
        [string]$SurfaceId,
        [string[]]$Lines,
        [int]$ExitCode
    )
    if ($ExitCode -ne 0) { return "clear_git_branch $SurfaceId" }
    $branch = $null
    $dirty = ""
    foreach ($line in $Lines) {
        if ($line -eq '# branch.oid (initial)') { return "clear_git_branch $SurfaceId" }
        if ($line.StartsWith('# branch.head ')) { $branch = $line.Substring(14); continue }
        if ($line.StartsWith('# ')) { continue }
        $dirty = "dirty"
    }
    if (-not $branch) { return "clear_git_branch $SurfaceId" }
    if ($branch -eq '(detached)') { $branch = 'HEAD' }
    return "report_git_branch $SurfaceId $branch $dirty"
}

# The git call runs OFF the prompt thread, in one in-process runspace that
# lives as long as the shell. Even as a single spawn it is ~25 ms of a prompt
# that otherwise costs ~1 ms, and the user is waiting on that prompt to type.
#
# A runspace and not Start-Job: a job is a whole child pwsh.exe, several
# hundred ms to start and a process to keep — the PR poller pays that once,
# on idle, for a 45 s tick. This has to be ready on every Enter.
#
# One runspace runs one pipeline at a time, and BeginInvoke on a busy one
# throws. So the prompt never starts a worker while one is running: it drops
# the cwd into `pending` and, if a worker is up, leaves — that worker drains
# `pending` before it exits, which is also what makes two Enters 40 ms apart
# both get reported, with the second cwd winning. `running` is flipped only
# under the lock, by the prompt on the way up and by the worker on the way
# out, so there is no moment where both believe the other has it.
#
# Opened asynchronously: Open() is 5-13 ms, and nothing here belongs on the
# startup path. A prompt that arrives before the open completes — or after
# the runspace failed to be created at all — runs git synchronously instead,
# so the row is never silently blank.
$global:_wmux_git_shared = [hashtable]::Synchronized(@{ pending = $null; running = $false })
$global:_wmux_git_runspace = $null
$global:_wmux_git_ps = $null
$global:_wmux_git_handle = $null
$global:_wmux_git_worker = $null
try {
    $_wmux_rs = [runspacefactory]::CreateRunspace()
    $_wmux_rs.ThreadOptions = [System.Management.Automation.Runspaces.PSThreadOptions]::ReuseThread
    $_wmux_rs.OpenAsync()
    $global:_wmux_git_runspace = $_wmux_rs
} catch {
    $global:_wmux_git_runspace = $null
}

# What the worker runs. Built on FIRST use rather than at source time, the way
# the PR job captures its functions when it starts and not when this file is
# read: the runspace sees none of this session's functions, so the two it
# needs travel across as text, and whatever Send-WmuxMessage is by the time
# the first prompt fires is the one that goes.
function Get-WmuxGitWorkerScript {
    if (-not $global:_wmux_git_worker) {
        $global:_wmux_git_worker = @"
param(`$shared, `$git, `$surfaceId)
function Send-WmuxMessage {
$(${function:Send-WmuxMessage})
}
function Get-WmuxGitBranchMessage {
$(${function:Get-WmuxGitBranchMessage})
}
while (`$true) {
    [System.Threading.Monitor]::Enter(`$shared.SyncRoot)
    try {
        `$cwd = `$shared.pending
        `$shared.pending = `$null
        if (`$null -eq `$cwd) { `$shared.running = `$false; break }
    } finally {
        [System.Threading.Monitor]::Exit(`$shared.SyncRoot)
    }
    `$msg = "clear_git_branch `$surfaceId"
    try {
        `$out = & `$git -C `$cwd --no-optional-locks status --porcelain=v2 --branch 2>`$null
        `$msg = Get-WmuxGitBranchMessage -SurfaceId `$surfaceId -Lines `$out -ExitCode `$LASTEXITCODE
    } catch {
        # git missing, or the directory went away: the row shows no branch.
    }
    Send-WmuxMessage `$msg
}
"@
    }
    return $global:_wmux_git_worker
}

# Hand a cwd to the worker. True if it was taken; false if the caller has to
# run git itself this time (runspace not up, or a start that failed — in which
# case the claim on `running` is given back, or no worker would ever run
# again).
function Request-WmuxGitReport {
    param([string]$Cwd)
    $rs = $global:_wmux_git_runspace
    if ($null -eq $rs -or $rs.RunspaceStateInfo.State -ne 'Opened') { return $false }
    $shared = $global:_wmux_git_shared
    [System.Threading.Monitor]::Enter($shared.SyncRoot)
    try {
        $shared.pending = $Cwd
        if ($shared.running) { return $true }
        $shared.running = $true
    } finally {
        [System.Threading.Monitor]::Exit($shared.SyncRoot)
    }
    # `running` was false, so the previous worker — if there was one — has
    # already left its loop and its pipeline is finishing; it is reaped here,
    # at the one point where that is known to be imminent. The wait is bounded
    # by pipeline teardown, well under a millisecond, but a runspace cannot
    # take a new pipeline until it is done, so it is not optional. Reaping is
    # not optional either: a completed PowerShell object per prompt is a leak.
    $prev = $global:_wmux_git_ps
    if ($null -ne $prev) {
        $done = $global:_wmux_git_handle.AsyncWaitHandle.WaitOne(1000)
        if (-not $done) {
            [System.Threading.Monitor]::Enter($shared.SyncRoot)
            try { $shared.running = $false; $shared.pending = $null } finally { [System.Threading.Monitor]::Exit($shared.SyncRoot) }
            return $false
        }
        try { $null = $prev.EndInvoke($global:_wmux_git_handle) } catch {}
        try { $prev.Dispose() } catch {}
        $global:_wmux_git_ps = $null
        $global:_wmux_git_handle = $null
    }
    $ps = $null
    try {
        $ps = [powershell]::Create()
        $ps.Runspace = $rs
        $null = $ps.AddScript((Get-WmuxGitWorkerScript)).AddArgument($shared).AddArgument($global:_wmux_git).AddArgument($env:WMUX_SURFACE_ID)
        $global:_wmux_git_handle = $ps.BeginInvoke()
        $global:_wmux_git_ps = $ps
        return $true
    } catch {
        if ($ps) { try { $ps.Dispose() } catch {} }
        [System.Threading.Monitor]::Enter($shared.SyncRoot)
        try { $shared.running = $false; $shared.pending = $null } finally { [System.Threading.Monitor]::Exit($shared.SyncRoot) }
        return $false
    }
}

# The worker's half of the exit: nothing here may keep the process alive or
# leave a git behind. Driven from the Exiting handler below.
function Stop-WmuxGitWorker {
    param($Pipeline, $Runspace)
    if ($null -ne $Pipeline) {
        try { $Pipeline.Stop() } catch {}
        try { $Pipeline.Dispose() } catch {}
    }
    if ($null -ne $Runspace) {
        try { $Runspace.Dispose() } catch {}
    }
}

# Report git branch.
#
# --no-optional-locks: this runs on every prompt, unasked, and a status that
# refreshes the index takes .git/index.lock to write it back — which is the
# lock the `git commit` the user is typing needs. git documents the flag for
# exactly this (BACKGROUND REFRESH), and it costs nothing measurable.
#
# The worker is told WHERE with `git -C`, since its runspace has a location of
# its own that never follows the pane. The directory handed over is the one a
# native command started from this thread gets: the session's current
# FILESYSTEM location, as a provider path. Not $PWD, which can be a PSDrive
# spelling git has never heard of; and not the process directory, which
# PowerShell never moves — `cd` changes the session's location only, and the
# host passes that to each native process it starts. Off the filesystem
# provider entirely (`cd Env:`) $PWD.ProviderPath is empty, while the
# filesystem location is still wherever the pane last was — which is exactly
# what git answered for when it ran here, so the row keeps saying the same
# thing.
function Report-GitBranch {
    $surfaceId = $env:WMUX_SURFACE_ID
    if (-not $surfaceId) { return }

    $cwd = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath
    if (Request-WmuxGitReport -Cwd $cwd) { return }

    try {
        $out = & $global:_wmux_git --no-optional-locks status --porcelain=v2 --branch 2>$null
        Send-WmuxMessage (Get-WmuxGitBranchMessage -SurfaceId $surfaceId -Lines $out -ExitCode $LASTEXITCODE)
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

# ---------------------------------------------------------------------------
# OSC 133 — semantic prompt marks (issue #207)
#
# Everything above this point reports out of band, over the named pipe, and that
# is the right shape for facts wmux only has to learn eventually. Prompt
# boundaries are not one of those. Their consumer is xterm's parser, which has
# to know where the prompt ended at the exact byte offset in the stream; a pipe
# message that lands a few milliseconds later can no longer say which row that
# was, because rows keep arriving in between.
#
# The spelling is FinalTerm's — the same marks iTerm2, VS Code, WezTerm, kitty
# and Windows Terminal emit — so a pane running somebody else's integration
# feeds wmux exactly the boundaries this file does.
# ---------------------------------------------------------------------------

# Whether a C has gone out with no D behind it yet. D only means anything as the
# other half of a C: an empty Enter runs no command but does run the prompt, so
# an unconditional D would report a command that never existed, carrying the
# PREVIOUS command's exit status.
$global:_wmux_command_open = $false

# The mark bytes themselves, as a string. An empty string when this shell is not
# in a wmux pane, so callers can splice the result in unconditionally.
#
# ST is ESC \ and not BEL. Both close an OSC string, but BEL is a bell on every
# terminal that takes it at face value, and a prompt that dings once per command
# is not a feature.
#
# [char]0x1b rather than PowerShell 7's `e escape: wmux spawns whichever
# PowerShell the user configured, and Windows PowerShell 5.1 renders `e as a
# literal "e".
function Get-WmuxPromptMark {
    param([string]$Payload)
    if (-not $env:WMUX_SURFACE_ID) { return '' }
    $esc = [char]0x1b
    return "$esc]133;$Payload" + $esc + '\'
}

# C and D go to the console directly. They mark points in the OUTPUT stream, not
# points in a prompt, so there is no string for them to travel inside — and
# writing them through the success stream from anywhere reachable by `prompt`
# would concatenate them into what the host draws.
function Write-WmuxPromptMark {
    param([string]$Payload)
    $mark = Get-WmuxPromptMark $Payload
    if ($mark) { [Console]::Write($mark) }
}

# Which of PowerShell's two "did that work" answers ends up in D.
#
# They are different questions, and only one of them is always answerable.
# $LASTEXITCODE is the process exit code of the last NATIVE executable: it says
# nothing at all about `Get-Item nope` failing, and it is sticky — it keeps
# whatever the last native command left there, so reading it after a failed
# cmdlet reports a number git produced ten commands ago. $? is the only signal
# that covers native commands and cmdlets alike, but it is just a boolean.
#
# So $? decides success or failure, and $LASTEXITCODE is consulted only to put a
# more useful number on a failure it can plausibly explain. A failed cmdlet with
# a stale non-zero $LASTEXITCODE therefore reports that stale code — still a
# failure, which is the part every consumer acts on — and a failed cmdlet with a
# clean $LASTEXITCODE reports 1. Reporting $LASTEXITCODE alone would have been
# the one unacceptable outcome: it calls every failed cmdlet a success.
function Get-WmuxExitStatus {
    param(
        [bool]$Succeeded,
        $NativeExitCode
    )
    if ($Succeeded) { return 0 }
    if ($NativeExitCode -is [int] -and $NativeExitCode -ne 0) { return $NativeExitCode }
    return 1
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

# C is the only mark that comes from the read-line hook, and it has to.
#
# C means "the line was submitted, output starts here". Emitting it from the
# Enter handler above would put it BEFORE AcceptLine echoes the newline, so the
# mark would land on the input row instead of the first output row and every
# consumer anchored on it would be one row out. Here the original read-line has
# already returned, so the cursor is where the output is about to appear.
#
# B used to be emitted here too, on the reasoning that PSConsoleHostReadLine is
# the seam between the prompt being drawn and the first keystroke. It is — but
# only for prompts that are followed by a read-line. PSReadLine's ClearScreen
# (Ctrl+L, a routine keystroke) does not end the read-line it is in the middle
# of: it calls InvokePrompt(), which re-runs `prompt` ALONE and never re-enters
# this function. So A came out once per prompt while B came out once per
# submitted line, and every Ctrl+L left an A with no B behind it — enough for
# the #207 consumers to discard the command typed next, which gets no outline
# entry, no highlight and no anchor. B now travels inside the prompt string,
# where it is emitted by whatever draws the prompt; see the prompt function.
#
# Re-sourcing this file (a nested shell, a re-read profile) must not wrap the
# wrapper: the second copy's "original" would be the first copy, which calls the
# name about to be redefined — infinite recursion on the next keystroke, not
# merely a duplicated mark. Guarded with a global flag, the way the PR job is.
# The capture lives INSIDE the guard for the same reason: doing it outside would
# re-point the "original" at our own wrapper even with the redefinition skipped.
if (-not $global:_wmux_readline_hooked -and
    (Get-Command -Name PSConsoleHostReadLine -CommandType Function -ErrorAction SilentlyContinue)) {
    $global:_wmux_readline_hooked = $true
    $_wmux_original_readline = $function:PSConsoleHostReadLine
    function PSConsoleHostReadLine {
        $line = & $_wmux_original_readline
        # A blank line is submitted without running anything, so it opens no
        # command and must not claim one.
        if (-not [string]::IsNullOrWhiteSpace($line)) {
            $global:_wmux_command_open = $true
            Write-WmuxPromptMark 'C'
        }
        $line
    }
}

# Override prompt (fires AFTER command completes)
#
# Guarded for the same reason the read-line hook above is: a second wrapper would
# capture the first as its "original", and calling it would call the name being
# redefined — infinite recursion on the very next prompt.
if (-not $global:_wmux_prompt_hooked) {
    $global:_wmux_prompt_hooked = $true
    $_wmux_original_prompt = $function:prompt
    function prompt {
        # Both of these answer for the command the user just ran, and both are
        # about to be destroyed — so they are read before anything else in this
        # function, including the reporting below.
        #
        # $? is overwritten by the very next statement, whatever it is.
        # $LASTEXITCODE needs the same treatment for a less obvious reason:
        # anything below that runs a native command sets it, so anything
        # reading it further down is reading that command's exit code and
        # calling it the user's. That was a live bug in the interrupted check
        # below while Report-GitBranch ran git on this thread; it runs git on
        # a worker now, but keeps a synchronous fallback, and the capture is
        # what makes the check correct on either path.
        $_wmux_ok = $global:?
        $_wmux_native_exit = $LASTEXITCODE

        if ($global:_wmux_command_open) {
            $global:_wmux_command_open = $false
            $_wmux_status = Get-WmuxExitStatus -Succeeded $_wmux_ok -NativeExitCode $_wmux_native_exit
            Write-WmuxPromptMark "D;$_wmux_status"
        }

        Report-Cwd
        Update-WmuxCwdFile
        Report-GitBranch
        # Detect if last command was interrupted (Ctrl+C → exit code -1073741510 on Windows)
        if ($_wmux_native_exit -eq -1073741510 -or $_wmux_native_exit -eq 130) {
            Report-ShellState "interrupted"
        } else {
            Report-ShellState "idle"
        }
        Send-WmuxMessage "ports_kick $env:WMUX_SURFACE_ID"

        # A and B are RETURNED, wrapped around the prompt, rather than written to
        # the console from in here. That placement is the fix for the Ctrl+L
        # defect in #207, and it fixes two things at once.
        #
        # Reliability: PSReadLine's ClearScreen re-runs this function alone,
        # through InvokePrompt(), without ending the read-line it is inside — so
        # a B that came from the read-line wrapper never arrived for that prompt.
        # Anything that draws the prompt now draws B with it, because B is part
        # of what "the prompt" is.
        #
        # Position: InvokePrompt evaluates `prompt` FIRST and homes the cursor
        # only afterwards, so a console write put A on whichever row the cursor
        # happened to be on before the screen was cleared. The host writes the
        # returned string after positioning, so the marks travel with the prompt
        # they describe.
        #
        # This is the arrangement the earlier code avoided, for fear of handing
        # PSReadLine a prompt whose escape bytes it would have to recognise as
        # zero-width — the bug `\[ \]` exists to prevent in bash. That fear does
        # not apply here: PSReadLine takes its initial coordinates from the
        # console cursor AFTER the host has written the prompt, and an OSC string
        # moves the cursor nowhere. Checked, not assumed — a wrapping command
        # line driven through a real pwsh under a pty produced a byte-for-byte
        # identical stream of PSReadLine cursor movements with the marks in the
        # prompt and with no marks at all.
        #
        # C is deliberately NOT here: it means "output starts here", and only the
        # read-line wrapper runs at a point where AcceptLine has already echoed
        # the newline.
        #
        # The wrapping survives oh-my-posh, Starship and PSReadLine because of
        # WHERE this file runs, not because of anything it does about them: all
        # three install their own `prompt` from the profile, and PowerShell reads
        # the profile before the -Command that dot-sources this file, so the
        # function captured above is already theirs. A prompt installed AFTER
        # this file — a hand-run `oh-my-posh init pwsh | iex` — replaces this
        # wrapper wholesale and takes the pipe reporting above with it; the marks
        # are no worse off than the rest of the integration.
        $_wmux_body = if ($_wmux_original_prompt) {
            & $_wmux_original_prompt
        } else {
            "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
        }
        # A prompt function is free to emit more than one object. The marks have
        # to sit outside all of them, so flatten before wrapping.
        "$(Get-WmuxPromptMark 'A')$($_wmux_body -join '')$(Get-WmuxPromptMark 'B')"
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
