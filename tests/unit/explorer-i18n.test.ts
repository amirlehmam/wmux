import { describe, it, expect } from 'vitest';
import { DICTIONARIES, SUPPORTED_LANGUAGES, type TranslationKey } from '../../src/renderer/i18n';
import { en } from '../../src/renderer/i18n/locales/en';
import {
  explorerErrorKey, codeErrorKey,
} from '../../src/renderer/components/Explorer/explorer-errors';
import type { ExplorerErrorCode } from '../../src/shared/types';

// The explorer and the code viewer are the two surfaces that speak
// ExplorerErrorCode. Two things have to stay true and neither is visible at a
// glance: every code has a translation key, and every key exists in every
// shipped locale. The panel used to build its keys with
// `t(\`explorer.error.${code}\` as any)`, which type-checks nothing — a renamed
// code would have compiled and rendered the raw slug at a user.

const CODES: ExplorerErrorCode[] = [
  'no_root', 'remote', 'invalid_path', 'outside_root', 'not_found',
  'not_a_directory', 'binary', 'executable', 'too_large', 'denied', 'read_failed',
  // Write-side codes. A save failure the user cannot read is worse than a read
  // failure they cannot read: they are holding edits at the time.
  'not_granted', 'conflict', 'write_failed',
];

describe('explorer error keys', () => {
  it('maps every ExplorerErrorCode to a key English actually defines', () => {
    for (const code of CODES) {
      expect(en[explorerErrorKey(code) as keyof typeof en], code).toBeTruthy();
      expect(en[codeErrorKey(code) as keyof typeof en], code).toBeTruthy();
    }
  });

  it('gives the code viewer file wording where the explorer says folder', () => {
    // Same code, different noun — the code pane was showing "Folder not found"
    // for a missing file, and "Could not read the folder" for a failed read.
    expect(explorerErrorKey('not_found')).toBe('explorer.error.not_found');
    expect(codeErrorKey('not_found')).toBe('code.error.not_found');
    expect(codeErrorKey('read_failed')).toBe('code.error.read_failed');
    // Everything else shares one wording rather than duplicating it.
    expect(codeErrorKey('denied')).toBe(explorerErrorKey('denied'));
  });
});

describe('explorer translations', () => {
  const KEYS: TranslationKey[] = [
    'shortcutAction.toggleExplorer', 'surfaceLabel.code',
    'explorer.title', 'explorer.refresh', 'explorer.showHidden', 'explorer.hideHidden',
    'explorer.close', 'explorer.empty', 'explorer.truncated', 'explorer.notViewable',
    'explorer.copyPath', 'explorer.reveal', 'explorer.openInApp',
    ...CODES.map((c) => explorerErrorKey(c)),
    'code.error.not_found', 'code.error.read_failed',
    // Change counts in the tree.
    'explorer.changedFiles',
    'explorer.baselineGit', 'explorer.baselineGitHint',
    'explorer.baselineSnapshot', 'explorer.baselineSnapshotHint',
    // Editing the code surface.
    'code.edit', 'code.readOnlyHint', 'code.save', 'code.revert',
    'code.unsaved', 'code.reload', 'code.conflictBody',
  ];

  it('ships every explorer string in every language, not just en/fr', () => {
    const missing: string[] = [];
    for (const lang of SUPPORTED_LANGUAGES) {
      const dict = DICTIONARIES[lang];
      for (const key of KEYS) {
        if (!dict?.[key]) missing.push(`${lang}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps the {count} placeholder, which the panel substitutes at render', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(DICTIONARIES[lang]?.['explorer.truncated'], lang).toContain('{count}');
      // Same substitution, second string. A translation that drops the
      // placeholder renders a totals bar reading "changed" with no number —
      // which looks like a rendering bug rather than a translation one, so it
      // is worth failing the build over.
      expect(DICTIONARIES[lang]?.['explorer.changedFiles'], lang).toContain('{count}');
    }
  });
});
