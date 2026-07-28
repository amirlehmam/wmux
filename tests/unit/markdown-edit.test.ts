import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeMarkdownFile, statMarkdownFile } from '../../src/main/markdown-file';
import {
  grantMarkdownPath,
  isMarkdownPathGranted,
  clearMarkdownGrants,
  resetMarkdownGrants,
} from '../../src/main/markdown-grants';
import {
  EDIT_INDENT,
  continuationPrefix,
  continueList,
  insertIndent,
} from '../../src/renderer/components/Markdown/markdown-utils';
import { markdownContentPatch } from '../../src/renderer/store/surface-slice';
import type { SurfaceRef } from '../../src/shared/types';

// ─── Write guards ─────────────────────────────────────────────────────────────

describe('writeMarkdownFile (issue #116, F3)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-md-'));
    file = path.join(dir, 'notes.md');
    fs.writeFileSync(file, 'original\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the buffer and reports the new mtime', () => {
    const res = writeMarkdownFile(file, '# edited\n');
    expect(res).toMatchObject({ ok: true });
    expect(fs.readFileSync(file, 'utf-8')).toBe('# edited\n');
    expect((res as { mtimeMs: number }).mtimeMs).toBeGreaterThan(0);
  });

  // The whitelist has to apply on the way out too, or a grant for notes.md
  // could be laundered into writing a .ps1 the shell will happily run.
  it('refuses to write outside the extension whitelist', () => {
    const script = path.join(dir, 'evil.ps1');
    expect(writeMarkdownFile(script, 'rm -rf /')).toMatchObject({ error: expect.any(String) });
    expect(fs.existsSync(script)).toBe(false);
  });

  it('refuses content past the 5MB cap', () => {
    const huge = 'x'.repeat(5 * 1024 * 1024 + 1);
    expect(writeMarkdownFile(file, huge)).toMatchObject({ error: expect.stringContaining('5MB') });
    expect(fs.readFileSync(file, 'utf-8')).toBe('original\n');
  });

  it('reports a conflict and writes nothing when the file moved underneath', () => {
    const before = fs.statSync(file).mtimeMs;
    // Something else (an agent) rewrote it since we loaded.
    fs.writeFileSync(file, 'rewritten by an agent\n', 'utf-8');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));

    const res = writeMarkdownFile(file, 'my edits\n', before);
    expect(res).toMatchObject({ conflict: true });
    expect(fs.readFileSync(file, 'utf-8')).toBe('rewritten by an agent\n');
  });

  it('overwrites when the caller deliberately drops the mtime check', () => {
    fs.writeFileSync(file, 'rewritten\n', 'utf-8');
    expect(writeMarkdownFile(file, 'mine wins\n')).toMatchObject({ ok: true });
    expect(fs.readFileSync(file, 'utf-8')).toBe('mine wins\n');
  });

  it('writes through a rename, leaving no temp file behind', () => {
    writeMarkdownFile(file, 'content\n');
    expect(fs.readdirSync(dir)).toEqual(['notes.md']);
  });

  it('creates a file that does not exist yet (Save As)', () => {
    const fresh = path.join(dir, 'new.md');
    expect(writeMarkdownFile(fresh, 'hello\n')).toMatchObject({ ok: true });
    expect(fs.readFileSync(fresh, 'utf-8')).toBe('hello\n');
  });

  it('re-stats an existing file and rejects a non-markdown path', () => {
    expect(statMarkdownFile(file)).toMatchObject({ mtimeMs: expect.any(Number) });
    expect(statMarkdownFile(path.join(dir, 'x.ps1'))).toMatchObject({ error: expect.any(String) });
    expect(statMarkdownFile(path.join(dir, 'missing.md'))).toMatchObject({ error: 'File not found' });
  });
});

// ─── Grant set ────────────────────────────────────────────────────────────────

describe('markdown write grants', () => {
  beforeEach(() => resetMarkdownGrants());

  // The point of the whole mechanism: the renderer holds the path and hands it
  // back on save, so a renderer-side bug must not be able to name a target the
  // user never opened.
  it('refuses a path the user never opened', () => {
    expect(isMarkdownPathGranted(1, 'C:/Users/me/.ssh/authorized_keys')).toBe(false);
  });

  it('allows a path a dialog or authenticated pipe client opened', () => {
    grantMarkdownPath(1, 'C:/docs/plan.md');
    expect(isMarkdownPathGranted(1, 'C:/docs/plan.md')).toBe(true);
  });

  it('does not leak grants between windows', () => {
    grantMarkdownPath(1, 'C:/docs/plan.md');
    expect(isMarkdownPathGranted(2, 'C:/docs/plan.md')).toBe(false);
  });

  it('forgets a window\'s grants when it is destroyed', () => {
    grantMarkdownPath(1, 'C:/docs/plan.md');
    clearMarkdownGrants(1);
    expect(isMarkdownPathGranted(1, 'C:/docs/plan.md')).toBe(false);
  });

  it('treats the many spellings of one Windows path as the same file', () => {
    grantMarkdownPath(1, 'C:\\docs\\plan.md');
    // Same file, different separators and case — must not need a second grant.
    expect(isMarkdownPathGranted(1, 'C:\\Docs\\Plan.md')).toBe(process.platform === 'win32');
    expect(isMarkdownPathGranted(1, 'C:\\docs\\plan.md')).toBe(true);
  });
});

