// ─── Explorer: opening a file into the preview tab ───────────────────────────
// Browsing ten files makes ONE tab, not ten. The reuse rules live here rather
// than in the panel because they are store logic and that is what the tests
// point at.
//
// Since the code viewer landed there are TWO surface types behind that one tab
// — `markdown` and `code` — and the single-preview rule holds ACROSS the pair,
// which is the whole point: crossing from a .md to a .ts must not start a
// second tab. A surface's type is fixed at creation, so switching types is a
// close plus an add rather than an update; see the ordering note at that step.

import { useStore } from '../../store';
import { findLeaf, getAllPaneIds } from '../../store/split-utils';
import type { ExplorerErrorCode, PaneId, SurfaceId, WorkspaceId } from '../../../shared/types';

/**
 * `markdown.readFile`'s failure codes, mapped onto the explorer's own — which
 * are the ones with `explorer.error.*` translations in every locale.
 *
 * Only `code` is ever mapped. The sibling `error` field stays English on
 * purpose (it is for main-process callers and the log), so rendering it would
 * put an untranslated string in front of a French user — the same split
 * commit 82a779f drew for MarkdownReadError.
 *
 * Anything unlisted falls back to `read_failed`: "could not read it" is true of
 * every failure here, and a wrong-but-specific message is worse than a vague
 * correct one.
 */
const READ_ERROR_CODES: Record<string, ExplorerErrorCode> = {
  not_found: 'not_found',
  no_path: 'invalid_path',
  unsupported_type: 'invalid_path',
  symlink: 'invalid_path',
  not_regular_file: 'invalid_path',
  too_large: 'too_large',
  read_failed: 'read_failed',
};

/**
 * The markdown surface's extension set, duplicated here rather than imported.
 * A renderer must not import from src/main/, and it is six strings — but the
 * two lists MUST agree, so a source-level test pins them equal (see
 * explorer-state.test.ts's wiring pin, same technique and same reason).
 */
const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx', '.txt', '.text', '.rst']);

/**
 * Which surface type this file belongs in. `dot > 0` and not `>= 0`, so a
 * dotfile like `.gitignore` is treated as extension-less and lands in `code`
 * rather than having `.gitignore` read as its own extension.
 */
function targetTypeFor(fileName: string): 'markdown' | 'code' {
  const dot = fileName.lastIndexOf('.');
  const ext = dot > 0 ? fileName.slice(dot).toLowerCase() : '';
  return MARKDOWN_EXT.has(ext) ? 'markdown' : 'code';
}

/**
 * Null on success, or when a newer open superseded this one — a superseded open
 * is not a failure, and reporting one would flash an error for a file the user
 * has already navigated away from.
 */
export type PreviewOpenFailure = ExplorerErrorCode | null;

// Fast browsing is exactly what this feature exists for, and two clicks in
// quick succession race across the `readFile` await below. Two distinct
// failures, two distinct guards:
//
// - With NO preview open yet, both calls could pass the "find a reusable
//   preview" check (step 2) before either has created one, producing TWO
//   ephemeral tabs — permanently defeating the reuse rule. `paneQueues`
//   serializes every open onto the SAME target pane so the second call's
//   step-2 check only ever runs after the first call has fully finished
//   creating/updating a surface.
// - With a preview ALREADY open, both calls resolve onto the same
//   `targetSurfaceId`, and without ordering the later-LANDING read would win
//   over the later-CLICKED one. Serializing already prevents the two reads
//   from overlapping, but `seq` is kept as an independent second guard —
//   cheap insurance against a future caller that reaches `openOnce` outside
//   the queue (a keyboard handler, a test) reintroducing the race.
//
// Both are keyed PER PANE, and the seq must be: a single module-level counter
// made an open in pane B supersede an in-flight open in pane A, which then
// returned `null` — reported as success — and left pane A's preview showing
// the previous file. Two panes' previews are independent tabs and neither can
// stand in for the other, so nothing about an open in one says anything about
// an open in the other.
//
// Unlike paneQueues this is not cleared when a pane goes idle: the counter has
// to keep rising across bursts or a later open could reuse a number an
// in-flight one is still holding. It is one integer per pane ever previewed
// into, which is bounded by the panes the user actually opens files in.
const seqs = new Map<string, number>();
const paneQueues = new Map<string, Promise<PreviewOpenFailure>>();

