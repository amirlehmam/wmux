// Path- and shell-namespace helpers shared by main and renderer.
//
// A wmux workspace can hold panes living in two different filesystems at once:
// Win32 (pwsh/cmd) and POSIX (wsl, and devcontainer shells reached through it).
// Both report their directory over the same `report_pwd`, so anything that
// stores or consumes a workspace-level cwd has to know which namespace a path
// belongs to. Keeping the predicate here rather than in pty-manager.ts lets the
// renderer apply the same rule the PTY layer does, instead of re-deriving it.

/**
 * A POSIX/WSL path (e.g. /home/user/project restored from session.json — issue
 * #60). Such a path is NOT a valid working dir for a Win32 process and makes
 * pty.spawn fail with error 267 (ERROR_DIRECTORY). Win32 paths are drive-rooted
 * (C:\...) or UNC (\\server\...); a leading forward slash means POSIX.
 */
export function isPosixPath(p: string): boolean {
  return p.startsWith('/') && !p.startsWith('//');
}

/**
 * A path as a HUMAN typed it, turned into one the OS can open (issue #205).
 *
 * Every other cwd wmux handles was produced by a machine — session.json, a
 * `report_pwd`, `--cwd` from a script, a split inheriting its parent — and is
 * already absolute. The default-starting-path setting is the one place a person
 * types a directory into wmux, and people type `~` and `%USERPROFILE%\dev`.
 * Neither is a thing CreateProcess understands: unexpanded, both die in
 * resolveSpawnCwd's stat and silently land the pane in %USERPROFILE%.
 *
 * `~` is expanded FIRST and only in the leading position. Doing vars first
 * would let a variable whose value happens to start with `~` become a home
 * reference the user never wrote; and `C:\a~b` is a legal Windows directory
 * name, so a global replace would corrupt real paths.
 *
 * An UNSET %VAR% is deliberately left literal rather than collapsed to nothing.
 * `%PROJECTS%\wmux` with PROJECTS unset would otherwise become `\wmux` — a real
 * directory on the current drive — and the pane would open somewhere plausible
 * and wrong. Left as-is it fails the stat downstream, which falls back to the
 * home directory AND logs the path it could not use.
 */
export function expandPathVars(p: string, env: Record<string, string | undefined>): string {
  let out = p.trim();
  if (!out) return '';

  // USERPROFILE on Windows, HOME for the POSIX shells reached through wsl.exe.
  const home = env.USERPROFILE || env.HOME;
  if (home && (out === '~' || out.startsWith('~/') || out.startsWith('~\\'))) {
    out = home + out.slice(1);
  }

  return out.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (whole, name: string) => {
    // Windows env lookup is case-insensitive; process.env on Windows already
    // answers either case, but an injected env in a test may not.
    const value = env[name] ?? env[name.toUpperCase()];
    return value === undefined ? whole : value;
  });
}

/**
 * Whether a shell command line opens a POSIX filesystem rather than a Win32 one.
 *
 * Deliberately the same substring test `getShellType` in pty-manager.ts uses, so
 * the renderer's idea of "this pane lives in WSL" cannot drift from the one the
 * spawn path acts on. An 'unknown' spec (a remote command line such as
 * `ssh user@host`, issue #78) is not treated as WSL — wmux does not know where
 * that lands, and guessing POSIX would send it a path it cannot open.
 */
export function isWslShell(shell: string | undefined): boolean {
  return !!shell && shell.toLowerCase().includes('wsl');
}

/**
 * The workspace-metadata patch for a `report_pwd` from some pane.
 *
 * `cwd` stays last-writer-wins — it is what the sidebar shows, and the most
 * recent prompt is the honest answer there. `posixCwd` is additive and only
 * ever written by a POSIX report, so a pwsh pane reporting C:\Users\<user>
 * cannot erase the WSL fallback its neighbours depend on. Omitting the key
 * (rather than writing undefined) is the whole point: updateWorkspaceMetadata
 * spreads the patch, so a present-but-undefined key would clear it.
 */
export function cwdReportPatch(pwd: string | undefined): { cwd?: string; posixCwd?: string } {
  return { cwd: pwd, ...(pwd && isPosixPath(pwd) ? { posixCwd: pwd } : {}) };
}

/**
 * The workspace-level cwd a surface should spawn in when it has none of its own
 * — picked to match the surface's filesystem namespace.
 *
 * A surface only carries its own `cwd` once shell integration has reported a
 * prompt (frozen into the tree by freezeSurfaceCwds at save time). Plain WSL
 * panes never report — wmux exports WMUX_INTEGRATION=1 into the distro but
 * installs no rc hook there — so in practice they live on this fallback for
 * their whole life, which is why handing them the wrong namespace is not a
 * corner case.
 *
 * For a WSL surface, deliberately returns undefined rather than a Win32 path
 * when no POSIX directory is known: `--cd C:\Users\<user>` is not something
 * wsl.exe can honour, so there is nothing to gain by passing it, and undefined
 * keeps the intent ("we do not know") legible downstream.
 */
export function workspaceFallbackCwd(
  shell: string | undefined,
  workspace: { cwd?: string; posixCwd?: string } | null | undefined,
): string | undefined {
  if (!workspace) return undefined;
  if (!isWslShell(shell)) return workspace.cwd;
  if (workspace.posixCwd) return workspace.posixCwd;
  return workspace.cwd && isPosixPath(workspace.cwd) ? workspace.cwd : undefined;
}
