/**
 * Holds a terminal at the size a buffer snapshot was taken at, for as long as
 * it takes that snapshot to actually be parsed.
 *
 * ## Why a latch and not just an ordered pair of calls
 *
 * `terminal.write()` is asynchronous. It queues into xterm's write buffer and
 * is parsed on a later task, so `resize(snap.cols, snap.rows)` immediately
 * followed by `write(snap.text)` does NOT replay the snapshot at the snapshot's
 * size — it only guarantees the size at the moment the bytes are *queued*.
 *
 * That gap is not theoretical. A remount is triggered by a split-tree change,
 * which is exactly when the pane's size changed, so the PTY attach continuation
 * (`scheduleInitialResize`), the ResizeObserver's first callback and the
 * visibility effect are all racing the parse — and any one of them re-fits the
 * terminal to the pane's NEW height first. Measured on a real pane close: the
 * snapshot was taken at 28 rows, the replay drained at 60, and because
 * SerializeAddon restores the cursor to its VIEWPORT row the cursor landed on
 * row 59 of 60 while ConPTY still had it on row 27 of 28. Nothing resyncs that
 * — from ConPTY's side nothing happened — so the prompt stayed stranded 32 rows
 * up, exactly the number of rows the pane had grown, until a `clear`.
 *
 * So the size has to be *held*, not merely set. While a replay is in flight
 * every size sync asks permission and is refused; the refusal is remembered, so
 * releasing performs the one sync that was owed. The pane then grows once, on
 * both sides in step, which is the case `windowsPty` makes correct.
 *
 * Deliberately knows nothing about terminals: this is the ordering rule, and it
 * is the part worth testing without a DOM.
 */
export class ReplayHold {
  private held = false;
  private owed = false;

  /** Begin holding. Called immediately before the snapshot write is queued. */
  hold(): void {
    this.held = true;
    this.owed = false;
  }

  get isHolding(): boolean {
    return this.held;
  }

  /**
   * May the caller sync sizes now? `false` means a replay is in flight and the
   * request has been recorded — the caller must do nothing at all, including
   * resizing the PTY, or the two sides end up at different heights.
   */
  request(): boolean {
    if (this.held) {
      this.owed = true;
      return false;
    }
    return true;
  }

  /**
   * Stop holding. Returns true when at least one sync was refused while held
   * and therefore still has to happen.
   *
   * Safe to call when not holding (a mount with no snapshot, a second call
   * after a write callback has already fired): it answers false and changes
   * nothing.
   */
  release(): boolean {
    if (!this.held) return false;
    this.held = false;
    const owed = this.owed;
    this.owed = false;
    return owed;
  }
}
