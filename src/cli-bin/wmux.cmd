@echo off
REM wmux CLI shim. wmux prepends this dir (cli-bin) to PATH in every shell it
REM spawns, so bare `wmux` resolves in cmd/PowerShell children too. Runs the
REM Node pipe client via the $WMUX_CLI path wmux injects; falls back to the copy
REM next to this shim. No wmux.exe in this dir, so no PATHEXT collision.
if defined WMUX_CLI (
  node "%WMUX_CLI%" %*
) else (
  node "%~dp0..\cli\wmux.js" %*
)
