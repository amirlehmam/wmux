import { useT } from '../../i18n';
import type { ShortcutBinding } from '../../store/settings-slice';
import { useKeyCapture } from '../../hooks/useKeyCapture';
import { formatBinding } from './KeyboardSettings';

interface ShortcutFilterCaptureProps {
  /** The active binding filter, or null for "no shortcut filter". */
  value: ShortcutBinding | null;
  onChange: (binding: ShortcutBinding | null) => void;
}

/**
 * Read-only sibling of ShortcutRecorder: click → listen → the next combo
 * becomes a *filter*, never a rebind. Nothing here touches the store. Unlike
 * the recorder there is no default to fall back to, hence the explicit clear (×).
 */
export default function ShortcutFilterCapture({ value, onChange }: ShortcutFilterCaptureProps) {
  const t = useT();
  const { capturing, start, cancel } = useKeyCapture({ onCapture: (binding) => onChange(binding) });

  const idleLabel = t('settings.keyboard.searchByShortcut', 'Search by shortcut…');
  const label = capturing
    ? t('settings.shortcutRecorder.pressKeys', 'Press keys...')
    : (value ? formatBinding(value) : idleLabel);

  const btnClass = [
    'shortcut-filter-capture__btn',
    capturing ? 'shortcut-filter-capture__btn--listening' : '',
    value && !capturing ? 'shortcut-filter-capture__btn--set' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="shortcut-filter-capture">
      <button
        type="button"
        className={btnClass}
        onClick={start}
        onBlur={cancel /* clicking into the text field must stop swallowing keys */}
        aria-label={idleLabel}
        title={capturing
          ? t('settings.shortcutRecorder.pressCombo', 'Press a key combo (Escape to cancel)')
          : t('settings.keyboard.captureShortcutTitle', 'Click, then press a shortcut to filter by it')}
      >
        {label}
      </button>
      {value && !capturing && (
        <button
          type="button"
          className="shortcut-filter-capture__clear"
          onClick={() => onChange(null)}
          aria-label={t('settings.keyboard.clearShortcutFilter', 'Clear shortcut filter')}
          title={t('settings.keyboard.clearShortcutFilter', 'Clear shortcut filter')}
        >×</button>
      )}
    </div>
  );
}
