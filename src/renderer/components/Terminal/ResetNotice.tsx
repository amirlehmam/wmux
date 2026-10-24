import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { formatBinding } from '../Settings/KeyboardSettings';
import { RESET_NOTICE_EVENT, type ResetNoticeDetail } from '../../utils/alt-screen-owner';

/**
 * "Kept the alternate screen — press again to leave it" (#357), shown when a
 * reset kept it and for as long as a second press would force it.
 *
 * An overlay rather than a `[wmux] …` line written to the terminal: the case it
 * appears in is the one where a program may still be drawing on that screen,
 * and a line written there would land inside the program's frame and move its
 * cursor. Non-modal and never hit-testable, like the copy-mode indicator.
 */
export default function ResetNotice({ surfaceId }: { surfaceId: string }) {
  const t = useT();
  const binding = useStore((s) => s.shortcuts.resetTerminal);
  const [until, setUntil] = useState<number | null>(null);

  useEffect(() => {
    const onNotice = (event: Event) => {
      const detail = (event as CustomEvent<ResetNoticeDetail>).detail;
      if (!detail || detail.surfaceId !== surfaceId) return;
      setUntil(detail.until);
    };
    document.addEventListener(RESET_NOTICE_EVENT, onNotice);
    return () => document.removeEventListener(RESET_NOTICE_EVENT, onNotice);
  }, [surfaceId]);

  useEffect(() => {
    if (until === null) return;
    const timer = setTimeout(() => setUntil(null), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [until]);

  // The live region stays mounted and only its text changes: a screen reader
  // announces a change to a region, and often says nothing about one that
  // arrives already filled. Empty, it draws nothing (terminal.css).
  let text = '';
  if (until !== null) {
    const shortcut = formatBinding(binding);
    text = shortcut
      ? t('terminal.resetKeptAltScreen').replace('{shortcut}', shortcut)
      : t('terminal.resetKeptAltScreenNoShortcut');
  }
  return (
    <div className="reset-notice" role="status" aria-live="polite">
      {text}
    </div>
  );
}
