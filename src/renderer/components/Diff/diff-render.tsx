/**
 * Unified-diff parsing and the hunk view, shared by the Diff tab and the
 * project Git view (#362) so a diff looks — and parses — the same in both.
 */
import React from 'react';

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldNum?: number;
  newNum?: number;
}

export interface DiffHunk {
  header: string;
  context: string;
  lines: DiffLine[];
}

const HEADER_PREFIXES = ['diff --git', 'index ', '---', '+++', 'new file', 'deleted file', 'similarity index', 'rename from', 'rename to', 'old mode', 'new mode'];
// Anchored, with non-optional groups: the loose `,?\d*` form backtracks
// super-linearly on a crafted `@@` line.
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Append one body line to `hunk`, advancing the line counters it owns. */
function pushBodyLine(hunk: DiffHunk, line: string, nums: { old: number; new: number }): void {
  if (line.startsWith('+')) {
    hunk.lines.push({ type: 'add', content: line.slice(1), newNum: nums.new++ });
  } else if (line.startsWith('-')) {
    hunk.lines.push({ type: 'remove', content: line.slice(1), oldNum: nums.old++ });
  } else if (line.startsWith(' ') || line === '') {
    const content = line.startsWith(' ') ? line.slice(1) : '';
    hunk.lines.push({ type: 'context', content, oldNum: nums.old++, newNum: nums.new++ });
  }
}

export function parseDiff(raw: string): DiffHunk[] {
  if (!raw) return [];
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  const nums = { old: 0, new: 0 };

  // The output's own trailing newline is not a blank context line — git writes
  // a blank context line as a single space — so it must not become a row.
  for (const line of raw.replace(/\r?\n$/, '').split('\n')) {
    if (!currentHunk && HEADER_PREFIXES.some(p => line.startsWith(p))) continue;
    if (line.startsWith('diff --git')) { currentHunk = null; continue; }

    if (line.startsWith('@@')) {
      const match = HUNK_HEADER.exec(line);
      if (match) {
        nums.old = Number.parseInt(match[1], 10);
        nums.new = Number.parseInt(match[2], 10);
        currentHunk = { header: line, context: match[3]?.trim() || '', lines: [] };
        hunks.push(currentHunk);
      }
      continue;
    }

    if (currentHunk) pushBodyLine(currentHunk, line, nums);
  }

  return hunks;
}

const LINE_PREFIX: Record<DiffLine['type'], string> = {
  add: '+',
  remove: '-',
  context: ' ',
};

/**
 * The hunks of one file, in the Diff tab's markup and styles.
 *
 * Wrapped in one `.diff-hunks` box sized to the widest line (diff.css), so every
 * row's add/remove tint reaches the end of the longest line when the view is
 * scrolled sideways, rather than stopping at the viewport's width (#441).
 */
export function DiffHunks({ hunks }: Readonly<{ hunks: DiffHunk[] }>) {
  return (
    <div className="diff-hunks">
      {hunks.map((hunk, hi) => (
        <div key={hi} className="diff-hunk">
          <div className="diff-hunk__header">
            {hunk.header}
            {hunk.context && (
              <span className="diff-hunk__context"> {hunk.context}</span>
            )}
          </div>
          {hunk.lines.map((line, li) => (
            <div key={li} className={`diff-line diff-line--${line.type}`}>
              <span className="diff-line__gutter diff-line__gutter--old">
                {line.type === 'add' ? '' : line.oldNum}
              </span>
              <span className="diff-line__gutter diff-line__gutter--new">
                {line.type === 'remove' ? '' : line.newNum}
              </span>
              <span className="diff-line__prefix">{LINE_PREFIX[line.type]}</span>
              <pre className="diff-line__content">{line.content || ' '}</pre>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
