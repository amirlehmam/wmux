/**
 * The `$BROWSER` wiring a pane gets, split out of pty-manager so it is testable
 * without loading node-pty's native module.
 */

/**
 * The `$BROWSER` target wmux installs into WSL panes.
 *
 * Deliberately the bare name, not a path: BROWSER parsers split the value on
 * whitespace, and an install path can contain spaces ("OneDrive - Pulsa"). The
 * shim lives in cli-bin, which is already prepended to PATH.
 */
export const BROWSER_SHIM_NAME = 'wmux-open-url';

/** Only WSL panes get the shim: native Windows tools cannot execute it. */
export function browserEnvFor(shellType: string): { BROWSER?: string } {
  return shellType === 'wsl' ? { BROWSER: BROWSER_SHIM_NAME } : {};
}

/**
 * Windows env vars WSL keeps. With no flag a variable crosses interop BOTH
 * ways; /u only from Windows into WSL; /p translates a Windows path to a WSL
 * mount (/mnt/c/...) on the way in and back on the way out.
 *
 * What a Windows helper started INSIDE the pane needs has no /u (#428): the
 * Claude Code hook and the bash integration's reports run Windows node.exe
 * from WSL, and with /u it never saw the surface, the pipe or the token, so
 * nothing it sent was heard. WMUX_CLI goes back out as its Windows path.
 *
 * The rest stays one-way on purpose. BROWSER is a POSIX shim Windows tools
 * cannot run. WMUX_REMOTE would send a Windows helper over the TCP bridge
 * instead of the local pipe. WMUX_WSL_NODE is the Windows runtime as a /mnt
 * path for the bash integration only: it is not WMUX_NODE, because the cli-bin
 * shim would then run node.exe on a /mnt script path it cannot open.
 */
export const WSL_ENV_PASSTHROUGH =
  'WMUX:WMUX_SURFACE_ID:WMUX_CLI/p:WMUX_PIPE:WMUX_PIPE_TOKEN:WMUX_INTEGRATION/u'
  + ':WMUX_WSL_NODE/up:WMUX_NODE_ELECTRON/u:WMUX_BASH_SCRIPT/up'
  + ':WMUX_REMOTE/u:WMUX_REMOTE_TOKEN/u:BROWSER/u';
