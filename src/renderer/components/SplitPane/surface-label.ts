import type { SplitNode, SurfaceRef } from '../../../shared/types';
import type { TranslationKey } from '../../i18n/core';

/** Defaults to returning the fallback verbatim so callers (and existing tests) that omit `t` still see English. */
const identityT = (_key: TranslationKey, fallback?: string): string => fallback ?? _key;

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

/** Extract the last path segment from a cwd string for use as a tab label. */
function cwdFolderName(cwd: string): string | null {
  const normalized = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  const lastSegment = normalized.split('/').pop();
  return lastSegment || null;
}

/**
 * @param oscTitle The OSC 0/2 window title the pane's program last set (issue
 *   #221), already normalised by `normalizeOscTitle`, or undefined when the
 *   feature is off or nothing has set one. Ranked BELOW both names a human
 *   chose — an explicit `rename-surface` and an `agent spawn --label` — and
 *   above the cwd: it only fills the gap where the tab had no name of its own
 *   but the program in it has been announcing one all along.
 */
export function getSurfaceLabel(
  surface: SurfaceRef,
  agentLabel?: string,
  workspaceShell?: string,
  t: (key: TranslationKey, fallback?: string) => string = identityT,
  oscTitle?: string,
): string {
  if (surface.customTitle) return surface.customTitle;
  if (agentLabel) return agentLabel;

  switch (surface.type) {
    case 'terminal': {
      // Only inside the terminal case, not above the switch: a browser or
      // markdown tab has no program that could have set a title, so one
      // arriving for it means something is confused, and the static label is
      // the answer that cannot be wrong.
      if (oscTitle) return oscTitle;
      const folder = surface.currentCwd ? cwdFolderName(surface.currentCwd) : null;
      if (folder) return folder;
      // resolvedShell first: it is the concrete executable, so it labels a
      // pane started with no spec at all. `shell` may be a whole command line
      // (`ssh user@host`), which getShellLabel would render as a mouthful.
      return getShellLabel(surface.resolvedShell || surface.shell || workspaceShell)
        || t('surfaceLabel.terminal', 'Terminal');
    }
    case 'browser':
      return t('surfaceLabel.browser', 'Browser');
    case 'markdown': {
      // `•` for an unsaved buffer (issue #116, F3) — the same convention every
      // editor uses, and the only signal on a tab the user isn't looking at.
      const name = surface.markdownFileName || t('surfaceLabel.markdown', 'Markdown');
      return surface.markdownDirty ? `• ${name}` : name;
    }
    case 'diff':
      return t('surfaceLabel.diff', 'Diff');
    case 'code': {
      // Same `•` as markdown, and the same flag behind it. A code surface used
      // to be read-only by construction and carried no marker; now that it can
      // be edited, an unsaved buffer on a tab the user is not looking at needs
      // to say so — which is the entire job of this convention.
      const name = surface.codeFileName || t('surfaceLabel.code', 'Code');
      return surface.markdownDirty ? `• ${name}` : name;
    }
    case 'prompts':
      return t('surfaceLabel.prompts', 'Prompts');
    default:
      return t('surfaceLabel.tab', 'Tab');
  }
}

type Translate = (key: TranslationKey, fallback?: string) => string;

/**
 * The executable of a shell spec. `shell` may be a whole command line
 * (`ssh user@host`, `"C:\Program Files\Git\bin\bash.exe" --login`), and a live
 * tab dodges that by labelling from `resolvedShell` — which does not exist yet
 * when a workspace is created. Without this, the stored title would read
 * `Wsl.exe  D Ubuntu` for good.
 */
function shellProgram(spec: string | undefined): string | undefined {
  const trimmed = spec?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return (end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)) || undefined;
  }
  return trimmed.split(/\s+/)[0];
}

/**
 * A tab's label as it can be known BEFORE the pane exists: `getSurfaceLabel`
 * minus everything that only arrives once a PTY runs — the agent label, the OSC
 * title, `currentCwd`, `resolvedShell`. So it can differ from what the tab reads
 * a second later, and that is accepted: the result is only ever a title seed.
 *
 * `named` is false when the label is nothing but the surface type. Those are
 * what make `Terminal + Terminal + Terminal` rows that cannot be told apart.
 */
function getInitialSurfaceLabel(
  surface: SurfaceRef,
  workspaceCwd: string | undefined,
  workspaceShell: string | undefined,
  t: Translate,
): { label: string; named: boolean } {
  if (surface.customTitle) return { label: surface.customTitle, named: true };

  switch (surface.type) {
    case 'terminal': {
      const cwd = surface.cwd || workspaceCwd;
      const folder = cwd ? cwdFolderName(cwd) : null;
      if (folder) return { label: folder, named: true };
      const shell = getShellLabel(shellProgram(surface.shell || workspaceShell));
      if (shell) return { label: shell, named: true };
      return { label: t('surfaceLabel.terminal', 'Terminal'), named: false };
    }
    // No `•` here: a dirty marker in a stored title would outlive the edit.
    case 'markdown':
      return surface.markdownFileName
        ? { label: surface.markdownFileName, named: true }
        : { label: t('surfaceLabel.markdown', 'Markdown'), named: false };
    case 'code':
      return surface.codeFileName
        ? { label: surface.codeFileName, named: true }
        : { label: t('surfaceLabel.code', 'Code'), named: false };
    default:
      return { label: getSurfaceLabel(surface, undefined, undefined, t), named: false };
  }
}

/**
 * The title an untitled new workspace gets: every tab's label, in split-tree
 * order (first child before second, tabs in pane order), joined with ` + `.
 * Duplicates are kept on purpose — `api + api` says there are two of them.
 *
 * Returns `''` when there is nothing to tell the workspace apart by: no tabs,
 * or every tab labelled only by its type. The caller falls back to
 * `Workspace {n}` then, which is what a bare three-terminal workspace was
 * called before this existed.
 */
export function deriveWorkspaceTitle(
  tree: SplitNode,
  workspaceCwd: string | undefined,
  workspaceShell: string | undefined,
  t: Translate = identityT,
): string {
  const labels: string[] = [];
  let anyNamed = false;
  const walk = (node: SplitNode): void => {
    if (node.type === 'branch') {
      walk(node.children[0]);
      walk(node.children[1]);
      return;
    }
    for (const surface of node.surfaces) {
      const { label, named } = getInitialSurfaceLabel(surface, workspaceCwd, workspaceShell, t);
      labels.push(label);
      anyNamed ||= named;
    }
  };
  walk(tree);
  return anyNamed ? labels.join(' + ') : '';
}
