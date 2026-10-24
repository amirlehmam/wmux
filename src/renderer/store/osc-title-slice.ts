import { StateCreator } from 'zustand';

/**
 * surfaceId → the OSC 0/2 window title the pane's program last set (issue #221).
 *
 * xterm has always parsed these and wmux has captured them since the detection
 * work landed, but the only consumer was agent detection: a pane whose program
 * was actively announcing what it was doing still showed a tab named after its
 * directory. This is the store half that lets the tab bar read it.
 *
 * Deliberately NOT a field on `SurfaceRef`. That type is what goes into
 * `session.json` — the split tree is persisted very nearly verbatim — so a
 * title parked there would come back after a restart on a fresh shell that has
 * set no title at all, labelling a plain `pwsh` pane with whatever the program
 * that used to live in it was doing when the window was last closed. A sibling
 * map is live-only by construction rather than by remembering to strip a field
 * in `freezeSurfaceCwds`, `saveCurrentLayoutAsPreset` and `handleSaveSession`.
 *
 * It stays renderer-local for the reason the capture map already gave: a title
 * is arbitrary process-controlled text with no reason to cross into main.
 */

/**
 * Longest title kept, in characters.
 *
 * A limit, not a display hint — the tab bar truncates for layout separately.
 * A title is chrome; anything longer is a program misusing OSC.
 */
export const MAX_OSC_TITLE_CHARS = 256;

/**
 * Surfaces tracked at once.
 *
 * The primary bound is the teardown at `SURFACE_CLOSED_EVENT`, which forgets a
 * pane's title when the pane goes. This is the backstop for the paths that
 * reach no teardown at all — the same reason `prompt-slice` and
 * `surfaceBufferCache` carry one.
 */
export const MAX_OSC_TITLE_SURFACES = 64;

export interface OscTitleEntry {
  title: string;
  /** When it was written. Only read to decide what to evict. */
  at: number;
}

/**
 * Clamp and flatten a title on its way in from the pane's program.
 *
 * Three separate jobs, and the middle one is the security-relevant one:
 *
 * 1. A tab is ONE line high, so newlines and tabs become spaces rather than
 *    truncating the label at the first of them.
 * 2. C0/C1 controls and bidi overrides are removed. U+202E (RTL override) does
 *    not just reverse its own tab — it reorders everything drawn after it, so a
 *    program that sets one rewrites the layout of chrome it was never given.
 *    The isolates (U+2066-U+2069) are stripped for the same reason. Plain
 *    marks (U+200E/U+200F) are left alone: they are ordinary content in real
 *    RTL titles and they do not escape their own run.
 * 3. Length is capped.
 *
 * Which of those three is load-bearing was settled by running the real xterm
 * against real OSC bytes rather than by reading its source, because a fake
 * terminal in a unit test would have agreed with whatever this function did:
 *
 *   - xterm STRIPS C0 itself. `ESC ] 2 ; build LF failed BEL` arrives here as
 *     "buildfailed" — the newline is already gone, so the whitespace collapse
 *     never sees one and cannot put the space back.
 *   - a C1 control ABORTS the sequence: `ESC ] 2 ; a NEL b BEL` fires no
 *     onTitleChange at all, so the tab keeps its previous label.
 *   - xterm does NOT touch bidi. `safe U+202E evil` arrives intact, and the
 *     strip on this line is the only thing standing between a pane's program
 *     and the layout of the whole tab strip.
 *
 * So (2) is defence in depth for the controls and the actual defence for bidi.
 * Both OSC 0 and OSC 2 fire the callback, which is why the feature has an
 * off switch: Git for Windows' default profile sets OSC 0 to its full path.
 *
 * An empty result is meaningful: it is the signal to CLEAR the surface's title,
 * so a program that blanks its own title hands the tab back to its cwd label.
 */
export function normalizeOscTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_OSC_TITLE_CHARS);
}

