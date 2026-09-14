/**
 * What the browser PANEL opens on when nobody has said (issue #232).
 *
 * ── The bug this exists to close ─────────────────────────────────────────────
 *
 * wmux shipped `https://github.com/amirlehmam/wmux` as `BrowserPane`'s default
 * parameter. With `openOnStartup` defaulting to true and no Start page
 * configured, that meant the browser panel opened on the project's own GitHub
 * repo on every launch, out of the box, for everybody.
 *
 * On its own that is merely rude. What made it a bug report is the second step:
 * the panel's `onUrlChange` fires for the INITIAL load too, and wrote whatever
 * loaded into `workspace.browserUrl`. So wmux laundered its own default into a
 * stored value indistinguishable from a user's choice — and from then on the
 * panel opened there regardless of settings, per workspace, forever. Verified on
 * a real install before writing this: two workspaces, both carrying
 * `"browserUrl": "https://github.com/amirlehmam/wmux"` in session.json, neither
 * ever typed by anyone.
 *
 * The third step is the one that got reported. The repo page puts an "Issues"
 * tab one click away, so a single click rewrote the stored value to
 * `.../wmux/issues` — and wmux then opened its own issue tracker on every launch
 * and every workspace switch. #232: "wmux regularly opens its GitHub Issues page
 * in an internal browser tab… at seemingly random times."
 *
 * ── Why the cleanup is read-time, and only for the PANEL ─────────────────────
 *
 * The stored value is now indistinguishable from a deliberate choice, so
 * something has to decide it was not one. A rev-gated one-shot migration (the
 * `promptDefaultRev` pattern) would work, but it needs a counter, a promotion
 * table and a write path to answer a question that is decidable from the URL
 * alone. Filtering at READ time is stateless, self-healing — the next navigation
 * overwrites the stored value through the normal path — and cannot fire twice.
 *
 * The blast radius is deliberately `workspace.browserUrl` and nothing else,
 * because that is the only URL wmux opens WITHOUT being asked. A browser surface
 * in the split tree exists because somebody made it, and its `surface.url` is
 * written directly by `openInWmuxBrowser` when a user clicks a link — so
 * applying this filter there would break the perfectly ordinary case of clicking
 * a link to wmux's own issue tracker and getting a blank pane.
 *
 * It does mean the panel's rule never expires, and that is a real cost: someone
 * who genuinely wants wmux's repo as their panel's page will not have it
 * REMEMBERED across launches. That is exactly the case the Start page setting
 * exists for, and `browserPrefs.defaultUrl` is deliberately NOT filtered — a
 * configured start page is a choice; a remembered one is an inference.
 */

/** A browser surface with nothing to show. Never a page on the internet. */
export const BROWSER_BLANK_PAGE = 'about:blank';

/**
 * The page wmux used to open by itself, and the prefix that catches wherever a
 * click from it lands (`/issues`, `/releases`, `/pulls`, …).
 *
 * Matched on host + path rather than by `startsWith` on the raw string, so
 * `http` vs `https`, a trailing slash, a `?utm=` or a `#readme` all resolve to
 * the same answer — and so a lookalike host (`github.com.example.test`) does not.
 */
const VENDOR_HOST = 'github.com';
const VENDOR_PATH = '/amirlehmam/wmux';

export function isVendorStartPage(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.hostname.toLowerCase() !== VENDOR_HOST) return false;
  let path = parsed.pathname.toLowerCase();
  // Trailing slashes trimmed with a loop rather than /\/+$/: that pattern
  // backtracks super-linearly, and this string comes off a user-editable
  // session file.
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path === VENDOR_PATH || path.startsWith(`${VENDOR_PATH}/`);
}

/**
 * The page the PANEL should reopen on for a workspace, or `''` for "nothing
 * remembered" — which lets the caller fall through to the configured Start page
 * and then to blank.
 *
 * `''` rather than `undefined` on purpose: the caller chains with `||`, which is
 * itself deliberate (#212 — a restored workspace stores `browserUrl: ''`, and
 * `??` treats that empty string as a value and defeats the fallback).
 */
export function rememberedPanelUrl(remembered: string | null | undefined): string {
  if (!remembered) return '';
  if (isVendorStartPage(remembered)) return '';
  return remembered;
}

/**
 * Is this URL worth storing as "where this surface was"?
 *
 * The blank page is not: it is what a surface shows when it has nowhere to be,
 * and persisting it would pin the surface blank across a restore. This is the
 * rule for a surface the user made; the panel adds one more condition below.
 */
export function shouldRememberUrl(url: string | null | undefined): url is string {
  return !!url && url !== BROWSER_BLANK_PAGE;
}

/**
 * The same question for the PANEL, which additionally refuses the vendor page.
 *
 * Refusing on the WRITE side is what stops new installs from ever acquiring the
 * value that `rememberedPanelUrl` has to clean up on old ones — the read-time
 * filter is for session files that already exist, this is so no more are made.
 */
export function shouldRememberPanelUrl(url: string | null | undefined): url is string {
  return shouldRememberUrl(url) && !isVendorStartPage(url);
}
