# wmux PowerShell Integration
# Injected automatically by wmux

$env:WMUX = "1"

# Named pipe client helper
function Send-WmuxMessage {
    param([string]$Message)
    try {
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

# Report shell state
function Report-ShellState {
    param([string]$State)
    $surfaceId = $env:WMUX_SURFACE_ID
    if ($surfaceId) {
        Send-WmuxMessage "report_shell_state $surfaceId $State"
    }
}

# Override prompt
$_wmux_original_prompt = $function:prompt
function prompt {
    Report-Cwd
    Report-GitBranch
    Report-ShellState "idle"
    Send-WmuxMessage "ports_kick $env:WMUX_SURFACE_ID"

    # Call original prompt or default
    if ($_wmux_original_prompt) {
        & $_wmux_original_prompt
    } else {
        "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
    }
}

# PR polling background job (every 45 seconds)
$_wmux_pr_job = Start-Job -ScriptBlock {
    param($surfaceId, $pipeName)
    while ($true) {
        Start-Sleep -Seconds 45
        try {
            $prJson = gh pr view --json number,state,title 2>$null
            if ($LASTEXITCODE -eq 0 -and $prJson) {
                $pr = $prJson | ConvertFrom-Json
                $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
                $pipe.Connect(1000)
                $writer = New-Object System.IO.StreamWriter($pipe)
                $writer.AutoFlush = $true
                $writer.WriteLine("report_pr $surfaceId $($pr.number) $($pr.state) $($pr.title)")
                $pipe.Close()
            }
        } catch { }
    }
} -ArgumentList $env:WMUX_SURFACE_ID, "wmux"
