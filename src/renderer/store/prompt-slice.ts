import { StateCreator } from 'zustand';

/**
 * The per-surface prompt log (issue #207).
 *
 * All four ideas in that discussion — highlight the prompt, pin it, anchor the
 * view at the start of the answer, list the prompts as jump marks — are
 * consumers of ONE fact: where a user prompt starts. So there is one producer
 * of that fact and four independent views of it, rather than four detectors.
 *
 * Two boundary sources feed this, and they are ranked, not merged — the same
 * shape ssh-detect.ts uses for managed/reported/probed:
 *
 *   'agent' — Claude Code's UserPromptSubmit hook. Carries the prompt TEXT
 *             verbatim, which no amount of screen reading can recover once the
 *             agent's TUI has repainted over it. Authoritative.
 *   'shell' — OSC 133 semantic marks from wmux's shell integration. Carries a
 *             boundary but no text; the text is read back out of the terminal
 *             buffer between the B and C marks, locally, in the renderer.
 *
 * There is deliberately no third, heuristic source. wmux stopped guessing agent
 * state from screen scraping in 0.39.0 (issue #128) and this feature does not
 * reintroduce it: with neither source present the log stays empty and every
 * view is inert, which is the honest outcome — a mis-detected prompt boundary
 * would pin the wrong text and anchor the view to the wrong line, and the user
 * would have no way to tell it had happened.
 */
export type PromptSource = 'agent' | 'shell';

export interface PromptEntry {
  /** `${surfaceId}:${seq}` — stable across re-renders, usable as a React key. */
  id: string;
  surfaceId: string;
  /** Monotonic per surface. Also the ordinal shown in the outline. */
  seq: number;
  /**
   * What the user typed. Empty until known: a shell entry is opened at the
   * `133;B` mark and only learns its command line at `133;C`, and an agent
   * entry that arrived without a payload (an older wmux-hook.js still on disk)
   * stays empty forever rather than inventing something.
   */
  text: string;
  source: PromptSource;
  at: number;
  /**
   * Absolute buffer line the prompt starts on, once the terminal layer has
   * resolved a marker for it — null while unresolved, and null again for an
   * entry whose marker was invalidated (see prompt-marks.ts: a marker's line
   * is lost when it scrolls out of the scrollback, and markers do not survive
   * the serialize/replay a split-tree restructure performs).
   *
   * A view MUST treat null as "cannot jump there", never as line 0.
   */
  line: number | null;
  /** Terminal rows the prompt occupies. ≥1; used to size the highlight. */
  rows: number;
}

/**
 * Longest prompt text kept, in characters.
 *
 * This bounds a string that crosses the pipe from a hook process and lands in a
 * web context, so it is a limit and not a display hint — the views truncate for
 * layout separately. Generous enough that a normal multi-paragraph prompt
 * survives intact for the outline.
 *
 * Enforced here EVEN THOUGH wmux-hook.js already caps the prompt at the same
 * number before sending it, and deliberately without the two being derived from
 * one constant: that file is copied into the user's `~/.claude` and an old copy
 * routinely outlives an upgrade, so this end cannot assume the other end agrees
 * about anything. (The hook's own stdin cap is a different, much larger number,
 * sized to let a pasted file PARSE rather than to bound what is forwarded.)
 */
export const MAX_PROMPT_TEXT = 4000;

/** Prompts kept per surface. Oldest evicted first — a plain FIFO ring. */
export const MAX_PROMPTS_PER_SURFACE = 200;

/**
 * Surfaces tracked at once. Bounded for the same reason surfaceBufferCache is:
 * a long-lived window opens and closes panes all day, and the teardown path is
 * best-effort (a crashed renderer reaches none of it). Least-recently-written
 * surface is dropped whole.
 */
export const MAX_TRACKED_SURFACES = 64;

/** Clamp + normalise text arriving from outside the renderer. */
export function normalizePromptText(text: unknown): string {
  if (typeof text !== 'string') return '';
  // Normalise the line endings a PTY-adjacent source produces before slicing,
  // so a CRLF prompt does not spend half its budget on carriage returns and so
  // the outline's "first line" is the same on both sources.
  return text.replace(/\r\n?/g, '\n').slice(0, MAX_PROMPT_TEXT);
}

