/**
 * pipe-bridge.ts — Exposes Zustand store operations as window.__wmux_* globals
 * so the main process can call them via executeJavaScript from V2 pipe handlers.
 */
import { useStore } from './store';
import { splitNode, getAllPaneIds, findLeaf, buildGridLayout, buildWorkspaceTree } from './store/split-utils';
import { surfaceTerminalRegistry } from './hooks/useTerminal';
import { PaneId, SurfaceId, WorkspaceId, SurfaceType, engineOf, type BrowserEngine, type WorkspaceLayout } from '../shared/types';
import { promptSummary, type PromptEntry, type PromptSource } from './store/prompt-slice';
import { v4 as uuid } from 'uuid';
import { translate, type TranslationKey } from './i18n/core';

/** Non-hook context (bridges the main process to the store) — reads the current language directly. */
const bridgeT = (key: TranslationKey, fallback?: string): string =>
  translate(useStore.getState().language, key, fallback);

const WIRE_LAYOUTS: readonly WorkspaceLayout[] = ['grid', 'columns', 'rows', 'left', 'down'];

/**
 * What `--panes` / `--layout` off the wire mean, given the user's settings
 * (issue #212).
 *
 * Exported and pure because the interesting behaviour is all in the gaps: an
 * omitted flag must fall through to the SETTING (that is the whole point of
 * #212 — one configurable answer, not a CLI that hard-codes its own), while a
 * flag that is present must win over it.
 *
 * `single` is a pane COUNT wearing a layout's name — it is the word the issue
 * used, so both entry points accept it, and both turn it into `panes = 1`
 * rather than carrying a sixth layout through the builder. An explicit
 * `--panes` still wins over it: writing both means the number was meant.
 *
 * An unrecognised layout falls back to the configured one rather than to a
 * silent `grid`, because a typo should cost the user their typo and not also
 * the setting they had already made.
 */
export function resolveWireLayout(
  params: { panes?: number; layout?: string } | undefined,
  prefs: { newWorkspacePanes: number; newWorkspaceLayout: WorkspaceLayout },
): { panes: number; layout: WorkspaceLayout } {
  const single = params?.layout === 'single';
  const named = params?.layout !== undefined && (WIRE_LAYOUTS as readonly string[]).includes(params.layout)
    ? params.layout as WorkspaceLayout
    : undefined;
  return {
    panes: params?.panes ?? (single ? 1 : prefs.newWorkspacePanes),
    layout: named ?? prefs.newWorkspaceLayout,
  };
}

/**
 * A prompt log entry as everything outside the renderer sees it (issue #207).
 *
 * Deliberately not `PromptEntry`: `id` is a React key and `surfaceId` is either
 * the argument the caller passed or the map key it is filed under, so both are
 * noise on the wire. `summary` is added instead of left to the caller, so a CLI
 * does not reimplement promptSummary's "first non-empty line" rule and then
 * drift from what the outline overlay shows for the same prompt.
 */
interface PublicPrompt {
  seq: number;
  at: number;
  source: PromptSource;
  /** Absolute buffer line, or null when the prompt is not jumpable — never 0. */
  line: number | null;
  rows: number;
  text: string;
  summary: string;
}

const publicPrompt = (entry: PromptEntry): PublicPrompt => ({
  seq: entry.seq,
  at: entry.at,
  source: entry.source,
  line: entry.line,
  rows: entry.rows,
  text: entry.text,
  summary: promptSummary(entry.text),
});

