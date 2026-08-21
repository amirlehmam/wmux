import React from 'react';
import { useT } from '../../i18n';
import { useUpdate } from '../../hooks/useUpdate';

/**
 * The badge is the whole update UI. It used to be a link to the GitHub release
 * page, so on Windows "update" meant: download an installer, close wmux, run it
 * (issue #125). It now drives the in-app updater in place — one click downloads,
 * a second one (or the confirmation dialog) restarts into the new version.
 * Zip extracts (the README install) take a dedicated swap path; NSIS installs
 * still go through electron-updater.
 *
 * Opening the release page is still the fallback whenever the running build
 * can't self-update: a dev run, `WMUX_DISABLE_UPDATER=1`, or a release
 * published without a usable artifact.
 */
export default function UpdateBadge() {
  const { update, state, trigger } = useUpdate();
  const t = useT();

  // A download in flight is worth showing even before the poller has named a
  // version; otherwise the badge only exists once there's something to install.
  const busy = state.phase === 'downloading' || state.phase === 'checking';
  if (!update && !busy && state.phase !== 'ready') return null;

  const version = state.version ?? update?.version ?? '';

  let label: string;
  let title: string;
  switch (state.phase) {
    case 'checking':
      label = t('titlebar.updateChecking', 'Checking…');
      title = t('titlebar.updateChecking', 'Checking…');
      break;
    case 'downloading':
      label = `${state.percent}%`;
      title = `${t('titlebar.updateDownloading', 'Downloading update')} v${version} — ${state.percent}%`;
      break;
    case 'ready':
      label = t('titlebar.updateRestart', 'Restart');
      title = `${t('titlebar.updateReady', 'Update ready')}: v${version}\n${t('titlebar.updateRestartHint', 'Click to restart into the new version')}`;
      // Say it on the badge as well as in the dialog. A user who cannot grant
      // admin rights should find that out before committing to a restart,
      // rather than at a UAC prompt after wmux has quit (issue #167).
      if (state.needsElevation) {
        title += `\n${t('titlebar.updateNeedsAdmin', 'Requires administrator rights')}`;
      }
      break;
    case 'error': {
      const detail = state.message ? `: ${state.message}` : '';
      label = `v${version}`;
      title = `${t('titlebar.updateFailed', 'Update failed')}${detail}\n${t('titlebar.updateRetry', 'Click to try again')}`;
      break;
    }
    default:
      label = `v${version}`;
      title = `${t('titlebar.updateAvailable')}: v${version}\n${t('titlebar.updateInstall', 'Click to download and install')}`;
  }

  return (
    <button
      className={`titlebar__btn titlebar__update-badge titlebar__update-badge--${state.phase}`}
      onClick={() => { void trigger(); }}
      disabled={busy}
      title={title}
    >
      <span className="titlebar__update-badge__arrow">{state.phase === 'ready' ? '⟳' : '↑'}</span>
      <span className="titlebar__update-badge__version">{label}</span>
    </button>
  );
}
