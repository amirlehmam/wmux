import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** `git <args>` in `cwd` with a fixed author and committer, so a commit never asks who you are. Returns stdout. */
export const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
  cwd, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).toString();

/** A new temporary directory, resolved through symlinks (macOS /var, Windows 8.3 names) so paths compare equal. */
export function makeTmpDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
