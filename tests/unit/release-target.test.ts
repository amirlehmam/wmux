import { describe, it, expect } from 'vitest';
import builderConfig from '../../electron-builder.json';

// Regression guard for issue #96: the Windows update artifact must be an NSIS
// installer. A bare "dir"/zip target can be downloaded and checksum-verified by
// electron-updater's NsisUpdater but never installed (quitAndInstall() no-ops
// and the app relaunches on the same version), so auto-update silently breaks.
describe('windows release target', () => {
  it('ships an NSIS installer, not a bare dir/zip', () => {
    const targets = builderConfig.win.target.map((t) =>
      typeof t === 'string' ? t : t.target,
    );
    expect(targets).toContain('nsis');
    expect(targets).not.toContain('dir');
  });
});
