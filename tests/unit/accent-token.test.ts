import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// The accent used to be `#0091FF` hardcoded in 53 places across 13 stylesheets —
// the one chrome colour that never went through theme-vars.css, which is why it
// could not be themed and why the light palette shipped a 2.6:1 contrast bug.
// These tests keep it from creeping back.

const SRC = path.join(__dirname, '..', '..', 'src');
const STYLES = path.join(SRC, 'renderer', 'styles');
const THEME_VARS = path.join(STYLES, 'theme-vars.css');

/** Every file under src/, minus the token definitions that legitimately hold the literal. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(css|tsx?|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Strip block comments and `//` line comments so prose about the old colour
 * doesn't trip the scan. Block comments are removed by index scanning rather
 * than a lazy `/\*[\s\S]*?\*\//` regex, which backtracks super-linearly on a
 * file with many unterminated `/*` sequences.
 */
function stripComments(text: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const open = text.indexOf('/*', cursor);
    if (open === -1) {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, open);
    const close = text.indexOf('*/', open + 2);
    if (close === -1) break;
    cursor = close + 2;
  }
  // Whole-line `//` comments only, matched without a regex for the same reason.
  // Trailing `//` is left alone so `url(https://…)` survives intact.
  return out
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
}

const ACCENT_LITERAL = /#0091ff|rgba\(\s*0,\s*145,\s*255/i;

describe('accent token', () => {
  it('is defined for both themes in theme-vars.css', () => {
    const css = fs.readFileSync(THEME_VARS, 'utf-8');
    expect(css).toMatch(/:root\s*\{[\s\S]*--ui-accent:\s*#0091ff/);
    expect(css).toMatch(/\[data-ui-theme='light'\][\s\S]*--ui-accent:\s*#0067c0/);
  });

  // A sweep that rewrites `#0091ff` -> `var(--ui-accent)` across every stylesheet
  // will happily rewrite the definition itself into `--ui-accent: var(--ui-accent)`,
  // which resolves to nothing and silently removes the accent app-wide.
  it('does not define itself circularly', () => {
    const css = fs.readFileSync(THEME_VARS, 'utf-8');
    expect(css).not.toMatch(/--ui-accent(-rgb|-contrast)?:\s*var\(\s*--ui-accent/);
  });

  it('declares an rgb triple and a contrast colour alongside every accent', () => {
    const css = stripComments(fs.readFileSync(THEME_VARS, 'utf-8'));
    const accents = css.match(/--ui-accent:/g) ?? [];
    const rgbs = css.match(/--ui-accent-rgb:/g) ?? [];
    const contrasts = css.match(/--ui-accent-contrast:/g) ?? [];
    expect(accents.length).toBeGreaterThanOrEqual(2);
    expect(rgbs).toHaveLength(accents.length);
    expect(contrasts).toHaveLength(accents.length);
  });

  it('is not hardcoded anywhere else in src/', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => path.resolve(file) !== path.resolve(THEME_VARS))
      .filter((file) => ACCENT_LITERAL.test(stripComments(fs.readFileSync(file, 'utf-8'))))
      .map((file) => path.relative(SRC, file));

    expect(offenders).toEqual([]);
  });
});

describe('selection treatment', () => {
  const sidebar = () => fs.readFileSync(path.join(STYLES, 'sidebar.css'), 'utf-8');

  // The complaint that started this: selecting a row painted an opaque accent
  // slab over every live status colour underneath it.
  it('does not paint the active row as an opaque accent fill by default', () => {
    const css = stripComments(sidebar());
    const rule = /\.workspace-row--active\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule![1]).not.toMatch(/background:\s*var\(--row-accent\)\s*;/);
    expect(rule![1]).toMatch(/color-mix/);
  });

  it('keeps an opt-in solid fill for the solidFill preference', () => {
    expect(stripComments(sidebar())).toMatch(/\.workspace-row--fill\s*\{[^}]*background:\s*var\(--row-accent\)/);
  });

  // These four rules replaced status/PR/context colours on selection. Only the
  // opaque-fill variant may still do that.
  it('only overrides status and PR colours inside the solid fill', () => {
    const css = stripComments(sidebar());
    for (const el of ['__status', '__pr']) {
      expect(css).not.toMatch(new RegExp(`\\.workspace-row--active\\s+\\.workspace-row${el}\\s*\\{`));
      expect(css).toMatch(new RegExp(`\\.workspace-row--fill\\s+\\.workspace-row${el}\\s*\\{`));
    }
  });
});

describe('reduced motion', () => {
  it('has an app-wide guard covering animations and transitions', () => {
    const css = fs.readFileSync(path.join(STYLES, 'global.css'), 'utf-8');
    const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}/.exec(css);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(block![1]).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(block![1]).toMatch(/animation-iteration-count:\s*1\s*!important/);
  });
});
