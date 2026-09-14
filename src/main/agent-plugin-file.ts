/**
 * The version marker wmux stamps into every plugin/extension file it installs
 * into another program's config directory, and the two decisions that depend
 * on it.
 *
 * There are now two of these — the OpenCode plugin (#149/#191) and the pi
 * extension (#231) — and they need exactly the same two answers:
 *
 *   install  is the copy on disk a different version of OURS?
 *   remove   is the copy on disk ours at all?
 *
 * The second is the one that must not be reimplemented per agent. Removing a
 * file the user wrote under a name wmux happens to use is unrecoverable data
 * loss, and it is the kind of guard a second copy loses first: the copy written
 * for omp had already dropped `trimEnd()` from the block splice (see
 * agent-instructions.ts), which is the same failure mode with a cosmetic
 * consequence instead of a destructive one.
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
