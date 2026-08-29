import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ─── Wiring pins ─────────────────────────────────────────────────────────────
// Same tactic and same reason as explorer-state.test.ts's block: these are
// facts about how three modules are CONNECTED, and there is no seam to call.
// A unit test of each part passes while the parts are wired to the wrong thing.

const root = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');

const handlers = read('src/main/ipc-handlers.ts');
const preload = read('src/preload/index.ts');
const types = read('src/shared/types.ts');
const provider = read('src/main/diff-provider.ts');

describe('the write path is gated three times, not once', () => {
  const block = handlers.slice(
    handlers.indexOf('IPC_CHANNELS.CODE_WRITE_FILE'),
    handlers.indexOf('IPC_CHANNELS.EXPLORER_READ_MARKDOWN'),
  );

  it('resolves through the jail before anything else', () => {
    expect(block).toContain("resolveExplorerPath(surfaceId, relPath, event.sender, 'file')");
  });

  // The jail alone would hand a compromised renderer arbitrary write access
  // across the user's whole project — which is precisely what #210 refused.
  it('refuses a path that is not in this window\'s grant set', () => {
    expect(block).toContain('isFilePathGranted(event.sender.id, resolved.abs)');
    expect(block).toContain("code: 'not_granted'");
  });

  it('forwards the expected mtime so a stale write is refused', () => {
    expect(block).toContain('expectedMtimeMs');
    expect(block).toContain('writeCodeFile(');
  });

  // Order matters: the grant check must not run against a path the jail has not
  // resolved yet, or it would be checking a renderer-supplied string.
  it('checks the grant AFTER resolving, never before', () => {
    expect(block.indexOf('resolveExplorerPath'))
      .toBeLessThan(block.indexOf('isFilePathGranted'));
  });
});

describe('grants are minted only by the jailed reads', () => {
  it('code:read-file mints on success', () => {
    const block = handlers.slice(
      handlers.indexOf('IPC_CHANNELS.CODE_READ_FILE'),
      handlers.indexOf('IPC_CHANNELS.CODE_WRITE_FILE'),
    );
    expect(block).toContain("grantFilePath(event.sender.id, read.filePath)");
  });

  it('explorer:read-markdown keeps the extension whitelist AND mints', () => {
    const block = handlers.slice(
      handlers.indexOf('IPC_CHANNELS.EXPLORER_READ_MARKDOWN'),
      handlers.indexOf('IPC_CHANNELS.EXPLORER_DIFF_STATS'),
    );
    // The jail is ADDED to readMarkdownFile's whitelist, not swapped in for it.
    expect(block).toContain('resolveExplorerPath');
    expect(block).toContain('readMarkdownFile(resolved.abs)');
    expect(block).toContain('grantFilePath(event.sender.id, read.filePath)');
  });

  // The unjailed read takes a renderer-supplied absolute path. If it ever minted,
  // the renderer could mint its own grants and the whole set would mean nothing.
  it('markdown:read-file (unjailed, absolute path) still mints NOTHING', () => {
    const start = handlers.indexOf('IPC_CHANNELS.MARKDOWN_READ_FILE');
    const block = handlers.slice(start, start + 400);
    expect(block).not.toContain('grantFilePath');
  });
});

describe('the diff column asks main by surfaceId, never by cwd', () => {
  it('the preload exposes only a surfaceId', () => {
    expect(preload).toContain('diffStats: (surfaceId: string) =>');
    // A cwd parameter here would be the pre-#210 pattern the jail exists to
    // reject — the renderer does not get to say which folder to read.
    expect(preload).not.toContain('diffStats: (cwd');
  });

  it('main derives the root through the same gate the listing uses', () => {
    const block = handlers.slice(
      handlers.indexOf('IPC_CHANNELS.EXPLORER_DIFF_STATS'),
      handlers.indexOf('IPC_CHANNELS.EXPLORER_DIFF_STATS') + 900,
    );
    expect(block).toContain('explorerRootFor(surfaceId, event.sender)');
    expect(block).toContain('getChangedFilesWithBaseline(root.realRoot)');
  });

  it('reuses the existing provider rather than a second diff engine', () => {
    // Two providers would eventually disagree, and the user would be looking at
    // a DiffPane and a tree that describe the same folder differently.
    expect(provider).toContain('export async function getChangedFilesWithBaseline');
    expect(handlers).toContain("from './diff-provider'");
  });
});

// The shared type mirrors main's ChangedFile because `shared/` may not import
// from `main/`. Two hand-kept copies drift; this is the thing that notices.
describe('ExplorerDiffEntry mirrors diff-provider ChangedFile', () => {
  // Line-by-line rather than a `^\s*(\w+)\??:` sweep: leading `\s*` before a
  // capture is the backtracking shape, and there is no reason to run it over a
  // whole file when the body is already a list of lines.
  const fieldsOf = (src: string, iface: string): string[] => {
    const start = src.indexOf(`interface ${iface} {`);
    const body = src.slice(start, src.indexOf('}', start));
    return body
      .split('\n')
      .map((line) => /^(\w+)\??:/.exec(line.trim())?.[1])
      .filter((name): name is string => !!name)
      .sort();
  };

  it('declares the same fields in both files', () => {
    expect(fieldsOf(types, 'ExplorerDiffEntry')).toEqual(fieldsOf(provider, 'ChangedFile'));
  });

  it('agrees on the status values', () => {
    for (const status of ['modified', 'added', 'deleted', 'renamed']) {
      expect(types, status).toContain(`'${status}'`);
      expect(provider, status).toContain(`'${status}'`);
    }
  });
});

describe('the surface tab shows unsaved code edits', () => {
  const label = read('src/renderer/components/SplitPane/surface-label.ts');

  // A code surface used to be read-only and carried no dirty marker. Now that it
  // can be edited, an unsaved buffer on a tab the user is NOT looking at is
  // exactly the case the `•` exists for.
  it('marks a dirty code tab, not only a dirty markdown one', () => {
    const codeBranch = label.slice(label.indexOf("case 'code':"), label.indexOf("case 'prompts':"));
    expect(codeBranch).toContain('markdownDirty');
    expect(codeBranch).toContain('`• ${name}`');
  });
});
