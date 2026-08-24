/**
 * shell-quote.ts — quoting for paths that get typed into a terminal.
 *
 * The same path can go to either side of an ssh connection and the two need
 * different quoting: a local pane is a Windows shell, a remote one is sh/bash.
 * Getting it backwards produces a path that looks right on screen and fails
 * the moment it is used.
 */

/**
 * Quote a path for a Windows shell, as the file-drop path has done since
 * issue #33: wrap in double quotes only when the path contains whitespace, so
 * the common case stays visually clean.
 */
export function windowsTerminalQuote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * Quote a path for a POSIX shell. Always quoted, never conditionally: the value
 * is going to a host whose filesystem conventions we do not know, and a single
 * quote is the only construct in sh with no escapes inside it at all.
 */
export function posixShellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}