export function openInPreviewTab(
  workspaceId: WorkspaceId,
  paneId: PaneId,
  filePath: string,
  fileName: string,
  // `surfaceId` + `relPath` are required for a CODE file and unused for a
  // markdown one: main addresses a code read by (surfaceId, relPath) and will
  // not accept an absolute path from the renderer. Existing markdown callers
  // keep working with `{ keep }` alone.
  opts: { keep: boolean; surfaceId?: SurfaceId; relPath?: string },
): Promise<PreviewOpenFailure> {
  // Queued on the pane the open will actually LAND on, not the one the caller
  // named. openOnce falls back to the workspace's first pane when the named one
  // has closed, so two clicks naming two different dead panes both resolve onto
  // one live pane — and keyed on the caller's id they would sit in two separate
  // queues, run their "find the reusable preview" checks concurrently, and each
  // create a preview tab. Two preview tabs in one pane is precisely what this
  // file exists to prevent.
  const targetPane = resolveTargetPane(workspaceId, paneId) ?? paneId;
  const key = paneKey(workspaceId, targetPane);
  const prev = paneQueues.get(key);
  // When the queue is idle, start openOnce SYNCHRONOUSLY (not via .then()) —
  // it must run up through its own `readFile` call in the same tick as the
  // caller's click, or the very first open in a burst would already be a
  // microtask behind the second one and the ordering this exists to fix
  // would be lost before either open even reaches its await.
  //
  // The chain continues on rejection as well as fulfilment (both `then` arms
  // run the same callback): a previous open that threw must not swallow every
  // later open behind it, which is the same wedge the `clear` below guards
  // against on the map side.
  // The RESOLVED pane is passed down, not re-derived inside openOnce. Resolving
  // twice means resolving at two different moments: the key is computed when
  // the click is queued, openOnce runs when its turn comes, and a pane that
  // closes in between makes the two disagree. Then a newer click for the
  // now-dead pane queues under the fallback pane and runs first, and the older
  // click falls through onto that same pane afterwards and overwrites it. One
  // resolution, one answer, carried.
  const next = (): Promise<PreviewOpenFailure> =>
    openOnce(workspaceId, targetPane, filePath, fileName, opts);
  const run = prev ? prev.then(next, next) : next();
  paneQueues.set(key, run);
  // Clear the entry once THIS call settles, but only if nothing newer has
  // already replaced it — otherwise a slow call's cleanup could evict a
  // fresher call's still-in-flight entry out from under it. This also keeps
  // one rejected/failed open from wedging every later open behind a
  // permanently-settled queue entry: the map simply goes back to idle.
  const clear = () => { if (paneQueues.get(key) === run) paneQueues.delete(key); };
  run.then(clear, clear);
  return run;
}

/** The queue and seq key. `paneId` alone would collide across workspaces. */
function paneKey(workspaceId: WorkspaceId, paneId: PaneId): string {
  return `${workspaceId}:${paneId}`;
}

/**
 * Which pane an open named for `paneId` will actually land on.
 *
 * The pane may have closed between the render and the click, and falling back
 * to the workspace's first leaf beats dropping the click on the floor. Stated
 * once, here, because the queue key is computed before openOnce runs and the
 * two MUST agree about the answer — a queue keyed on a pane the work does not
 * happen in serializes nothing.
 *
 * Null when the workspace is gone or has no panes at all; callers keep their
 * own handling for that.
 */
function resolveTargetPane(workspaceId: WorkspaceId, paneId: PaneId): PaneId | null {
  const workspace = useStore.getState().workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return null;
  if (findLeaf(workspace.splitTree, paneId)) return paneId;
  return getAllPaneIds(workspace.splitTree)[0] ?? null;
}

