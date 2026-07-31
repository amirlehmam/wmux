import { useStore } from '../../store';
import { useT } from '../../i18n';

export default function SidebarSettings() {
  const t = useT();
  const { sidebarPrefs, setSidebarPrefs, appearancePrefs, setAppearancePrefs } = useStore();

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.sidebarPanel.detailsSection', 'Sidebar Details')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.sidebarPanel.showGitBranch', 'Show git branch')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={sidebarPrefs.showGitBranch}
          onChange={(e) => setSidebarPrefs({ showGitBranch: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.sidebarPanel.showWorkingDir', 'Show working directory')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={sidebarPrefs.showWorkingDir}
          onChange={(e) => setSidebarPrefs({ showWorkingDir: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.sidebarPanel.showPR', 'Show PR status')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={sidebarPrefs.showPR}
          onChange={(e) => setSidebarPrefs({ showPR: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.sidebarPanel.showPorts', 'Show ports')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={sidebarPrefs.showPorts}
          onChange={(e) => setSidebarPrefs({ showPorts: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.sidebarPanel.showNotificationMessage', 'Show notification message')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={sidebarPrefs.showNotificationMessage}
          onChange={(e) => setSidebarPrefs({ showNotificationMessage: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.sidebarPanel.hideAllDetails', 'Hide all details')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={sidebarPrefs.hideAllDetails}
          onChange={(e) => setSidebarPrefs({ hideAllDetails: e.target.checked })}
        />
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.sidebarPanel.appearanceSection', 'Appearance')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.sidebarPanel.mode', 'Sidebar mode')}</label>
        <select
          className="settings-select"
          value={appearancePrefs.uiMode}
          onChange={(e) =>
            setAppearancePrefs({ uiMode: e.target.value as 'classic' | 'trace' })
          }
        >
          <option value="classic">{t('settings.sidebarPanel.mode.classic', 'Classic')}</option>
          <option value="trace">{t('settings.sidebarPanel.mode.trace', 'TRACE — live circuit')}</option>
        </select>
      </div>

      <div className="settings-row settings-row--column">
        <p className="settings-hint">
          {t(
            'settings.sidebarPanel.traceHint',
            'TRACE renders each Claude session as a tap on a copper bus. Current flows only where work is actually happening, tool calls fire rings, and the colour tells you whether an agent is reading, writing, running commands or delegating. Composes with both light and dark.',
          )}
        </p>
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.sidebarPanel.activeTabIndicator', 'Active tab indicator')}</label>
        <select
          className="settings-select"
          value={sidebarPrefs.activeTabIndicator}
          onChange={(e) =>
            setSidebarPrefs({
              activeTabIndicator: e.target.value as 'leftRail' | 'solidFill',
            })
          }
        >
          <option value="leftRail">{t('settings.sidebarPanel.indicator.leftRail', 'Left Rail')}</option>
          <option value="solidFill">{t('settings.sidebarPanel.indicator.solidFill', 'Solid Fill')}</option>
        </select>
      </div>

      <div className="settings-row settings-row--column">
        <div className="settings-row-header">
          <label className="settings-label">{t('settings.sidebarPanel.backgroundOpacity', 'Background opacity')}</label>
          <span className="settings-value">{sidebarPrefs.backgroundOpacity}%</span>
        </div>
        <input
          type="range"
          className="settings-slider"
          min={10}
          max={100}
          value={sidebarPrefs.backgroundOpacity}
          onChange={(e) => setSidebarPrefs({ backgroundOpacity: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}
