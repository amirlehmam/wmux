import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isBinaryPath, looksBinary, readCodeFile, MAX_CODE_BYTES,
} from '../../src/main/code-file';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-code-file-'));
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export {}\r\nconst a = 1\n');
  fs.writeFileSync(path.join(dir, 'empty.txt'), '');
  fs.writeFileSync(path.join(dir, 'bom.txt'), Buffer.from([0xEF, 0xBB, 0xBF, 0x68, 0x69]));
  fs.writeFileSync(path.join(dir, 'utf16.txt'), Buffer.from([0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00]));
  // A .txt whose CONTENT is binary — the extension passes, the sniff must not.
  fs.writeFileSync(path.join(dir, 'liar.txt'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x1A]));
  fs.writeFileSync(path.join(dir, 'photo.png'), 'not really a png');
  fs.mkdirSync(path.join(dir, 'subdir'));
  fs.writeFileSync(path.join(dir, 'big.log'), Buffer.alloc(MAX_CODE_BYTES + 1, 0x41));
});

afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const code = (r: any): string | undefined => r.code;

describe('isBinaryPath', () => {
  it('rejects deny-listed extensions regardless of case', () => {
    expect(isBinaryPath('app.exe')).toBe(true);
    expect(isBinaryPath('IMAGE.PNG')).toBe(true);
    expect(isBinaryPath('bundle.Zip')).toBe(true);
  });

  it('accepts source files', () => {
    expect(isBinaryPath('index.ts')).toBe(false);
    expect(isBinaryPath('main.rs')).toBe(false);
    expect(isBinaryPath('config.yaml')).toBe(false);
  });

  it('accepts extension-less names — Makefile and friends are text', () => {
    expect(isBinaryPath('Makefile')).toBe(false);
    expect(isBinaryPath('Dockerfile')).toBe(false);
    expect(isBinaryPath('LICENSE')).toBe(false);
  });

  it('accepts dotfiles, whose leading dot is not an extension', () => {
    expect(isBinaryPath('.gitignore')).toBe(false);
    expect(isBinaryPath('.env')).toBe(false);
  });
});

describe('looksBinary', () => {
  it('treats the empty buffer as text', () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
  });

  it('treats plain ASCII, CRLF and tabs as text', () => {
    expect(looksBinary(Buffer.from('const a = 1;\r\n\tconst b = 2;\n'))).toBe(false);
  });

  it('treats UTF-8 as text', () => {
    expect(looksBinary(Buffer.from('héllo — 😀 日本語', 'utf-8'))).toBe(false);
  });

  it('treats a UTF-8 BOM as text', () => {
    expect(looksBinary(Buffer.from([0xEF, 0xBB, 0xBF, 0x68, 0x69]))).toBe(false);
  });

  it('treats a UTF-16LE BOM as text', () => {
    expect(looksBinary(Buffer.from([0xFF, 0xFE, 0x68, 0x00]))).toBe(false);
  });

  it('rejects any buffer containing a NUL byte', () => {
    expect(looksBinary(Buffer.from([0x68, 0x69, 0x00, 0x68]))).toBe(true);
  });

  it('rejects a control-character-dense buffer', () => {
    expect(looksBinary(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x41, 0x42, 0x43]))).toBe(true);
  });
});

describe('readCodeFile', () => {
  it('reads a source file, returning content and mtime', () => {
    const r: any = readCodeFile(path.join(dir, 'index.ts'));
    expect(r.content).toBe('export {}\r\nconst a = 1\n');
    expect(r.filePath).toBe(path.join(dir, 'index.ts'));
    expect(typeof r.mtimeMs).toBe('number');
  });

  it('reads an empty file as empty content, not an error', () => {
    const r: any = readCodeFile(path.join(dir, 'empty.txt'));
    expect(r.content).toBe('');
  });

  it('strips a UTF-8 BOM from the content', () => {
    const r: any = readCodeFile(path.join(dir, 'bom.txt'));
    expect(r.content).toBe('hi');
  });

  it('decodes UTF-16LE rather than calling it binary', () => {
    const r: any = readCodeFile(path.join(dir, 'utf16.txt'));
    expect(r.content).toBe('hi');
  });

  it('rejects a deny-listed extension before touching the disk', () => {
    expect(code(readCodeFile(path.join(dir, 'photo.png')))).toBe('binary');
  });

  it('rejects binary CONTENT behind a text extension', () => {
    expect(code(readCodeFile(path.join(dir, 'liar.txt')))).toBe('binary');
  });

  it('rejects a file over the size cap', () => {
    expect(code(readCodeFile(path.join(dir, 'big.log')))).toBe('too_large');
  });

  it('rejects a directory', () => {
    expect(code(readCodeFile(path.join(dir, 'subdir')))).toBe('invalid_path');
  });

  it('reports a missing file as not_found', () => {
    expect(code(readCodeFile(path.join(dir, 'nope.ts')))).toBe('not_found');
  });
});
