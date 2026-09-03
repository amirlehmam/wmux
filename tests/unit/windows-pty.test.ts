import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { windowsPtyCompat } from '../../src/renderer/utils/windows-pty';

/**
 * The prompt that strands itself in the middle of the screen after a pane is
 * closed.
 *
 * Two facts have to hold together, and neither is checkable from the other's
 * side:
 *
 * 1. xterm must be told its PTY is ConPTY. Without `windowsPty` it grows rows
 *    the POSIX way — pulls scrollback back down into the viewport and keeps the
 *    cursor on the same ABSOLUTE buffer line — while ConPTY appends blank rows
 *    at the bottom and keeps the cursor on the same VIEWPORT row. Grow by K
 *    rows and every repaint ConPTY sends afterwards lands K rows too high.
 * 2. A remount must replay its snapshot at the size the snapshot was taken at,
 *    because SerializeAddon restores the cursor to its VIEWPORT row and that is
 *    the size ConPTY still has. Setting the size is necessary and not
 *    sufficient — `terminal.write()` is asynchronous, so it has to be HELD for
 *    the duration of the parse; `replay-hold.test.ts` covers that half.
 *
 * Both live in a file that needs a DOM to run, so the wiring is pinned at the
 * source level (the shape used by `resources-sync.test.ts`). Losing either one
 * reintroduces the bug in full.
 */
const USE_TERMINAL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'hooks', 'useTerminal.ts'),
  'utf8',
);

describe('windowsPtyCompat', () => {
  it('reports the ConPTY backend and the build number from os.release()', () => {
    expect(windowsPtyCompat('10.0.26200')).toEqual({ backend: 'conpty', buildNumber: 26200 });
  });

  it('keeps a pre-21376 build number, which is what turns on the wrapping heuristics', () => {
    expect(windowsPtyCompat('10.0.19045')).toEqual({ backend: 'conpty', buildNumber: 19045 });
  });

  it('still declares the backend when the release is unparseable', () => {
    // `backend` alone is enough to fix the row-growth behaviour, and omitting
    // the build number leaves reflow ON — the safer half of the trade to lose.
    for (const release of ['', 'nonsense', '10.0', '10.0.x']) {
      expect(windowsPtyCompat(release)).toEqual({ backend: 'conpty' });
    }
  });
});

describe('useTerminal wiring', () => {
  it('constructs every terminal with the ConPTY compatibility block', () => {
    expect(USE_TERMINAL).toMatch(/windowsPty:\s*windowsPtyCompat\(/);
  });

  it('fits the buffer to the pane before anything is written into it', () => {
    const open = USE_TERMINAL.indexOf('terminal.open(terminalRef.current)');
    const fit = USE_TERMINAL.indexOf('\n    fit();', open);
    const replay = USE_TERMINAL.indexOf('surfaceBufferCache.get(surfaceId)');
    expect(open).toBeGreaterThan(-1);
    expect(fit).toBeGreaterThan(open);
    expect(fit).toBeLessThan(replay);
  });

  it('replays a snapshot at the size it was taken at, before writing it', () => {
    const resize = USE_TERMINAL.indexOf('terminal.resize(snapshot.cols, snapshot.rows)');
    // Note the trailing comma: the write carries a callback now, because
    // resizing before the write is not enough on its own — see
    // `replay-hold.test.ts` for the race that fact closes.
    const write = USE_TERMINAL.indexOf('terminal.write(snapshot.text,');
    expect(resize).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(resize);
  });

  it('captures the dimensions alongside the snapshot text', () => {
    expect(USE_TERMINAL).toMatch(/cols:\s*terminal\.cols,\s*rows:\s*terminal\.rows/);
  });
});
