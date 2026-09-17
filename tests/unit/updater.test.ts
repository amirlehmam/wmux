import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Hoisted so the vi.mock factory (which is hoisted above imports) can close
// over it, and so tests can flip `isPackaged` per case.
const fakeApp = vi.hoisted(() => ({
  getVersion: () => '0.0.0',
  isPackaged: true,
  // Install root for the writability probe (#167). Tests point this at a real
  // temp dir, or at one they have made unwritable.
  exePath: '',
  getPath(name: string) {
    if (name === 'exe') return fakeApp.exePath;
    throw new Error(`unexpected getPath(${name})`);
  },
}));

const fakeDialog = vi.hoisted(() => ({ showMessageBox: vi.fn() }));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: fakeDialog,
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

const zipMocks = vi.hoisted(() => ({
  resolvePortableZipTarget: vi.fn(),
  runPortableZipUpdate: vi.fn(),
  applyStagedPortableUpdate: vi.fn(),
}));

vi.mock('../../src/main/zip-updater', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/zip-updater')>();
  return {
    ...actual,
    resolvePortableZipTarget: zipMocks.resolvePortableZipTarget,
    runPortableZipUpdate: zipMocks.runPortableZipUpdate,
    applyStagedPortableUpdate: zipMocks.applyStagedPortableUpdate,
  };
});

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

  it('does not download when electron-updater reports the current version', async () => {
    const u = await freshUpdater();
    u.autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: fakeApp.getVersion() } });
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

/**
 * Issue #167: `canSelfUpdate()` answered "packaged, and not disabled" under a
 * doc comment promising "can actually install an update in place" — a strictly
 * stronger claim it never evaluated. Nothing anywhere in updater.ts asked
 * whether the process could write to the directory an update replaces.
 *
 * The way an install gets there is ordinary: the assisted installer re-offers
 * the scope page DURING an update, so a per-user install under %LOCALAPPDATA%
 * that had been self-updating silently becomes a per-machine install under
 * Program Files that cannot, via one click on a page that reads as "confirm the
 * install location".
 */
describe('install-root writability (issue #167)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-root-'));
    // getPath('exe') returns the executable; the root is its directory.
    fakeApp.exePath = path.join(root, 'wmux.exe');
    fakeApp.isPackaged = true;
  });

  it('probes by writing, and leaves nothing behind', async () => {
    const u = await freshUpdater();
    expect(u.isInstallRootWritable()).toBe(true);
    // A probe file that survived would accumulate one per launch inside the
    // user's install directory.
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('reports a root it cannot write to, rather than assuming', async () => {
    const u = await freshUpdater();
    // A directory that does not exist stands in for one the process cannot
    // write: both make the write throw, which is the only signal that matters.
    fakeApp.exePath = path.join(root, 'gone', 'wmux.exe');
    expect(u.isInstallRootWritable()).toBe(false);
    expect(u.updateNeedsElevation()).toBe(true);
  });

  it('does not claim elevation is needed for a writable root', async () => {
    const u = await freshUpdater();
    expect(u.updateNeedsElevation()).toBe(false);
  });

  it('never claims an unpackaged dev run needs elevation', async () => {
    const u = await freshUpdater();
    fakeApp.isPackaged = false;
    fakeApp.exePath = path.join(root, 'gone', 'wmux.exe');
    // There is no install root to speak of; canSelfUpdate already excludes it.
    expect(u.updateNeedsElevation()).toBe(false);
  });

  it('caches the probe — it cannot change without a restart', async () => {
    const u = await freshUpdater();
    expect(u.isInstallRootWritable()).toBe(true);
    // The process token is what the answer depends on, and that is fixed for
    // the life of the process. Moving the exe underneath it must not re-probe.
    fakeApp.exePath = path.join(root, 'gone', 'wmux.exe');
    expect(u.isInstallRootWritable()).toBe(true);
    u.resetInstallRootProbe();
    expect(u.isInstallRootWritable()).toBe(false);
  });

  it('keeps canSelfUpdate true for a per-machine install, and says why', async () => {
    // The deliberate non-change. An admin on a per-machine install CAN update
    // in place, via a UAC prompt — returning false here would take a working
    // path away from every such user. The fact is surfaced instead.
    const u = await freshUpdater();
    fakeApp.exePath = path.join(root, 'gone', 'wmux.exe');
    expect(u.canSelfUpdate()).toBe(true);
    expect(u.updateNeedsElevation()).toBe(true);
  });

  it('still refuses when the updater is switched off or unpackaged', async () => {
    const u = await freshUpdater();
    fakeApp.isPackaged = false;
    expect(u.canSelfUpdate()).toBe(false);
  });
});

/**
 * Zip extracts (the README install) have wmux.exe and no NSIS uninstaller.
 * NsisUpdater cannot replace that layout (issue #96); the badge click has to
 * take the download-extract-swap path instead of checkForUpdates().
 */
