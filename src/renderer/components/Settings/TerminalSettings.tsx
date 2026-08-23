import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { AppearancePrefs, TerminalPrefs, UserColorScheme } from '../../store/settings-slice';
import type { ThemeConfig } from '../../../shared/types';

/** First family of a CSS font stack, unquoted — used to match the picker. */
function firstFamily(stack: string): string {
  const first = (stack || '').split(',')[0].trim();
  return first.replace(/^['"]/, '').replace(/['"]$/, '');
}

/** Quote a family name for CSS if it needs it (spaces etc.). */
function cssFamily(name: string): string {
  return /^[A-Za-z][A-Za-z0-9-]*$/.test(name) ? name : `'${name}'`;
}

export default function TerminalSettings() {
  const t = useT();
  const { terminalPrefs, setTerminalPrefs } = useStore();
  const setAppearancePrefs = useStore((s) => s.setAppearancePrefs);
  const [themes, setThemes] = useState<string[]>(['Monokai']);
  const [newSchemeName, setNewSchemeName] = useState('');
  // Installed font families for the picker (issue #89) — enumerated by the
  // main process from the Windows font registry, so users don't have to guess
  // what to type into the free-text stack field.
  const [systemFonts, setSystemFonts] = useState<string[]>([]);

  // Load the list of bundled themes from the main process on mount so the
  // dropdown reflects actual files in resources/themes/ rather than a stub.
  useEffect(() => {
    (window as any).wmux?.config?.getThemeList?.().then((list: string[]) => {
      if (Array.isArray(list) && list.length > 0) setThemes(list);
    });
    (window as any).wmux?.system?.getFonts?.().then((list: string[]) => {
      if (Array.isArray(list)) setSystemFonts(list);
    }).catch(() => { /* picker simply stays hidden */ });
  }, []);

  const currentFamily = firstFamily(terminalPrefs.fontFamily);
  const pickerValue = systemFonts.includes(currentFamily) ? currentFamily : '';

  const userSchemeNames = Object.keys(terminalPrefs.userColorSchemes || {});
  const allSchemes = Array.from(new Set([...themes, ...userSchemeNames])).sort((a, b) => a.localeCompare(b));

  const addUserScheme = () => {
    const name = newSchemeName.trim();
    if (!name) return;
    setTerminalPrefs({
      userColorSchemes: {
        ...terminalPrefs.userColorSchemes,
        [name]: { background: '#1e1e1e', foreground: '#dddddd', cursor: '#ffffff' },
      },
    });
    setNewSchemeName('');
  };

  const updateUserScheme = (name: string, patch: Partial<UserColorScheme>) => {
    setTerminalPrefs({
      userColorSchemes: {
        ...terminalPrefs.userColorSchemes,
        [name]: { ...terminalPrefs.userColorSchemes[name], ...patch },
      },
    });
  };

  const removeUserScheme = (name: string) => {
    const next = { ...terminalPrefs.userColorSchemes };
    delete next[name];
    setTerminalPrefs({ userColorSchemes: next });
  };

  // ── Import an existing terminal's config ───────────────────────────────────
  // Both parsers have existed in the main process since config-loader.ts was
  // written, wired through preload and IPC, with nothing in the UI ever calling
  // them — which is also why the `background-opacity` they parse was never
  // applied to anything. These two buttons are the missing end of that path.
  const [importStatus, setImportStatus] = useState<string | null>(null);
  // One click writes seven settings across two slices, one of which asks for
  // a restart — a lot to land on someone who was aiming at the button beside
  // it, and not recoverable by hand once their old font size is gone. So each
  // import parks the exact keys it is about to overwrite and offers them back.
  const [importUndo, setImportUndo] = useState<
    { terminal: Partial<TerminalPrefs>; appearance: Partial<AppearancePrefs> } | null
  >(null);

  const undoImport = () => {
    if (!importUndo) return;
    setTerminalPrefs(importUndo.terminal);
    // Putting windowTransparency back re-runs useWindowTransparency, which
    // re-derives the restart flag from the window itself — so undoing an
    // import that turned transparency on also clears the restart banner it
    // raised, provided the window was never rebuilt in between.
    setAppearancePrefs(importUndo.appearance);
    setImportUndo(null);
    setImportStatus(t('settings.terminalPanel.importReverted', 'Import reverted.'));
  };

  const runImport = async (source: 'wt' | 'ghostty') => {
    const config = (window as any).wmux?.config;
    const theme: ThemeConfig | null = source === 'ghostty'
      ? await config?.importGhostty?.()
      : await config?.importWindowsTerminal?.();

    // Null is the parsers' "no config file at the expected path", not an error.
    if (!theme) {
      setImportStatus(t('settings.terminalPanel.importNotFound', 'No config found to import.'));
      return;
    }

    const name = theme.name || (source === 'ghostty' ? 'Ghostty' : 'Windows Terminal');

    // Read through the store rather than the render closure: the await above
    // means this handler can outlive the render that created it.
    const prevTerminal = useStore.getState().terminalPrefs;
    const prevAppearance = useStore.getState().appearancePrefs;
    setImportUndo({
      // The whole userColorSchemes map, not just the imported key: the source
      // may name a scheme the user already had, and this silently replaces it.
      terminal: {
        userColorSchemes: prevTerminal.userColorSchemes,
        theme: prevTerminal.theme,
        fontFamily: prevTerminal.fontFamily,
        fontSize: prevTerminal.fontSize,
      },
      appearance: {
        terminalBgOpacity: prevAppearance.terminalBgOpacity,
        windowTransparency: prevAppearance.windowTransparency,
        windowMaterial: prevAppearance.windowMaterial,
      },
    });
    setTerminalPrefs({
      userColorSchemes: {
        ...prevTerminal.userColorSchemes,
        [name]: {
          background: theme.background,
          foreground: theme.foreground,
          cursor: theme.cursor,
          cursorText: theme.cursorText,
          selectionBackground: theme.selectionBackground,
          selectionForeground: theme.selectionForeground,
          palette: theme.palette,
        },
      },
      theme: name,
      ...(theme.fontFamily ? { fontFamily: cssFamily(theme.fontFamily) } : {}),
      ...(theme.fontSize ? { fontSize: theme.fontSize } : {}),
    });

    // The imported opacity only means something if there is a backdrop behind
    // the terminal, and the source terminals both mean "let the desktop show
    // through" by it. So turning it on is part of honouring the import — set
    // the number alone and it would silently do nothing, which is the exact bug
    // this path had in the first place.
    const pct = Math.round(Math.max(0, Math.min(1, theme.backgroundOpacity ?? 1)) * 100);
    let note = '';
    if (pct < 100) {
      // Plain alpha is what both source terminals mean by opacity, and it
      // needs only DWM — so this is gated on `transparency`, not `materials`.
      const caps = await (window as any).wmux?.window?.supportsBackdrop?.();
      const supported = caps?.transparency === true;
      setAppearancePrefs({
        terminalBgOpacity: pct,
        ...(supported ? { windowTransparency: true, windowMaterial: 'clear' } : {}),
      });
      note = supported
        ? ` · ${pct}% ${t('settings.terminalPanel.importRestart', '(restart to apply transparency)')}`
        : ` · ${pct}%`;
    }

    setImportStatus(
      `${t('settings.terminalPanel.imported', 'Imported')} ${name}${note}`,
    );
  };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.terminalPanel.font', 'Font')}</h3>

      {systemFonts.length > 0 && (
        <div className="settings-row">
          <label className="settings-label">{t('settings.terminalPanel.font', 'Font')}</label>
          <select
            className="settings-select"
            value={pickerValue}
            onChange={(e) => {
              const name = e.target.value;
              if (name) setTerminalPrefs({ fontFamily: `${cssFamily(name)}, Consolas, monospace` });
            }}
          >
            <option value="">{pickerValue
              ? t('settings.terminalPanel.customStack', 'Custom stack…')
              : t('settings.terminalPanel.pickInstalledFont', 'Pick an installed font ({count})…').replace('{count}', String(systemFonts.length))}</option>
            {systemFonts.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </div>
      )}

      <div className="settings-row">
        <label className="settings-label">{t('settings.terminalPanel.fontStackAdvanced', 'Font stack (advanced)')}</label>
        <input
          type="text"
          className="settings-input"
          value={terminalPrefs.fontFamily}
          onChange={(e) => setTerminalPrefs({ fontFamily: e.target.value })}
          placeholder={t('settings.terminalPanel.fontStackPlaceholder', 'e.g. Consolas, Menlo, monospace')}
        />
      </div>

      {/* Live preview in the selected font, so a pick is verifiable at a glance */}
      <div className="settings-row">
        <div
          style={{
            width: '100%',
            padding: '6px 10px',
            borderRadius: 4,
            border: '1px solid rgba(128,128,128,0.25)',
            fontFamily: terminalPrefs.fontFamily || 'monospace',
            fontSize: terminalPrefs.fontSize || 13,
            opacity: 0.9,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          {currentFamily || 'monospace'} — 0O 1lI {'{}'} =&gt; -&gt; :: 42
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.terminalPanel.fontSize', 'Font size')}</label>
        <input
          type="number"
          className="settings-input settings-input--narrow"
          value={terminalPrefs.fontSize}
          min={8}
          max={72}
          onChange={(e) => setTerminalPrefs({ fontSize: Number(e.target.value) })}
        />
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.terminalPanel.colorSchemeSection', 'Color scheme')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.terminalPanel.defaultScheme', 'Default scheme')}</label>
        <div className="settings-theme-row">
          <select
            className="settings-select"
            value={terminalPrefs.theme}
            onChange={(e) => setTerminalPrefs({ theme: e.target.value })}
          >
            {allSchemes.map((scheme) => (
              <option key={scheme} value={scheme}>{scheme}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="settings-row" style={{ opacity: 0.7, fontSize: '12px' }}>
        {t('settings.terminalPanel.schemeHintPart1', 'Applied to new panes. Override per pane via ')}<code>wmux split --color-scheme NAME</code>{t('settings.terminalPanel.schemeHintPart2', ' or ')}<code>wmux set-color-scheme NAME</code>{t('settings.terminalPanel.schemeHintPart3', '.')}
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.terminalPanel.importSection', 'Import')}</h3>
      <div className="settings-row" style={{ opacity: 0.7, fontSize: '12px' }}>
        {t('settings.terminalPanel.importHint', 'Bring colors, font and background opacity across from a terminal you already have set up. Saved as a custom scheme and selected.')}
      </div>
      <div className="settings-row">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="settings-btn settings-btn--secondary" onClick={() => runImport('wt')}>
            {t('settings.terminalPanel.importWt', 'From Windows Terminal')}
          </button>
          <button className="settings-btn settings-btn--secondary" onClick={() => runImport('ghostty')}>
            {t('settings.terminalPanel.importGhostty', 'From Ghostty')}
          </button>
        </div>
      </div>
      {importStatus && (
        <div className="settings-row" style={{ opacity: 0.7, fontSize: '12px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{importStatus}</span>
          {importUndo && (
            <button className="settings-btn settings-btn--secondary" onClick={undoImport}>
              {t('settings.terminalPanel.importUndo', 'Undo')}
            </button>
          )}
        </div>
      )}

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.terminalPanel.customSchemesSection', 'Custom schemes')}</h3>
      <div className="settings-row" style={{ opacity: 0.7, fontSize: '12px' }}>
        {t('settings.terminalPanel.customSchemesHint', 'Define named overrides (dev / staging / prod). Only the fields you set are overridden; the rest fall back to the bundled base theme.')}
      </div>

      {userSchemeNames.map((name) => {
        const scheme = terminalPrefs.userColorSchemes[name];
        return (
          <div key={name} className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>{name}</strong>
              <button className="settings-btn settings-btn--secondary" onClick={() => removeUserScheme(name)}>{t('settings.terminalPanel.remove', 'Remove')}</button>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {t('settings.terminalPanel.bg', 'bg')}
                <input type="color" value={scheme.background || '#1e1e1e'}
                  onChange={(e) => updateUserScheme(name, { background: e.target.value })} />
              </label>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {t('settings.terminalPanel.fg', 'fg')}
                <input type="color" value={scheme.foreground || '#dddddd'}
                  onChange={(e) => updateUserScheme(name, { foreground: e.target.value })} />
              </label>
              <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {t('settings.terminalPanel.cursorAbbr', 'cursor')}
                <input type="color" value={scheme.cursor || '#ffffff'}
                  onChange={(e) => updateUserScheme(name, { cursor: e.target.value })} />
              </label>
            </div>
          </div>
        );
      })}

      <div className="settings-row">
        <input
          type="text"
          className="settings-input"
          placeholder={t('settings.terminalPanel.newSchemeNamePlaceholder', 'new scheme name (e.g. prod)')}
          value={newSchemeName}
          onChange={(e) => setNewSchemeName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addUserScheme(); }}
        />
        <button className="settings-btn settings-btn--secondary" onClick={addUserScheme}>{t('settings.terminalPanel.addScheme', 'Add scheme')}</button>
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.terminalPanel.cursorSection', 'Cursor')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.terminalPanel.cursorStyle', 'Cursor style')}</label>
        <select
          className="settings-select"
          value={terminalPrefs.cursorStyle}
          onChange={(e) =>
            setTerminalPrefs({ cursorStyle: e.target.value as 'block' | 'underline' | 'bar' })
          }
        >
          <option value="block">{t('settings.terminalPanel.cursorStyle.block', 'Block')}</option>
          <option value="underline">{t('settings.terminalPanel.cursorStyle.underline', 'Underline')}</option>
          <option value="bar">{t('settings.terminalPanel.cursorStyle.bar', 'Bar')}</option>
        </select>
      </div>

      <div className="settings-row">
        <label className="settings-label">{t('settings.terminalPanel.cursorBlink', 'Cursor blink')}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={terminalPrefs.cursorBlink}
          onChange={(e) => setTerminalPrefs({ cursorBlink: e.target.checked })}
        />
      </div>

      <div className="settings-divider" />
      <h3 className="settings-section-title">{t('settings.terminalPanel.scrollbackSection', 'Scrollback')}</h3>

      <div className="settings-row">
        <label className="settings-label">{t('settings.terminalPanel.scrollbackLines', 'Scrollback lines')}</label>
        <input
          type="number"
          className="settings-input settings-input--narrow"
          value={terminalPrefs.scrollbackLines}
          min={100}
          max={100000}
          step={100}
          onChange={(e) => setTerminalPrefs({ scrollbackLines: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}
