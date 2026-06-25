import { useEffect, useState } from 'react';
import { useT } from '../../i18n';

// Help / About panel — shows the running app version and quick links to the
// project's GitHub issues page and website. The version comes from the main
// process (Electron's app.getVersion()) so it always matches the packaged build
// rather than a hardcoded literal.
const REPO_URL = 'https://github.com/amirlehmam/wmux';
const ISSUES_URL = `${REPO_URL}/issues`;
const WEBSITE_URL = 'https://wmux.org';

export default function HelpSettings() {
  const t = useT();
  const [version, setVersion] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(window.wmux?.system?.getVersion?.())
      .then((v?: string) => {
        if (!cancelled && typeof v === 'string') setVersion(v);
      })
      .catch(() => {
        /* version unavailable — leave blank rather than crash the panel */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openExternal = (url: string) => window.wmux?.system?.openExternal?.(url);

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.help.about')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.help.version')}</label>
        <span>wmux{version ? ` v${version}` : ''}</span>
      </div>

      <div className="settings-row">
        <button
          className="settings-btn settings-btn--secondary"
          onClick={() => openExternal(ISSUES_URL)}
        >
          {t('settings.help.reportIssue')}
        </button>
        <button
          className="settings-btn settings-btn--secondary"
          onClick={() => openExternal(WEBSITE_URL)}
        >
          {t('settings.help.website')}
        </button>
      </div>

      <p className="settings-hint">{t('settings.help.hint')}</p>
    </div>
  );
}
