import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listDir, validateRelPath, MAX_ENTRIES, FILTERED_NAMES } from '../../src/main/explorer-fs';

let root: string;
let outside: string;

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-explorer-'));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'docs', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  for (const filtered of FILTERED_NAMES) {
    fs.mkdirSync(path.join(root, filtered), { recursive: true });
  }
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# hi');
  fs.writeFileSync(path.join(root, 'index.ts'), 'export {}');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(root, 'docs', 'guide.markdown'), 'g');
  // A legitimately-named child whose name merely BEGINS with '..'. Nothing
  // stops a user creating one, and the jail must not confuse it with '..'.
  fs.mkdirSync(path.join(root, '..foo'), { recursive: true });
  fs.writeFileSync(path.join(root, '..foo', 'inside.md'), 'i');
  fs.writeFileSync(path.join(outside, 'secret.md'), 'nope');
});

afterAll(() => {
  try { fs.rmSync(path.dirname(root), { recursive: true, force: true }); } catch { /* best effort */ }
});

function err(result: any): string | undefined { return result.code; }

describe('validateRelPath', () => {
  it('accepts an empty path and ordinary relative paths', () => {
    expect(validateRelPath('')).toBeNull();
    expect(validateRelPath('docs')).toBeNull();
    expect(validateRelPath('docs/nested')).toBeNull();
    expect(validateRelPath('docs\\nested')).toBeNull();
  });

  it('rejects absolute, drive-relative, UNC and namespace-prefixed paths', () => {
    expect(validateRelPath('C:\\Windows')).toBe('invalid_path');
    expect(validateRelPath('/etc/passwd')).toBe('invalid_path');
    expect(validateRelPath('C:foo')).toBe('invalid_path');
    expect(validateRelPath('\\\\server\\share')).toBe('invalid_path');
    expect(validateRelPath('\\\\?\\C:\\Windows')).toBe('invalid_path');
    expect(validateRelPath('\\\\.\\PhysicalDrive0')).toBe('invalid_path');
  });

  it('rejects alternate data streams', () => {
    expect(validateRelPath('notes.md:hidden')).toBe('invalid_path');
    expect(validateRelPath('docs/notes.md:$DATA')).toBe('invalid_path');
  });

  it('rejects reserved DOS device names stem-wise', () => {
    for (const name of ['NUL', 'CON', 'PRN', 'AUX', 'COM1', 'LPT9', 'con', 'CON.md']) {
      expect(validateRelPath(name)).toBe('invalid_path');
    }
    expect(validateRelPath('CONSOLE.md')).toBeNull();
    expect(validateRelPath('docs/CON/x')).toBe('invalid_path');
  });

  it('rejects segments with a trailing dot or space', () => {
    expect(validateRelPath('docs ')).toBe('invalid_path');
    expect(validateRelPath('docs.')).toBe('invalid_path');
    expect(validateRelPath('docs./nested')).toBe('invalid_path');
  });
});

