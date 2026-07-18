/**
 * Strip trailing spaces/tabs from every line of copied terminal text.
 *
 * ConPTY repaints lines padded to the full terminal width with real space
 * characters, so xterm's getSelection() returns them verbatim — it cannot
 * tell a typed space from pad cells (issue #102). Windows Terminal trims
 * line-end whitespace on copy for the same reason; we match that behavior.
 * Line separators (\n or \r\n) are preserved as-is.
 */
export function trimTrailingWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const hasCR = line.endsWith('\r');
      let end = hasCR ? line.length - 1 : line.length;
      while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
      return hasCR ? line.slice(0, end) + '\r' : line.slice(0, end);
    })
    .join('\n');
}
