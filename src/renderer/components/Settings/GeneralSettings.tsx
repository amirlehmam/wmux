import { useStore } from '../../store';
import { LANGUAGES, Language, useT } from '../../i18n';
import type { AppearancePrefs } from '../../store/settings-slice';

// General settings — currently the UI language switcher (issue #56) and the
// app UI theme switcher (issue #67). The app previously had no way to change
// language, or to run in anything but dark mode, from the gear page.
export default function GeneralSettings() {
  const language = useStore((s) => s.language);
  const setLanguage = useStore((s) => s.setLanguage);
  const uiTheme = useStore((s) => s.appearancePrefs.uiTheme);
  const setAppearancePrefs = useStore((s) => s.setAppearancePrefs);
  const t = useT();

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.general.languageSection')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.general.language')}</label>
        <select
          className="settings-select"
          value={language}
          onChange={(e) => setLanguage(e.target.value as Language)}
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.label}
            </option>
          ))}
        </select>
      </div>

      <p className="settings-hint">{t('settings.general.languageHint')}</p>

      <h3 className="settings-section-title">{t('settings.general.appearanceSection')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.general.uiTheme')}</label>
        <select
          className="settings-select"
          value={uiTheme}
          onChange={(e) => setAppearancePrefs({ uiTheme: e.target.value as AppearancePrefs['uiTheme'] })}
        >
          <option value="system">{t('settings.general.uiTheme.system')}</option>
          <option value="dark">{t('settings.general.uiTheme.dark')}</option>
          <option value="light">{t('settings.general.uiTheme.light')}</option>
        </select>
      </div>

      <p className="settings-hint">{t('settings.general.appearanceHint')}</p>
    </div>
  );
}
