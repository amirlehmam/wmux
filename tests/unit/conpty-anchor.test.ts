import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Terminal } from '@xterm/xterm';
import {
  anchorViewportLikeConpty,
  captureCursorLine,
  captureViewportTop,
  conptyViewportTop,
  restoreCursorLine,
  shiftViewport,
  type AnchorBufferService,
} from '../../src/renderer/utils/conpty-anchor';

/**
 * The third half of the stranded-prompt bug (after `windows-pty.test.ts` and
 * `replay-hold.test.ts`): a change of COLUMNS. xterm answers a reflow by trading
 * rows with its scrollback, keeping the cursor on the same viewport row; ConPTY
 * has no scrollback and keeps the viewport's TOP line in place instead, moving
 * the cursor. The bundled ConPTY sends nothing after a resize, so the prompt
 * stays stranded one row per line that wrapped or unwrapped.
 *
 * The ConPTY side was measured against a live bundled conpty.dll through
 * node-pty (typing a marker after the resize and reading which row it landed
 * on): across widen, narrow, widen→narrow, narrow→widen, row+column changes and
 * a monitor-style round trip, the cursor row ConPTY reports is exactly the one
 * the top-anchored model below predicts. What is tested here is xterm's half —
 * the real xterm, driven through its real reflow, no DOM needed for the buffer.
 */

const COLS = 20;
const ROWS = 6;

function makeTerminal(cols = COLS, rows = ROWS, reflowCursorLine = true): Terminal {
  return new Terminal({
    cols,
    rows,
    scrollback: 1000,
    allowProposedApi: true,
    windowsPty: { backend: 'conpty', buildNumber: 26200 },
    // As useTerminal.ts sets it (#273).
    reflowCursorLine,
  });
}

function write(t: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => t.write(data, resolve));
}

function viewport(t: Terminal): string[] {
  const b = t.buffer.active;
  const out: string[] = [];
  for (let y = 0; y < t.rows; y++) out.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '');
  return out;
}

/** Scrollback, then a 30-cell line that wraps once at 20 cols, then a prompt. */
async function filled(): Promise<Terminal> {
  const t = makeTerminal();
  await write(t, ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'x'.repeat(30), 'after', 'PS> '].join('\r\n'));
  return t;
}

function resizeLikeWmux(t: Terminal, cols: number, rows: number): void {
  const reflows = cols !== t.cols;
  const top = reflows ? captureViewportTop(t) : undefined;
  const cursorLine = reflows ? captureCursorLine(t) : undefined;
  t.resize(cols, rows);
  restoreCursorLine(t, cursorLine);
  anchorViewportLikeConpty(t, top);
}

describe('xterm reflow, left alone, disagrees with ConPTY (the premise)', () => {
  it('a widen pulls scrollback down and leaves the cursor row where it was', async () => {
    const t = await filled();
    const before = t.buffer.active.cursorY;
    t.resize(40, ROWS);
    // ConPTY moves its cursor UP one row here (one line unwrapped). If this
    // starts failing, xterm changed its reflow and the fix may be redundant.
    expect(t.buffer.active.cursorY).toBe(before);
    t.dispose();
  });
});

