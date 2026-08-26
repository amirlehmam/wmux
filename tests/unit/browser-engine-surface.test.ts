import { describe, it, expect } from 'vitest';
import { pickBrowserSurface } from '../../src/main/browser-engine-surface';

/**
 * `wmux browser engine [web|agent] [--surface <id>]` carries its surface in
 * `params.caller`, the same slot every other browser verb uses. So the caller is
 * sometimes a terminal (resolve it to the browser pane it drives) and sometimes
 * a browser surface itself (`--surface` was passed explicitly).
 *
 * Found live during the 2.1.0 smoke test: only the terminal case was handled, so
 * `--surface <browser-surface>` fell through to the workspace scan, a second
 * browser pane made it ambiguous, and the error asked the user to pass
 * `--surface` — which is what they had just done.
 */
describe('pickBrowserSurface', () => {
  const A = 'surf-aaaaaaaa-0000-0000-0000-000000000000';
  const B = 'surf-bbbbbbbb-0000-0000-0000-000000000000';
  const TERM = 'surf-cccccccc-0000-0000-0000-000000000000';

  it('uses the caller itself when it IS a browser surface', () => {
    expect(pickBrowserSurface(A, [A, B])).toEqual({ kind: 'found', surfaceId: A });
  });

  it('picks the caller even when another browser pane exists — the regression', () => {
    // Two browser panes used to mean `ambiguous` regardless of who was asking.
    expect(pickBrowserSurface(B, [A, B])).toEqual({ kind: 'found', surfaceId: B });
  });

  it('resolves a terminal caller to the workspace\'s only browser pane', () => {
    expect(pickBrowserSurface(TERM, [A])).toEqual({ kind: 'found', surfaceId: A });
  });

  it('refuses to guess for a terminal caller with two browser panes', () => {
    // Guessing here would flip a different agent's browser (issue #62).
    expect(pickBrowserSurface(TERM, [A, B])).toEqual({ kind: 'ambiguous' });
  });

  it('reports none when the workspace has no browser pane', () => {
    expect(pickBrowserSurface(TERM, [])).toEqual({ kind: 'none' });
  });

  it('prefers the caller over a single unrelated browser pane', () => {
    // Both rules could fire; the explicit one must win, or `--surface` is
    // silently ignored whenever exactly one other browser pane exists.
    expect(pickBrowserSurface(A, [A])).toEqual({ kind: 'found', surfaceId: A });
  });
});
