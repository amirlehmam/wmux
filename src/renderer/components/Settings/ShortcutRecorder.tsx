import { useState, useEffect } from 'react';
import { ShortcutBinding, ShortcutAction } from '../../store/settings-slice';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { actionLabel } from './KeyboardSettings';
import { bindingsEqual } from '../../utils/shortcut-binding';
import { useKeyCapture } from '../../hooks/useKeyCapture';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bindingToString(b: ShortcutBinding): string {
  const parts: string[] = [];
  if (b.ctrl) parts.push('Ctrl');
  if (b.alt) parts.push('Alt');
  if (b.shift) parts.push('Shift');
  parts.push(b.key);
  return parts.join('+');
}

// ─── Component ────────────────────────────────────────────────────────────────

interface ShortcutRecorderProps {
  action: ShortcutAction;
  binding: ShortcutBinding;
}

export default function ShortcutRecorder({ action, binding }: ShortcutRecorderProps) {
  const t = useT();
  const { shortcuts, setShortcut } = useStore();
  const [conflict, setConflict] = useState<ShortcutAction | null>(null);

  const { capturing: recording, start } = useKeyCapture({
    onCapture: (newBinding) => {
      // Check for conflicts with other actions. bindingsEqual compares
      // single-character keys case-insensitively, matching the rule
      // useKeyboardShortcuts.ts applies at dispatch time — otherwise a combo
      // like Ctrl+Shift+N (persisted as key: 'N') could silently miss its
      // conflict with newWindow's default (key: 'n').
      const conflictAction = (Object.entries(shortcuts) as [ShortcutAction, ShortcutBinding][]).find(
        ([a, b]) => a !== action && bindingsEqual(b, newBinding),
      );
      setConflict(conflictAction ? conflictAction[0] : null);
      setShortcut(action, newBinding);
    },
    onCancel: () => setConflict(null),
  });

  // Clear conflict warning after 3 seconds
  useEffect(() => {
    if (!conflict) return;
    const timer = setTimeout(() => setConflict(null), 3000);
    return () => clearTimeout(timer);
  }, [conflict]);

  return (
    <div className="shortcut-recorder">
      <button
        className={`shortcut-recorder__btn ${recording ? 'shortcut-recorder__btn--recording' : ''}`}
        onClick={() => {
          setConflict(null);
          start();
        }}
        title={recording
          ? t('settings.shortcutRecorder.pressCombo', 'Press a key combo (Escape to cancel)')
          : t('settings.shortcutRecorder.clickToRecord', 'Click to record a new shortcut')}
      >
        {recording ? t('settings.shortcutRecorder.pressKeys', 'Press keys...') : bindingToString(binding)}
      </button>
      {conflict && (
        <span className="shortcut-recorder__conflict">
          {t('settings.shortcutRecorder.conflictsWith', 'Conflicts with {action}').replace('{action}', actionLabel(conflict, t))}
        </span>
      )}
    </div>
  );
}
