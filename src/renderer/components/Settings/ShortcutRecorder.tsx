import { useState, useEffect } from 'react';
import { DEFAULT_SHORTCUTS, ShortcutBinding, ShortcutAction } from '../../store/settings-slice';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { actionLabel, formatBinding } from './KeyboardSettings';
import { bindingsEqual } from '../../utils/shortcut-binding';
import { useKeyCapture } from '../../hooks/useKeyCapture';

// ─── Component ────────────────────────────────────────────────────────────────

interface ShortcutRecorderProps {
  action: ShortcutAction;
  binding: ShortcutBinding;
}

export default function ShortcutRecorder({ action, binding }: ShortcutRecorderProps) {
  const t = useT();
  const { shortcuts, setShortcut } = useStore();
  const [conflict, setConflict] = useState<ShortcutAction | null>(null);

  function assignBinding(newBinding: ShortcutBinding): void {
    const conflictAction = (Object.entries(shortcuts) as [ShortcutAction, ShortcutBinding][]).find(
      ([a, b]) => a !== action && bindingsEqual(b, newBinding),
    );
    setConflict(conflictAction ? conflictAction[0] : null);
    setShortcut(action, newBinding);
  }

  const { capturing: recording, start, cancel } = useKeyCapture({
    onCapture: assignBinding,
    onCancel: () => setConflict(null),
  });
  const bound = !!binding.key;
  const secondaryLabel = bound
    ? t('settings.shortcutRecorder.unbind', 'Unbind shortcut')
    : t('settings.shortcutRecorder.restoreDefault', 'Restore default');

  // Clear conflict warning after 3 seconds
  useEffect(() => {
    if (!conflict) return;
    const timer = setTimeout(() => setConflict(null), 3000);
    return () => clearTimeout(timer);
  }, [conflict]);

  return (
    <div className="shortcut-recorder">
      <div className={`shortcut-recorder__control ${!bound ? 'shortcut-recorder__control--unbound' : ''} ${recording ? 'shortcut-recorder__control--recording' : ''}`}>
        <button
          type="button"
          className={`shortcut-recorder__btn ${recording ? 'shortcut-recorder__btn--recording' : ''}`}
          onClick={() => {
            setConflict(null);
            start();
          }}
          onBlur={cancel}
          aria-label={`${actionLabel(action, t)}: ${bound ? formatBinding(binding) : t('settings.shortcutRecorder.addShortcut', 'Add shortcut')}`}
          title={recording
            ? t('settings.shortcutRecorder.pressCombo', 'Press a key combo (Escape to cancel)')
            : t('settings.shortcutRecorder.clickToRecord', 'Click to record a new shortcut')}
        >
          {recording
            ? t('settings.shortcutRecorder.pressKeys', 'Press keys...')
            : bound ? formatBinding(binding) : `+ ${t('settings.shortcutRecorder.addShortcut', 'Add shortcut')}`}
        </button>
        <button
          type="button"
          className={`shortcut-recorder__action ${!bound ? 'shortcut-recorder__action--restore' : ''}`}
          onClick={() => {
            cancel();
            if (bound) setShortcut(action, { key: '' });
            else assignBinding(DEFAULT_SHORTCUTS[action]);
          }}
          aria-label={`${secondaryLabel}: ${actionLabel(action, t)}`}
          title={secondaryLabel}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {bound
              ? <path d="m4 4 8 8M12 4l-8 8" />
              : <path d="M3 6a5 5 0 1 1 0 5M3 2v4h4" />}
          </svg>
        </button>
      </div>
      {conflict && (
        <span className="shortcut-recorder__conflict">
          {t('settings.shortcutRecorder.conflictsWith', 'Conflicts with {action}').replace('{action}', actionLabel(conflict, t))}
        </span>
      )}
    </div>
  );
}
