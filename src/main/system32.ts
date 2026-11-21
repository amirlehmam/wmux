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
 * The Windows OpenSSH installation wmux should use for a bare managed spec
 * (#193).
 *
 * Why it has to be Windows' own ssh rather than whichever one PATH finds first:
 * Git for Windows puts an MSYS2 ssh ahead of System32 on PATH, and it cannot
 * talk to the Windows named-pipe ssh-agent — so a bare `ssh` spec died on
 * "Permission denied (publickey)" wherever keys live only in an agent.
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
  const standalone = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OpenSSH');
  // Select an installation, not an individual tool: mixing ssh from one build
  // with scp from another changes config/agent behaviour on Windows.
  if (exists(path.join(standalone, 'ssh.exe')) && exists(path.join(standalone, 'scp.exe'))) {
    return path.join(standalone, `${tool}.exe`);
  }
  return system32('OpenSSH', `${tool}.exe`);
}

/**
 * The absolute `%SystemRoot%\\System32\\wsl.exe`. A bare `wsl.exe` would be looked
 * up by the OS at every spawn, so a writable PATH entry would decide what runs
 * (the same reason `gitExecutable` and `opensshPath` are absolute). Always a
 * Windows path, whichever platform computes it, so a test can pin it.
 */
export function wslExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(wslSystemRoot(env), 'System32', 'wsl.exe');
}

/** The Windows directory, for a `cwd` that exists and means nothing to the child. */
export function wslSystemRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.SystemRoot ?? env.windir ?? 'C:\\Windows';
}
