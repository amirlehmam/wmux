/**
 * The changed file an agent's edit hook is talking about.
 *
 * The hook reports the file as an ABSOLUTE path in the agent's own file system (`tool_input.file_path`). That is
 * not the path the Diff tab asks for: git prints paths relative to the checkout, and the two roots need not even
 * be the same directory. A devbox session edits `/workspaces/<repo>/a.ts` inside its container while the workspace's
 * ssh target is the checkout on the devbox host (`/home/<user>/.../<repo>`), and a Windows pane reports `C:\repo\a.ts`
 * for a checkout wmux may know under another spelling. So the hook's path is matched against the list of changed
 * files, never handed on: the answer is always a path git itself printed, so it stays inside the checkout.
 */

/**
 * The listed file whose path is the end of `hookFile` (at a path segment, backslashes read as separators), the
 * longest when several are, or null when none is. A folder entry (`docs/`, git's `-unormal` for an untracked
 * folder) is never a match: it names no one file.
 */
export function pickHookFile(files: readonly { path: string }[], hookFile: unknown): string | null {
  if (typeof hookFile !== 'string' || hookFile === '') return null;
  const named = hookFile.replace(/\\/g, '/');
  let best: string | null = null;
  for (const { path } of files) {
    if (path === '' || path.endsWith('/')) continue;
    const listed = path.replace(/\\/g, '/');
    if (named !== listed && !named.endsWith(`/${listed}`)) continue;
    if (best === null || path.length > best.length) best = path;
  }
  return best;
}
