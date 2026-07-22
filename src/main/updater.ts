import { autoUpdater } from 'electron-updater';
import { BrowserWindow, dialog } from 'electron';
import { fetchLatestRelease } from './update-checker';

// ── Auto-update hardening (issue #29) ────────────────────────────────────────
// The old flow auto-downloaded AND silently auto-installed on quit, with no
// authenticity check. Anyone able to publish a release to the repo got near-
// instant silent RCE on every install. We mitigate the two highest-leverage
// properties here, in code, without new signing infrastructure:
//
//   1. Quarantine window — never install a release until it has been public for
//      N days, so a malicious release can be detected and yanked before clients
//      adopt it. Age is read from GitHub's server-side `published_at`, not the
//      attacker-writable latest.yml `releaseDate`.
//   2. No silent install — autoDownload/autoInstallOnAppQuit are off; the user
//      must explicitly confirm the install via a dialog.
//
// Authenticode signing is wired in CI (issue #71): release.yml signs wmux.exe
// via SignPath when the SIGNPATH_* secrets are configured. The publisherName
// pin was REMOVED from electron-builder.json: SignPath fell back to a
// self-signed cert, and a pin combined with non-chain-trusted artifacts made
// every client reject every update (which is why latest.yml was withheld for
// 0.26–0.31, stranding all installs). Without the pin, NsisUpdater skips
// Authenticode verification; download integrity comes from the latest.yml
// sha512, and the quarantine window + explicit install dialog below are the
// primary client-side controls. Re-add the pin only together with reliable
// chain-trusted signing.

const DEFAULT_MIN_RELEASE_AGE_DAYS = 3;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function minReleaseAgeMs(): number {
  const raw = process.env.WMUX_MIN_RELEASE_AGE_DAYS;
  const days = raw !== undefined && raw !== '' ? Number(raw) : DEFAULT_MIN_RELEASE_AGE_DAYS;
  if (!Number.isFinite(days) || days < 0) return DEFAULT_MIN_RELEASE_AGE_DAYS * DAY_MS;
  return days * DAY_MS;
}

// Age of the release that electron-updater found, in ms, from GitHub's
// server-side published_at. Returns null when it can't be confirmed — callers
// treat null conservatively (hold the update this cycle, re-check later).
async function releaseAgeMs(version: string): Promise<number | null> {
  const release = await fetchLatestRelease();
  if (!release?.published_at) return null;
  const tag = (release.tag_name || '').replace(/^v/, '');
  if (tag && version && tag !== version.replace(/^v/, '')) return null;
  const published = Date.parse(release.published_at);
  if (Number.isNaN(published)) return null;
  return Date.now() - published;
}

let installPrompted = false;
let missingChannelFileWarned = false;

// A release without latest.yml (manual/partial releases, transient GitHub
// errors) is an expected condition, not a failure — the notify-only checker in
// update-checker.ts still covers it (issue #68).
export function isMissingChannelFileError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null | undefined;
  if (e?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return true;
  const msg = e?.message || String(err ?? '');
  return msg.includes('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') || msg.includes('Cannot find latest.yml');
}

export function isUpdaterDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WMUX_DISABLE_UPDATER === '1';
}

export function initAutoUpdater(): void {
  // Kill switch for air-gapped / corporate / sandboxed environments that
  // cannot (or should not) reach GitHub (issue #68).
  if (isUpdaterDisabled()) {
    console.log('[updater] Disabled via WMUX_DISABLE_UPDATER=1');
    return;
  }

  // Gate both download and install — nothing happens without passing the
  // quarantine window and an explicit user click.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', async (info) => {
    try {
      const ageMs = await releaseAgeMs(info.version);
      const minMs = minReleaseAgeMs();
      if (ageMs === null) {
        console.log(`[updater] Cannot confirm age of ${info.version}; holding until next check.`);
        return;
      }
      if (ageMs < minMs) {
        const daysLeft = ((minMs - ageMs) / DAY_MS).toFixed(1);
        console.log(`[updater] ${info.version} in quarantine window (${daysLeft}d remaining); not downloading yet.`);
        return;
      }
      console.log(`[updater] ${info.version} cleared quarantine; downloading.`);
      await autoUpdater.downloadUpdate();
    } catch (err) {
      console.error('[updater] update-available handling failed:', err);
    }
  });

  autoUpdater.on('update-downloaded', async (info) => {
    // Surface to the renderer (badge), then require an explicit user click to
    // install — never restart-and-replace silently.
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.webContents.send('updater:ready', info.version);
    });

    if (installPrompted) return;
    installPrompted = true;
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Install and restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'wmux update ready',
      message: `wmux ${info.version} has been downloaded.`,
      detail: 'Review the release notes on GitHub before installing. Install now?',
    });
    if (response === 0) {
      autoUpdater.quitAndInstall();
    } else {
      installPrompted = false; // allow re-prompting on a later cycle
    }
  });

  autoUpdater.on('error', (err) => {
    if (isMissingChannelFileError(err)) {
      if (!missingChannelFileWarned) {
        missingChannelFileWarned = true;
        console.warn('[updater] latest.yml not found in latest release — update check skipped.');
      }
      return;
    }
    console.error('[updater] Auto-updater error:', err);
  });

  // Initial check + periodic re-check so a quarantined release installs once it
  // ages past the window, without needing an app restart.
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, RECHECK_INTERVAL_MS);
}
