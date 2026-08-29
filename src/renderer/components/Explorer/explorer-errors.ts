// ─── Explorer / code viewer: error code → translation key ────────────────────
// One table, two readings of it. Both surfaces answer in ExplorerErrorCode, so
// the mapping was being written twice — once as a typed record in CodePane and
// once as a `t(\`explorer.error.${code}\` as any)` template in the panel, which
// type-checks nothing and would have kept compiling if a code were renamed.
//
// The two readings differ because the same code means a different noun on each
// side: the panel is listing a FOLDER, the code pane is opening a FILE, so
// `not_found` is "Folder not found" in one and "File not found" in the other.
// Only the codes where that distinction is visible get an override; everything
// else shares the explorer's wording.

import type { TranslationKey } from '../../i18n';
import type { ExplorerErrorCode } from '../../../shared/types';

const EXPLORER_ERROR_KEY: Record<ExplorerErrorCode, TranslationKey> = {
  no_root: 'explorer.error.no_root',
  remote: 'explorer.error.remote',
  invalid_path: 'explorer.error.invalid_path',
  outside_root: 'explorer.error.outside_root',
  not_found: 'explorer.error.not_found',
  not_a_directory: 'explorer.error.not_a_directory',
  binary: 'explorer.error.binary',
  executable: 'explorer.error.executable',
  too_large: 'explorer.error.too_large',
  denied: 'explorer.error.denied',
  read_failed: 'explorer.error.read_failed',
  // Write-side codes. They cannot arise from a listing, but the record is
  // exhaustive over ExplorerErrorCode by type — which is the point: adding a
  // code to the union without a message a user can read is a compile error, not
  // a string that renders as `write_failed` in the pane.
  not_granted: 'code.error.not_granted',
  conflict: 'code.error.conflict',
  write_failed: 'code.error.write_failed',
};

/** Codes whose explorer wording says "folder" where the code pane means a file. */
const CODE_OVERRIDE: Partial<Record<ExplorerErrorCode, TranslationKey>> = {
  not_found: 'code.error.not_found',
  read_failed: 'code.error.read_failed',
};

export function explorerErrorKey(code: ExplorerErrorCode): TranslationKey {
  return EXPLORER_ERROR_KEY[code] ?? 'explorer.error.read_failed';
}

export function codeErrorKey(code: ExplorerErrorCode): TranslationKey {
  return CODE_OVERRIDE[code] ?? explorerErrorKey(code);
}