describe('portable zip install', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-portable-'));
    fs.writeFileSync(path.join(root, 'wmux.exe'), '');
    fakeApp.exePath = path.join(root, 'wmux.exe');
    fakeApp.isPackaged = true;
    delete process.env.WMUX_DISABLE_UPDATER;
    zipMocks.resolvePortableZipTarget.mockReset();
    zipMocks.runPortableZipUpdate.mockReset().mockReturnValue(new Promise(() => {}));
    zipMocks.applyStagedPortableUpdate.mockReset();
  });

  it('does not ask NsisUpdater to download', async () => {
    zipMocks.resolvePortableZipTarget.mockResolvedValue({
      version: '9.9.9',
      asset: { name: 'wmux-9.9.9-win-x64.zip', browser_download_url: 'https://example.test/x.zip', size: 10 },
    });
    const u = await freshUpdater();
    await expect(u.requestUpdateNow()).resolves.toEqual({ handled: true });
    expect(u.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(zipMocks.resolvePortableZipTarget).toHaveBeenCalledTimes(1);
    expect(zipMocks.runPortableZipUpdate).toHaveBeenCalledTimes(1);
    expect(u.getUpdateState()).toMatchObject({ phase: 'downloading', version: '9.9.9' });
  });

  it('reports no_update when the zip install is already current', async () => {
    zipMocks.resolvePortableZipTarget.mockRejectedValue(
      Object.assign(new Error('no_update'), { code: 'NO_UPDATE' }),
    );
    const u = await freshUpdater();
    await expect(u.requestUpdateNow()).resolves.toEqual({ handled: false, reason: 'no_update' });
    expect(zipMocks.runPortableZipUpdate).not.toHaveBeenCalled();
    expect(u.getUpdateState().phase).toBe('idle');
  });

  it('falls back to the release page when the release has no win-x64 zip', async () => {
    zipMocks.resolvePortableZipTarget.mockRejectedValue(
      Object.assign(new Error('no zip'), { code: 'NO_ZIP_ASSET' }),
    );
    const u = await freshUpdater();
    await expect(u.requestUpdateNow()).resolves.toEqual({ handled: false, reason: 'no_zip_asset' });
  });

  it('skips NsisUpdater init so a zip extract never enters the #96 loop', async () => {
    const u = await freshUpdater();
    u.initAutoUpdater();
    expect(u.autoUpdater.on).not.toHaveBeenCalled();
    expect(u.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });
});

/**
 * Issue #3: "Install and restart" used to quit unconditionally. A payload that
 * vanished while the update sat behind "Later", or a helper an antivirus would
 * not let start, left the user with wmux closed and nothing to restart it.
 * A failed install now stays in the app, says so, and the next click does the
 * one thing that can help.
 */