/** The first non-empty line of a prompt, for one-line views. */
export function promptSummary(text: string, max = 120): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface PromptSlice {
  /** surfaceId → prompts, oldest first. Absent key = nothing recorded yet. */
  prompts: Record<string, PromptEntry[]>;
  /**
   * The surface whose outline overlay is open, or null.
   *
   * One at a time, keyed by surface rather than by pane: the overlay belongs to
   * the terminal it lists, and a pane's hidden keep-alive tabs must not render
   * it (PaneWrapper keeps every tab mounted — visibility:hidden unmounts
   * nothing, so the gate has to be in JS).
   */
  promptOutlineSurface: string | null;
  /**
   * surfaceId → a prompt the user pinned by hand, overriding "pin the latest".
   *
   * Separate from `prompts` because it is a CHOICE, not an observation: it must
   * survive the entry it points at being evicted from the ring, and it must not
   * be silently replaced when the next prompt arrives — that is the difference
   * between a pin and a header.
   */
  pinnedPrompts: Record<string, PromptEntry | null>;
  /**
   * The terminal surface a `prompts` PANE lists.
   *
   * A pane, unlike the overlay, is not attached to the terminal it describes —
   * it sits somewhere else in the split tree — so it has to be told which one to
   * follow. This is the last terminal surface to hold focus, written by App.tsx.
   *
   * The load-bearing rule is what it does NOT track: focus landing on anything
   * that is not a terminal leaves this alone. Otherwise clicking into the
   * prompts pane itself — to scroll it, to filter it, to click a row — would
   * immediately blank the thing the user just clicked on.
   */
  promptSourceSurface: string | null;
  /**
   * paneSurfaceId → the terminal surface that pane has been PINNED to.
   *
   * Following focus is right for one terminal and wrong for two: watching pane A
   * while typing in pane B is exactly when an outline is worth having, and
   * follow-focus makes that the one thing it cannot do. An entry here opts a
   * single panel out.
   *
   * Deliberately not persisted and not on the SurfaceRef. A lock is a statement
   * about the CURRENT arrangement of panes, and restoring one whose target
   * surface no longer exists gives a panel that is stuck on nothing and offers
   * no clue why. Restarting into follow-focus is the recoverable default.
   */
  promptPaneLocks: Record<string, string>;

  recordPrompt(entry: PromptEntry): void;
  /** Fill in fields learned after the entry was opened (text, line, rows). */
  updatePrompt(surfaceId: string, id: string, patch: Partial<PromptEntry>): void;
  clearPromptsForSurface(surfaceId: string): void;
  setPromptOutlineSurface(surfaceId: string | null): void;
  setPinnedPrompt(surfaceId: string, entry: PromptEntry | null): void;
  setPromptSourceSurface(surfaceId: string | null): void;
  /** Pin a prompts pane to one terminal, or pass null to follow focus again. */
  setPromptPaneLock(paneSurfaceId: string, sourceSurfaceId: string | null): void;
}

/** Next sequence number for a surface. */
export function nextPromptSeq(list: PromptEntry[] | undefined): number {
  if (!list || list.length === 0) return 1;
  return list[list.length - 1].seq + 1;
}

/**
 * Drop the least-recently-written surfaces once the map is over budget.
 *
 * "Least recently written" is approximated by the newest entry's timestamp
 * rather than tracked separately: the only thing that writes a surface's list
 * is a new prompt, so the two are the same fact.
 */
function evictSurfaces(prompts: Record<string, PromptEntry[]>): Record<string, PromptEntry[]> {
  const keys = Object.keys(prompts);
  if (keys.length <= MAX_TRACKED_SURFACES) return prompts;
  const ranked = keys
    .map((key) => ({ key, at: prompts[key][prompts[key].length - 1]?.at ?? 0 }))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_TRACKED_SURFACES);
  const kept: Record<string, PromptEntry[]> = {};
  for (const { key } of ranked) kept[key] = prompts[key];
  return kept;
}

