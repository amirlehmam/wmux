/**
 * Keeps the keyboard in the focused pane when the sidebar is clicked.
 *
 * Nothing in the sidebar is keyboard-driven apart from its text fields, yet a
 * click moved focus off the terminal and nothing gave it back, while the pane
 * kept its focus ring: typing after a click on the active workspace went
 * nowhere.
 *
 * Two ways back, because one does not fit every target:
 *
 * - Most presses have their default cancelled, so focus never moves. The
 *   terminal sees no blur, and an app with focus reporting on is not sent a
 *   focus-out/focus-in pair. Clicks still fire.
 * - A workspace row is `draggable`, and cancelling the press also cancels
 *   Chromium's native drag, which is how rows are reordered. There the press
 *   keeps its default and focus is handed back once the press ends, but only
 *   to an element still inside the focused pane: a click that switched the
 *   workspace or the pane has already chosen where focus belongs next.
 *
 * Text fields keep normal focus, and so does the docked explorer, which has
 * keyboard navigation of its own.
 */
const EDITABLE = 'input, textarea, select, [contenteditable="true"]';

export function keepPaneFocus(e: { target: EventTarget | null; preventDefault(): void }): void {
  const target = e.target as Element | null;
  if (!target?.closest) return;
  if (target.closest(`${EDITABLE}, .sidebar__docked`)) return;
  const row = target.closest('[draggable="true"]');
  if (!row) {
    e.preventDefault();
    return;
  }

  const prev = document.activeElement;
  if (!(prev instanceof HTMLElement) || prev === document.body) return;
  const restore = () => {
    window.removeEventListener('mouseup', restore, true);
    window.removeEventListener('dragend', restore, true);
    // After the click's own handlers and React's commit, so a workspace or
    // pane switch is already visible in the DOM.
    setTimeout(() => {
      // A button inside the row took it, which is the press itself; anything
      // else (a rename field, another pane) was put there on purpose.
      const now = document.activeElement;
      const pressed = !now || now === document.body || (row.contains(now) && !now.matches(EDITABLE));
      if (!pressed) return;
      if (!prev.isConnected || !prev.closest('.pane-wrapper--focused')) return;
      prev.focus({ preventScroll: true });
    }, 0);
  };
  // A drag swallows the mouseup and ends with dragend instead.
  window.addEventListener('mouseup', restore, true);
  window.addEventListener('dragend', restore, true);
}