// ─── Editor key handling ──────────────────────────────────────────────────────

describe('insertIndent', () => {
  it('inserts an indent at the caret', () => {
    expect(insertIndent('ab', 1, 1)).toEqual({
      content: `a${EDIT_INDENT}b`,
      selectionStart: 1 + EDIT_INDENT.length,
      selectionEnd: 1 + EDIT_INDENT.length,
    });
  });

  it('indents every line a selection touches, from the line start', () => {
    const content = 'one\ntwo\nthree';
    // Selection starts mid-"one" and ends mid-"two".
    const res = insertIndent(content, 1, 6);
    expect(res.content).toBe('  one\n  two\nthree');
  });
});

describe('continuationPrefix', () => {
  it('continues bullets, keeping the marker and indent', () => {
    expect(continuationPrefix('- item')).toBe('- ');
    expect(continuationPrefix('  * item')).toBe('  * ');
    expect(continuationPrefix('+ item')).toBe('+ ');
  });

  it('increments ordered lists', () => {
    expect(continuationPrefix('1. first')).toBe('2. ');
    expect(continuationPrefix('  9) ninth')).toBe('  10) ');
  });

  it('continues task lists as unchecked tasks', () => {
    expect(continuationPrefix('- [x] done')).toBe('- [ ] ');
    expect(continuationPrefix('- [ ] todo')).toBe('- [ ] ');
  });

  it('continues blockquotes', () => {
    expect(continuationPrefix('> quoted')).toBe('> ');
    expect(continuationPrefix('>> nested')).toBe('>> ');
  });

  // Enter on an empty item ends the list rather than emitting bullets forever.
  it('ends the list on an empty item', () => {
    expect(continuationPrefix('- ')).toBe('');
    expect(continuationPrefix('1. ')).toBe('');
    expect(continuationPrefix('- [ ] ')).toBe('');
    expect(continuationPrefix('> ')).toBe('');
  });

  it('leaves ordinary paragraphs alone', () => {
    expect(continuationPrefix('just text')).toBeNull();
    expect(continuationPrefix('')).toBeNull();
    expect(continuationPrefix('# heading')).toBeNull();
  });
});

describe('continueList', () => {
  it('inserts the newline and the inherited prefix', () => {
    const content = '- one';
    const res = continueList(content, content.length)!;
    expect(res.content).toBe('- one\n- ');
    expect(res.selectionStart).toBe(res.content.length);
  });

  it('strips the marker of an empty item instead of repeating it', () => {
    const content = '- one\n- ';
    const res = continueList(content, content.length)!;
    expect(res.content).toBe('- one\n\n');
  });

  it('returns null when the default newline is right', () => {
    expect(continueList('plain text', 10)).toBeNull();
  });
});

// ─── Dirty tracking ───────────────────────────────────────────────────────────

describe('markdownContentPatch', () => {
  const fileBacked = { id: 'surf-1', type: 'markdown', markdownFilePath: 'C:/docs/a.md' } as SurfaceRef;
  const pathless = { id: 'surf-2', type: 'markdown' } as SurfaceRef;

  it('a load from disk is clean and records the mtime', () => {
    const patch = markdownContentPatch(pathless, 'body', {
      fileName: 'a.md', filePath: 'C:/docs/a.md', mtimeMs: 42,
    });
    expect(patch).toMatchObject({
      markdownContent: 'body',
      markdownFileName: 'a.md',
      markdownFilePath: 'C:/docs/a.md',
      markdownFileMtime: 42,
      markdownDirty: false,
    });
  });

  // `wmux markdown set --content` against a file-backed surface leaves the
  // buffer differing from disk. That is a user edit in every way that matters:
  // keep the path, mark it dirty, do NOT auto-write.
  it('a content-only push into a file-backed surface goes dirty', () => {
    const patch = markdownContentPatch(fileBacked, 'pushed');
    expect(patch.markdownDirty).toBe(true);
    expect(patch.markdownFilePath).toBeUndefined();
    expect(patch.markdownFileName).toBeUndefined();
  });

  it('a content-only push into a pathless surface is not dirty', () => {
    expect(markdownContentPatch(pathless, 'pushed').markdownDirty).toBe(false);
  });

  it('an explicit dirty flag wins over the inference', () => {
    expect(markdownContentPatch(fileBacked, 'x', { dirty: false }).markdownDirty).toBe(false);
  });
});
