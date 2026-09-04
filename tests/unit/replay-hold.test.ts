import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { ReplayHold } from '../../src/renderer/utils/replay-hold';

/**
 * The second half of the stranded-prompt bug (the first is `windows-pty.test.ts`).
 *
 * Replaying a snapshot at the size it was taken at is not achieved by resizing
 * and then writing: `terminal.write()` is asynchronous, so that only fixes the
 * size the bytes are QUEUED at. Instrumenting a real pane close showed the
 * snapshot taken at 28 rows and the same replay draining at 60, with the
 * restored cursor on row 59 of 60 against ConPTY's row 27 of 28 — a 32-row
 * strand, matching the rows the pane had just grown by.
 */
const USE_TERMINAL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'hooks', 'useTerminal.ts'),
  'utf8',
);

describe('ReplayHold', () => {
  it('allows size syncs when no replay is in flight', () => {
    const hold = new ReplayHold();
    expect(hold.isHolding).toBe(false);
    expect(hold.request()).toBe(true);
    expect(hold.request()).toBe(true);
  });

  it('refuses every size sync while holding', () => {
    const hold = new ReplayHold();
    hold.hold();
    expect(hold.isHolding).toBe(true);
    expect(hold.request()).toBe(false);
    expect(hold.request()).toBe(false);
  });

  it('reports that a sync is owed when one was refused', () => {
    const hold = new ReplayHold();
    hold.hold();
    hold.request();
    expect(hold.release()).toBe(true);
    expect(hold.isHolding).toBe(false);
  });

  it('reports nothing owed when the replay finished before anything asked', () => {
    // The common case on a mount that is not racing a resize: the pane is
    // already the right size and re-fitting it would be a no-op.
    const hold = new ReplayHold();
    hold.hold();
    expect(hold.release()).toBe(false);
  });

  it('is inert when released without holding, and on a second release', () => {
    // A mount with no snapshot never holds, and a write callback can fire after
    // teardown has already released. Neither may report work that is not owed.
    const hold = new ReplayHold();
    expect(hold.release()).toBe(false);
    hold.hold();
    hold.request();
    expect(hold.release()).toBe(true);
    expect(hold.release()).toBe(false);
  });

  it('does not carry an owed sync across a second replay', () => {
    const hold = new ReplayHold();
    hold.hold();
    hold.request();
    expect(hold.release()).toBe(true);
    hold.hold();
    expect(hold.release()).toBe(false);
  });
});

describe('useTerminal replay wiring', () => {
  it('holds across the snapshot write and releases in its callback', () => {
    const hold = USE_TERMINAL.indexOf('replayHold.hold()');
    const write = USE_TERMINAL.indexOf('terminal.write(snapshot.text');
    const release = USE_TERMINAL.indexOf('replayHold.release()');
    expect(hold).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(hold);
    // The release has to be INSIDE the write callback: releasing on the next
    // line would restore exactly the race this class exists to close.
    expect(release).toBeGreaterThan(write);
    expect(USE_TERMINAL).toMatch(/terminal\.write\(snapshot\.text,\s*\(\)\s*=>\s*\{/);
  });

  it('gates fit() itself, so every resize path is covered', () => {
    // fit() is called from the ResizeObserver, the PTY attach continuation, the
    // visibility effect and the theme effect. Gating the shared helper is what
    // makes the hold hold; gating one caller would leave the others racing.
    expect(USE_TERMINAL).toMatch(/const fit = \(\)[^}]*replayHoldRef\.current\.request\(\)/s);
  });

  it('never resizes the PTY while the replay is held', () => {
    // A PTY resize that lands while xterm is pinned to the snapshot size puts
    // the two at different heights — the same divergence, from the other side.
    for (const call of USE_TERMINAL.matchAll(/window\.wmux\.pty\.resize\(/g)) {
      const line = USE_TERMINAL.lastIndexOf('\n', call.index);
      const context = USE_TERMINAL.slice(Math.max(0, line - 400), call.index);
      expect(context).toMatch(/replayHold|isHolding|dims/);
    }
  });
});
