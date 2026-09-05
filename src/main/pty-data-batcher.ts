/**
 * Coalesces the per-chunk PTY output stream into batched deliveries.
 *
 * ConPTY hands node-pty many small chunks in bursts, and each chunk used to be
 * its own `webContents.send` — one structured-clone + IPC message per chunk,
 * all serialized through the single main→renderer channel that also carries
 * every other pane's output and the observer's regex pass. Under many
 * concurrently-streaming panes that channel is what the user feels as typing
 * latency: the echo of a keystroke queues behind the flood.
 *
 * Shape: leading-edge immediate delivery, then a short trailing window. The
 * FIRST chunk after an idle period is delivered synchronously — a lone
 * keystroke echo never waits — and opens a WINDOW_MS window during which
 * subsequent chunks accumulate into one string, delivered when the window
 * closes. Sustained output therefore settles at ~1000/WINDOW_MS deliveries
 * per second per pane instead of one per chunk, while interactive latency
 * stays at zero for the byte the user is waiting on.
 */
export interface PtyDataBatcher {
  /** Queue a chunk (or deliver it now, when idle). */
  push(data: string): void;
  /**
   * Deliver anything buffered right now. Call before sending PTY_EXIT so a
   * process's trailing output lands ahead of its exit notification.
   */
  flush(): void;
  /** Drop buffered data and cancel the pending timer. */
  dispose(): void;
}

const WINDOW_MS = 4;

// Force a delivery mid-window past this much buffered text, so one pane
// cat-ing a huge file cannot grow an unbounded string in main.
const MAX_BUFFERED_CHARS = 256 * 1024;

export function createPtyDataBatcher(deliver: (data: string) => void): PtyDataBatcher {
  let buffered = '';
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  const closeWindow = () => {
    if (disposed) return;
    if (!buffered) {
      // Quiet window: go idle, so the next chunk takes the immediate path.
      timer = null;
      return;
    }
    const out = buffered;
    buffered = '';
    // Re-arm BEFORE delivering: sustained output keeps batching instead of
    // alternating immediate/batched on every expiry.
    timer = setTimeout(closeWindow, WINDOW_MS);
    deliver(out);
  };

  return {
    push(data: string): void {
      if (disposed) return;
      if (timer === null) {
        timer = setTimeout(closeWindow, WINDOW_MS);
        deliver(data);
        return;
      }
      buffered += data;
      if (buffered.length >= MAX_BUFFERED_CHARS) {
        const out = buffered;
        buffered = '';
        deliver(out);
      }
    },
    flush(): void {
      if (disposed || !buffered) return;
      const out = buffered;
      buffered = '';
      deliver(out);
    },
    dispose(): void {
      disposed = true;
      buffered = '';
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
