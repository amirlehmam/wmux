/**
 * Shared ownership markers and version-based update checks for agent plugins.
 * Installers with embedded configuration, such as Pi's, compare full contents
 * for updates and use the marker only to establish ownership.
 * Never infer ownership from a filename: replacing or removing a user's own
 * file under the same name would be unrecoverable data loss.
 */

/**
 * `// wmux-plugin-version: N` anywhere in the file.
 *
 * Compared VERBATIM, never numerically: the marker is a source-level identity,
 * not an ordering. A downgrade has to reinstall too, and a marker that is not a
 * number at all (a branch name, a hash) must still work.
 */
export const PLUGIN_VERSION_RE = /wmux-plugin-version:\s*(\S+)/;

/**
 * Pure: compare embedded version markers to decide whether to re-install.
 *
 * An unversioned SOURCE always reinstalls — fail safe, because the alternative
 * is a source whose changes reach nobody. Note this is the direction that bit
 * #191: every broken install already had the old file on disk, so a plugin
 * change with no marker bump is invisible to every machine that needs it.
 */
export function pluginNeedsUpdate(src: string, target: string | null): boolean {
  if (target === null) return true;
  const s = src.match(PLUGIN_VERSION_RE)?.[1];
  const t = target.match(PLUGIN_VERSION_RE)?.[1];
  if (s === undefined) return true;
  return s !== t;
}

/** Is this file one wmux installed? The guard on every uninstall path. */
export function isWmuxPluginFile(contents: string): boolean {
  return PLUGIN_VERSION_RE.test(contents);
}
