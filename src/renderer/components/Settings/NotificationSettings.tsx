import { useStore } from '../../store';
import { useT } from '../../i18n';
import { NOTIFICATION_SOUND_LABELS, previewNotificationSound } from '../../notification-sound';

export default function NotificationSettings() {
  const t = useT();
  const { notificationPrefs, setNotificationPrefs } = useStore();

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.notifications.alertsSection', 'Alerts')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.toast', 'Show toast notifications')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.toast}
          onChange={(e) => setNotificationPrefs({ toast: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.taskbarFlash', 'Taskbar flash')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.taskbarFlash}
          onChange={(e) => setNotificationPrefs({ taskbarFlash: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.paneRing', 'Pane ring')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.paneRing}
          onChange={(e) => setNotificationPrefs({ paneRing: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.paneFlashAnimation', 'Pane flash animation')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.paneFlashAnimation}
          onChange={(e) => setNotificationPrefs({ paneFlashAnimation: e.target.checked })}
        />
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.notifications.aiAgentsSection', 'AI agents')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.agentInputNotify', 'Notify when agent needs input')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.agentInputNotify}
          onChange={(e) => setNotificationPrefs({ agentInputNotify: e.target.checked })}
        />
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.agentStopNotify', "Notify when agent finishes its turn")}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={notificationPrefs.agentStopNotify}
          onChange={(e) => setNotificationPrefs({ agentStopNotify: e.target.checked })}
        />
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.notifications.soundSection', 'Sound')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.notifications.sound', 'Notification sound')}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            className="settings-select"
            value={notificationPrefs.sound}
            onChange={(e) => {
              const sound = e.target.value as typeof notificationPrefs.sound;
              setNotificationPrefs({ sound });
              previewNotificationSound(sound);
            }}
          >
            {NOTIFICATION_SOUND_LABELS.map((s) => (
              <option key={s.value} value={s.value}>{t(s.labelKey, s.fallback)}</option>
            ))}
          </select>
          <button
            type="button"
            className="settings-button"
            disabled={notificationPrefs.sound === 'none'}
            onClick={() => previewNotificationSound(notificationPrefs.sound)}
          >
            {t('settings.notifications.preview', 'Preview')}
          </button>
        </div>
      </div>
    </div>
  );
}
