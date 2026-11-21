/**
 * The identity a remote file has in the renderer, `ssh://<host>/<absolute path>`: not a local path and
 * unable to resolve to one (main/ssh-command.ts builds it). Main and the renderer both tell it from a local path.
 */
export const REMOTE_IDENTITY_PREFIX = 'ssh://';

/** True for the identity a remote file has in the renderer. Anything else is a local path. */
export function isRemoteIdentity(filePath: unknown): filePath is string {
  return typeof filePath === 'string' && filePath.startsWith(REMOTE_IDENTITY_PREFIX);
}