describe('listDir jail', () => {
  it('lists the root', async () => {
    // Subset assertion, not an exact array: other tests in this file create
    // additional entries under `root` (leaf-link, mid-link, big,
    // denied-probe), and this test must stay correct regardless of run
    // order, `.only`, or file-level concurrency — it does not own `root`
    // exclusively.
    const r: any = await listDir(root, '');
    expect(r.code).toBeUndefined();
    expect(r.relPath).toBe('');
    const names = r.entries.map((e: any) => e.name);
    expect(names).toEqual(expect.arrayContaining(['README.md', 'docs', 'index.ts']));
    expect(names).not.toContain('.git');
  });

  it('rejects a .. escape, including a deep chain', async () => {
    expect(err(await listDir(root, '..'))).toBe('outside_root');
    expect(err(await listDir(root, 'docs/../../..'))).toBe('outside_root');
    expect(err(await listDir(root, 'docs/nested/../../../outside'))).toBe('outside_root');
  });

  // The over-rejection the bare `rel.startsWith('..')` form caused: '..foo' is
  // an ordinary child directory, not an escape. The user saw it as a folder in
  // the tree that silently refused to open.
  it('opens a child whose name merely BEGINS with .. rather than calling it an escape', async () => {
    const r: any = await listDir(root, '..foo');
    expect(r.code).toBeUndefined();
    expect(r.relPath).toBe('..foo');
    expect(r.entries.map((e: any) => e.name)).toContain('inside.md');
  });

  it('still rejects the real .. escapes that share that prefix', async () => {
    expect(err(await listDir(root, '..'))).toBe('outside_root');
    expect(err(await listDir(root, '../outside'))).toBe('outside_root');
    expect(err(await listDir(root, '..\\outside'))).toBe('outside_root');
  });

  // A root that already ENDS in a separator: path.resolve('C:\') is 'C:\', so
  // the containment prefix was spelt with two. Nothing below a bare drive
  // letter could match it, and a pane sitting at C:\ listed its root fine and
  // then refused to open any folder in it.
  it('opens a child of a root that is itself a drive root', async () => {
    const real = fs.realpathSync(root);
    const driveRoot = path.parse(real).root;
    const fromDrive = path.relative(driveRoot, real);
    const r: any = await listDir(driveRoot, fromDrive);
    expect(r.code).toBeUndefined();
    expect(r.entries.map((e: any) => e.name)).toEqual(
      expect.arrayContaining(['README.md', 'docs', 'index.ts']),
    );
  });

  it('rejects an absolute relPath before resolving it', async () => {
    expect(err(await listDir(root, outside))).toBe('invalid_path');
  });

  it('rejects a drive-qualified relPath via the path policy', async () => {
    // A drive-qualified relPath like 'D:\data' is caught by
    // validateRelPath's /^[A-Za-z]:/ check BEFORE listDir ever resolves a
    // path, so this test proves rejection at the policy layer. It does NOT
    // exercise listDir's `path.isAbsolute(rel)` clause — that clause is
    // unreachable given the current policy (a drive-qualified relPath never
    // survives validateRelPath), and is covered by its own comment in
    // explorer-fs.ts rather than by a test that can't reach it.
    const otherDrive = root.startsWith('C:') ? 'D:\\data' : 'C:\\data';
    expect(err(await listDir(root, otherDrive))).toBe('invalid_path');
  });

  it('rejects a symlink as the FINAL segment', async () => {
    const link = path.join(root, 'leaf-link');
    fs.symlinkSync(outside, link, 'junction');
    expect(err(await listDir(root, 'leaf-link'))).toBe('outside_root');
  });

  it('rejects a junction as an INTERMEDIATE segment', async () => {
    // root\mid-link\ is a junction to `outside`; asking for mid-link/sub must
    // fail even though the FINAL lstat would resolve inside `outside`.
    fs.mkdirSync(path.join(outside, 'sub'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'mid-link'), 'junction');
    expect(err(await listDir(root, 'mid-link/sub'))).toBe('outside_root');
  });

  it('reports a junction entry as kind=symlink and never viewable', async () => {
    // Self-contained: creates its own link rather than relying on
    // 'leaf-link' from the earlier test having already run, so this
    // assertion holds regardless of test order, `.only`, or concurrency.
    // existsSync guard: an unguarded symlinkSync throws EEXIST on a vitest
    // --retry or --rerun (the temp root can survive), and an EEXIST here reads
    // exactly like a real regression in listDir.
    const linkPath = path.join(root, 'kind-check-link');
    if (!fs.existsSync(linkPath)) fs.symlinkSync(outside, linkPath, 'junction');
    const r: any = await listDir(root, '');
    const link = r.entries.find((e: any) => e.name === 'kind-check-link');
    expect(link.kind).toBe('symlink');
    expect(link.viewable).toBe(false);
  });

  // skipIf rather than an early `return` inside the test body: a silent
  // no-op reports green with zero assertions run, which looks identical to
  // a passing test in CI output. skipIf shows up as explicitly skipped.
  it.skipIf(process.platform !== 'win32')('treats Windows case variance as the same jail', async () => {
    const shouted = root.toUpperCase();
    const r: any = await listDir(shouted, 'docs');
    expect(r.code).toBeUndefined();
    expect(r.relPath).toBe('docs');
  });
});

