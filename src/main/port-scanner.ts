import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class PortScanner {
  private coalesceTimer: NodeJS.Timeout | null = null;
  private burstTimers: NodeJS.Timeout[] = [];
  private scanning = false;
  private callback: ((ports: Map<number, number[]>) => void) | null = null;

  /**
   * Set the callback that receives port scan results.
   * Map<PID, ports[]>
   */
  onResults(callback: (ports: Map<number, number[]>) => void): void {
    this.callback = callback;
  }

  /**
   * Kick a scan — coalesces rapid kicks, then does burst scanning.
   * Pattern: 200ms coalesce, then scans at [0.5, 1.5, 3, 5, 7.5, 10] seconds
   */
  kick(): void {
    // Clear existing coalesce timer
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);

    // Coalesce: wait 200ms before starting burst
    this.coalesceTimer = setTimeout(() => {
      this.clearBurst();
      const offsets = [500, 1500, 3000, 5000, 7500, 10000];
      offsets.forEach(ms => {
        const timer = setTimeout(() => this.scan(), ms);
        this.burstTimers.push(timer);
      });
    }, 200);
  }

  stop(): void {
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.clearBurst();
  }

  private clearBurst(): void {
    this.burstTimers.forEach(t => clearTimeout(t));
    this.burstTimers = [];
  }

  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;

    try {
      const { stdout } = await execFileAsync('netstat', ['-ano'], { windowsHide: true });
      const portsByPid = this.parseNetstat(stdout);
      this.callback?.(portsByPid);
    } catch {
      // netstat failed, ignore
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Parse netstat -ano output.
   * Lines look like: TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    12345
   */
  parseNetstat(output: string): Map<number, number[]> {
    const result = new Map<number, number[]>();
    const lines = output.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.includes('LISTENING')) continue;

      // Parse: PROTO  LOCAL_ADDR  FOREIGN_ADDR  STATE  PID
      const parts = trimmed.split(/\s+/);
      if (parts.length < 5) continue;

      const localAddr = parts[1];
      const pid = parseInt(parts[parts.length - 1], 10);
      if (isNaN(pid) || pid === 0) continue;

      // Extract port from local address (e.g., 0.0.0.0:3000 or [::]:3000)
      const colonIdx = localAddr.lastIndexOf(':');
      if (colonIdx === -1) continue;
      const port = parseInt(localAddr.substring(colonIdx + 1), 10);
      if (isNaN(port)) continue;

      // Skip common system ports
      if (port < 1024) continue;

      const existing = result.get(pid) || [];
      if (!existing.includes(port)) {
        existing.push(port);
        result.set(pid, existing);
      }
    }

    return result;
  }
}
