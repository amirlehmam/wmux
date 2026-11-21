import { useEffect } from 'react';
import { useStore } from '../store';

/** A folder on a WSL share, `\\wsl.localhost\<distro>\...` or `\\wsl$\<distro>\...` (either slash). */
const WSL_SHARE = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]/i;

/**
 * Tell main which workspace is on screen, so that the persistent worker of its ssh target, or of
 * its WSL distro when its folder is on a WSL share, is started before the first click rather than
 * by it (main/exec-warm.ts). Sent when the workspace becomes the active one, when the window gets
 * focus and when the page becomes visible again: the last two are what a person coming back
 * after a pause does, which is when the worker's idle lifetime has ended.
 *
 * Main decides everything else: whether the workspace has an ssh target, whether the folder names
 * a distro, whether the window is shown, whether the worker is already there. A message costs a
 * map lookup there, and it is dropped when the workspace is not the selected one. The folder is
 * sent only when it is on a WSL share.
 */
export function useWorkspaceWarm(activeWorkspaceId: string | null): void {
  const wslFolder = useStore((s) => {
    const cwd = s.workspaces.find((w) => w.id === activeWorkspaceId)?.cwd;
    return cwd && WSL_SHARE.test(cwd) ? cwd : undefined;
  });
  useEffect(() => {
    if (!activeWorkspaceId) return undefined;
    const warm = (): void => {
      if (document.visibilityState === 'hidden') return;
      try { window.wmux?.workspace?.warm?.(activeWorkspaceId, wslFolder); } catch { /* an optimisation: never an error */ }
    };
    warm();
    window.addEventListener('focus', warm);
    document.addEventListener('visibilitychange', warm);
    return () => {
      window.removeEventListener('focus', warm);
      document.removeEventListener('visibilitychange', warm);
    };
  }, [activeWorkspaceId, wslFolder]);
}
