import { useStore } from '../../store';
import { useT } from '../../i18n';

export default function BrowserSettings() {
  const t = useT();
  const { browserPrefs, setBrowserPrefs } = useStore();

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.browser.searchSection', 'Search')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.browser.defaultSearchEngine', 'Default search engine')}</label>
        <select
          className="settings-select"
          value={browserPrefs.searchEngine}
          onChange={(e) =>
            setBrowserPrefs({
              searchEngine: e.target.value as 'google' | 'duckduckgo' | 'bing' | 'brave',
            })
          }
        >
          <option value="google">Google</option>
          <option value="duckduckgo">DuckDuckGo</option>
          <option value="bing">Bing</option>
          <option value="brave">Brave Search</option>
        </select>
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.browser.startupSection', 'Startup')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.browser.openOnStartup', 'Open browser panel on startup')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={browserPrefs.openOnStartup}
          onChange={(e) => setBrowserPrefs({ openOnStartup: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label" htmlFor="browser-default-url">
          {t('settings.browser.defaultUrl', 'Start page')}
        </label>
        <input
          id="browser-default-url"
          type="text"
          className="settings-input"
          value={browserPrefs.defaultUrl}
          onChange={(e) => setBrowserPrefs({ defaultUrl: e.target.value })}
          placeholder="http://localhost:3000"
          spellCheck={false}
        />
      </div>
      <p className="settings-hint">
        {t(
          'settings.browser.defaultUrlHint',
          'Where a workspace\'s browser panel opens before it has been anywhere. Needs a scheme (http:// or https://). Leave empty for wmux\'s own page. Also settable in ~/.wmux/config.toml as [browser] default-url.',
        )}
      </p>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.browser.linksSection', 'Links')}</h3>

      <div className="settings-row">
        <label className="settings-label">
          {t('settings.browser.openLinksExternally', 'Open links in the system browser')}
        </label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={browserPrefs.openLinksExternally}
          onChange={(e) => setBrowserPrefs({ openLinksExternally: e.target.checked })}
        />
      </div>

      <p className="settings-hint">
        {t(
          'settings.browser.openLinksExternallyHint',
          'Clicked links in terminals and markdown go to your default browser instead of the wmux panel. Ctrl+click always does the opposite.',
        )}
      </p>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.browser.devToolsSection', 'Developer Tools')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.browser.devToolsIcon', 'DevTools icon')}</label>
        <select
          className="settings-select"
          value={browserPrefs.devToolsIcon}
          onChange={(e) =>
            setBrowserPrefs({
              devToolsIcon: e.target.value as 'default' | 'compact' | 'hidden',
            })
          }
        >
          <option value="default">{t('settings.browser.devToolsIcon.default', 'Default')}</option>
          <option value="compact">{t('settings.browser.devToolsIcon.compact', 'Compact')}</option>
          <option value="hidden">{t('settings.browser.devToolsIcon.hidden', 'Hidden')}</option>
        </select>
      </div>
    </div>
  );
}
