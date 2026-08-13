import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { stripLegacyBlocks } from '../../src/main/claude-context';
import { injectWmuxBlock } from '../../src/main/opencode-context';

const BLOCK = fs.readFileSync(
  path.join(__dirname, '..', '..', 'resources', 'claude-instructions.md'),
  'utf-8',
);

/**
 * The block wmux writes lands in three GLOBAL files — ~/.claude/CLAUDE.md,
 * ~/.config/opencode/AGENTS.md and ~/.kiro/steering/wmux.md — so it is read by
 * every session on the machine, not only the ones inside wmux (issue #152).
 *
 * It used to open by asserting "You are running inside wmux…" and then, on the
 * strength of that claim, forbid the agent's own web tooling. A Claude Code
 * Desktop session with no wmux process running believed it and burned turns
 * driving a CLI that could not reach anything. The claim is a WRITE-time fact
 * being read at an arbitrarily later time by someone else — so the block has to
 * be checkable by its reader, not asserted by its writer.
 */
describe('global agent-context block (issue #152)', () => {
  it('never states as fact that the reader is inside wmux', () => {
    // The specific sentence that misled the reported session, in the tense that
    // made it a claim about the reader.
    expect(BLOCK).not.toMatch(/You are running inside wmux/);
    expect(BLOCK).not.toMatch(/^wmux is a terminal multiplexer.*\bthat you are\b/mi);
  });

  it('gives the reader a way to find out, before anything depends on the answer', () => {
    const beforeBrowser = BLOCK.substring(0, BLOCK.indexOf('## Browser'));
    // `wmux ping` is answered before the pipe's auth gate and fails fast when
    // nothing is listening, which is what makes it usable as the gate here.
    expect(beforeBrowser).toContain('wmux ping');
  });

  it('says what to do when the check fails, so a false premise has an exit', () => {
    expect(BLOCK).toMatch(/if it does not answer/i);
    // \s+ because the source is hard-wrapped — the sentence may straddle a line.
    expect(BLOCK).toMatch(/use your (normal|own)\s+tools/i);
  });

  it('never removes the reader\'s alternatives outright', () => {
    // The load-bearing part of the old text was not that it OFFERED wmux browser
    // — it was "Do NOT use Playwright, Firecrawl, or WebSearch", which leaves an
    // agent that believes it with no reason to look for another way.
    expect(BLOCK).not.toMatch(/Do NOT use Playwright/);
    expect(BLOCK).toMatch(/prefer the `wmux browser` commands|prefer/i);
  });

  it('is one file, so all three agents get the same fix', () => {
    // Claude, OpenCode and Kiro are all written from this one source; a
    // per-agent variant is how they drift.
    for (const file of ['claude-context.ts', 'opencode-context.ts', 'kiro-context.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', file), 'utf-8');
      expect(src).toContain('claude-instructions');
    }
  });
});

/**
 * Copies of the block written before it was marker-delimited (and before the
 * smux→wmux rename) were never updated and never removed: splicing keys off the
 * first `<!-- wmux:start -->`, so anything without markers just accumulated. The
 * machine this was found on had six, several disagreeing about the CLI's name,
 * all loaded into every session.
 */
describe('legacy marker-less copies (issue #152)', () => {
  const legacy = [
    '# wmux',
    '',
    'You are running inside wmux, a terminal multiplexer with a browser panel.',
    '',
    '```bash',
    'wmux browser open <url>          # navigate',
    '```',
    '',
  ].join('\n');

  it('removes a marker-less copy', () => {
    expect(stripLegacyBlocks(legacy).trim()).toBe('');
  });

  it('removes the smux-era copy too', () => {
    const smux = legacy.replace(/wmux/g, 'smux');
    expect(stripLegacyBlocks(smux).trim()).toBe('');
  });

  it('keeps the user\'s own content, including their own headings', () => {
    const doc = `# My notes\n\nAlways run the linter.\n\n${legacy}\n# wmux\n\nMy own wmux tips, not wmux's.\n`;
    const out = stripLegacyBlocks(doc);
    expect(out).toContain('Always run the linter.');
    expect(out).toContain("My own wmux tips, not wmux's.");
    expect(out).not.toContain('You are running inside wmux');
  });

  it('leaves the managed block alone — it has the same heading', () => {
    const out = stripLegacyBlocks(`${legacy}\n${BLOCK}`);
    expect(out).toContain('<!-- wmux:start');
    expect(out).toContain('<!-- wmux:end -->');
    expect(out).not.toContain('You are running inside wmux');
  });

  it('is not fooled by a "# " line inside a fenced example', () => {
    // The block's own markdown section shows `--content "# Title\\n..."`; a
    // scanner that treated any `# ` as a new section would cut a copy in half
    // and leave the tail behind.
    const withFence = [
      '# wmux',
      '',
      'You are running inside wmux, a terminal multiplexer.',
      '',
      '```bash',
      '# Title',
      'wmux markdown set id --content "hi"',
      '```',
      '',
      'trailing line of the legacy block',
      '',
    ].join('\n');
    expect(stripLegacyBlocks(withFence).trim()).toBe('');
  });

  it('collapses the gap it leaves instead of growing one', () => {
    const doc = `# Notes\n\ntext\n\n${legacy}\n\n# More\n\ntext\n`;
    expect(stripLegacyBlocks(doc)).not.toMatch(/\n{3,}/);
  });

  it('cleans up on the OpenCode path too, where the same block is written', () => {
    const out = injectWmuxBlock(`# Setup\n\nmine\n\n${legacy}`, BLOCK);
    expect(out).toContain('mine');
    expect(out.match(/<!-- wmux:start/g)).toHaveLength(1);
    expect(out).not.toContain('You are running inside wmux');
  });

  it('is idempotent — a clean file is returned unchanged', () => {
    const clean = `# Notes\n\nmine\n\n${BLOCK.trimEnd()}\n`;
    expect(stripLegacyBlocks(clean)).toBe(clean);
  });
});
