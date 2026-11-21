import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Which remote calls are polls. ipc-handlers.ts needs Electron, so (as
 * ssh-explorer-wiring.test.ts does) its wiring is pinned at the source: a
 * handler that forgot `runForPoll` would run a timer's spawns as a person's, and
 * the renderer's flag would reach nothing.
 */
const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
const handlers = read('src/main/ipc-handlers.ts');

function handlerBody(channel: string): string {
  const start = handlers.indexOf(`IPC_CHANNELS.${channel},`);
  expect(start, channel).toBeGreaterThan(-1);
  const next = handlers.indexOf('ipcMain.handle(', start);
  return handlers.slice(start, next < 0 ? undefined : next);
}

describe('the poll flag in main', () => {
  it.each([
    ['DIFF_GET_FILES', 'remoteChangedFiles'],
    ['DIFF_GET_DIFF', 'remoteFileDiff'],
  ])('%s runs the remote call as a poll when told to', (channel, fn) => {
    expect(handlerBody(channel)).toMatch(new RegExp(`runForPoll\\(poll, \\(\\) => ${fn}\\(`));
  });

  it('EXPLORER_DIFF_STATS passes the flag to the remote branch', () => {
    expect(handlerBody('EXPLORER_DIFF_STATS')).toContain('remoteDiffStats(remote, poll)');
    expect(handlers).toMatch(/runForPoll\(poll, \(\) =>\s+runWithSshGit/);
  });

  it('GIT_VIEW runs the remote and the local request as a poll when told to', () => {
    const body = handlerBody('GIT_VIEW');
    expect(body).toMatch(/runForPoll\(poll, \(\) => handleGitView\(request, \{ target: located\.target \}\)\)/);
    expect(body).toContain('return runForPoll(poll, () => handleGitView(request));');
  });
});

describe('an agent edit signal in main', () => {
  const index = read('src/main/index.ts');

  it('puts every ssh workspace\'s polls back to full cadence, from both places that push a diff update', () => {
    const push = index.slice(index.indexOf('function pushDiffUpdate'), index.indexOf('/** The `hook.event` fields'));
    expect(push).toContain('noteAgentEdit();');
    const refresh = index.slice(index.indexOf("case 'diff.refresh'"), index.indexOf("respond({ ok: true });", index.indexOf("case 'diff.refresh'")));
    expect(refresh).toContain('noteAgentEdit();');
  });
});
