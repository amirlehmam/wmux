import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { LANGUAGES, Language, useT } from '../../i18n';
import type { AppearancePrefs } from '../../store/settings-slice';

// Named background presets for issue #89 — the first is the gradient the
// requester posted ("MyLovelyBackground"), kept verbatim as a tribute.
const BG_PRESETS: Array<{ name: string; css: string }> = [
  {
    name: 'Lovely',
    css: 'radial-gradient(ellipse at 0% 0%, rgba(9, 140, 206, 0.40) 0%, transparent 75%), radial-gradient(ellipse at 100% 100%, rgba(137, 33, 210, 0.35) 0%, transparent 75%), #1a1a1a',
  },
  {
    name: 'Ember',
    css: 'radial-gradient(ellipse at 20% 100%, rgba(255, 94, 58, 0.28) 0%, transparent 70%), radial-gradient(ellipse at 90% 0%, rgba(255, 184, 0, 0.18) 0%, transparent 65%), #151210',
  },
  {
    name: 'Deep sea',
    css: 'linear-gradient(160deg, #04141f 0%, #062c3e 55%, #04303a 100%)',
  },
  {
    name: 'Aurora',
    css: 'radial-gradient(ellipse at 50% 0%, rgba(64, 224, 160, 0.22) 0%, transparent 60%), radial-gradient(ellipse at 0% 100%, rgba(80, 120, 255, 0.25) 0%, transparent 70%), #0d1117',
  },
  {
    name: 'Graphite',
    css: 'linear-gradient(135deg, #1c1c1e 0%, #2a2a2e 50%, #1c1c1e 100%)',
  },
];

// General settings — the UI language switcher (issue #56), the app UI theme
// switcher (issue #67), and the custom background parallel to theming
// (issue #89). The app previously had no way to change language, or to run
// in anything but dark mode, from the gear page.
export default function GeneralSettings() {
  const language = useStore((s) => s.language);
  const setLanguage = useStore((s) => s.setLanguage);
  const uiTheme = useStore((s) => s.appearancePrefs.uiTheme);
  const appearancePrefs = useStore((s) => s.appearancePrefs);
  const setAppearancePrefs = useStore((s) => s.setAppearancePrefs);
  const t = useT();

  // The Explorer verb's state lives in the registry, NOT in wmux's prefs — the
  // user can remove the keys with regedit or another tool, and a persisted
  // boolean would then confidently show a checkbox that matches nothing. Read
  // the real thing on mount, and re-read whatever the write actually achieved.
  const [contextMenu, setContextMenu] = useState(false);
  const [contextMenuBusy, setContextMenuBusy] = useState(false);
  const [contextMenuError, setContextMenuError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.wmux?.system?.getContextMenu?.()
      .then((on: boolean) => { if (!cancelled) setContextMenu(!!on); })
      .catch(() => { /* registry unreadable — leave the toggle showing off */ });
    return () => { cancelled = true; };
  }, []);

  const applyContextMenu = async (next: boolean) => {
    setContextMenuBusy(true);
    setContextMenuError(false);
    try {
      const res = await window.wmux?.system?.setContextMenu?.(
        next,
        t('settings.general.contextMenuLabel'),
      );
      // Trust the reported state over the requested one: a half-written set of
      // registry keys must leave the checkbox showing what is actually there.
      setContextMenu(res ? res.enabled : next);
      setContextMenuError(!!res && !res.ok);
    } catch {
      setContextMenuError(true);
    } finally {
      setContextMenuBusy(false);
    }
  };

  const activePreset = BG_PRESETS.find((p) => p.css === appearancePrefs.customBackground)?.name ?? '';

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

      <h3 className="settings-section-title">{t('settings.general.shellSection')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.general.contextMenu')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={contextMenu}
          disabled={contextMenuBusy}
          onChange={(e) => { applyContextMenu(e.target.checked); }}
        />
      </div>

      <p className="settings-hint">
        {contextMenuError ? t('settings.general.contextMenuFailed') : t('settings.general.contextMenuHint')}
      </p>

      <h3 className="settings-section-title">{t('settings.general.customBgSection')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.general.customBgEnable')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={appearancePrefs.customBackgroundEnabled}
          onChange={(e) => setAppearancePrefs({ customBackgroundEnabled: e.target.checked })}
        />
      </div>

      {appearancePrefs.customBackgroundEnabled && (
        <>
          <div className="settings-row">
            <label className="settings-label">{t('settings.general.customBgPreset')}</label>
            <select
              className="settings-select"
              value={activePreset}
              onChange={(e) => {
                const preset = BG_PRESETS.find((p) => p.name === e.target.value);
                if (preset) setAppearancePrefs({ customBackground: preset.css });
              }}
            >
              <option value="">{t('settings.general.customBgPreset.none')}</option>
              {BG_PRESETS.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <label className="settings-label">{t('settings.general.customBgCss')}</label>
            <textarea
              className="settings-input"
              style={{ minHeight: 64, resize: 'vertical', fontFamily: 'Consolas, monospace', fontSize: 12 }}
              value={appearancePrefs.customBackground}
              onChange={(e) => setAppearancePrefs({ customBackground: e.target.value })}
              placeholder="radial-gradient(ellipse at 0% 0%, rgba(9,140,206,0.4) 0%, transparent 75%), #1a1a1a"
              spellCheck={false}
            />
          </div>

          {/* Live preview of the background as the terminal would show it */}
          {appearancePrefs.customBackground.trim() !== '' && (
            <div className="settings-row">
              <div
                aria-hidden
                style={{
                  width: '100%',
                  height: 56,
                  borderRadius: 6,
                  border: '1px solid rgba(128,128,128,0.25)',
                  background: appearancePrefs.customBackground,
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  background: `rgba(30, 30, 30, ${(appearancePrefs.terminalBgOpacity ?? 88) / 100})`,
                  color: '#9ecbff',
                  fontFamily: 'Consolas, monospace',
                  fontSize: 12,
                  padding: '6px 8px',
                }}>
                  $ echo preview
                </div>
              </div>
            </div>
          )}

          <div className="settings-row">
            <label className="settings-label">
              {t('settings.general.customBgOpacity')} — {appearancePrefs.terminalBgOpacity}%
            </label>
            <input
              type="range"
              min={30}
              max={100}
              step={1}
              value={appearancePrefs.terminalBgOpacity}
              onChange={(e) => setAppearancePrefs({ terminalBgOpacity: Number(e.target.value) })}
            />
          </div>
        </>
      )}

      <p className="settings-hint">{t('settings.general.customBgHint')}</p>
    </div>
  );
}
