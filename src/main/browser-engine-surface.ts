/**
 * Which browser surface does a `browser.get_engine` / `browser.set_engine`
 * caller mean?
 *
 * `wmux browser engine [web|agent] [--surface <id>]` carries its surface in
 * `params.caller` — the same slot every other browser verb uses — so the caller
 * is sometimes a TERMINAL (resolve it to the browser pane that terminal drives,
 * per the per-caller binding of issue #62) and sometimes a BROWSER surface
 * itself, which is what `--surface <id>` sends.
 *
 * Lives in its own module rather than beside its only caller in `index.ts`
 * because importing that file executes the whole Electron app bootstrap, so the
 * precedence below could not otherwise be tested.
 */

export type BrowserSurfacePick =
  | { kind: 'found'; surfaceId: string }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

/**
 * Pure precedence. `existing` is every browser surface in the caller's
 * workspace.
 *
 * The caller-is-a-browser-surface case must win OUTRIGHT, ahead of the
 * single-pane shortcut. Found live during the 2.1.0 smoke test: only the
 * terminal case was handled, so `--surface <browser-surface>` fell through to
 * the workspace scan, a second browser pane made the answer `ambiguous`, and the
 * error told the user to pass `--surface` — which is exactly what they had just
 * done. The flag was unusable in the one situation it exists for.
 *
 * `ambiguous` for a terminal caller with several browser panes is deliberate:
 * guessing would flip a DIFFERENT agent's browser, the cross-talk that #62's
 * per-caller binding exists to prevent.
 */
export function pickBrowserSurface(caller: string, existing: string[]): BrowserSurfacePick {
  if (existing.includes(caller)) return { kind: 'found', surfaceId: caller };
  if (existing.length === 1) return { kind: 'found', surfaceId: existing[0] };
  if (existing.length > 1) return { kind: 'ambiguous' };
  return { kind: 'none' };
}
