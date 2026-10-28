import * as path from 'path';

// ─── Git Bash resolution (issue #252) ────────────────────────────────────────
//
// Settings → Workspace → Default shell offers "Git Bash" and stores the bare
// name `bash.exe`. That name was resolved with `where bash.exe` against wmux's
// OWN PATH, and Git for Windows does not put its bash there: the installer's
// default adds only `<Git>\cmd` (git.exe, no bash). The reporter's shell found
// `C:\Program Files\Git\usr\bin\bash.exe` because a Git Bash session adds
// `usr\bin` to its own PATH — wmux, launched from the Start menu, never has it.
// So one of two things happened, and neither was Git Bash:
//
//   * no WSL: `where` misses, resolveShell falls back to pwsh with a
//     console.warn nobody sees — "the setting has no effect";
//   * WSL installed: `where` answers `C:\Windows\System32\bash.exe`, the WSL
//     launcher, and the "Git Bash" pane opens a Linux distro.
//
// Measured on the machine this was fixed on: with PATH rebuilt from the
// registry (what an Explorer-launched wmux inherits), `where bash.exe` returns
// System32\bash.exe and the WindowsApps alias, and no Git bash at all.
//
// The fix is to treat a bare `bash` / `git-bash` spec as the alias it is: an
// honest PATH hit still wins (an MSYS2 or Cygwin bash the user put there on
// purpose), but the WSL launcher does not count as one — Git for Windows'
// bash is looked up at its install root before falling back to it. A spec
// that still fails to resolve now says so in the pane (pty-manager.ts's
// `shellFallbackFrom`) instead of only in main's log.
//
// Pure: every filesystem and PATH question is the caller's, so the whole rule
// is testable on a machine with no Git installed.

/** Which alias a shell spec is, if it is a bare Git Bash alias at all. */
export function bashAlias(spec: string): 'bash' | 'git-bash' | null {
  // Only a BARE name. `C:\msys64\usr\bin\bash.exe` or `.\bash.exe` is a path
  // the user wrote and is resolved as written.
  if (!spec || /[\\/]/.test(spec)) return null;
  const base = spec.toLowerCase().replace(/\.exe$/, '');
  if (base === 'bash') return 'bash';
  // git-bash.exe itself opens a separate mintty WINDOW, which is useless in a
  // pane — the spec can only ever mean "Git's bash", so it maps to the same.
  if (base === 'git-bash') return 'git-bash';
  return null;
}

/**
 * Is this the WSL launcher rather than a bash? `%SystemRoot%\System32\bash.exe`
 * is the legacy WSL entry point, and the WindowsApps `bash.exe` is its App
 * Execution Alias. Both start a Linux distro, which is never what a spec that
 * came from a "Git Bash" option means.
 */
export function isWslBashLauncher(p: string, systemRoot = 'C:\\Windows'): boolean {
  const norm = path.win32.normalize(p).toLowerCase();
  if (norm === path.win32.join(systemRoot, 'System32', 'bash.exe').toLowerCase()) return true;
  // The alias itself, or (since #299 resolves aliases found on PATH to the
  // exe behind them) that exe one package directory down. Git for Windows
  // never installs under a WindowsApps tree.
  return /\\windowsapps\\(?:[^\\]+\\)?bash\.exe$/.test(norm);
}

/**
 * The Git install root a `git.exe` hit implies. Git for Windows ships git.exe
 * in three places — `cmd\` (what the installer puts on PATH), `bin\` and
 * `mingw64\bin\` — so the root is the directory above whichever one it is.
 */
export function gitRootFromGitExe(gitExe: string): string | undefined {
  const dir = path.win32.dirname(gitExe);
  const leaf = path.win32.basename(dir).toLowerCase();
  if (leaf === 'cmd') return path.win32.dirname(dir);
  if (leaf === 'bin') {
    const parent = path.win32.dirname(dir);
    const parentLeaf = path.win32.basename(parent).toLowerCase();
    // mingw64\bin, mingw32\bin, clangarm64\bin → one more level up.
    if (/^(mingw(32|64)|clang(arm)?(32|64))$/.test(parentLeaf)) return path.win32.dirname(parent);
    return parent;
  }
  return undefined;
}

/**
 * Candidate `bin\bash.exe` paths, most specific first: the install the `git`
 * on PATH belongs to (that is the Git the user runs), then the default
 * per-machine and per-user install locations.
 *
 * `bin\bash.exe`, not `usr\bin\bash.exe`: the `bin\` one is Git's launcher —
 * it sets MSYSTEM and puts `mingw64\bin` and `usr\bin` on PATH before starting
 * the real bash. The `usr\bin` one run directly is a bash with none of that,
 * and `git`, `ls` or `ssh` may not resolve inside it.
 */
export function gitBashCandidates(env: Record<string, string | undefined>, gitOnPath?: string): string[] {
  const roots: string[] = [];
  const fromPath = gitOnPath ? gitRootFromGitExe(gitOnPath) : undefined;
  if (fromPath) roots.push(fromPath);
  for (const base of [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (base) roots.push(path.win32.join(base, 'Git'));
  }
  if (env.LOCALAPPDATA) roots.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git'));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    const exe = path.win32.join(root, 'bin', 'bash.exe');
    const key = exe.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(exe);
  }
  return out;
}

/**
 * Git Bash's launcher starts a NON-login shell unless told otherwise, so
 * /etc/profile and profile.d never run: no `ls` colour alias, no ~/bin on
 * PATH, none of what every other Git Bash entry point (the Start menu item,
 * Windows Terminal's generated profile) gives the user. Those use exactly
 * these two flags. Measured under node-pty: the pane still opens in the cwd it
 * was given — Git's /etc/profile does not cd to $HOME.
 */
export const GIT_BASH_LOGIN_ARGS: readonly string[] = ['--login', '-i'];

/**
 * Whether a resolved executable is a Git-style `bin\bash.exe` launcher (and
 * not a raw `usr\bin\bash.exe`). Only consulted for a bare alias spec, so an
 * explicit path the user wrote is never given flags it did not ask for.
 */
export function isGitBashLauncher(resolved: string): boolean {
  const norm = resolved.replace(/\//g, '\\').toLowerCase();
  return norm.endsWith('\\bin\\bash.exe') && !norm.endsWith('\\usr\\bin\\bash.exe');
}
