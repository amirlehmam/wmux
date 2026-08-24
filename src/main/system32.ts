/**
 * Absolute paths to Windows-owned tools that must not be shadowed by a
 * user-writable PATH entry.
 */
import * as fs from 'fs';
import * as path from 'path';

function systemRoot(): string {
  return process.env.SystemRoot || process.env.windir || 'C:\\Windows';
}

/** `system32('OpenSSH', 'ssh.exe')` -> the in-box Windows OpenSSH client. */
export function system32(...parts: string[]): string {
  return path.join(systemRoot(), 'System32', ...parts);
}

/** Windows PowerShell 5.1, present on every supported Windows release. */
export function powershellPath(): string {
  return system32('WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * The Windows OpenSSH installation wmux should use for a bare managed spec.
 *
 * Microsoft's standalone upgrade is installed under Program Files and should
 * win over the older in-box copy when both exist. System32 is the stable
 * fallback. Keeping this decision in one helper also lets uploads select the
 * sibling `scp.exe` from the same authentication stack.
 */
export function opensshPath(
  tool: 'ssh' | 'scp',
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  const file = `${tool}.exe`;
  const standalone = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OpenSSH', file);
  if (exists(standalone)) return standalone;
  return system32('OpenSSH', file);
}
