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
