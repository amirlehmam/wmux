@echo off
setlocal
REM wmux CLI shim. wmux prepends this dir (cli-bin) to PATH in every shell it
REM spawns, so bare `wmux` resolves in cmd/PowerShell children too. Runs the
REM Node pipe client via the $WMUX_CLI path wmux injects; falls back to the copy
REM next to this shim. No wmux.exe in this dir, so no PATHEXT collision.
REM
REM The runtime comes from $WMUX_NODE when wmux declared one (issue #187): bare
REM `node` assumes node is installed AND on PATH, and wmux already resolved a
REM better answer at launch — down to its own Electron binary, which is Node
REM only with ELECTRON_RUN_AS_NODE set. Unset means an older wmux (or a shell it
REM did not spawn), so the old behaviour is the fallback, not an error.
if defined WMUX_NODE_ELECTRON set "ELECTRON_RUN_AS_NODE=1"
if defined WMUX_NODE (set "WMUX_NODE_BIN=%WMUX_NODE%") else (set "WMUX_NODE_BIN=node")
if defined WMUX_CLI (
  "%WMUX_NODE_BIN%" "%WMUX_CLI%" %*
) else (
  "%WMUX_NODE_BIN%" "%~dp0..\cli\wmux.js" %*
)
