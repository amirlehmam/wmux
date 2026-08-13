# wmux CLI shim for PowerShell.
#
# PowerShell resolves a .ps1 ahead of every PATHEXT entry, so when this dir is on
# PATH it is THIS file — not wmux.cmd — that a bare `wmux …` runs in PowerShell,
# and cmd.exe's parser never sees the arguments.
#
# That is the whole point (issue #154). PowerShell strips the quoting the user
# wrote before invoking a .cmd, and cmd.exe then re-reads `>`, `|`, `&` and `<`
# inside free-form text as shell syntax — turning
#     wmux browser eval "document.title.length>0"
# into an evaluation whose output is redirected into a new file named `0`: exit 0,
# no output, no warning. The redirect is applied to cmd.exe's own invocation line,
# before wmux.cmd starts, so no amount of quoting inside the batch file can undo
# it; only keeping cmd.exe out of the path can. `@args` splats the arguments
# through natively, with no shell in between.
#
# Runs the Node pipe client via the $WMUX_CLI path wmux injects, falling back to
# the copy shipped next to this shim — same contract as wmux.cmd and the bash
# shim, so all three stay interchangeable.
$wmuxCli = if ($env:WMUX_CLI) { $env:WMUX_CLI } else { Join-Path $PSScriptRoot '..\cli\wmux.js' }
& node $wmuxCli @args
exit $LASTEXITCODE
