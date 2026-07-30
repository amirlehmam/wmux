import { useState, useEffect, useRef } from 'react';
import { ShortcutBinding, ShortcutAction, DEFAULT_SHORTCUTS } from '../../store/settings-slice';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { actionLabel } from './KeyboardSettings';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bindingToString(b: ShortcutBinding): string {
  const parts: string[] = [];
  if (b.ctrl) parts.push('Ctrl');
  if (b.alt) parts.push('Alt');
  if (b.shift) parts.push('Shift');
  parts.push(b.key);
  return parts.join('+');
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

// ─── Component ────────────────────────────────────────────────────────────────

interface ShortcutRecorderProps {
  action: ShortcutAction;
  binding: ShortcutBinding;
}

export default function ShortcutRecorder({ action, binding }: ShortcutRecorderProps) {
  const t = useT();
  const { shortcuts, setShortcut } = useStore();
  const [recording, setRecording] = useState(false);
  const [conflict, setConflict] = useState<ShortcutAction | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!recording) return;

    function handleKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();

      // Escape cancels recording
      if (e.key === 'Escape') {
        setRecording(false);
        setConflict(null);
        return;
      }

      // Ignore bare modifier presses
      if (MODIFIER_KEYS.has(e.key)) return;

      const newBinding: ShortcutBinding = {
        key: e.key,
        ctrl: e.ctrlKey || undefined,
        shift: e.shiftKey || undefined,
        alt: e.altKey || undefined,
      };

      // Check for conflicts with other actions
      const conflictAction = (Object.entries(shortcuts) as [ShortcutAction, ShortcutBinding][]).find(
        ([a, b]) => a !== action && b.key === newBinding.key &&
          !!b.ctrl === !!newBinding.ctrl &&
          !!b.shift === !!newBinding.shift &&
          !!b.alt === !!newBinding.alt,
      );

      if (conflictAction) {
        setConflict(conflictAction[0]);
      } else {
        setConflict(null);
      }

      setShortcut(action, newBinding);
      setRecording(false);
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [recording, shortcuts, action, setShortcut]);

  // Clear conflict warning after 3 seconds
  useEffect(() => {
    if (!conflict) return;
    const timer = setTimeout(() => setConflict(null), 3000);
    return () => clearTimeout(timer);
  }, [conflict]);

  return (
    <div className="shortcut-recorder">
      <button
        ref={btnRef}
        className={`shortcut-recorder__btn ${recording ? 'shortcut-recorder__btn--recording' : ''}`}
        onClick={() => {
          setConflict(null);
          setRecording(true);
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
