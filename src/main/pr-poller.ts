import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface PrInfo {
  number: number;
  state: string;
  title: string;
}

export class PrPoller {
  private intervals = new Map<string, NodeJS.Timeout>(); // cwd → interval
  private callback: ((cwd: string, pr: PrInfo | null) => void) | null = null;
  private pollIntervalMs = 45000; // 45 seconds

  onUpdate(callback: (cwd: string, pr: PrInfo | null) => void): void {
    this.callback = callback;
  }

  /**
   * Start polling PR status for a given working directory.
   */
  startPolling(cwd: string): void {
    if (this.intervals.has(cwd)) return;

    // Initial poll
    this.pollPr(cwd);

    // Recurring poll
    const interval = setInterval(() => this.pollPr(cwd), this.pollIntervalMs);
    this.intervals.set(cwd, interval);
  }

  stopPolling(cwd: string): void {
    const interval = this.intervals.get(cwd);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(cwd);
    }
  }

  stopAll(): void {
    for (const [cwd] of this.intervals) {
      this.stopPolling(cwd);
    }
  }

  private async pollPr(cwd: string): Promise<void> {
    try {
      const { stdout } = await execFileAsync('gh', ['pr', 'view', '--json', 'number,state,title'], {
        cwd,
        windowsHide: true,
      });

      const pr = JSON.parse(stdout.trim()) as PrInfo;
      this.callback?.(cwd, pr);
    } catch {
      // gh not installed or no PR — that's fine
      this.callback?.(cwd, null);
    }
  }
}