describe('re-anchoring to ConPTY after a column change', () => {
  it('a widen keeps the top line on top and moves the cursor up by the rows it removed', async () => {
    const t = await filled();
    const top = viewport(t)[0];
    const before = t.buffer.active.cursorY;

    resizeLikeWmux(t, 40, ROWS);

    const rows = viewport(t);
    expect(rows[0]).toBe(top);
    expect(t.buffer.active.cursorY).toBe(before - 1);
    expect(rows[t.buffer.active.cursorY].trimEnd()).toBe('PS>');
    expect(rows[ROWS - 1]).toBe(''); // the blank row ConPTY appended
    t.dispose();
  });

  it('a narrow back spends the blank row instead of pushing into scrollback', async () => {
    const t = await filled();
    const original = viewport(t);
    const before = t.buffer.active.cursorY;

    resizeLikeWmux(t, 40, ROWS);
    resizeLikeWmux(t, COLS, ROWS);

    expect(t.buffer.active.cursorY).toBe(before);
    expect(viewport(t)).toEqual(original);
    t.dispose();
  });

  it('never loses output: every line is still in the buffer after a round trip', async () => {
    const t = await filled();
    const all = (): string => {
      const b = t.buffer.active;
      const parts: string[] = [];
      for (let i = 0; i < b.length; i++) parts.push(b.getLine(i)?.translateToString(true) ?? '');
      return parts.join('');
    };
    const text = all();
    resizeLikeWmux(t, 40, ROWS);
    resizeLikeWmux(t, 12, ROWS);
    resizeLikeWmux(t, 60, ROWS);
    resizeLikeWmux(t, COLS, ROWS);
    expect(all()).toBe(text);
    t.dispose();
  });

  it('orphans a wrapped tail at the top of the viewport, as ConPTY has no head for it', async () => {
    const t = makeTerminal();
    // 50 cells wrap into three rows; scroll so the viewport opens on the last.
    await write(t, ['l1', 'l2', 'y'.repeat(50), 'a', 'b', 'c', 'd', 'PS> '].join('\r\n'));
    const b = t.buffer.active;
    expect(b.getLine(b.baseY)?.isWrapped).toBe(true);

    const top = captureViewportTop(t);
    expect(b.getLine(b.baseY)?.isWrapped).toBe(false);
    anchorViewportLikeConpty(t, top);
    t.dispose();
  });

  it('does nothing on the alternate screen, which has no scrollback to disagree about', async () => {
    const t = await filled();
    await write(t, '\x1b[?1049h');
    expect(captureViewportTop(t)).toBeUndefined();
    t.dispose();
  });

  it('a change of rows alone shifts nothing — windowsPty already agrees there', async () => {
    const t = await filled();
    const top = captureViewportTop(t);
    const baseY = t.buffer.active.baseY;
    t.resize(COLS, ROWS + 4);
    anchorViewportLikeConpty(t, top);
    expect(t.buffer.active.baseY).toBe(baseY);
    t.dispose();
  });
});

/**
 * Issue #273: a prompt first drawn in a narrower pane stayed broken at that
 * width. Measured against a live bundled ConPTY: a pwsh prompt drawn at 45
 * columns and widened to 120 gets NO output from ConPTY, and the next keystroke
 * PSReadLine echoes is placed by an absolute CUP on ConPTY's REFLOWED layout
 * (row 2, just after the prompt) — so the cursor's line has to reflow on
 * xterm's side too, and the cursor has to land where ConPTY's did.
 */
describe('the line the cursor is on (#273)', () => {
  // 113 cells: three rows at 45 columns, two at 100.
  const PROMPT = 'PS D:\\' + 'a'.repeat(40) + '\\_1_project_managed_by_' + 'b'.repeat(30) + '\\phase2_land> ';

  function rows(t: Terminal): string[] {
    const b = t.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? '');
    return out.filter((l) => l !== '');
  }

  function cursor(t: Terminal): [number, number] {
    const b = t.buffer.active;
    return [b.cursorX, b.baseY + b.cursorY];
  }

  it("is left at its old width by xterm's default — the bug (premise)", async () => {
    const t = makeTerminal(45, 24, false);
    await write(t, PROMPT);
    resizeLikeWmux(t, 100, 24);
    expect(rows(t)).toHaveLength(3);
    t.dispose();
  });

  it('a widen rejoins the prompt and puts the cursor at its end', async () => {
    const t = makeTerminal(45, 24);
    await write(t, PROMPT);
    resizeLikeWmux(t, 100, 24);
    expect(rows(t)).toEqual([PROMPT.slice(0, 100), PROMPT.slice(100)]);
    expect(cursor(t)).toEqual([PROMPT.length - 100, 1]);
    t.dispose();
  });

  it('what is typed next lands right after the prompt', async () => {
    const t = makeTerminal(45, 24);
    await write(t, PROMPT);
    resizeLikeWmux(t, 100, 24);
    await write(t, 'Z');
    expect(rows(t)[1]).toBe(PROMPT.slice(100) + 'Z');
    t.dispose();
  });

  it('a narrow re-wraps the prompt and keeps the cursor at its end', async () => {
    const t = makeTerminal(100, 24);
    await write(t, PROMPT);
    resizeLikeWmux(t, 45, 24);
    expect(rows(t)).toEqual([PROMPT.slice(0, 45), PROMPT.slice(45, 90), PROMPT.slice(90)]);
    expect(cursor(t)).toEqual([PROMPT.length - 90, 2]);
    t.dispose();
  });

  it('a cursor mid-line keeps its place in the text across a round trip', async () => {
    const t = makeTerminal(45, 24);
    // Cursor back onto the 'h' of "hello", the way an arrow key would leave it.
    await write(t, PROMPT + 'echo hello\x1b[5D');
    const at = PROMPT.length + 'echo '.length;
    resizeLikeWmux(t, 100, 24);
    expect(cursor(t)).toEqual([at - 100, 1]);
    resizeLikeWmux(t, 45, 24);
    expect(cursor(t)).toEqual([at - 90, 2]);
    t.dispose();
  });

  it('a cursor at the exact end of a full row stays in the wrap-pending column', async () => {
    const t = makeTerminal(30, 24);
    await write(t, 'x'.repeat(40));
    resizeLikeWmux(t, 40, 24);
    expect(cursor(t)).toEqual([40, 0]);
    await write(t, 'Y');
    expect(rows(t)).toEqual(['x'.repeat(40), 'Y']);
    t.dispose();
  });
});

