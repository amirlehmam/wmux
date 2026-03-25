import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

interface GitState {
  branch: string | null;
  dirty: boolean;
}

export class GitPoller {
  private watchers = new Map<string, fs.FSWatcher>(); // cwd → watcher
  private callback: ((cwd: string, state: GitState) => void) | null = null;

  onUpdate(callback: (cwd: string, state: GitState) => void): void {
    this.callback = callback;
  }

  /**
   * Start watching a directory's .git/HEAD for branch changes.
   */
  watch(cwd: string): void {
    if (this.watchers.has(cwd)) return;

    const gitHead = path.join(cwd, '.git', 'HEAD');
    if (!fs.existsSync(gitHead)) return;

    try {
      const watcher = fs.watch(gitHead, { persistent: false }, () => {
        this.pollGitState(cwd);
      });
      this.watchers.set(cwd, watcher);
      // Initial poll
      this.pollGitState(cwd);
    } catch {
      // Not a git repo or can't watch
    }
  }

  unwatch(cwd: string): void {
    const watcher = this.watchers.get(cwd);
    if (watcher) {
      watcher.close();
      this.watchers.delete(cwd);
    }
  }

  unwatchAll(): void {
    for (const [cwd] of this.watchers) {
      this.unwatch(cwd);
    }
  }

  private async pollGitState(cwd: string): Promise<void> {
    try {
      const { stdout: branch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        windowsHide: true,
      });

      let dirty = false;
      try {
        const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], {
          cwd,
          windowsHide: true,
        });
        dirty = status.trim().length > 0;
      } catch {}

      this.callback?.(cwd, { branch: branch.trim(), dirty });
    } catch {
      this.callback?.(cwd, { branch: null, dirty: false });
    }
  }
}