async function openOnce(
  workspaceId: WorkspaceId,
  paneId: PaneId,
  filePath: string,
  fileName: string,
  opts: { keep: boolean; surfaceId?: SurfaceId; relPath?: string },
): Promise<PreviewOpenFailure> {
  const store = useStore.getState();
  const workspace = store.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return null;

  // The pane may have closed between the render and the click. Falling back to
  // the first leaf beats dropping the click on the floor.
  // Already resolved by the caller, which keyed the queue on the answer — so
  // there is no second resolution here, only a check that the answer still
  // holds. A pane that died while this open sat in the queue makes the click
  // STALE, and a stale click is dropped rather than redirected: redirecting it
  // moves work onto a pane whose queue it was never in, where a newer click
  // keyed to that pane may already have run, and the older open then overwrites
  // the newer one. Falling back beats dropping a click only at enqueue time,
  // where resolveTargetPane already does it and the key follows.
  const targetPane = paneId;
  const leaf = findLeaf(workspace.splitTree, targetPane);
  if (!leaf) return null;

  const targetType = targetTypeFor(fileName);
  // A code read is addressed by (surfaceId, relPath) — main owns the root and
  // the renderer never supplies an absolute path. Without them there is nothing
  // to ask for, and inventing one would defeat the jail.
  if (targetType === 'code' && (!opts.surfaceId || !opts.relPath)) return 'invalid_path';

  // 1. Already open in this pane → focus it. Same "check before adding" rule as
  //    maybeAutoOpenDiffTab (App.tsx:215).
  const existingIndex = leaf.surfaces.findIndex(
    (s) => s.markdownFilePath === filePath || s.codeFilePath === filePath,
  );
  if (existingIndex >= 0) {
    const existing = leaf.surfaces[existingIndex];
    store.selectSurface(workspaceId, targetPane, existingIndex);
    if (opts.keep && existing.ephemeral) {
      store.updateSurface(workspaceId, targetPane, existing.id, { ephemeral: undefined });
    }
    return null;
  }

  // 2. Find the pane's preview tab. A DIRTY one is promoted, never recycled —
  //    an unsaved edit is not discarded by a click in a tree.
  //    One ephemeral preview per pane, SHARED across both types — that is what
  //    keeps "browsing ten files makes ONE tab" true when the browse crosses
  //    the markdown/code boundary.
  const preview = leaf.surfaces.find(
    (s) => (s.type === 'markdown' || s.type === 'code') && s.ephemeral,
  );
  let targetSurfaceId = preview && !preview.markdownDirty ? preview.id : null;
  if (preview && preview.markdownDirty) {
    store.updateSurface(workspaceId, targetPane, preview.id, { ephemeral: undefined });
  }

  // Per TARGET pane, not per requested pane: the fallback above can redirect
  // two clicks onto one pane, and it is the pane whose preview tab is being
  // rewritten that decides whether an in-flight read is still wanted.
  const seqKey = paneKey(workspaceId, targetPane);
  const mine = (seqs.get(seqKey) ?? 0) + 1;
  seqs.set(seqKey, mine);
  // A markdown file goes through the ordinary, UNJAILED markdown read, and a
  // .md opened from the tree is therefore read-only until the user picks a
  // destination in Save As. That is markdown-grants.ts's rule, not an oversight
  // here: a renderer-supplied path never mints a save grant, and a jail is a
  // smaller blast radius rather than the user's consent. See the note where
  // that handler would have gone in ipc-handlers.ts.
  const read = targetType === 'code'
    ? await window.wmux.code.readFile(opts.surfaceId!, opts.relPath!)
    : await window.wmux.markdown.readFile(filePath);
  if (seqs.get(seqKey) !== mine) return null; // a newer open landed while this one was in flight
  // No empty tab is left behind on failure — but the failure is REPORTED, not
  // swallowed. Silence here is what made a wrong absolute path look like a
  // dead click with no explanation, and it hides every click on a file that
  // was deleted out from under the tree.
  if (!read) return 'read_failed';
  if ('error' in read) {
    // code.read-file already answers in ExplorerErrorCode, so it passes through
    // unmapped; markdown.readFile's own codes still need the map.
    return targetType === 'code'
      ? (read.code as ExplorerErrorCode)
      : (READ_ERROR_CODES[read.code] ?? 'read_failed');
  }

  // 2b. The dirty check above was made BEFORE the read, and the user had the
  //     whole duration of that read to start typing into the very tab it is
  //     about to overwrite. Re-read it from live state: a tab that went dirty
  //     in the meantime gets the same treatment it would have got had it been
  //     dirty all along — promoted out of preview, and left alone. The rule is
  //     "an unsaved edit is not discarded by a click in a tree", and a race is
  //     not an exception to it.
  if (targetSurfaceId) {
    const liveWs = useStore.getState().workspaces.find((w) => w.id === workspaceId);
    const liveLeaf = liveWs ? findLeaf(liveWs.splitTree, targetPane) : null;
    const live = liveLeaf?.surfaces.find((s) => s.id === targetSurfaceId);
    if (!live) {
      // Closed outright during the read. Falling through would address the
      // update to an id no surface has any more — which a store `.map` silently
      // no-ops, so the click would report success and put nothing on screen.
      // Forgetting it here sends the open down the create-a-tab path instead.
      targetSurfaceId = null;
    } else if (live.markdownDirty) {
      useStore.getState().updateSurface(workspaceId, targetPane, targetSurfaceId, { ephemeral: undefined });
      targetSurfaceId = null;
    }
  }

  // 3. A reusable preview of the WRONG type cannot be updated in place; type is
  //    fixed at creation. Close it and add a replacement. This runs only AFTER
  //    the read succeeded, so a failed open never destroys the tab the user is
  //    looking at, and only under paneQueues' serialization, so two clicks
  //    cannot interleave a close with another open's add.
  //    ADD FIRST, then close. Closing the last surface in a pane IS a pane
  //    close (surface-slice.ts's `newSurfaces.length === 0` branch), and for a
  //    single-pane workspace closing that pane closes the WORKSPACE. So a user
  //    who had closed their terminal, leaving a code preview alone in the pane,
  //    lost the whole workspace by clicking a .md file in the tree that was
  //    still on screen. Ordering it the other way round means the count never
  //    reaches zero and the destructive branch is never entered.
  const replacing = targetSurfaceId && preview && preview.type !== targetType ? preview.id : null;
  if (replacing) targetSurfaceId = null;

  // 4. No reusable preview → make one.
  if (!targetSurfaceId) {
    targetSurfaceId = useStore.getState().addSurface(workspaceId, targetPane, targetType, {
      ephemeral: !opts.keep,
    });
    if (!targetSurfaceId) return 'read_failed';
    if (replacing) useStore.getState().closeSurface(workspaceId, targetPane, replacing);
  } else if (opts.keep) {
    store.updateSurface(workspaceId, targetPane, targetSurfaceId, { ephemeral: undefined });
  }

  if (targetType === 'code') {
    useStore.getState().updateSurface(workspaceId, targetPane, targetSurfaceId, {
      codeContent: read.content,
      codeFilePath: read.filePath,
      codeFileName: fileName,
      codeRelPath: opts.relPath,
      // Persisted, and what lets the tab refill itself after a restart: main
      // will only read for a live terminal it owns, so the code surface's own
      // id is unusable — see SurfaceRef.codeRootSurfaceId.
      codeRootSurfaceId: opts.surfaceId,
    });
  } else {
    // fileName is REQUIRED: without it markdownFileName is not updated and the
    // tab keeps the previous file's label.
    useStore.getState().setMarkdownContent(targetSurfaceId, read.content, {
      filePath: read.filePath,
      fileName,
      mtimeMs: read.mtimeMs,
    });
  }
  return null;
}
