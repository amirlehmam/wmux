import React, { useEffect, useState } from 'react';
import { useT } from '../../i18n';

interface UpdateInfo {
  version: string;
  url: string;
  body?: string;
  publishedAt?: string;
}

export default function UpdateBadge() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const t = useT();

  useEffect(() => {
    const wmux = (window as any).wmux;
    if (!wmux?.update) return;

    // Pick up an update that may have been detected before this window mounted.
    wmux.update.getLatest().then((info: UpdateInfo | null) => {
      if (info) setUpdate(info);
    }).catch(() => {});

    const unsub = wmux.update.onAvailable((info: UpdateInfo) => setUpdate(info));
    return unsub;
  }, []);

  if (!update) return null;

  const handleClick = () => {
    (window as any).wmux?.update?.openRelease?.(update.url);
  };

  return (
    <button
      className="titlebar__btn titlebar__update-badge"
      onClick={handleClick}
      title={`${t('titlebar.updateAvailable')}: v${update.version}\n${t('titlebar.updateDownload')}`}
    >
      <span className="titlebar__update-badge__arrow">↑</span>
      <span className="titlebar__update-badge__version">v{update.version}</span>
    </button>
  );
}