export function initPipeBridge(): void {
  const w = window as any;

  // ─── Workspace ──────────────────────────────────────────────────────────────

  w.__wmux_createWorkspace = (params?: {
    title?: string; shell?: string; cwd?: string; panes?: number; layout?: string;
  }) => {
    const store = useStore.getState();
    // `--panes` / `--layout` (issue #212) build a tree HERE rather than being
    // passed through to createWorkspace, because a caller-supplied splitTree is
    // exactly what createWorkspace already accepts — and going through
    // buildWorkspaceTree is what clamps a hostile `panes: 5000` arriving over
    // the pipe to something that will not spawn five thousand shells.
    //
    // Only when one of them was given: omitting both must keep the caller on
    // the configured default, which is the whole point of #212.
    const wants = params?.panes !== undefined || params?.layout !== undefined;
    const shape = resolveWireLayout(params, store.workspacePrefs);
    const splitTree = wants ? buildWorkspaceTree(shape.panes, shape.layout) : undefined;
    const id = store.createWorkspace({
      title: params?.title,
      shell: params?.shell,
      cwd: params?.cwd,
      ...(splitTree ? { splitTree } : {}),
    }, bridgeT);
    return { workspaceId: id };
  };

  w.__wmux_closeWorkspace = (id: string) => {
    useStore.getState().closeWorkspace(id as WorkspaceId);
  };

  w.__wmux_selectWorkspace = (id: string) => {
    useStore.getState().selectWorkspace(id as WorkspaceId);
  };

  w.__wmux_renameWorkspace = (id: string, title: string) => {
    useStore.getState().renameWorkspace(id as WorkspaceId, title);
  };

  w.__wmux_listWorkspaces = () => {
    const store = useStore.getState();
    return store.workspaces.map(ws => ({
      id: ws.id,
      title: ws.title,
      isActive: ws.id === store.activeWorkspaceId,
      cwd: ws.cwd,
      shell: ws.shell,
    }));
  };

  // Which workspace owns a given surface? Used by main to route browser commands
  // to a browser pane in the *caller agent's* workspace (issue #62). Returns the
  // active workspace id as a fallback when the surface isn't found.
  w.__wmux_getWorkspaceIdForSurface = (surfaceId: string) => {
    const store = useStore.getState();
    for (const ws of store.workspaces) {
      for (const paneId of getAllPaneIds(ws.splitTree)) {
        const leaf = findLeaf(ws.splitTree, paneId);
        if (leaf?.surfaces?.some(s => s.id === surfaceId)) return ws.id;
      }
    }
    return store.activeWorkspaceId ?? null;
  };

  // The caller's OWN workspace, identity included. Main injects the workspace
  // id it resolved from the caller's WMUX_SURFACE_ID (callerScoped), so there
  // is deliberately NO fallback to the active workspace here: an agent in a
  // background pane has to be able to tell "I don't know" from "it's this one",
  // and the active workspace would answer the second when it only knows the
  // first.
  w.__wmux_currentWorkspace = (workspaceId: string, surfaceId: string) => {
    if (!workspaceId) return null;
    const ws = useStore.getState().workspaces.find(x => x.id === workspaceId);
    if (!ws) return null;
    return { id: ws.id, title: ws.title, cwd: ws.cwd, shell: ws.shell, surfaceId: surfaceId || null };
  };

  // All browser surface ids in a workspace. Main adopts an unbound one for a
  // caller (or creates a fresh pane) so each agent gets its own browser (#62).
  w.__wmux_listBrowserSurfaces = (workspaceId: string) => {
    const store = useStore.getState();
    const ws = store.workspaces.find(x => x.id === workspaceId);
    if (!ws) return [];
    const ids: string[] = [];
    for (const paneId of getAllPaneIds(ws.splitTree)) {
      const leaf = findLeaf(ws.splitTree, paneId);
      for (const s of leaf?.surfaces ?? []) {
        if (s.type === 'browser') ids.push(s.id);
      }
    }
    return ids;
  };

  /**
   * Which engine backs a browser surface — `web` (the Electron <webview>) or
   * `agent` (vercel-labs agent-browser driving a real Chrome).
   *
   * The split tree lives here, in the Zustand store, and main has no copy of
   * it, so main asks this before routing any `browser.*` verb (see
   * `engineForSurface` in v2-browser.ts).
   *
   * An UNKNOWN surface answers `web`, and that is the safe answer rather than a
   * lazy one: `web` needs no external binary and can always render, so a stale
   * id, a surface on another window, or a race against a pane being created can
   * only ever degrade to today's behaviour. Read through `engineOf` rather than
   * off the raw field so a corrupt persisted value (the session file is
   * user-editable) degrades identically here and in main.
   */
  w.__wmux_getBrowserEngine = (surfaceId: string): BrowserEngine => {
    const store = useStore.getState();
    for (const ws of store.workspaces) {
      for (const paneId of getAllPaneIds(ws.splitTree)) {
        const leaf = findLeaf(ws.splitTree, paneId);
        const surface = leaf?.surfaces?.find(s => s.id === surfaceId);
        if (surface) return engineOf(surface);
      }
    }
    return 'web';
  };

  /**
   * Flip a browser surface's engine. Returns whether it took.
   *
   * Refuses a non-browser surface outright instead of writing the field
   * anyway: `engineOf` would ignore `browserEngine` on a terminal surface, so
   * the write would persist a value that reads back as `web` forever — a
   * mutation that "succeeds" while changing nothing, which is the #143 failure
   * mode.
   */
  w.__wmux_setBrowserEngine = (surfaceId: string, engine: BrowserEngine): boolean => {
    const store = useStore.getState();
    for (const ws of store.workspaces) {
      for (const paneId of getAllPaneIds(ws.splitTree)) {
        const leaf = findLeaf(ws.splitTree, paneId);
        const surface = leaf?.surfaces?.find(s => s.id === surfaceId);
        if (!surface) continue;
        if (surface.type !== 'browser') return false;
        store.updateSurface(ws.id, paneId, surfaceId as SurfaceId, { browserEngine: engine });
        return true;
      }
    }
    return false;
  };

  // ─── Pane ───────────────────────────────────────────────────────────────────

  w.__wmux_splitPane = (params?: { direction?: string; type?: string; workspaceId?: string; colorScheme?: string; startupCommands?: string[] }) => {
    const store = useStore.getState();
    const wsId = (params?.workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return null;

    const paneIds = getAllPaneIds(ws.splitTree);
    const targetPaneId = paneIds[0];
    if (!targetPaneId) return null;

    const newPaneId = `pane-${uuid()}` as PaneId;
    const surfaceType = (params?.type || 'terminal') as SurfaceType;
    const direction = params?.direction === 'down' || params?.direction === 'vertical'
      ? 'vertical' : 'horizontal';

    const newTree = splitNode(ws.splitTree, targetPaneId, newPaneId, surfaceType, direction);
    store.updateSplitTree(wsId, newTree);

    const newLeaf = findLeaf(newTree, newPaneId);
    const surfaceId = newLeaf?.surfaces?.[0]?.id || null;

    // Patch the freshly-created surface before React gets a chance to mount it:
    // `colorScheme` so `wmux split --color-scheme prod` takes effect
    // immediately, and `startupCommands` because useTerminal reads them once,
    // at pty.create time — a patch that landed after mount would never run.
    // Both store writes happen in this same synchronous tick as
    // `updateSplitTree` above, which is what makes that safe.
    const patch: Partial<{ colorScheme: string; startupCommands: string[] }> = {};
    if (params?.colorScheme) patch.colorScheme = params.colorScheme;
    if (params?.startupCommands?.length) patch.startupCommands = params.startupCommands;
    if (surfaceId && newLeaf && Object.keys(patch).length > 0) {
      store.updateSurface(wsId, newPaneId, surfaceId as SurfaceId, patch);
    }

    return { paneId: newPaneId, surfaceId };
  };

  w.__wmux_closePane = (paneId: string, workspaceId?: string) => {
    const store = useStore.getState();
    // Without an explicit workspace, find the pane wherever it is rather than
    // assuming it is in the active one (issue #143) — pane ids are uuids, so
    // the search is unambiguous, and the old assumption made `close-pane` a
    // no-op that still reported success for any pane not currently on screen.
    const candidates = workspaceId
      ? store.workspaces.filter(w => w.id === workspaceId)
      : store.workspaces;
    const ws = candidates.find(w => getAllPaneIds(w.splitTree).includes(paneId as PaneId));
    if (!ws) return;

    // Reaping + tree surgery live in the store action (issue #65 fixed the
    // missing reap here; the last-pane case was still wrong in all three copies).
    store.closePane(ws.id, paneId as PaneId);
  };

  w.__wmux_layoutGrid = (params: { count: number; type?: string; anchorSurfaceId?: string; anchorPaneId?: string; workspaceId?: string }) => {
    const store = useStore.getState();
    const wsId = (params?.workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return null;

    const count = Math.max(1, Math.floor(params.count || 1));
    if (count < 2) return { newPaneIds: [], newPanes: [] };

    // Resolve the anchor pane: explicit paneId > surface lookup > first pane
    const paneIds = getAllPaneIds(ws.splitTree);
    let anchorPaneId: PaneId | undefined;

    if (params.anchorPaneId) {
      anchorPaneId = params.anchorPaneId as PaneId;
    } else if (params.anchorSurfaceId) {
      for (const pid of paneIds) {
        const leaf = findLeaf(ws.splitTree, pid);
        if (leaf?.surfaces?.some(s => s.id === params.anchorSurfaceId)) {
          anchorPaneId = pid;
          break;
        }
      }
    }
    if (!anchorPaneId) anchorPaneId = paneIds[0];
    if (!anchorPaneId) return null;

    const surfaceType = (params.type || 'terminal') as SurfaceType;
    const { tree: newTree, newPaneIds } = buildGridLayout(ws.splitTree, anchorPaneId, count, surfaceType);
    store.updateSplitTree(wsId, newTree);

    // Resolve surface IDs for the newly-created panes so callers can target them directly.
    const newPanes = newPaneIds.map(pid => {
      const leaf = findLeaf(newTree, pid);
      return {
        paneId: pid,
        surfaceId: leaf?.surfaces?.[0]?.id || null,
      };
    });

    return { newPaneIds, newPanes, anchorPaneId, cols: Math.ceil(Math.sqrt(count)), rows: Math.ceil(count / Math.ceil(Math.sqrt(count))) };
  };

  w.__wmux_listPanes = (workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return [];

    const paneIds = getAllPaneIds(ws.splitTree);
    return paneIds.map(pid => {
      const leaf = findLeaf(ws.splitTree, pid);
      return {
        paneId: pid,
        surfaces: leaf?.surfaces?.map(s => ({ id: s.id, type: s.type })) || [],
        tabCount: leaf?.surfaces?.length || 0,
        activeSurfaceIndex: leaf?.activeSurfaceIndex ?? 0,
      };
    });
  };

  // ─── Surface ────────────────────────────────────────────────────────────────

  w.__wmux_createSurface = (params?: { type?: string; paneId?: string; workspaceId?: string; colorScheme?: string }) => {
    const store = useStore.getState();
    const wsId = (params?.workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;

    let paneId = params?.paneId as PaneId | undefined;
    if (!paneId) {
      const ws = store.workspaces.find(w => w.id === wsId);
      if (!ws) return null;
      const paneIds = getAllPaneIds(ws.splitTree);
      paneId = paneIds[0];
    }
    if (!paneId) return null;

    const type = (params?.type || 'terminal') as SurfaceType;
    const surfaceId = store.addSurface(wsId, paneId, type, { colorScheme: params?.colorScheme });
    if (!surfaceId) return null;
    return { surfaceId, paneId };
  };

  /**
   * Update an existing surface's color scheme. Lets users switch a running
   * pane to "prod" mid-session via `wmux surface set-color-scheme <id> prod`.
   */
  w.__wmux_setSurfaceColorScheme = (surfaceId: string, colorScheme: string | null) => {
    const store = useStore.getState();
    for (const ws of store.workspaces) {
      const paneIds = getAllPaneIds(ws.splitTree);
      for (const pid of paneIds) {
        const leaf = findLeaf(ws.splitTree, pid);
        if (leaf?.surfaces?.some(s => s.id === surfaceId)) {
          store.updateSurface(ws.id, pid, surfaceId as SurfaceId, {
            colorScheme: colorScheme || undefined,
          });
          return { ok: true };
        }
      }
    }
    return { ok: false, error: 'Surface not found' };
  };

  /**
   * The workspaces an id-targeted op should search: the one it was given, else
   * every workspace in this window.
   *
   * Surface and pane ids are uuids, so a global search cannot hit the wrong
   * thing — whereas restricting the search to the *active* workspace silently
   * did nothing whenever the target lived elsewhere, and still answered `ok`
   * (issue #143: a scripted mutation "succeeding" without mutating anything is
   * worse than an error, because nothing downstream notices).
   */
  const searchScope = (workspaceId?: string) => {
    const store = useStore.getState();
    if (!workspaceId) return store.workspaces;
    const ws = store.workspaces.find(w => w.id === workspaceId);
    return ws ? [ws] : [];
  };

  w.__wmux_closeSurface = (surfaceId: string, workspaceId?: string) => {
    const store = useStore.getState();
    for (const ws of searchScope(workspaceId)) {
      for (const pid of getAllPaneIds(ws.splitTree)) {
        const leaf = findLeaf(ws.splitTree, pid);
        if (leaf?.surfaces?.some(s => s.id === surfaceId)) {
          store.closeSurface(ws.id, pid, surfaceId as SurfaceId);
          return;
        }
      }
    }
  };

  w.__wmux_renameSurface = (surfaceId: string, title: string, workspaceId?: string) => {
    const store = useStore.getState();
    for (const ws of searchScope(workspaceId)) {
      for (const pid of getAllPaneIds(ws.splitTree)) {
        const leaf = findLeaf(ws.splitTree, pid);
        if (leaf?.surfaces?.some(s => s.id === surfaceId)) {
          store.renameSurface(ws.id, pid, surfaceId as SurfaceId, title ?? '');
          return { ok: true };
        }
      }
    }
    return { ok: false, error: 'Surface not found' };
  };

  w.__wmux_focusSurface = (surfaceId: string, workspaceId?: string) => {
    const store = useStore.getState();
    for (const ws of searchScope(workspaceId)) {
      for (const pid of getAllPaneIds(ws.splitTree)) {
        const leaf = findLeaf(ws.splitTree, pid);
        const idx = leaf?.surfaces?.findIndex(s => s.id === surfaceId) ?? -1;
        if (idx >= 0) {
          store.selectSurface(ws.id, pid, idx);
          return;
        }
      }
    }
  };

  w.__wmux_listSurfaces = (workspaceId?: string, paneId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return [];

    const paneIds = getAllPaneIds(ws.splitTree).filter(pid => !paneId || pid === paneId);
    const surfaces: Array<{ id: string; type: string; paneId: string; isActive: boolean }> = [];
    for (const pid of paneIds) {
      const leaf = findLeaf(ws.splitTree, pid);
      if (leaf?.surfaces) {
        leaf.surfaces.forEach((s, idx) => {
          surfaces.push({
            id: s.id,
            type: s.type,
            paneId: pid,
            isActive: idx === leaf.activeSurfaceIndex,
          });
        });
      }
    }
    return surfaces;
  };

  /**
   * WHERE in THIS window does `surfaceId` live — `{ workspaceId, paneId }` — or
   * null if this window does not hold it at all? Used by the main process to
   * answer a CLI state query about the place the caller's shell actually lives,
   * rather than about whichever window happens to be first in `getAllWindows()`
   * (issue #141: `tree` and `list-surfaces` reported different panes at the
   * same moment, so a scripted "find the diff surface and close it" found
   * nothing and exited reporting success).
   *
   * It returns the workspace, not just a yes/no, because yes/no was only half
   * an answer (issue #143): a window owns many workspaces, and a caller parked
   * in a background one still had every query answered about the *active* one.
   * The window was right and the workspace was wrong, so `tree` reliably
   * described panes the caller had never seen.
   */
  w.__wmux_locateSurface = (surfaceId: string) => {
    if (!surfaceId) return null;
    for (const ws of useStore.getState().workspaces) {
      for (const pid of getAllPaneIds(ws.splitTree)) {
        const leaf = findLeaf(ws.splitTree, pid);
        if (leaf?.surfaces.some(s => s.id === surfaceId)) {
          return { workspaceId: ws.id, paneId: pid };
        }
      }
    }
    return null;
  };

  w.__wmux_getActiveSurfaceId = () => {
    const store = useStore.getState();
    const wsId = store.activeWorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    if (!ws) return null;
    const paneIds = getAllPaneIds(ws.splitTree);
    if (paneIds.length === 0) return null;
    const leaf = findLeaf(ws.splitTree, paneIds[0]);
    if (!leaf?.surfaces?.length) return null;
    const idx = leaf.activeSurfaceIndex ?? 0;
    return leaf.surfaces[idx]?.id || null;
  };

  // Read a terminal's screen as plain text (surface.read_text / read-screen).
  // Reads the ACTIVE xterm buffer — alt buffer included, so a full-screen TUI
  // returns what is actually visible. `lines` counts back from the bottom of
  // the buffer (scrollback included); trailing blank lines are trimmed.
  w.__wmux_readScreen = (surfaceId?: string, lines?: number) => {
    const id = surfaceId || w.__wmux_getActiveSurfaceId?.();
    if (!id) return { error: 'No active surface' };
    const terminal = surfaceTerminalRegistry.get(id);
    if (!terminal) {
      return { error: `no terminal for surface ${id} (markdown/browser pane, another window, or closed)` };
    }
    const buf = terminal.buffer.active;
    const count = Math.min(Math.max(Math.floor(lines ?? 50), 1), 10000);
    const end = buf.length;
    const out: string[] = [];
    for (let i = Math.max(0, end - count); i < end; i++) {
      out.push(buf.getLine(i)?.translateToString(true) ?? '');
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return { text: out.join('\n'), lines: out.length, surfaceId: id };
  };

  /**
   * The prompt log a surface has recorded (issue #207) — backs `wmux prompts`.
   *
   * This is the only way an agent can ask what its own pane was asked to do.
   * `__wmux_readScreen` cannot answer it: an agent TUI repaints over its own
   * scrollback, and once it has, the prompt text is gone from the buffer for
   * good — which is exactly why the log records the text at the boundary rather
   * than scraping it back later.
   *
   * With a surfaceId it answers that surface's list; without one it answers the
   * whole map, because "which panes have prompts" is a question that only makes
   * sense from OUTSIDE a pane and there is no sensible default surface there.
   *
   * The result crosses out of the renderer through `executeJavaScript`, so both
   * halves of that contract are load-bearing: it returns only plain data (a
   * class instance or an undefined-valued key would come back mangled or throw
   * a clone error in main), and it cannot throw — a rejected script surfaces in
   * main as an opaque failure with no surface id in it. Hence the `?? []`: a
   * surface with nothing recorded has no key at all, and that is an empty log,
   * not an error.
   */
  w.__wmux_listPrompts = (surfaceId?: string) => {
    const { prompts } = useStore.getState();
    if (surfaceId) return (prompts[surfaceId] ?? []).map(publicPrompt);
    const all: Record<string, PublicPrompt[]> = {};
    for (const [id, list] of Object.entries(prompts)) all[id] = list.map(publicPrompt);
    return all;
  };

  // ─── Markdown ───────────────────────────────────────────────────────────────

  w.__wmux_setMarkdownContent = (surfaceId: string, markdown: string, fileName?: string, filePath?: string, mtimeMs?: number) => {
    // Persist into the store so MarkdownPane (re)renders the content. The old
    // `wmux:markdown-update` CustomEvent had no listener, so content never
    // displayed (issue #54). `fileName`, when the content came from a file, is
    // used as the tab label so multiple markdown tabs stay distinguishable;
    // `filePath` makes the surface path-aware (issue #116) so the pane can show
    // the path, copy it, reveal it, and reload from it.
    // `mtimeMs` (F3) records what was on disk at load time so a later save can
    // detect an agent having rewritten the file underneath the pane.
    useStore.getState().setMarkdownContent(surfaceId as SurfaceId, markdown ?? '', { fileName, filePath, mtimeMs });
    return { ok: true };
  };

  // Read a markdown surface's buffer back out (issue #116). Mirrors
  // __wmux_readScreen for terminals — an agent that pushed content has no other
  // way to check what actually landed.
  w.__wmux_getMarkdownContent = (surfaceId: string) => {
    const state = useStore.getState();
    for (const ws of state.workspaces) {
      for (const paneId of getAllPaneIds(ws.splitTree)) {
        const surface = findLeaf(ws.splitTree, paneId)?.surfaces.find((s) => s.id === surfaceId);
        if (surface) {
          return {
            surfaceId,
            content: surface.markdownContent ?? '',
            filePath: surface.markdownFilePath ?? null,
            fileName: surface.markdownFileName ?? null,
            dirty: !!surface.markdownDirty,
          };
        }
      }
    }
    return null;
  };

  // ─── Notifications ──────────────────────────────────────────────────────────

  w.__wmux_listNotifications = () => {
    return useStore.getState().notifications || [];
  };

  w.__wmux_clearNotification = (id: string) => {
    useStore.getState().clearNotification(id);
  };

  w.__wmux_clearAllNotifications = () => {
    useStore.getState().clearAll();
  };

  // ─── Tree ───────────────────────────────────────────────────────────────────

  w.__wmux_getTree = (workspaceId?: string) => {
    const store = useStore.getState();
    const wsId = (workspaceId || store.activeWorkspaceId) as WorkspaceId;
    if (!wsId) return null;
    const ws = store.workspaces.find(w => w.id === wsId);
    return ws?.splitTree || null;
  };
}
