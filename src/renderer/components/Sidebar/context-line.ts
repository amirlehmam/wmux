// ─── The workspace row's context line: "branch* · ~/path · :3000" ───────────
// Pure, beside workspace-status.ts, for the same reason that file exists: the
// row is a component, and the decisions worth pinning are not.
//
// Two things went wrong here before (#279), and both read as "the sidebar
// lost my git branch":
//
//   * Settings → Sidebar's six detail toggles were read by NOTHING. They
//     persisted, they round-tripped, and the row ignored every one of them —
//     so "Show git branch" being ticked said nothing about whether a branch
//     would show. `sidebarDetails` is the one place they are applied now.
//   * Any drive root was shortened to `~`: `L:\repos\ai` rendered as
//     `~/repos/ai`, which claims the repo is under the home directory. `~`
//     means the home directory and nothing else.

import type { SidebarPrefs } from '../../store/settings-slice';

/** What each detail line may show, after the toggles and the master switch. */
export interface SidebarDetails {
  gitBranch: boolean;
  workingDir: boolean;
  pr: boolean;
  ports: boolean;
  notificationMessage: boolean;
}

/** "Hide all details" wins over every individual toggle. */
export function sidebarDetails(prefs: Pick<SidebarPrefs,
  'showGitBranch' | 'showWorkingDir' | 'showPR' | 'showPorts' | 'showNotificationMessage' | 'hideAllDetails'>): SidebarDetails {
  const on = !prefs.hideAllDetails;
  return {
    gitBranch: on && prefs.showGitBranch,
    workingDir: on && prefs.showWorkingDir,
    pr: on && prefs.showPR,
    ports: on && prefs.showPorts,
    notificationMessage: on && prefs.showNotificationMessage,
  };
}

/**
 * WSL UNC paths retain their Linux spelling, without the Windows redirector
 * or distro prefix. Other paths use forward slashes and `~` for home ONLY. A Windows home is matched case-insensitively (NTFS is, and the shell
 * may report `c:\users\…`), on a whole path segment — `C:\Users\amir2` is not
 * under `C:\Users\amir`. A POSIX `/home/<user>` (a WSL pane) is the home of
 * that distro's user and is shortened too; every other path keeps its drive.
 */
export function shortenCwd(cwd: string, homeDir?: string): string {
  const path = cwd.replace(/\\/g, '/');
  const wsl = /^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(?:\/(.*))?$/i.exec(path);
  if (wsl) return `/${wsl[1] ?? ''}`;
  if (homeDir) {
    let home = homeDir.replace(/\\/g, '/');
    while (home.endsWith('/')) home = home.slice(0, -1);
    if (home && (path.toLowerCase() === home.toLowerCase()
      || path.toLowerCase().startsWith(`${home.toLowerCase()}/`))) {
      return `~${path.slice(home.length)}`;
    }
  }
  const posixHome = /^\/home\/[^/]+(?=\/|$)/.exec(path) ?? /^\/root(?=\/|$)/.exec(path);
  if (posixHome) return `~${path.slice(posixHome[0].length)}`;
  return path;
}

export interface ContextLineInputs {
  gitBranch?: string;
  gitDirty?: boolean;
  cwd?: string;
  ports?: number[];
}

/** The joined line, or null when nothing it could show is both known and enabled. */
export function buildContextLine(ws: ContextLineInputs, details: SidebarDetails, homeDir?: string): string | null {
  const parts: string[] = [];
  if (details.gitBranch && ws.gitBranch) parts.push(`${ws.gitBranch}${ws.gitDirty ? '*' : ''}`);
  if (details.workingDir && ws.cwd) parts.push(shortenCwd(ws.cwd, homeDir));
  if (details.ports && ws.ports && ws.ports.length > 0) parts.push(ws.ports.map((p) => `:${p}`).join(' '));
  return parts.length > 0 ? parts.join(' · ') : null;
}