export const createPromptSlice: StateCreator<PromptSlice, [], [], PromptSlice> = (set) => ({
  prompts: {},
  promptOutlineSurface: null,
  pinnedPrompts: {},
  promptSourceSurface: null,
  promptPaneLocks: {},

  recordPrompt(entry: PromptEntry): void {
    set((state) => {
      const existing = state.prompts[entry.surfaceId] ?? [];
      const appended = [...existing, entry];
      const trimmed = appended.length > MAX_PROMPTS_PER_SURFACE
        ? appended.slice(appended.length - MAX_PROMPTS_PER_SURFACE)
        : appended;
      return { prompts: evictSurfaces({ ...state.prompts, [entry.surfaceId]: trimmed }) };
    });
  },

  updatePrompt(surfaceId: string, id: string, patch: Partial<PromptEntry>): void {
    set((state) => {
      // Keep a hand-pinned entry pointing at the same prompt in sync — it holds
      // its own copy so it can outlive eviction, which is exactly why it would
      // otherwise keep a stale line and jump to the wrong place.
      //
      // Evaluated INDEPENDENTLY of the ring below, not after a successful patch
      // of it. A pin outliving eviction is the whole reason `pinnedPrompts`
      // keeps a copy at all, so the one case where the ring no longer has the
      // entry is precisely the case where the pin most needs correcting — and
      // an early return on the ring lookup made it the one case that was
      // skipped.
      const pinned = state.pinnedPrompts[surfaceId];
      const pinnedPatch = pinned && pinned.id === id
        ? { pinnedPrompts: { ...state.pinnedPrompts, [surfaceId]: { ...pinned, ...patch } } }
        : null;

      const existing = state.prompts[surfaceId];
      const idx = existing ? existing.findIndex((e) => e.id === id) : -1;
      if (idx === -1) return pinnedPatch ?? {};

      const next = (existing as PromptEntry[]).slice();
      next[idx] = { ...next[idx], ...patch };
      return { prompts: { ...state.prompts, [surfaceId]: next }, ...(pinnedPatch ?? {}) };
    });
  },

  clearPromptsForSurface(surfaceId: string): void {
    set((state) => {
      // A lock is dropped from BOTH sides: the pane that holds it may be the
      // surface going away, and so may the terminal it points at. A lock left
      // pointing at a dead terminal is a panel permanently showing nothing, with
      // its own "following" label insisting otherwise.
      const lockedKeys = Object.keys(state.promptPaneLocks)
        .filter((pane) => pane === surfaceId || state.promptPaneLocks[pane] === surfaceId);

      if (!(surfaceId in state.prompts)
        && !(surfaceId in state.pinnedPrompts)
        && state.promptOutlineSurface !== surfaceId
        && state.promptSourceSurface !== surfaceId
        && lockedKeys.length === 0) {
        return {};
      }
      const prompts = { ...state.prompts };
      delete prompts[surfaceId];
      const pinnedPrompts = { ...state.pinnedPrompts };
      delete pinnedPrompts[surfaceId];
      const promptPaneLocks = { ...state.promptPaneLocks };
      for (const pane of lockedKeys) delete promptPaneLocks[pane];
      return {
        prompts,
        pinnedPrompts,
        promptPaneLocks,
        promptOutlineSurface: state.promptOutlineSurface === surfaceId ? null : state.promptOutlineSurface,
        promptSourceSurface: state.promptSourceSurface === surfaceId ? null : state.promptSourceSurface,
      };
    });
  },

  setPromptOutlineSurface(surfaceId: string | null): void {
    set({ promptOutlineSurface: surfaceId });
  },

  setPinnedPrompt(surfaceId: string, entry: PromptEntry | null): void {
    set((state) => ({ pinnedPrompts: { ...state.pinnedPrompts, [surfaceId]: entry } }));
  },

  setPromptSourceSurface(surfaceId: string | null): void {
    // Guarded because the caller is a focus effect that re-runs on every split
    // tree change: writing an unchanged value re-renders every prompts pane in
    // the window, which is the over-invalidation shape of issue #141.
    set((state) => (state.promptSourceSurface === surfaceId ? {} : { promptSourceSurface: surfaceId }));
  },

  setPromptPaneLock(paneSurfaceId: string, sourceSurfaceId: string | null): void {
    set((state) => {
      const promptPaneLocks = { ...state.promptPaneLocks };
      if (sourceSurfaceId) promptPaneLocks[paneSurfaceId] = sourceSurfaceId;
      else delete promptPaneLocks[paneSurfaceId];
      return { promptPaneLocks };
    });
  },
});