describe('conptyViewportTop', () => {
  it('keeps the anchor on top when the cursor still fits', () => {
    expect(conptyViewportTop(10, 14, 6)).toBe(10);
  });

  it('scrolls just enough to keep the cursor on the bottom row', () => {
    expect(conptyViewportTop(10, 20, 6)).toBe(15);
  });

  it('never goes above the start of the buffer', () => {
    expect(conptyViewportTop(-3, 2, 6)).toBe(0);
  });
});

describe('shiftViewport', () => {
  function fake(lines: string[], ybase: number, y: number, rows: number) {
    const store = lines.map((s) => ({ isWrapped: false, text: s, getTrimmedLength: () => s.length }));
    const svc: AnchorBufferService & { store: typeof store } = {
      store,
      rows,
      buffer: {
        ybase,
        ydisp: ybase,
        y,
        scrollTop: 0,
        scrollBottom: rows - 1,
        lines: {
          get length() { return store.length; },
          get: (i: number) => store[i],
          pop: () => store.pop(),
        },
      },
      scroll() {
        store.push({ isWrapped: false, text: '', getTrimmedLength: () => 0 });
        svc.buffer.ybase++;
        svc.buffer.ydisp = svc.buffer.ybase;
      },
    };
    return svc;
  }

  it('pulls down only as far as there are blank rows under the cursor', () => {
    // viewport = lines 2..5, cursor on line 3 (y=1), one blank row below it
    // that is NOT blank at the very bottom → nothing may be dropped past it.
    const svc = fake(['s0', 's1', 'v0', 'PS>', '', 'late output'], 2, 1, 4);
    expect(shiftViewport(svc, 0, null)).toBe(0);
    expect(svc.store).toHaveLength(6);
  });

  it('drops trailing blank rows and moves the cursor down with the content', () => {
    const svc = fake(['s0', 's1', 'v0', 'PS>', '', ''], 2, 1, 4);
    expect(shiftViewport(svc, 0, null)).toBe(-2);
    expect(svc.buffer.ybase).toBe(0);
    expect(svc.buffer.y).toBe(3);
    expect(svc.store.map((l) => l.text)).toEqual(['s0', 's1', 'v0', 'PS>']);
  });

  it('pushes up without moving the cursor above row 0', () => {
    const svc = fake(['s0', 'v0', 'PS>', 'x'], 1, 1, 3);
    expect(shiftViewport(svc, 5, null)).toBe(1);
    expect(svc.buffer.y).toBe(0);
  });

  it('refuses to push inside an app-set scroll region', () => {
    const svc = fake(['s0', 'v0', 'PS>', 'x'], 1, 1, 3);
    svc.buffer.scrollTop = 1;
    expect(shiftViewport(svc, 2, null)).toBe(0);
  });
});

describe('useTerminal wiring', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'renderer', 'hooks', 'useTerminal.ts'),
    'utf8',
  );

  it('fit() anchors around the resize, and only for a change of columns', () => {
    const fit = src.slice(src.indexOf('const fit = () => {'));
    const body = fit.slice(0, fit.indexOf('\n  };'));
    const capture = body.indexOf('captureViewportTop(term)');
    const resize = body.indexOf('fitAddonRef.current.fit()');
    const cursor = body.indexOf('captureCursorLine(term)');
    const restore = body.indexOf('restoreCursorLine(term, cursorLine)');
    const anchor = body.indexOf('anchorViewportLikeConpty(term, top)');
    expect(capture).toBeGreaterThan(-1);
    // The cursor's line is measured after the top tail is orphaned, and put
    // back before the anchor reads the cursor row to decide how far to scroll.
    expect(cursor).toBeGreaterThan(capture);
    expect(resize).toBeGreaterThan(cursor);
    expect(restore).toBeGreaterThan(resize);
    expect(anchor).toBeGreaterThan(restore);
    expect(body).toMatch(/next\.cols !== term\.cols/);
  });

  it('reflows the cursor line, as ConPTY does (#273)', () => {
    expect(src).toMatch(/reflowCursorLine: true/);
  });
});