describe('portable zip install that cannot run (#3)', () => {
  const target = {
    version: '9.9.9',
    asset: { name: 'wmux-9.9.9-win-x64.zip', browser_download_url: 'https://example.test/x.zip', size: 10 },
  };
  const staged = { version: '9.9.9', extractDir: 'X:\\payload', installDir: 'X:\\wmux', exePath: 'X:\\wmux\\wmux.exe' };
  const payloadMissing = () =>
    Object.assign(new Error('the downloaded update is no longer on disk — download it again'), { code: 'PAYLOAD_MISSING' });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-portable-'));
    fs.writeFileSync(path.join(root, 'wmux.exe'), '');
    fakeApp.exePath = path.join(root, 'wmux.exe');
    fakeApp.isPackaged = true;
    delete process.env.WMUX_DISABLE_UPDATER;
    zipMocks.resolvePortableZipTarget.mockReset().mockResolvedValue(target);
    zipMocks.runPortableZipUpdate.mockReset().mockResolvedValue(staged);
    zipMocks.applyStagedPortableUpdate.mockReset();
    fakeDialog.showMessageBox.mockReset().mockResolvedValue({ response: 1 });
  });

  /** Download, answer the dialog with `response`, and wait for it to settle. */
  async function downloadAndAnswer(u: Awaited<ReturnType<typeof freshUpdater>>, response: number) {
    fakeDialog.showMessageBox.mockResolvedValueOnce({ response });
    await u.requestUpdateNow();
    await vi.waitFor(() => expect(fakeDialog.showMessageBox).toHaveBeenCalled());
    await flush();
  }

  it('forgets a payload that is gone, and downloads again on the next click', async () => {
    const u = await freshUpdater();
    await downloadAndAnswer(u, 1); // Later
    expect(u.getUpdateState().phase).toBe('ready');

    zipMocks.applyStagedPortableUpdate.mockRejectedValueOnce(payloadMissing());
    await expect(u.requestUpdateNow()).resolves.toEqual({ handled: true });
    await vi.waitFor(() => expect(u.getUpdateState().phase).toBe('error'));
    expect(u.getUpdateState().message).toMatch(/download it again/);

    await u.requestUpdateNow();
    expect(zipMocks.resolvePortableZipTarget).toHaveBeenCalledTimes(2);
    expect(zipMocks.runPortableZipUpdate).toHaveBeenCalledTimes(2);
    expect(zipMocks.applyStagedPortableUpdate).toHaveBeenCalledTimes(1);
  });

  it('keeps a good payload when the helper fails, and offers the install again without downloading', async () => {
    const u = await freshUpdater();
    await downloadAndAnswer(u, 1); // Later

    zipMocks.applyStagedPortableUpdate.mockRejectedValueOnce(new Error('spawn EPERM'));
    await u.requestUpdateNow();
    await vi.waitFor(() => expect(u.getUpdateState()).toMatchObject({ phase: 'error', message: 'spawn EPERM' }));

    // The error badge says "Click to try again", not "Restart": the retry asks
    // before it quits wmux and every session in it.
    zipMocks.applyStagedPortableUpdate.mockResolvedValueOnce(undefined);
    fakeDialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await expect(u.requestUpdateNow()).resolves.toEqual({ handled: true });
    await vi.waitFor(() => expect(zipMocks.applyStagedPortableUpdate).toHaveBeenCalledTimes(2));
    expect(fakeDialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(zipMocks.applyStagedPortableUpdate).toHaveBeenLastCalledWith(staged);
    expect(zipMocks.resolvePortableZipTarget).toHaveBeenCalledTimes(1);
    expect(zipMocks.runPortableZipUpdate).toHaveBeenCalledTimes(1);
  });

  // Two clicks that both reach main before the first dialog is up must not let
  // the second one install behind the dialog's back.
  it('does not let a second quick click on the error badge skip the dialog', async () => {
    const u = await freshUpdater();
    await downloadAndAnswer(u, 1); // Later
    zipMocks.applyStagedPortableUpdate.mockRejectedValueOnce(new Error('spawn EPERM'));
    await u.requestUpdateNow();
    await vi.waitFor(() => expect(u.getUpdateState().phase).toBe('error'));

    fakeDialog.showMessageBox.mockReturnValueOnce(new Promise(() => {})); // user still reading
    await Promise.all([u.requestUpdateNow(), u.requestUpdateNow()]);
    await flush();
    await flush();
    expect(fakeDialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(zipMocks.applyStagedPortableUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not quit on a retry the user declines', async () => {
    const u = await freshUpdater();
    await downloadAndAnswer(u, 1); // Later
    zipMocks.applyStagedPortableUpdate.mockRejectedValueOnce(new Error('spawn EPERM'));
    await u.requestUpdateNow();
    await vi.waitFor(() => expect(u.getUpdateState().phase).toBe('error'));

    await u.requestUpdateNow(); // dialog answers Later (the beforeEach default)
    await vi.waitFor(() => expect(fakeDialog.showMessageBox).toHaveBeenCalledTimes(2));
    await flush();
    expect(zipMocks.applyStagedPortableUpdate).toHaveBeenCalledTimes(1);
  });

  // An antivirus that blocks the helper blocks it every time. Without a limit
  // each click re-runs the same failing install, the badge never changes, and
  // the release page — the fallback for exactly this — is never offered.
  it('hands over to the release page once the retry has failed too', async () => {
    const u = await freshUpdater();
    await downloadAndAnswer(u, 1); // Later
    zipMocks.applyStagedPortableUpdate.mockRejectedValue(new Error('spawn EPERM'));

    await u.requestUpdateNow();
    await vi.waitFor(() => expect(u.getUpdateState().phase).toBe('error'));
    fakeDialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await u.requestUpdateNow();
    await vi.waitFor(() => expect(zipMocks.applyStagedPortableUpdate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(u.getUpdateState().phase).toBe('error'));

    // With the page to open: the renderer's cached release info may never have
    // arrived, and a fallback with nothing to open is the dead click again.
    await expect(u.requestUpdateNow()).resolves.toEqual({
      handled: false,
      reason: 'install_failed',
      url: 'https://github.com/amirlehmam/wmux/releases/tag/v9.9.9',
    });
    await flush();
    expect(zipMocks.applyStagedPortableUpdate).toHaveBeenCalledTimes(2);
    expect(zipMocks.runPortableZipUpdate).toHaveBeenCalledTimes(1);
  });

  it('asks again for the next update after an install from the dialog failed', async () => {
    const u = await freshUpdater();
    zipMocks.applyStagedPortableUpdate.mockRejectedValueOnce(payloadMissing());
    await downloadAndAnswer(u, 0); // Install and restart
    await vi.waitFor(() => expect(u.getUpdateState().phase).toBe('error'));
    expect(zipMocks.applyStagedPortableUpdate).toHaveBeenCalledTimes(1);

    await u.requestUpdateNow();
    await vi.waitFor(() => expect(fakeDialog.showMessageBox).toHaveBeenCalledTimes(2));
  });

  it('does not start a second install while the first is still waiting on its helper', async () => {
    const u = await freshUpdater();
    await downloadAndAnswer(u, 1); // Later
    zipMocks.applyStagedPortableUpdate.mockReturnValue(new Promise(() => {}));
    await u.requestUpdateNow();
    await flush();
    await u.requestUpdateNow();
    await flush();
    expect(zipMocks.applyStagedPortableUpdate).toHaveBeenCalledTimes(1);
  });
});
