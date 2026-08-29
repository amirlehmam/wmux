import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeCodeFile, readCodeFile, usesCrlf, toCrlf, detectEncoding } from '../../src/main/code-file';
import {
  grantFilePath, isFilePathGranted, clearFileGrants, resetFileGrants,
} from '../../src/main/file-grants';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-code-write-'));
  resetFileGrants();
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function write(name: string, content: string | Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function mtimeOf(p: string): number {
  return fs.lstatSync(p).mtimeMs;
}

describe('writeCodeFile', () => {
  it('writes content back to the file', () => {
    const p = write('a.ts', 'old\n');
    const res = writeCodeFile(p, 'new\n', mtimeOf(p));
    expect('error' in res).toBe(false);
    expect(fs.readFileSync(p, 'utf-8')).toBe('new\n');
  });

  it('returns the post-write mtime so the next save can guard on it', () => {
    const p = write('a.ts', 'old\n');
    const res = writeCodeFile(p, 'new\n', mtimeOf(p));
    if ('error' in res) throw new Error('expected success');
    expect(res.mtimeMs).toBe(mtimeOf(p));
  });

  // The core of the feature: an agent rewriting the file under the user.
  it('refuses a write when the file changed since it was read', () => {
    const p = write('a.ts', 'old\n');
    const staleMtime = mtimeOf(p) - 5000;
    const res = writeCodeFile(p, 'mine\n', staleMtime);
    expect(res).toMatchObject({ code: 'conflict' });
    expect(fs.readFileSync(p, 'utf-8')).toBe('old\n');   // untouched
  });

  it('never resolves a conflict by picking a winner', () => {
    const p = write('a.ts', 'theirs\n');
    writeCodeFile(p, 'mine\n', mtimeOf(p) - 1);
    expect(fs.readFileSync(p, 'utf-8')).toBe('theirs\n');
  });

  it('writes when no expected mtime is supplied', () => {
    const p = write('a.ts', 'old\n');
    expect('error' in writeCodeFile(p, 'new\n', undefined)).toBe(false);
  });

  it('refuses a missing file', () => {
    expect(writeCodeFile(path.join(dir, 'nope.ts'), 'x')).toMatchObject({ code: 'not_found' });
  });

  it('refuses a directory', () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    expect(writeCodeFile(path.join(dir, 'sub'), 'x')).toMatchObject({ code: 'invalid_path' });
  });

  it('refuses a binary extension', () => {
    const p = write('img.png', 'not really a png');
    expect(writeCodeFile(p, 'x', mtimeOf(p))).toMatchObject({ code: 'binary' });
  });

  it('refuses non-string content', () => {
    const p = write('a.ts', 'old\n');
    expect(writeCodeFile(p, undefined as any, mtimeOf(p))).toMatchObject({ code: 'invalid_path' });
  });

  it('refuses content past the 2MB cap', () => {
    const p = write('a.ts', 'old\n');
    const huge = 'x'.repeat(2 * 1024 * 1024 + 1);
    expect(writeCodeFile(p, huge, mtimeOf(p))).toMatchObject({ code: 'too_large' });
    expect(fs.readFileSync(p, 'utf-8')).toBe('old\n');
  });

  it('round-trips through readCodeFile', () => {
    const p = write('a.ts', 'one\ntwo\n');
    writeCodeFile(p, 'one\ntwo\nthree\n', mtimeOf(p));
    const read = readCodeFile(p);
    if ('error' in read) throw new Error('expected success');
    expect(read.content).toBe('one\ntwo\nthree\n');
  });
});

