import { useStore } from '../../store';
import { useT } from '../../i18n';
import { formatBinding } from './KeyboardSettings';

/**
 * Label + checkbox + one plain-language sentence.
 *
 * Every row in this panel has that shape, and the sentence is not decoration:
 * "Anchor" and "Pin" name behaviours nobody has seen before, so a bare toggle
 * with a two-word label is a toggle users flip once, dislike, and never
 * revisit. Labels and hints arrive already translated so a caller can splice a
 * live key binding into its own sentence — see the panel below.
 */
function ToggleRow({ label, hint, checked, disabled, onChange }: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <>
      <div className="settings-row">
        <label className="settings-label">{label}</label>
        <input
          type="checkbox"
          className="settings-toggle"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
      </div>
      <p className="settings-hint">{hint}</p>
    </>
  );
}

/**
 * Issue #207 — "Pin and highlight the original prompt in a pane".
 *
 * Four features share one per-surface prompt log, so they share one panel and
 * one master switch. The switch is first and everything below it dims when it
 * is off, because the sub-toggles are meaningless without the log and a live
 * control that does nothing is worse than a greyed one.
 */
export default function PromptSettings() {
  const t = useT();
  const promptPrefs = useStore((s) => s.promptPrefs);
  const setPromptPrefs = useStore((s) => s.setPromptPrefs);
  // The LIVE bindings, not the defaults: a rebind on the Shortcuts tab must not
  // leave these hints advertising a combo that no longer does anything.
  const shortcuts = useStore((s) => s.shortcuts);

  const off = !promptPrefs.enabled;
  // Dimming is the only signal a disabled checkbox gives on its own that the
  // whole group is inert rather than each row individually unavailable.
  const groupStyle = { opacity: off ? 0.45 : 1 };

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">{t('settings.prompt.title', 'Prompts')}</h3>

      <ToggleRow
        label={t('settings.prompt.enabled', 'Track prompts')}
        hint={t(
          'settings.prompt.enabledHint',
          'Remembers what you typed in each pane so the features below have something to point at. Turned off, none of them run and nothing is recorded.',
        )}
        checked={promptPrefs.enabled}
        onChange={(enabled) => setPromptPrefs({ enabled })}
      />

      <div style={groupStyle}>
        <div className="settings-divider" />
        <h3 className="settings-section-title">{t('settings.prompt.highlightSection', 'Highlight')}</h3>

        <ToggleRow
          label={t('settings.prompt.highlight', 'Highlight prompt lines')}
          hint={t(
            'settings.prompt.highlightHint',
            'Tints the rows your prompt occupies so it stays visible against the answer that follows it.',
          )}
          checked={promptPrefs.highlight}
          disabled={off}
          onChange={(highlight) => setPromptPrefs({ highlight })}
        />

        <div className="settings-row">
          <label className="settings-label">{t('settings.prompt.highlightColor', 'Highlight color')}</label>
          <input
            type="color"
            value={promptPrefs.highlightColor}
            disabled={off}
            onChange={(e) => setPromptPrefs({ highlightColor: e.target.value })}
          />
        </div>
        <p className="settings-hint">
          {t(
            'settings.prompt.highlightColorHint',
            'Pick a color your color scheme never prints, so a highlighted row can never be mistaken for output.',
          )}
        </p>

        <ToggleRow
          label={t('settings.prompt.ruler', 'Mark prompts on the scrollbar')}
          hint={t(
            'settings.prompt.rulerHint',
            'Adds a tick per prompt to the scrollbar, so you can see where they sit in a long scrollback without scrolling through it.',
          )}
          checked={promptPrefs.ruler}
          disabled={off}
          onChange={(ruler) => setPromptPrefs({ ruler })}
        />

        <div className="settings-divider" />
        <h3 className="settings-section-title">{t('settings.prompt.pinSection', 'Sticky header')}</h3>

        <ToggleRow
          label={t('settings.prompt.pin', 'Pin the last prompt')}
          hint={t(
            'settings.prompt.pinHint',
            'Keeps the last prompt in a header above the pane so you can still read what you asked while the answer scrolls. Costs a couple of rows, which is why it is off by default. {binding} pins or releases one by hand.',
          ).replace('{binding}', formatBinding(shortcuts.togglePinnedPrompt))}
          checked={promptPrefs.pin}
          disabled={off}
          onChange={(pin) => setPromptPrefs({ pin })}
        />

        <div className="settings-row">
          <label className="settings-label">{t('settings.prompt.pinLines', 'Header height (lines)')}</label>
          <input
            type="number"
            className="settings-input settings-input--narrow"
            value={promptPrefs.pinLines}
            min={1}
            max={5}
            disabled={off}
            onChange={(e) => setPromptPrefs({ pinLines: Number(e.target.value) })}
          />
        </div>
        <p className="settings-hint">
          {t(
            'settings.prompt.pinLinesHint',
            'How many lines of the prompt the header shows before it is cut short. Between 1 and 5 — the header takes those rows away from the terminal.',
          )}
        </p>

        <div className="settings-divider" />
        <h3 className="settings-section-title">{t('settings.prompt.anchorSection', 'Answer anchor')}</h3>

        <ToggleRow
          label={t('settings.prompt.anchor', 'Hold the view at the start of the answer')}
          hint={t(
            'settings.prompt.anchorHint',
            'When an answer starts, keep the first line in view instead of chasing the output downwards. {binding} goes back to following the output.',
          ).replace('{binding}', formatBinding(shortcuts.followOutput))}
          checked={promptPrefs.anchor}
          disabled={off}
          onChange={(anchor) => setPromptPrefs({ anchor })}
        />

        <div className="settings-row">
          <label className="settings-label">{t('settings.prompt.anchorScope', 'Apply it to')}</label>
          <select
            className="settings-select"
            value={promptPrefs.anchorScope}
            disabled={off || !promptPrefs.anchor}
            onChange={(e) => setPromptPrefs({ anchorScope: e.target.value as 'agent' | 'all' })}
          >
            <option value="agent">{t('settings.prompt.anchorScope.agent', 'Agent answers only')}</option>
            <option value="all">{t('settings.prompt.anchorScope.all', 'Agent answers and shell commands')}</option>
          </select>
        </div>
        <p className="settings-hint">
          {t(
            'settings.prompt.anchorScopeHint',
            'Shell commands follow their output by default, the way every terminal does. Switch to the second option to hold the view for long builds and test runs too.',
          )}
        </p>

        <div className="settings-divider" />
        <h3 className="settings-section-title">{t('settings.prompt.outlineSection', 'Outline')}</h3>

        <ToggleRow
          label={t('settings.prompt.outline', 'Prompt outline')}
          hint={t(
            'settings.prompt.outlineHint',
            'A list of every prompt in the pane, click one to jump back to it. It stays closed until you ask for it — {binding} opens and closes it.',
          ).replace('{binding}', formatBinding(shortcuts.togglePromptOutline))}
          checked={promptPrefs.outline}
          disabled={off}
          onChange={(outline) => setPromptPrefs({ outline })}
        />

        <div className="settings-row">
          <label className="settings-label">{t('settings.prompt.outlineSide', 'Outline side')}</label>
          <select
            className="settings-select"
            value={promptPrefs.outlineSide}
            disabled={off}
            onChange={(e) => setPromptPrefs({ outlineSide: e.target.value as 'right' | 'left' })}
          >
            <option value="right">{t('settings.prompt.outlineSide.right', 'Right')}</option>
            <option value="left">{t('settings.prompt.outlineSide.left', 'Left')}</option>
          </select>
        </div>
        <p className="settings-hint">
          {t('settings.prompt.outlineSideHint', 'Which edge of the pane the outline opens against.')}
        </p>
      </div>
    </div>
  );
}
