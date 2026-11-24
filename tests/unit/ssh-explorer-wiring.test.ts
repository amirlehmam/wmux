import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * ipc-handlers.ts needs Electron and cannot be imported here, so the few facts about
 * its wiring that cannot be tested as behaviour are pinned at the source. The gates
 * themselves (who owns a surface, which window holds a grant, remote-before-local
 * order) are behavioural tests of ssh-access.ts; what is pinned here is only that
 * the handlers go through them, and that a handler that cannot be served remotely
 * refuses a remote surface instead of falling through to a local path that merely
 * shares its spelling.
 */
const source = fs.readFileSync(path.resolve(__dirname, '../../src/main/ipc-handlers.ts'), 'utf8');
const readRepo = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

function handlerBody(channel: string): string {
  const start = source.indexOf(`IPC_CHANNELS.${channel},`);
  expect(start, channel).toBeGreaterThan(-1);
  const next = source.indexOf('ipcMain.handle(', start);
  return source.slice(start, next < 0 ? undefined : next);
}

describe('remote explorer wiring in ipc-handlers.ts', () => {
  it.each(['EXPLORER_LIST_DIR', 'CODE_READ_FILE', 'CODE_WRITE_FILE', 'EXPLORER_READ_MARKDOWN', 'EXPLORER_DIFF_STATS'])(
    '%s answers through serveRemoteFirst, which asks the remote host before the local gate',
    (channel) => {
      const body = handlerBody(channel);
      expect(body).toContain('serveRemoteFirst(');
      expect(body).toContain('remoteTargetFor(surfaceId, event.sender)');
    },
  );

  it.each(['EXPLORER_REVEAL', 'EXPLORER_OPEN_IN_APP', 'TERMINAL_RESOLVE_FILE_LINK'])(
    '%s refuses a remote surface rather than act on a local path',
    (channel) => {
      const body = handlerBody(channel);
      const gate = body.indexOf('remoteTargetFor(');
      expect(gate, channel).toBeGreaterThan(-1);
      expect(body.slice(gate)).toContain('REMOTE_NOT_SUPPORTED');
      expect(gate).toBeLessThan(body.search(/explorerRootFor\(|resolveExplorerPath\(/));
    },
  );
});

describe('remote markdown save and reload wiring', () => {
  it('markdown:save-file resolves an ssh:// identity on the remote host BEFORE the local grant and writer', () => {
    const body = handlerBody('MARKDOWN_SAVE_FILE');
    const remote = body.indexOf('isRemoteIdentity(filePath)');
    expect(remote).toBeGreaterThan(-1);
    expect(remote).toBeLessThan(body.indexOf('isFilePathGranted(event.sender.id, filePath)'));
    expect(body.indexOf('saveRemoteMarkdown(')).toBeLessThan(body.indexOf('writeMarkdownFile('));
  });

  it('reload re-reads the remote file; stat, reveal and open-in-app refuse an ssh:// identity instead of touching the OS', () => {
    expect(handlerBody('MARKDOWN_READ_FILE')).toContain('readRemoteMarkdown(filePath, remoteMarkdownDeps(event.sender.id))');
    for (const channel of ['MARKDOWN_STAT_FILE', 'MARKDOWN_REVEAL', 'MARKDOWN_OPEN_IN_APP']) {
      const body = handlerBody(channel);
      const guard = body.indexOf('isRemoteIdentity(filePath)');
      expect(guard, channel).toBeGreaterThan(-1);
      expect(body.slice(guard), channel).toContain("code: 'remote'");
      expect(guard, channel).toBeLessThan(body.search(/statMarkdownFile\(|showItemInFolder|openPath/));
    }
  });

  it('the markdown pane disables reveal and open-in-app for an ssh:// file but keeps reload', () => {
    const pane = readRepo('src/renderer/components/Markdown/MarkdownPane.tsx');
    expect(pane).toContain('const isLocalFile = hasPath && !isRemoteIdentity(filePath);');
    expect(pane).toContain("t('markdown.reveal', 'Reveal in File Explorer'), enabled: isLocalFile");
    expect(pane).toContain("t('markdown.openInApp', 'Open in default app'), enabled: isLocalFile");
    expect(pane).toContain("t('markdown.reload', 'Reload from disk'), enabled: hasPath");
  });
});

describe('remote diff wiring', () => {
  it.each([
    ['DIFF_GET_FILES', 'getChangedFiles('],
    ['DIFF_GET_DIFF', 'getFileDiff('],
  ])('%s serves a remote surface from the target BEFORE running git on the renderer cwd', (channel, localCall) => {
    const body = handlerBody(channel);
    // The sender's own window only: another window's workspace cannot be named.
    expect(body).toContain('diffTargetFor(surfaceId, BrowserWindow.fromWebContents(event.sender))');
    expect(body.indexOf('if (target) return')).toBeGreaterThan(-1);
    expect(body.indexOf('if (target) return')).toBeLessThan(body.indexOf(localCall));
  });
});

describe('the explorer offers no local-path actions for a remote host', () => {
  it('main still refuses reveal and open-in-app for a remote surface (the backstop)', () => {
    for (const channel of ['EXPLORER_REVEAL', 'EXPLORER_OPEN_IN_APP']) {
      expect(handlerBody(channel)).toContain('REMOTE_NOT_SUPPORTED');
    }
  });
});

describe('remote git wiring', () => {
  it('git:view looks the surface up in the sender\'s window before it runs the request, locally or remotely', () => {
    const body = handlerBody('GIT_VIEW');
    expect(body).toContain('BrowserWindow.fromWebContents(event.sender)');
    expect(body).not.toContain('getAllWindows');
    expect(body.indexOf('senderLocationFor(')).toBeGreaterThan(-1);
    expect(body.indexOf('senderLocationFor(')).toBeLessThan(body.indexOf('handleGitView('));
  });
});