/**
 * Is this the title Windows gives a console by DEFAULT, rather than one a
 * program chose (issue #286)?
 *
 * A Windows console starts out titled with the full path of the executable it
 * was launched from, and an elevated one prefixes that with a LOCALISED
 * "Administrator: " ("Administrateur : ", "管理员: " …). ConPTY forwards that
 * title as OSC 0 like any other, so with #221's title-as-tab-label every pwsh
 * pane in an elevated wmux was captioned
 * `Administrator: C:\Program Files\WindowsApps\Microsoft.PowerShell_…\pwsh.exe`
 * — and each tab first showed its folder, then "reverted" to that the moment
 * the shell's title arrived. It names no program activity, only the binary, so
 * it must not outrank the cwd label: treat it as "no title".
 *
 * Narrow on purpose: only an absolute Windows path (or a bare file name) ending
 * in an executable extension, behind at most one short "<word(s)>:" prefix. A
 * title a program actually sets — "✳ Claude Code", "vim README.md",
 * Git Bash's "MINGW64:/c/repo" — never looks like that.
 */
export function isConsoleDefaultTitle(title: string): boolean {
  const rest = title.replace(/^[^:\\/]{1,40}:\s*(?=[A-Za-z]:\\|\\\\)/, '');
  return /^(?:[a-z]:\\|\\\\)?[^"*?<>|:/]*\.(?:exe|com|cmd|bat)$/i.test(rest);
}

/**
 * One leading status-glyph token: a run of one to three characters that are
 * neither letters, digits nor spaces, followed by a space or by the end of the
 * title. Claude Code puts `✳` there when idle and `◐ ◑ ◒ ◓` (braille frames in
 * older builds) while it works. Any short run of symbols rather than a list of
 * frames, so the next agent's spinner needs no entry here; a title that starts
 * with a letter or a digit (`MINGW64:/c/repo`, `(1) Inbox`) never matches.
 */
const STATUS_GLYPH_PREFIX = /^[^\p{L}\p{N}\s]{1,3}(?:\s+|$)/u;

/**
 * A window title without the status glyph an agent animates in front of it (#343).
 *
 * The workspace NAME reads titles through this, so a spinner frame — up to five
 * store writes a second while an agent works — does not rename the workspace
 * and re-render everything that names it. A title that is only a glyph answers
 * empty, which callers treat as "no title". The tab label keeps the raw title:
 * there the glyph is the pane's live status.
 */
export function stripStatusGlyph(title: string): string {
  return title.replace(STATUS_GLYPH_PREFIX, '');
}

/**
 * Drop the least recently written surfaces once the map is over budget.
 *
 * Returns the input untouched when it fits, so the common path allocates
 * nothing and the store's identity check can short-circuit a re-render.
 */
export function evictOscTitles(map: Record<string, OscTitleEntry>): Record<string, OscTitleEntry> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_OSC_TITLE_SURFACES) return map;
  const keep = keys
    .sort((a, b) => map[b].at - map[a].at)
    .slice(0, MAX_OSC_TITLE_SURFACES);
  const next: Record<string, OscTitleEntry> = {};
  for (const key of keep) next[key] = map[key];
  return next;
}

export interface OscTitleSlice {
  /** surfaceId → its last window title. Absent key = the program has set none. */
  oscTitles: Record<string, OscTitleEntry>;
  /**
   * Record a title. Pass an empty one to clear.
   *
   * A repeat of the title already stored is a NO-OP that returns the same state
   * object, so it costs no re-render. That matters more than it looks: several
   * shells re-emit an unchanged title on every prompt, and the tab bar
   * subscribes to this map.
   */
  setOscTitle(surfaceId: string, title: string): void;
  /** Forget a surface's title, when its pane is destructively closed. */
  clearOscTitle(surfaceId: string): void;
}

export const createOscTitleSlice: StateCreator<OscTitleSlice, [], [], OscTitleSlice> = (set) => ({
  oscTitles: {},

  setOscTitle(surfaceId: string, title: string): void {
    if (!surfaceId) return;
    const normalized = normalizeOscTitle(title);
    set((state) => {
      const current = state.oscTitles[surfaceId];
      if (!normalized) {
        if (!current) return state;
        const rest = { ...state.oscTitles };
        delete rest[surfaceId];
        return { oscTitles: rest };
      }
      if (current?.title === normalized) return state;
      return {
        oscTitles: evictOscTitles({ ...state.oscTitles, [surfaceId]: { title: normalized, at: Date.now() } }),
      };
    });
  },

  clearOscTitle(surfaceId: string): void {
    set((state) => {
      if (!state.oscTitles[surfaceId]) return state;
      const rest = { ...state.oscTitles };
      delete rest[surfaceId];
      return { oscTitles: rest };
    });
  },
});