describe('listDir filtering, limits and errors', () => {
  it('hides dotfiles and every FILTERED_NAMES entry by default', async () => {
    // Asserts against the actual exported set (.git, node_modules, dist,
    // build as of writing) rather than a hardcoded list that can silently
    // drift from FILTERED_NAMES.
    expect(FILTERED_NAMES.size).toBeGreaterThan(0);
    const r: any = await listDir(root, '');
    const names = r.entries.map((e: any) => e.name);
    expect(names).not.toContain('.env');
    for (const filtered of FILTERED_NAMES) {
      expect(names).not.toContain(filtered);
    }
  });

  it('shows dotfiles and FILTERED_NAMES entries with showHidden', async () => {
    const r: any = await listDir(root, '', { showHidden: true });
    const names = r.entries.map((e: any) => e.name);
    expect(names).toContain('.env');
    for (const filtered of FILTERED_NAMES) {
      expect(names).toContain(filtered);
    }
  });

  it('marks every non-binary file viewable, and never a directory', async () => {
    const result: any = await listDir(root, '', { showHidden: true });
    const byName = Object.fromEntries(result.entries.map((e: any) => [e.name, e]));
    expect(byName['README.md'].viewable).toBe(true);
    // The change this feature exists for: source files are now openable.
    expect(byName['index.ts'].viewable).toBe(true);
    expect(byName['.env'].viewable).toBe(true);
    expect(byName['docs'].viewable).toBe(false);
    const docs: any = await listDir(root, 'docs');
    expect(docs.entries.find((e: any) => e.name === 'guide.markdown').viewable).toBe(true);
  });

  it('never marks a binary file viewable', async () => {
    fs.writeFileSync(path.join(root, 'logo.png'), 'x');
    const result: any = await listDir(root, '');
    const logo = result.entries.find((e: any) => e.name === 'logo.png');
    expect(logo.viewable).toBe(false);
  });

  // Explicit timeout: this writes 2005 files and then lstats every one of them,
  // and it runs alongside the rest of the suite. The 15s global default is
  // enough in isolation (~2s) but not always under full parallel load, and a
  // timeout here reads exactly like a real truncation regression.
  it('truncates at MAX_ENTRIES', async () => {
    const big = path.join(root, 'big');
    fs.mkdirSync(big, { recursive: true });
    for (let i = 0; i < MAX_ENTRIES + 5; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), '');
    const r: any = await listDir(root, 'big');
    expect(r.truncated).toBe(true);
    expect(r.entries.length).toBe(MAX_ENTRIES);
  }, 60000);

  it('returns not_found and not_a_directory distinctly', async () => {
    expect(err(await listDir(root, 'nope'))).toBe('not_found');
    expect(err(await listDir(root, 'README.md'))).toBe('not_a_directory');
  });

  it('maps EACCES to denied rather than read_failed', async () => {
    fs.mkdirSync(path.join(root, 'denied-probe'), { recursive: true });
    const realReaddir = fs.promises.readdir;
    (fs.promises as any).readdir = async () => {
      const e: any = new Error('permission denied'); e.code = 'EACCES'; throw e;
    };
    try {
      expect(err(await listDir(root, 'denied-probe'))).toBe('denied');
    } finally {
      (fs.promises as any).readdir = realReaddir;
    }
  });
});

// ─── Shell-action deny-list ──────────────────────────────────────────────────
// The one list in this module that IS a security boundary rather than a UX
// filter: `shell.openPath` on these RUNS them, and the jail bounds only which
// file can be named, not what Windows does once it opens it.

describe('isExecutablePath', () => {
  it('refuses programs, installers and script hosts', async () => {
    const { isExecutablePath } = await import('../../src/main/explorer-fs');
    for (const name of ['setup.exe', 'a.BAT', 'deploy.ps1', 'x.cmd', 'evil.vbs',
                        'run.js', 'thing.hta', 'add.reg', 'shortcut.lnk', 'app.msi']) {
      expect(isExecutablePath(name), name).toBe(true);
    }
  });

  it('refuses scripts whose association is an interpreter on a dev machine', async () => {
    const { isExecutablePath } = await import('../../src/main/explorer-fs');
    // A .py opens an editor on one machine and RUNS on the next, depending only
    // on what the Python installer did to HKCR. A guard whose outcome depends on
    // the victim's file associations is not a guard.
    for (const name of ['build.py', 'gui.pyw', 'task.rb', 'old.pl', 'index.php',
                        'init.lua', 'macro.ahk', 'setup.sh', 'run.bash']) {
      expect(isExecutablePath(name), name).toBe(true);
    }
  });

  it('refuses files whose DEFAULT VERB executes what they contain or point at', async () => {
    const { isExecutablePath } = await import('../../src/main/explorer-fs');
    // The group that names no interpreter and is not a program, so reading the
    // list extension-by-extension never reaches it: Windows hands each of these
    // to a component that runs its contents or fetches its target.
    for (const name of ['help.chm', 'launch.appref-ms', 'setup.application', 'fix.diagcab',
                        'addin.xll', 'query.iqy', 'comp.wsc', 'comp.sct',
                        'thing.settingcontent-ms', 'share.library-ms', 'link.website',
                        'driver.inf', 'pkg.msix', 'pkg.appinstaller', 'archive.pyz']) {
      expect(isExecutablePath(name), name).toBe(true);
    }
  });

  it('allows ordinary source and data files', async () => {
    const { isExecutablePath } = await import('../../src/main/explorer-fs');
    for (const name of ['index.ts', 'main.rs', 'App.tsx', 'README.md', 'data.json',
                        'logo.png', 'report.pdf', 'Makefile', '.gitignore', 'notes.txt']) {
      expect(isExecutablePath(name), name).toBe(false);
    }
  });

  it('is case-insensitive and extension-anchored, not a substring match', async () => {
    const { isExecutablePath } = await import('../../src/main/explorer-fs');
    expect(isExecutablePath('Setup.EXE')).toBe(true);
    expect(isExecutablePath('exe-notes.md')).toBe(false);
    expect(isExecutablePath('')).toBe(false);
  });
});
