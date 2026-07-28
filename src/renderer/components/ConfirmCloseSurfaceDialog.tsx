import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import { useT } from '../i18n';

/**
 * Unsaved-markdown guard (issue #116, F3): shown when a tab holding edits that
 * have not been written to disk is closed by a user gesture — the tab ×, or
 * Ctrl+W. Programmatic closes (`wmux close-surface`) bypass it entirely and
 * never reach this component, the same split ConfirmCloseDialog draws for
 * workspaces.
 */
export default function ConfirmCloseSurfaceDialog() {
  const pending = useStore((s) => s.pendingCloseSurface);
  const confirm = useStore((s) => s.confirmPendingCloseSurface);
  const cancel = useStore((s) => s.cancelPendingCloseSurface);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const t = useT();

  const open = !!pending;

  // Cancel is the safe default: the dialog exists to protect text the user
  // typed, so a stray Enter must not be the thing that discards it.
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, cancel]);

  if (!pending) return null;

  const message = t('markdown.closeUnsaved', 'Close without saving?').replace('{name}', pending.label);

  return (
    <div className="confirm-dialog__overlay" onClick={cancel}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={message}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-dialog__title">{message}</div>
        <div className="confirm-dialog__message">
          {t('markdown.closeUnsavedHint', 'This note has edits that were never written to disk.')}
        </div>
        <div className="confirm-dialog__actions">
          <button ref={cancelRef} className="confirm-dialog__btn" onClick={cancel}>
            {t('markdown.keepEditing', 'Keep editing')}
          </button>
          <button className="confirm-dialog__btn confirm-dialog__btn--danger" onClick={confirm}>
            {t('markdown.discardAndClose', 'Discard and close')}
          </button>
        </div>
      </div>
    </div>
  );
}
