import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factory (which is hoisted above imports) can close
// over it, and so tests can flip `isPackaged` per case.
const fakeApp = vi.hoisted(() => ({ getVersion: () => '0.0.0', isPackaged: true }));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: vi.fn() },
  app: fakeApp,
  net: { request: vi.fn() },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: vi.fn(),
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
  },
}));

import { isMissingChannelFileError, isUpdaterDisabled } from '../../src/main/updater';

/**
 * The updater keeps one module-level state machine, as it must — there is one
 * app to update. Tests therefore take a fresh module graph each time instead of
 * asking production code for a reset hook it has no other reason to expose.
 */
async function freshUpdater() {
  vi.resetModules();
  const { autoUpdater } = await import('electron-updater');
  // The mocked electron-updater object survives resetModules, so its call
  // history has to be cleared by hand or counts leak between tests.
  const au = autoUpdater as any;
  au.checkForUpdates.mockReset().mockResolvedValue(undefined);
  au.downloadUpdate.mockReset().mockResolvedValue(undefined);
  au.quitAndInstall.mockReset();
  au.on.mockReset();
  const mod = await import('../../src/main/updater');
  return { autoUpdater: au, ...mod };
}

describe('isMissingChannelFileError', () => {
  it('matches by error code', () => {
    const err = Object.assign(new Error('some wrapper text'), {
      code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    });
    expect(isMissingChannelFileError(err)).toBe(true);
  });

  it('matches the electron-updater 404 message', () => {
    const err = new Error(
      'Cannot find latest.yml in the latest release artifacts ' +
      '(https://github.com/amirlehmam/wmux/releases/download/v0.15.0/latest.yml): HttpError: 404'
    );
    expect(isMissingChannelFileError(err)).toBe(true);
  });

  it('matches when the code only appears in the message', () => {
    expect(isMissingChannelFileError(new Error("code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'"))).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isMissingChannelFileError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(false);
    expect(isMissingChannelFileError(null)).toBe(false);
    expect(isMissingChannelFileError(undefined)).toBe(false);
    expect(isMissingChannelFileError('plain string error')).toBe(false);
  });
});

describe('isUpdaterDisabled', () => {
  it('is disabled only when WMUX_DISABLE_UPDATER is exactly "1"', () => {
    expect(isUpdaterDisabled({ WMUX_DISABLE_UPDATER: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isUpdaterDisabled({ WMUX_DISABLE_UPDATER: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isUpdaterDisabled({ WMUX_DISABLE_UPDATER: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isUpdaterDisabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

// Issue #125: the titlebar badge only ever opened the GitHub release page, so
// Windows users concluded there was no real in-app updater. There is — the
// badge now drives it, and only falls back to the browser when this build
// genuinely cannot install in place.
describe('in-app update (issue #125)', () => {
  beforeEach(() => {
    fakeApp.isPackaged = true;
    delete process.env.WMUX_DISABLE_UPDATER;
  });

  it('refuses to self-update from an unpackaged run', async () => {
    const u = await freshUpdater();
    fakeApp.isPackaged = false;
    expect(u.canSelfUpdate()).toBe(false);
    await expect(u.requestUpdateNow()).resolves.toEqual({ handled: false, reason: 'not_supported' });
    expect(u.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('honours the kill switch', async () => {
    const u = await freshUpdater();
    process.env.WMUX_DISABLE_UPDATER = '1';
    expect(u.canSelfUpdate()).toBe(false);
    await expect(u.requestUpdateNow()).resolves.toEqual({ handled: false, reason: 'not_supported' });
  });

  it('downloads without waiting out the quarantine window', async () => {
    // Quarantine guards the UNATTENDED path (issue #29). An explicit click is
    // the consent that gate exists to obtain, so it must not block here — a
    // just-published release is exactly when people click the badge.
    const u = await freshUpdater();
    u.autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '9.9.9' } });
    await expect(u.requestUpdateNow()).resolves.toEqual({ handled: true });
    expect(u.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(u.getUpdateState()).toMatchObject({ phase: 'downloading', version: '9.9.9' });
  });

  it('falls back to the release page when there is no latest.yml', async () => {
    const u = await freshUpdater();
    u.autoUpdater.checkForUpdates.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }),
    );
    await expect(u.requestUpdateNow()).resolves.toEqual({ handled: false, reason: 'no_channel_file' });
    expect(u.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(u.getUpdateState().phase).toBe('idle');
  });

  it('falls back to the release page on any other updater failure', async () => {
    const u = await freshUpdater();
    u.autoUpdater.checkForUpdates.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'));
    await expect(u.requestUpdateNow()).resolves.toEqual({ handled: false, reason: 'error' });
    expect(u.getUpdateState().phase).toBe('idle');
  });

  it('falls back when the check finds nothing to install', async () => {
    const u = await freshUpdater();
    u.autoUpdater.checkForUpdates.mockResolvedValue(null);
    await expect(u.requestUpdateNow()).resolves.toEqual({ handled: false, reason: 'no_update' });
    expect(u.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('does not start a second download while one is in flight', async () => {
    const u = await freshUpdater();
    u.autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '9.9.9' } });
    await u.requestUpdateNow();
    await expect(u.requestUpdateNow()).resolves.toEqual({ handled: true });
    expect(u.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  });
});