// A textarea normalizes its value to LF. Without this, changing one character
// in a CRLF file rewrites every line — visible immediately in the +N/-N column
// this release adds, and in the user's next commit.
describe('line ending preservation', () => {
  it('detects a CRLF-dominant file', () => {
    expect(usesCrlf('a\r\nb\r\nc\r\n')).toBe(true);
    expect(usesCrlf('a\nb\nc\n')).toBe(false);
    expect(usesCrlf('')).toBe(false);
  });

  it('follows the majority in a mixed file', () => {
    expect(usesCrlf('a\r\nb\r\nc\n')).toBe(true);
    expect(usesCrlf('a\r\nb\nc\n')).toBe(false);
  });

  it('does not double a carriage return that is already there', () => {
    expect(toCrlf('a\r\nb\n')).toBe('a\r\nb\r\n');
  });

  it('restores CRLF when saving a CRLF file', () => {
    const p = write('crlf.ts', 'one\r\ntwo\r\n');
    writeCodeFile(p, 'one\ntwo\nthree\n', mtimeOf(p));
    expect(fs.readFileSync(p, 'utf-8')).toBe('one\r\ntwo\r\nthree\r\n');
  });

  it('leaves an LF file as LF', () => {
    const p = write('lf.ts', 'one\ntwo\n');
    writeCodeFile(p, 'one\ntwo\nthree\n', mtimeOf(p));
    expect(fs.readFileSync(p, 'utf-8')).toBe('one\ntwo\nthree\n');
  });
});

describe('encoding preservation', () => {
  it('detects the three forms it can write', () => {
    expect(detectEncoding(Buffer.from([0xFF, 0xFE]))).toBe('utf16le');
    expect(detectEncoding(Buffer.from([0xEF, 0xBB, 0xBF]))).toBe('utf8-bom');
    expect(detectEncoding(Buffer.from('abc'))).toBe('utf8');
    expect(detectEncoding(Buffer.alloc(0))).toBe('utf8');
  });

  it('keeps a UTF-8 BOM rather than silently stripping it', () => {
    const p = write('bom.ts', Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('old\n')]));
    writeCodeFile(p, 'new\n', mtimeOf(p));
    const raw = fs.readFileSync(p);
    expect([raw[0], raw[1], raw[2]]).toEqual([0xEF, 0xBB, 0xBF]);
    expect(raw.subarray(3).toString('utf-8')).toBe('new\n');
  });

  it('keeps a UTF-16LE file as UTF-16LE rather than converting it', () => {
    const p = write('utf16.ts', Buffer.concat([
      Buffer.from([0xFF, 0xFE]), Buffer.from('old\n', 'utf16le'),
    ]));
    writeCodeFile(p, 'new\n', mtimeOf(p));
    const raw = fs.readFileSync(p);
    expect([raw[0], raw[1]]).toEqual([0xFF, 0xFE]);
    expect(raw.subarray(2).toString('utf16le')).toBe('new\n');
  });

  it('measures the size cap on encoded bytes, not string length', () => {
    // UTF-16 doubles the text, so a string comfortably under the cap can encode
    // to a file the read side would then refuse to reopen.
    const p = write('utf16.ts', Buffer.concat([
      Buffer.from([0xFF, 0xFE]), Buffer.from('x', 'utf16le'),
    ]));
    const justUnderAsChars = 'y'.repeat(1024 * 1024 + 100);   // ~1MB chars, ~2MB bytes
    expect(writeCodeFile(p, justUnderAsChars, mtimeOf(p))).toMatchObject({ code: 'too_large' });
  });
});

// The rename from markdown-grants.ts must not have changed behaviour, and the
// code surface must be checking the SAME set the markdown surface checks.
describe('file-grants, shared by both surfaces', () => {
  it('refuses a path that was never granted', () => {
    expect(isFilePathGranted(1, path.join(dir, 'a.ts'))).toBe(false);
  });

  it('allows a granted path', () => {
    const p = write('a.ts', 'x');
    grantFilePath(1, p);
    expect(isFilePathGranted(1, p)).toBe(true);
  });

  it('scopes grants per window', () => {
    const p = write('a.ts', 'x');
    grantFilePath(1, p);
    expect(isFilePathGranted(2, p)).toBe(false);
  });

  it('drops a window\'s grants when it goes away', () => {
    const p = write('a.ts', 'x');
    grantFilePath(1, p);
    clearFileGrants(1);
    expect(isFilePathGranted(1, p)).toBe(false);
  });

  it('matches a granted path spelled with different separators', () => {
    const p = path.join(dir, 'sub', 'a.ts');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(p, 'x');
    grantFilePath(1, p);
    expect(isFilePathGranted(1, p.split(path.sep).join('/'))).toBe(true);
  });

  it('ignores an empty path on both sides', () => {
    grantFilePath(1, '');
    expect(isFilePathGranted(1, '')).toBe(false);
  });
});
