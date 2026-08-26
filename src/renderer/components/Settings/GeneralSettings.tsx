import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { LANGUAGES, Language, useT } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import type { AppearancePrefs } from '../../store/settings-slice';
import AgentIntegrationSettings from './AgentIntegrationSettings';
import { formatBinding } from './KeyboardSettings';
import { MIN_TERMINAL_OPACITY_PCT, opacityToAlpha } from '../../store/backdrop';
import { backdropCaps, NO_BACKDROP, type BackdropCaps } from '../../utils/backdrop-caps';

// Named background presets for issue #89 — the first is the gradient the
// requester posted ("MyLovelyBackground"), kept verbatim as a tribute.
const BG_PRESETS: Array<{ nameKey: TranslationKey; fallback: string; css: string }> = [
  {
    nameKey: 'settings.general.bgPreset.lovely',
    fallback: 'Lovely',
    css: 'radial-gradient(ellipse at 0% 0%, rgba(9, 140, 206, 0.40) 0%, transparent 75%), radial-gradient(ellipse at 100% 100%, rgba(137, 33, 210, 0.35) 0%, transparent 75%), #1a1a1a',
  },
  {
    nameKey: 'settings.general.bgPreset.ember',
    fallback: 'Ember',
    css: 'radial-gradient(ellipse at 20% 100%, rgba(255, 94, 58, 0.28) 0%, transparent 70%), radial-gradient(ellipse at 90% 0%, rgba(255, 184, 0, 0.18) 0%, transparent 65%), #151210',
  },
  {
    nameKey: 'settings.general.bgPreset.deepSea',
    fallback: 'Deep sea',
    css: 'linear-gradient(160deg, #04141f 0%, #062c3e 55%, #04303a 100%)',
  },
  {
    nameKey: 'settings.general.bgPreset.aurora',
    fallback: 'Aurora',
    css: 'radial-gradient(ellipse at 50% 0%, rgba(64, 224, 160, 0.22) 0%, transparent 60%), radial-gradient(ellipse at 0% 100%, rgba(80, 120, 255, 0.25) 0%, transparent 70%), #0d1117',
  },
  {
    nameKey: 'settings.general.bgPreset.graphite',
    fallback: 'Graphite',
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
  const openHubBinding = useStore((s) => s.shortcuts.openHub);
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

  const activePreset = BG_PRESETS.find((p) => p.css === appearancePrefs.customBackground)?.nameKey ?? '';

  // Asked of main rather than sniffed here: the renderer only sees a Chrome UA
  // string. Two flags, because plain alpha needs only DWM while the blur
  // materials need Win11 — collapsing them would hide transparency from every
  // Windows 10 user over a mode they never asked for.
  const [caps, setCaps] = useState<BackdropCaps>(NO_BACKDROP);
  useEffect(() => {
    let cancelled = false;
    backdropCaps().then((c) => { if (!cancelled) setCaps(c); });
    return () => { cancelled = true; };
  }, []);

  // Set by useWindowTransparency (called once, in App) when the setting on
  // screen is ahead of the window on screen.
  const needsRestart = useStore((s) => s.transparencyNeedsRestart);

  // The slider is window opacity, so it needs a transparent window to mean
  // anything. A custom background alone no longer qualifies: it now replaces
  // the terminal's colour outright rather than being faded toward, so with an
  // opaque window there is nothing left for the slider to move.
  //
  // Deliberately the pref alone, NOT hasTransparentWindow's pref-and-not-
  // pending: the other call sites are asking what to PAINT, and until the
  // restart lands the answer there is "still opaque". This one is asking what
  // to OFFER, and the moment after someone ticks the box is exactly when they
  // want to set the opacity the restart will come up with. The restart hint
  // sits directly above it.
  const opacityApplies = appearancePrefs.windowTransparency;
  const effectiveOpacity = Math.round(opacityToAlpha(appearancePrefs.terminalBgOpacity) * 100);

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
      {/* Someone who wants to fix a translation looks here, not in the docs
          (issue #147). The path is the discoverable part — `wmux locales`
          reports what loaded and why anything was rejected. */}
      <p className="settings-hint">
        {t('settings.general.languageCustomHint')} <code>~/.wmux/locales</code>
      </p>

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
                const preset = BG_PRESETS.find((p) => p.nameKey === e.target.value);
                if (preset) setAppearancePrefs({ customBackground: preset.css });
              }}
            >
              <option value="">{t('settings.general.customBgPreset.none')}</option>
              {BG_PRESETS.map((p) => (
                <option key={p.nameKey} value={p.nameKey}>{t(p.nameKey, p.fallback)}</option>
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
                {/* No scrim: the terminal's own background is fully transparent
                    wherever a custom background is set, so a pane really does
                    render as text straight onto this. */}
                <div style={{
                  position: 'absolute',
                  inset: 0,
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
        </>
      )}

      <p className="settings-hint">{t('settings.general.customBgHint')}</p>

      {caps.transparency && (
        <>
          <h3 className="settings-section-title">{t('settings.general.transparencySection')}</h3>

          <div className="settings-row">
            <label className="settings-label">{t('settings.general.transparencyEnable')}</label>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={appearancePrefs.windowTransparency}
              onChange={(e) => setAppearancePrefs({ windowTransparency: e.target.checked })}
            />
          </div>

          {appearancePrefs.windowTransparency && (
            <div className="settings-row">
              <label className="settings-label">{t('settings.general.transparencyMaterial')}</label>
              <select
                className="settings-select"
                value={appearancePrefs.windowMaterial}
                onChange={(e) =>
                  setAppearancePrefs({ windowMaterial: e.target.value as AppearancePrefs['windowMaterial'] })
                }
              >
                <option value="clear">{t('settings.general.transparencyMaterial.clear')}</option>
                {/* Blur materials are Win11-only — picking one on Windows 10
                    would just produce a black window. Rendered and DISABLED
                    rather than omitted: a settings.json carrying 'acrylic' does
                    reach a Windows 10 machine (they roam), and a controlled
                    select whose value matches no option shows blank, which
                    reads as a broken dropdown rather than as an unavailable
                    choice. */}
                <option value="acrylic" disabled={!caps.materials}>
                  {t('settings.general.transparencyMaterial.acrylic')}
                </option>
                <option value="mica" disabled={!caps.materials}>
                  {t('settings.general.transparencyMaterial.mica')}
                </option>
              </select>
            </div>
          )}

          <p className="settings-hint">{t('settings.general.transparencyHint')}</p>

          {needsRestart && (
            <p className="settings-hint">{t('settings.general.transparencyRestart')}</p>
          )}
        </>
      )}

      {opacityApplies && (
        <div className="settings-row">
          <label className="settings-label">
            {/* The floored value, not the stored one. A blob saved before the
                floor existed can hold 0, and a label reading 0% beside a
                terminal rendering at 15% is just a lie. */}
            {t('settings.general.customBgOpacity')} — {effectiveOpacity}%
          </label>
          <input
            type="range"
            min={MIN_TERMINAL_OPACITY_PCT}
            max={100}
            step={1}
            value={effectiveOpacity}
            onChange={(e) => setAppearancePrefs({ terminalBgOpacity: Number(e.target.value) })}
          />
        </div>
      )}

      <AgentIntegrationSettings />

      <h3 className="settings-section-title">{t('settings.general.easterEggSection', 'Easter eggs')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.general.hubEnable', 'Agent office')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={appearancePrefs.hubEnabled}
          onChange={(e) => setAppearancePrefs({ hubEnabled: e.target.checked })}
        />
      </div>

      <p className="settings-hint">
        {/* The LIVE binding, not the default — a rebind in the panel one tab
            over must not leave this hint advertising a dead combo. */}
        {t('settings.general.hubEnableHint', 'Watch your agents as pixel characters in a tiny office. Adds a titlebar button and enables {binding}.')
          .replace('{binding}', formatBinding(openHubBinding))}
      </p>
    </div>
  );
}
