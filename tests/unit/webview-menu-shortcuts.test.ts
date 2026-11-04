import { expect, it, vi } from 'vitest';
import { ignoreMenuShortcutsInGuest } from '../../src/main/webview-menu-shortcuts';
import * as fs from 'fs';
import * as path from 'path';

function contents(type: string) {
  return { getType: () => type, setIgnoreMenuShortcuts: vi.fn() };
}

it('keeps menu accelerators such as Window → Close (Ctrl+W) away from a browser guest', () => {
  const guest = contents('webview');
  ignoreMenuShortcutsInGuest(guest as any);
  expect(guest.setIgnoreMenuShortcuts).toHaveBeenCalledWith(true);
});

it.each(['window', 'remote', 'backgroundPage'])('leaves the menu alone for %s contents', (type) => {
  const other = contents(type);
  ignoreMenuShortcutsInGuest(other as any);
  expect(other.setIgnoreMenuShortcuts).not.toHaveBeenCalled();
});

// Wiring: the helper only helps if hardenWebContents calls it for every guest.
// The block is sliced out by brace counting (comments blanked, string bodies
// skipped) so a nested block or a brace in a comment cannot fool the check.
const QUOTES = new Set(["'", '"', '`']);

function skipString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
  return i + 1;
}

function blankComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (QUOTES.has(src[i])) {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
    } else if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (src.startsWith('/*', i)) {
      const stop = src.indexOf('*/', i) + 2;
      out += src.slice(i, stop).replaceAll(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

function blockFrom(src: string, from: number): string {
  const open = src.indexOf('{', from);
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (QUOTES.has(ch)) {
      i = skipString(src, i);
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
    i += 1;
  }
  throw new Error(`unbalanced block at ${from}`);
}

function webviewBlocksOfHardenWebContents(source: string): string[] {
  const code = blankComments(source);
  const fnAt = code.indexOf('function hardenWebContents(');
  expect(fnAt).toBeGreaterThanOrEqual(0);
  const body = blockFrom(code, fnAt);
  const blocks: string[] = [];
  const guard = /if\s*\(\s*type\s*===\s*'webview'\s*\)/g;
  for (const m of body.matchAll(guard)) blocks.push(blockFrom(body, m.index));
  return blocks;
}

it('hardenWebContents calls ignoreMenuShortcutsInGuest(contents) inside its webview block', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/main/index.ts'), 'utf8');
  const blocks = webviewBlocksOfHardenWebContents(source);
  expect(blocks.length).toBeGreaterThan(0);
  expect(blocks.some((b) => /\bignoreMenuShortcutsInGuest\(\s*contents\s*\)/.test(b))).toBe(true);
});
