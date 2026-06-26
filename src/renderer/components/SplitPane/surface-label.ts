import type { SurfaceRef } from '../../../shared/types';

export function getShellLabel(shell?: string): string | null {
  if (!shell) return null;
  const normalized = shell.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || shell.toLowerCase();
  if (normalized === 'pwsh.exe' || normalized === 'pwsh') return 'PowerShell';
  if (normalized === 'powershell.exe' || normalized === 'powershell') return 'Windows PowerShell';
  if (normalized === 'cmd.exe' || normalized === 'cmd') return 'Command Prompt';
  if (normalized === 'bash.exe' || normalized === 'bash') return 'Bash';
  if (normalized === 'zsh' || normalized === 'zsh.exe') return 'Zsh';
  if (normalized === 'wsl.exe' || normalized === 'wsl') return 'WSL';
  if (normalized === 'git-bash.exe') return 'Git Bash';
  return normalized.replace(/\.exe$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getSurfaceLabel(surface: SurfaceRef, agentLabel?: string, workspaceShell?: string): string {
  if (surface.customTitle) return surface.customTitle;
  if (agentLabel) return agentLabel;

  switch (surface.type) {
    case 'terminal':
      return getShellLabel(surface.shell || workspaceShell) || 'Terminal';
    case 'browser':
      return 'Browser';
    case 'markdown':
      return 'Markdown';
    case 'diff':
      return 'Diff';
    default:
      return 'Tab';
  }
}
