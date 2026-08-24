import { describe, expect, it } from 'vitest';
import type { SurfaceId, SurfaceRef } from '../../src/shared/types';
import { getSurfaceLabel } from '../../src/renderer/components/SplitPane/surface-label';

function surface(id: string, patch: Partial<SurfaceRef> = {}): SurfaceRef {
  return {
    id: id as SurfaceId,
    type: 'terminal',
    ...patch,
  };
}

describe('surface labels', () => {
  it('labels from resolvedShell, so a spec with arguments stays readable', () => {
    // `shell` is the requested spec and may be a whole command line. Rendering
    // that as a tab caption produced "Ssh Fortuna@honoured Accident"; the
    // resolved executable is what the label wants.
    expect(
      getSurfaceLabel(surface('surf-1', {
        shell: 'ssh fortuna@honoured-accident',
        resolvedShell: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
      })),
    ).toBe('Ssh');
  });

  it('labels a pane started with no spec at all', () => {
    // The regression e5ec559 existed to prevent: with no requested spec there
    // is nothing to name the tab after except what actually spawned.
    expect(getSurfaceLabel(surface('surf-1', { resolvedShell: 'pwsh.exe' }))).toBe('PowerShell');
  });

  it('still falls back to the requested spec, then the workspace shell', () => {
    expect(getSurfaceLabel(surface('surf-1', { shell: 'cmd.exe' }))).toBe('Command Prompt');
    expect(getSurfaceLabel(surface('surf-1'), undefined, 'bash.exe')).toBe('Bash');
  });

  it('prefers custom titles over agent and shell labels', () => {
    expect(
      getSurfaceLabel(
        surface('surf-1', { customTitle: 'API', shell: 'pwsh.exe' }),
        'Agent runner',
        'cmd.exe',
      ),
    ).toBe('API');
  });

  it('uses agent labels before terminal shell labels', () => {
    expect(getSurfaceLabel(surface('surf-1', { shell: 'pwsh.exe' }), 'Agent runner')).toBe('Agent runner');
  });

  it('uses the surface shell before the workspace shell for terminal labels', () => {
    expect(
      getSurfaceLabel(
        surface('surf-1', { shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }),
        undefined,
        'cmd.exe',
      ),
    ).toBe('PowerShell');
  });

  it('falls back to the workspace shell for terminal labels', () => {
    expect(getSurfaceLabel(surface('surf-1'), undefined, 'C:\\Windows\\System32\\cmd.exe')).toBe('Command Prompt');
  });

  it('uses stable labels for non-terminal surface types', () => {
    expect(getSurfaceLabel(surface('surf-browser', { type: 'browser' }))).toBe('Browser');
    expect(getSurfaceLabel(surface('surf-markdown', { type: 'markdown' }))).toBe('Markdown');
    expect(getSurfaceLabel(surface('surf-diff', { type: 'diff' }))).toBe('Diff');
  });

  it('shows the markdown file name when the surface was opened from a file', () => {
    expect(
      getSurfaceLabel(surface('surf-markdown', { type: 'markdown', markdownFileName: 'README.md' })),
    ).toBe('README.md');
  });

  it('falls back to "Markdown" for a markdown surface without a file name', () => {
    expect(getSurfaceLabel(surface('surf-markdown', { type: 'markdown', markdownContent: '# hi' }))).toBe(
      'Markdown',
    );
  });

  it('prefers a custom title over the markdown file name', () => {
    expect(
      getSurfaceLabel(
        surface('surf-markdown', { type: 'markdown', customTitle: 'Docs', markdownFileName: 'README.md' }),
      ),
    ).toBe('Docs');
  });

  it('shows the folder name from currentCwd for terminal labels', () => {
    expect(
      getSurfaceLabel(
        surface('surf-1', { currentCwd: 'C:\\Users\\me\\coding\\wmux' }),
        undefined,
        'pwsh.exe',
      ),
    ).toBe('wmux');
  });

  it('falls back to shell name when currentCwd is empty', () => {
    expect(
      getSurfaceLabel(
        surface('surf-1', { currentCwd: '' }),
        undefined,
        'pwsh.exe',
      ),
    ).toBe('PowerShell');
  });

  it('prefers custom title over currentCwd', () => {
    expect(
      getSurfaceLabel(
        surface('surf-1', { customTitle: 'My Tab', currentCwd: 'C:\\Users\\me\\coding\\wmux' }),
      ),
    ).toBe('My Tab');
  });
});
