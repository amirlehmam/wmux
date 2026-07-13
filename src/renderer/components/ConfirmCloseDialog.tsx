import { useEffect, useRef } from 'react';
import { useStore } from '../store';

/**
 * Close-session guard (issue #90): confirmation dialog shown when the opt-in
 * `confirmWorkspaceClose` pref is on and the user closes a session via the
 * sidebar ×, the workspace context menu, or Ctrl+Shift+W. "Close others"
 * queues every victim into `pendingCloseWorkspaceIds`, so this renders one
 * dialog for the whole batch. Programmatic closes (CLI/agents) bypass the
 * guard entirely and never reach this component.
 */
export default function ConfirmCloseDialog() {
  const pendingIds = useStore((s) => s.pendingCloseWorkspaceIds);
  const workspaces = useStore((s) => s.workspaces);
  const confirmPendingClose = useStore((s) => s.confirmPendingClose);
  const cancelPendingClose = useStore((s) => s.cancelPendingClose);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const open = pendingIds.length > 0;

  // Cancel is the safe default: the dialog exists to absorb a stray click, so
  // a stray Enter right after must not confirm the close it guards against.
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancelPendingClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, cancelPendingClose]);

  if (!open) return null;

  const titles = pendingIds
    .map((id) => workspaces.find((w) => w.id === id)?.title)
    .filter((t): t is string => !!t);
  const message =
    pendingIds.length === 1
      ? `Close "${titles[0] ?? 'this session'}"?`
      : `Close ${pendingIds.length} sessions?`;

  return (
    <div className="confirm-dialog__overlay" onClick={cancelPendingClose}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={message}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-dialog__title">{message}</div>
        <div className="confirm-dialog__message">
          Everything running inside — shells, agents, unsaved tool state — will be terminated.
        </div>
        <div className="confirm-dialog__actions">
          <button ref={cancelRef} className="confirm-dialog__btn" onClick={cancelPendingClose}>
            Cancel
          </button>
          <button
            className="confirm-dialog__btn confirm-dialog__btn--danger"
            onClick={confirmPendingClose}
          >
            {pendingIds.length === 1 ? 'Close session' : `Close ${pendingIds.length} sessions`}
          </button>
        </div>
      </div>
    </div>
  );
}
