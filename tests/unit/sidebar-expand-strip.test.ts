import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// #462: the collapsed sidebar's expand strip is a flow sibling of the pane area.
// Any hover rule that changes its box (width, padding, margin, border width)
// shrinks every pane and resizes every terminal as the pointer crosses it.
const css = readFileSync(join(__dirname, '../../src/renderer/styles/sidebar.css'), 'utf8');

function rulesFor(selector: string): string[] {
  const out: string[] = [];
  // Flat stylesheet (no nesting): every '}' ends one "selectors { body" chunk.
  for (const chunk of css.split('}')) {
    const open = chunk.indexOf('{');
    if (open < 0) continue;
    let head = chunk.slice(0, open);
    const commentEnd = head.lastIndexOf('*/');
    if (commentEnd >= 0) head = head.slice(commentEnd + 2);
    const selectors = head.split(',').map((s) => s.trim());
    if (selectors.includes(selector)) out.push(chunk.slice(open + 1));
  }
  return out;
}

describe('sidebar expand strip (#462)', () => {
  it('has a hover highlight', () => {
    const hover = rulesFor('.sidebar-expand-strip:hover').join('\n');
    expect(hover).toMatch(/background\s*:/);
  });

  it('never changes its size on hover', () => {
    const hover = rulesFor('.sidebar-expand-strip:hover').join('\n');
    expect(hover).not.toMatch(/(^|[\s;])(min-|max-)?width\s*:/);
    expect(hover).not.toMatch(/(^|[\s;])(padding|margin)(-[a-z]+)?\s*:/);
    expect(hover).not.toMatch(/border(-right)?\s*:/);
    expect(hover).not.toMatch(/transform\s*:/);
  });
});
