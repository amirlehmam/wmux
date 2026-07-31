import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ALLOWED_MD_EXT,
  MAX_MD_BYTES,
  MD_DIALOG_EXTENSIONS,
  isAllowedMarkdownPath,
  readMarkdownFile,
} from '../../src/main/markdown-file';

// Guards shared by every markdown read path (issue #116). Previously duplicated
// in main/index.ts and ipc-handlers.ts; these tests pin the behaviour so the
// single copy can't regress silently.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-md-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

describe('isAllowedMarkdownPath', () => {
  it('accepts every whitelisted extension', () => {
    for (const ext of ALLOWED_MD_EXT) {
      expect(isAllowedMarkdownPath(`C:\\docs\\file${ext}`)).toBe(true);
    }
  });

  it('is case-insensitive about the extension', () => {
    expect(isAllowedMarkdownPath('C:\\docs\\README.MD')).toBe(true);
  });

  // This is what stops `openPath` from becoming an arbitrary-program launcher.
  it('rejects executables and scripts', () => {
    expect(isAllowedMarkdownPath('C:\\docs\\payload.ps1')).toBe(false);
    expect(isAllowedMarkdownPath('C:\\docs\\payload.exe')).toBe(false);
    expect(isAllowedMarkdownPath('C:\\docs\\payload.cmd')).toBe(false);
  });

  it('rejects an extensionless path and an empty path', () => {
    expect(isAllowedMarkdownPath('C:\\docs\\id_rsa')).toBe(false);
    expect(isAllowedMarkdownPath('')).toBe(false);
  });

  it('keeps the dialog filter list in sync with the whitelist', () => {
    expect(MD_DIALOG_EXTENSIONS.map((e) => `.${e}`).sort()).toEqual([...ALLOWED_MD_EXT].sort());
  });
});

describe('readMarkdownFile', () => {
  it('reads a whitelisted file and reports its mtime', () => {
    const file = write('notes.md', '# Hello');
    const result = readMarkdownFile(file);

    expect(result).toMatchObject({ filePath: file, content: '# Hello' });
    expect((result as any).mtimeMs).toBeGreaterThan(0);
  });

  it('refuses a non-whitelisted extension even when the file exists', () => {
    const file = write('secrets.env', 'TOKEN=1');
    expect(readMarkdownFile(file)).toEqual({ error: 'Unsupported file type: .env', code: 'unsupported_type' });
  });

  it('reports a missing file rather than throwing', () => {
    expect(readMarkdownFile(path.join(dir, 'nope.md'))).toEqual({ error: 'File not found', code: 'not_found' });
  });

  it('refuses a directory', () => {
    const sub = path.join(dir, 'docs.md');
    fs.mkdirSync(sub);
    expect(readMarkdownFile(sub)).toEqual({ error: 'File is not a regular file', code: 'not_regular_file' });
  });

  it('refuses an empty path', () => {
    expect(readMarkdownFile('')).toEqual({ error: 'No file path provided', code: 'no_path' });
  });

  it('enforces the size cap', () => {
    const file = path.join(dir, 'huge.md');
    fs.writeFileSync(file, Buffer.alloc(MAX_MD_BYTES + 1, 0x61));
    expect(readMarkdownFile(file)).toEqual({ error: 'File exceeds the 5MB limit', code: 'too_large' });
  });

  // A symlink named `notes.md` pointing at `id_rsa` would otherwise pass the
  // extension check on its own name. Windows needs elevation or Developer Mode
  // to create one, so the test skips itself rather than failing the suite.
  it('refuses a symlink whose name would pass the whitelist', () => {
    const target = write('id_rsa_like.txtx', 'PRIVATE KEY');
    const link = path.join(dir, 'notes.md');
    try {
      fs.symlinkSync(target, link);
    } catch {
      return; // no symlink privilege in this environment
    }
    expect(readMarkdownFile(link)).toEqual({ error: 'Refusing to read a symlink', code: 'symlink' });
  });
});
