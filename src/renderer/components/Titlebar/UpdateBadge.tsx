import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n';

interface UpdateInfo {
  version: string;
  url: string;
  body?: string;
  publishedAt?: string;
}

interface UpdateState {
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
  version: string | null;
  percent: number;
  message?: string;
}

const IDLE: UpdateState = { phase: 'idle', version: null, percent: 0 };

/**
 * The badge is the whole update UI. It used to be a link to the GitHub release
 * page, so on Windows "update" meant: download an installer, close wmux, run it
 * (issue #125). It now drives electron-updater in place — one click downloads,
 * a second one (or the confirmation dialog) restarts into the new version.
 *
 * Opening the release page is still the fallback whenever the running build
 * can't self-update: a dev run, `WMUX_DISABLE_UPDATER=1`, or a release
 * published without latest.yml.
 */
export default function UpdateBadge() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [state, setState] = useState<UpdateState>(IDLE);
  const t = useT();

  useEffect(() => {
    const wmux = (window as any).wmux;
    if (!wmux?.update) return;

    // Pick up an update that may have been detected before this window mounted.
    wmux.update.getLatest().then((info: UpdateInfo | null) => {
      if (info) setUpdate(info);
    }).catch(() => {});
    wmux.update.getState?.().then((s: UpdateState | null) => {
      if (s) setState(s);
    }).catch(() => {});

    const offAvailable = wmux.update.onAvailable((info: UpdateInfo) => setUpdate(info));
    const offState = wmux.update.onState?.((s: UpdateState) => setState(s));
    return () => {
      offAvailable?.();
      offState?.();
    };
  }, []);

  const handleClick = useCallback(async () => {
    const api = (window as any).wmux?.update;
    if (!api) return;
    const openRelease = () => update && api.openRelease?.(update.url);

    if (!api.install) { openRelease(); return; }
    try {
      const result = await api.install();
      if (!result?.handled) openRelease();
    } catch {
      openRelease();
    }
  }, [update]);

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
      onClick={handleClick}
      disabled={busy}
      title={title}
    >
      <span className="titlebar__update-badge__arrow">{state.phase === 'ready' ? '⟳' : '↑'}</span>
      <span className="titlebar__update-badge__version">{label}</span>
    </button>
  );
}
