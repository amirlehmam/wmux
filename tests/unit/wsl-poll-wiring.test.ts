import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Which local calls are polls. ipc-handlers.ts needs Electron, so (as ssh-poll-wiring.test.ts
 * does) its wiring is pinned at the source: a handler that forgot `runForPoll` would run a timer's
 * work on a WSL folder as a person's, and the renderer's flag would reach nothing. A folder that
 * is not on a WSL share ignores the flag, so passing it on for every folder changes nothing there.
 */
const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
const handlers = read('src/main/ipc-handlers.ts');

function handlerBody(channel: string): string {
  const start = handlers.indexOf(`IPC_CHANNELS.${channel},`);
  expect(start, channel).toBeGreaterThan(-1);
  const next = handlers.indexOf('ipcMain.handle(', start);
  return handlers.slice(start, next < 0 ? undefined : next);
}

describe('the poll flag reaches the local providers', () => {
  it.each([
    ['DIFF_GET_FILES', 'getChangedFiles'],
    ['DIFF_GET_DIFF', 'getFileDiff'],
    ['EXPLORER_DIFF_STATS', 'getChangedFilesWithBaseline'],
    ['GIT_VIEW', 'handleGitView'],
  ])('%s runs the local call as a poll when told to', (channel, fn) => {
    expect(handlerBody(channel)).toMatch(new RegExp(`runForPoll\\(poll, \\(\\) => ${fn}\\(`));
  });
});

describe('a save into a WSL folder starts its polls over', () => {
  it.each(['CODE_WRITE_FILE', 'MARKDOWN_SAVE_FILE', 'MARKDOWN_SAVE_AS'])('%s tells the snapshot layer', (channel) => {
    expect(handlerBody(channel)).toContain('noteWslWrite(');
  });
});
