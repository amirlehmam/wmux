import { autoUpdater } from 'electron-updater';
import { app, BrowserWindow, dialog } from 'electron';
import { IPC_CHANNELS } from '../shared/types';
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

// ── In-app install, driven by the badge (issue #125) ─────────────────────────
// The titlebar badge used to be notify-only: it opened the GitHub release page
// and left the user to download and run an installer by hand, which read as
// "Windows doesn't get the real updater". It does — electron-updater was
// already running, just silently, and the quarantine window meant a freshly
// published release was days away from downloading. Clicking the badge now
// drives that same updater directly.
//
// The click BYPASSES the quarantine window on purpose. Quarantine exists to
// stop a malicious release from installing itself before anyone can yank it
// (issue #29); a user who reads the version and clicks is making that call
// themselves, and the install still needs the confirmation dialog below.
// Nothing about the unattended path changes.

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  version: string | null;
  /** 0–100 while downloading. */
  percent: number;
  message?: string;
}

let state: UpdateState = { phase: 'idle', version: null, percent: 0 };
// Set while a user-initiated flow owns the download, so the unattended
// `update-available` handler doesn't start a second one or re-apply quarantine.
let userDriven = false;

export function getUpdateState(): UpdateState {
  return state;
}

function setState(next: Partial<UpdateState>): void {
  state = { ...state, ...next };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.UPDATE_STATE, state);
  }
}

/** True when this build can actually install an update in place. */
export function canSelfUpdate(): boolean {
  return app.isPackaged && !isUpdaterDisabled();
}

/**
 * Badge click. Resolves as soon as the flow is under way — download progress
 * and the ready state arrive over UPDATE_STATE, not on this promise.
 *
 * `handled: false` means the caller should fall back to opening the release
 * page: an unpackaged dev run, the updater kill switch, a release with no
 * latest.yml, or any updater error. The GitHub link stays the safety net it
 * always was; it is just no longer the only path.
 */
export async function requestUpdateNow(): Promise<{ handled: boolean; reason?: string }> {
  if (!canSelfUpdate()) return { handled: false, reason: 'not_supported' };

  // Already downloaded — this click is the install confirmation.
  if (state.phase === 'ready') {
    setImmediate(() => autoUpdater.quitAndInstall());
    return { handled: true };
  }
  if (state.phase === 'checking' || state.phase === 'downloading') return { handled: true };

  userDriven = true;
  setState({ phase: 'checking', percent: 0, message: undefined });
  try {
    const result = await autoUpdater.checkForUpdates();
    const version = result?.updateInfo?.version ?? null;
    if (!version) {
      userDriven = false;
      setState({ phase: 'idle', version: null, percent: 0 });
      return { handled: false, reason: 'no_update' };
    }
    setState({ phase: 'downloading', version, percent: 0 });
    // Deliberately not awaited: the download can take minutes and the caller is
    // an IPC round-trip. Progress and completion come over UPDATE_STATE.
    autoUpdater.downloadUpdate().catch((err) => {
      userDriven = false;
      console.error('[updater] user-requested download failed:', err);
      setState({ phase: 'error', message: String((err as Error)?.message ?? err) });
    });
    return { handled: true };
  } catch (err) {
    userDriven = false;
    const reason = isMissingChannelFileError(err) ? 'no_channel_file' : 'error';
    console.warn(`[updater] user-requested update unavailable (${reason}):`, err);
    setState({ phase: 'idle', percent: 0 });
    return { handled: false, reason };
  }
}

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

  autoUpdater.on('download-progress', (progress) => {
    setState({ phase: 'downloading', percent: Math.round(progress?.percent ?? 0) });
  });

  autoUpdater.on('update-available', async (info) => {
    // A user-initiated flow already owns this update; don't race it.
    if (userDriven) return;
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
    userDriven = false;
    setState({ phase: 'ready', version: info.version, percent: 100 });

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
    const wasBusy = state.phase === 'checking' || state.phase === 'downloading';
    userDriven = false;
    if (isMissingChannelFileError(err)) {
      if (!missingChannelFileWarned) {
        missingChannelFileWarned = true;
        console.warn('[updater] latest.yml not found in latest release — update check skipped.');
      }
      // Nothing to install here; drop back to the notify-only badge rather than
      // showing the user an error they can do nothing about.
      if (wasBusy) setState({ phase: 'idle', percent: 0 });
      return;
    }
    console.error('[updater] Auto-updater error:', err);
    if (wasBusy) setState({ phase: 'error', message: String((err as Error)?.message ?? err) });
  });

  // Initial check + periodic re-check so a quarantined release installs once it
  // ages past the window, without needing an app restart.
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, RECHECK_INTERVAL_MS);
}
