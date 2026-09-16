# New Workspace Layout Picker — Design Spec

**Date:** 2026-09-16
**Status:** Implemented — Phase 1 (Requirements) approved · Phase 2 (Design) approved · Phase 3 (Tasks) done except the manual checklist (8.1, 8.3, 8.4)

> Turn the sidebar `+` into a split-button: `+` still creates a workspace from the default, an upward caret `▴` opens a list of the saved layouts from Settings so any of them can be picked in one click. New workspaces are titled after the tabs they open.

## Contents

1. Overview
2. Current State
3. Requirements (Phase 1)
4. Design (Phase 2)
5. Tasks (Phase 3)
6. Impact

---

## 1. Overview

Saved Layouts (Settings → Workspace → Saved Layouts) already capture a pane arrangement with each pane's shell, cwd and startup commands. One of them can be marked **Default**, and every new-workspace entry point then uses it. Any *other* saved layout is reachable only through the command palette (`New Workspace: {name}`), which is slow for something done many times a day.

This spec adds a layout picker to the sidebar `+` button and changes how an untitled new workspace is named: instead of `Session N` / `Workspace N`, the title lists the tabs the workspace opens with, e.g. `api + api + notes.md + Prompts`.

## 2. Current State

| Piece | Where | Behaviour today |
|---|---|---|
| Sidebar `+` | `Sidebar.tsx:321` → `App.tsx` `handleCreateWorkspace` | Creates a workspace titled `Session N` from `resolveDefaultSplitTree`. |
| Default resolution | `workspace-slice.ts` `resolveDefaultSplitTree` | Saved layout with id `workspacePrefs.defaultLayoutId`, else `newWorkspacePanes` × `newWorkspaceLayout`. |
| Saved layouts | `settings-slice.ts` `savedLayouts: SavedLayout[]` (`{ id, name, splitTree, createdAt }`) | Managed in `WorkspaceSettings.tsx`; persisted under `wmux-saved-layouts`. |
| Palette entries | `CommandPalette.tsx` | `Save current layout as new preset`; `New Workspace: {name}` per layout — no title passed, so `Workspace N`. |
| Ctrl+N | `useKeyboardShortcuts.ts` `newWorkspace` | `createWorkspace(undefined, t)` → `Workspace N`. |
| CLI | `pipe-bridge.ts` `__wmux_newWorkspace` | Passes `--title` if given, else `Workspace N`. |
| Open folder | `useKeyboardShortcuts.ts` `openFolderAsWorkspace` | Title = folder name. |
| First launch | `App.tsx` | `Session 1`. |
| Split-button pattern | `SurfaceTabBar.tsx:438` | `+` + `▾` caret, portalled menu, closes on outside click / Escape / resize / scroll. |
| Tab labels | `surface-label.ts` `getSurfaceLabel` | customTitle → agent label → OSC title → cwd folder → shell → type label. |

## 3. Requirements (Phase 1)

### Terminology

- **Saved layout** — an entry in `savedLayouts`, shown under Settings → Workspace → Saved Layouts.
- **Default layout** — the saved layout whose id equals `workspacePrefs.defaultLayoutId`.
- **Standard shape** — `newWorkspacePanes` panes in the `newWorkspaceLayout` arrangement, used when no default layout is set.
- **Layout picker** — the caret next to the sidebar `+` and the menu it opens upward.
- **Tab-derived title** — a workspace title built from the labels of the tabs it is created with.

### US-1 — Quick create with the default (unchanged behaviour)

**User story:** As a wmux user, I want a single click on `+` to keep creating a workspace from my default, so that my muscle memory still works.

**Acceptance criteria:**

1. WHEN the user clicks `+` in the sidebar footer THEN wmux SHALL create a workspace from the default layout if one is set, otherwise from the standard shape, and SHALL select it.
2. WHEN the user clicks `+` THEN wmux SHALL NOT open the layout picker menu.

### US-2 — Pick a saved layout from the sidebar

**User story:** As a wmux user with several saved layouts, I want to open a list next to `+` and pick one, so that I can start a workspace from a non-default layout without opening the command palette.

**Acceptance criteria:**

1. The sidebar footer SHALL show a caret button directly adjacent to `+`, visually grouped with it as one split-button.
2. WHILE the menu is closed THEN the caret SHALL point **up** (`▴`), the direction the menu opens.
3. WHEN the user clicks the caret AND the menu is closed THEN wmux SHALL open the menu **above** the caret, growing upward, with its bottom edge anchored to the top of the split-button.
4. WHILE the menu is open THEN the caret SHALL point **down** (`▾`), meaning "collapse".
5. WHEN the user clicks the caret AND the menu is open THEN wmux SHALL close the menu without creating anything.
6. IF the menu is taller than the space between the split-button and the top of the window THEN the menu SHALL still open upward, cap its height to that space and scroll its layout list internally.

```
  closed                      open
                              ┌───────────────────────────┐
                              │ Dev                       │
                              │ Agents 4×                 │
                              │ Frontend + browser        │
                              │ ───────────────────────── │
                              │ Save current layout as …  │
                              │ Manage layouts…           │
                              └───────────────────────────┘
  💾  📂  [ + │ ▴ ]            💾  📂  [ + │ ▾ ]
```

7. WHEN the menu is open THEN it SHALL list every saved layout by name, in the same order as in Settings → Workspace → Saved Layouts, top to bottom.
8. WHEN the user clicks a saved layout in the menu THEN wmux SHALL create a workspace from that layout (same result as the palette's `New Workspace: {name}`), SHALL select it, and SHALL close the menu.
9. WHEN a saved layout has an empty name THEN the menu SHALL show a placeholder name (`Untitled layout`) rather than an empty row.
10. The menu SHALL NOT mark which layout is the default, and SHALL NOT contain a "standard shape" entry. *(Explicitly out of scope — see Non-goals.)*
11. WHEN the menu is open AND the user clicks outside the menu, presses Escape, resizes the window or scrolls THEN wmux SHALL close the menu without creating anything.
12. The caret SHALL expose `aria-haspopup="menu"` and `aria-expanded` matching the menu state.
13. IF the saved layouts change while the menu is open (e.g. edited in Settings) THEN the menu SHALL reflect the current list.

### US-3 — Save and manage layouts from the picker

**User story:** As a wmux user, I want to save the current workspace as a layout and jump to layout management from the same menu, so that building my list of layouts does not require digging through Settings.

**Acceptance criteria:**

1. The menu SHALL show, below the layout list and separated from it, the actions **Save current layout as preset** and **Manage layouts…**.
2. WHEN the user clicks **Save current layout as preset** AND there is an active workspace THEN wmux SHALL save it as a new saved layout named `Layout {n}` (n = number of saved layouts + 1), exactly as the palette command does, and SHALL close the menu.
3. WHEN the user clicks **Save current layout as preset** AND there is no active workspace THEN wmux SHALL show the existing notification `No active workspace to save as a layout.` and SHALL NOT create a layout.
4. WHEN the user clicks **Manage layouts…** THEN wmux SHALL open Settings on the Workspace tab and SHALL close the menu.

### US-4 — Empty state

**User story:** As a new user with no saved layouts, I want the picker to tell me that layouts exist and how to create one, so that I can discover the feature.

**Acceptance criteria:**

1. IF there are no saved layouts THEN the caret SHALL still be shown.
2. WHEN the menu opens AND there are no saved layouts THEN it SHALL show a non-clickable hint `No saved layouts yet` in place of the list, followed by both actions from US-3.

### US-5 — Tab-derived workspace title

**User story:** As a wmux user with many workspaces, I want a new workspace to be titled after the tabs it opens with, so that I can tell workspaces apart in the sidebar without renaming each one.

**Acceptance criteria:**

1. WHEN a workspace is created without an explicit title THEN wmux SHALL set its title to the labels of all its tabs joined with ` + `.
2. The tabs SHALL be ordered by pane in split-tree order (depth-first, first child before second: left before right, top before bottom), and by tab order within each pane.
3. Duplicate labels SHALL be kept (e.g. `api + api + notes.md`).
4. The label of each tab SHALL be computed from what is known at creation time, in this order:
   1. the tab's custom title, if set;
   2. for a terminal: the folder name of its starting directory (the tab's own cwd, else the workspace cwd), else the shell label (e.g. `PowerShell`), else `Terminal`;
   3. for a markdown or code tab: the file name, without the unsaved `•` marker;
   4. otherwise: the translated type label (`Browser`, `Prompts`, `Diff`, …).
5. The title SHALL be computed once at creation and stored as the workspace's ordinary title; it SHALL NOT change when tabs are later opened, closed, renamed or change directory.
6. The user SHALL be able to rename such a workspace exactly like any other.
7. This rule SHALL apply to every creation path that does not supply its own title: sidebar `+`, a layout picked in the picker, Ctrl+N, the palette's `New Workspace: {name}`, first launch with nothing to restore, and `wmux new-workspace` without `--title`.
8. WHEN a title is supplied explicitly — `wmux new-workspace --title`, **Open folder as workspace** (folder name), restoring a saved or auto-saved session — THEN wmux SHALL use that title unchanged.
9. IF no tab has a name of its own — every tab would be labelled only by its type (`Terminal`, `Browser`, `Markdown`, `Code`, `Diff`, `Prompts`) — or the workspace has no tabs THEN wmux SHALL use `Workspace {n}` instead. *(Decision D4: a bare `Terminal + Terminal + Terminal` cannot tell workspaces apart.)* A tab has a name of its own when its label comes from a custom title, a directory, a file name or a shell.
10. The full title SHALL be stored untruncated; the sidebar SHALL keep truncating long titles visually as it does today.

### Non-goals

- A default-layout marker in the menu (US-2.6).
- A "standard shape" menu entry that bypasses the default layout.
- Live titles that follow tab changes (US-5.5).
- A CLI flag to create a workspace from a saved layout by name.
- Keyboard shortcuts for individual layouts, or arrow-key navigation inside the menu beyond what the tab-bar split-button menu has today.
- Reordering, renaming or deleting layouts from the menu (stays in Settings).

### Assumptions (confirmed)

- **A1.** `Session N` (sidebar `+`) and `Session 1` (first launch) are treated as *defaults*, not explicit titles, so US-5 replaces them. Where US-5.9 applies, they become `Workspace {n}`, the same fallback every other path uses.
- **A2.** A terminal's label at creation uses the **starting** directory, because the live cwd (`currentCwd`) and OSC titles do not exist yet. It can therefore differ from the label the tab shows a second later.
- **A3.** The CLI change in US-5.7 is acceptable: a script that runs `wmux new-workspace` without `--title` and matches on `Workspace N` in `list-workspaces` output would break.

### Requirements Checklist

- [x] All user roles identified (single role: wmux user; CLI caller covered by US-5.7/5.8)
- [x] Normal, edge and error cases covered (empty list, empty name, no active workspace, empty derived title)
- [x] Requirements are testable
- [x] No conflicting requirements
- [x] EARS format used consistently

---

## 4. Design (Phase 2)

### 4.1 Overview

Two independent slices that ship together:

- **Slice A — tab-derived title (US-5).** A pure function computes a title from a split tree. `createWorkspace` uses it whenever the caller passes no title. The callers that pass a *default* title (`Session N`, `Session 1`) stop doing so. Nothing else changes: explicit titles and session restore keep their paths.
- **Slice B — layout picker (US-1…US-4).** A new sidebar component replaces the bare `+` with a split-button (`+ │ ▴`) and an upward, portalled menu. It reuses the store actions and menu styling that already exist (`instantiateLayout`, `saveCurrentLayoutAsPreset`, `.surface-tab-menu`).

Slice A lands first, so every workspace the picker creates gets the new title with no extra code.

### 4.2 Architecture

```
Sidebar footer
  └─ NewWorkspaceButton (new)                      reads: savedLayouts, saveCurrentLayoutAsPreset
       ├─ [+]  ── onCreate() ─────────────────────► App.handleCreateWorkspace
       ├─ [▴]  toggles menu (portal → document.body)
       └─ menu
            ├─ layout row ── onCreateFromLayout(id) ► App.handleCreateWorkspaceFromLayout
            ├─ Save current layout as preset ───────► store.saveCurrentLayoutAsPreset
            └─ Manage layouts… ── onManageLayouts() ► App: open Settings on "Workspace"

App.handleCreateWorkspace*            ┐
Ctrl+N (useKeyboardShortcuts)         │
CommandPalette "New Workspace: {name}"├─► store.createWorkspace(options, t)
pipe-bridge __wmux_newWorkspace (CLI) │        title = options.title
first launch (App)                    ┘              ?? deriveWorkspaceTitle(splitTree, cwd, shell, t)
                                                     || "Workspace {n}"
```

### 4.3 Components and Interfaces

#### C1. `deriveWorkspaceTitle` — `src/renderer/components/SplitPane/surface-label.ts` (extend)

```ts
export function deriveWorkspaceTitle(
  tree: SplitNode,
  workspaceCwd: string | undefined,
  workspaceShell: string | undefined,
  t: (key: TranslationKey, fallback?: string) => string = identityT,
): string
```

- Walks the tree depth-first, `children[0]` before `children[1]`, and each leaf's `surfaces` in array order (US-5.2).
- Maps each surface with `getInitialSurfaceLabel` (below) and joins the labels with `' + '`. Duplicates are kept (US-5.3).
- Returns `''` when the tree has no surfaces **or no surface is `named`** (US-5.9, D4). The caller then falls back to `Workspace {n}`.

```ts
function getInitialSurfaceLabel(surface, workspaceCwd, workspaceShell, t): { label: string; named: boolean }
```

The label order from US-5.4, i.e. `getSurfaceLabel` with the parts that cannot exist at creation removed. `named` says whether the label is a real name or only the type fallback:

| Surface type | Label | `named` |
|---|---|---|
| any, with `customTitle` | `customTitle` | ✓ |
| `terminal` | `cwdFolderName(surface.cwd ?? workspaceCwd)` | ✓ |
| | → `getShellLabel(surface.shell \|\| workspaceShell)` | ✓ |
| | → `t('surfaceLabel.terminal')` | ✗ |
| `markdown` | `markdownFileName`, **without** the `•` dirty marker | ✓ |
| | → `t('surfaceLabel.markdown')` | ✗ |
| `code` | `codeFileName`, **without** `•` | ✓ |
| | → `t('surfaceLabel.code')` | ✗ |
| `browser` / `diff` / `prompts` / other | the same translated type label `getSurfaceLabel` returns | ✗ |

Example: a layout with a `api` terminal, a bare terminal and a Prompts tab gives `api + Terminal + Prompts`, because one named tab is enough. The default 3-pane shape with no cwd gives `''`, so the workspace is titled `Workspace 4`.

Not used: agent label, OSC title, `currentCwd`, `resolvedShell`. None of them exists before the PTY starts (A2).

#### C2. `createWorkspace` — `src/renderer/store/workspace-slice.ts` (modify)

```ts
const splitTree = options.splitTree ?? resolveDefaultSplitTree(get);
title: options.title
  ?? (deriveWorkspaceTitle(splitTree, options.cwd, options.shell, t)
      || t('workspace.defaultTitle', 'Workspace {n}').replace('{n}', …)),
```

- `replaceAllWorkspaces` (session restore) is **not** changed (US-5.8).
- Existing callers that already pass `t` (Ctrl+N, CLI `bridgeT`) get translated labels for free. `CommandPalette` currently omits `t` and must pass it.

#### C3. Default-title callers — `src/renderer/App.tsx` (modify)

- `handleCreateWorkspace`: drop the `title: t('app.sessionTitle', …)` option; pass `t`.
- First launch: `createWorkspace({ title: t('app.firstSessionTitle', …) })` → `createWorkspace(undefined, t)`.
- `app.sessionTitle` and `app.firstSessionTitle` become unused. Remove them from **all 18 locales**: `tests/unit/i18n.test.ts` fails when a locale keeps a key that `en` dropped.

#### C4. `handleCreateWorkspaceFromLayout` — `src/renderer/App.tsx` (new callback)

```ts
(layoutId: string) => {
  const layout = useStore.getState().savedLayouts.find((l) => l.id === layoutId);
  if (!layout) return;                       // deleted between render and click
  const id = createWorkspace({ splitTree: instantiateLayout(layout.splitTree) }, t);
  selectWorkspace(id);
}
```

Same result as the palette entry (US-2.8). The palette keeps its own inline copy, now with `t` added (C2).

#### C5. Settings opened on a tab — `SettingsWindow.tsx` + `App.tsx` (modify)

- `SettingsWindow` gets an optional prop `initialTab?: typeof TABS[number]`, used as the `useState` initial value (default `'Terminal'`, as today).
- `App` keeps a `settingsTab` state next to `settingsOpen`. `onManageLayouts` sets it to `'Workspace'` and opens Settings. Every other opener (titlebar, shortcut) resets it to `undefined`, so they behave exactly as before.

#### C6. `NewWorkspaceButton` — `src/renderer/components/Sidebar/NewWorkspaceButton.tsx` (new)

```ts
interface NewWorkspaceButtonProps {
  onCreate: () => void;
  onCreateFromLayout: (layoutId: string) => void;
  onManageLayouts: () => void;
}
```

- Reads `savedLayouts` and `saveCurrentLayoutAsPreset` from `useStore`, so the list stays reactive (US-2.13).
- Renders the split-button group: `+` (existing `sidebar__new-btn` look, `flex: 1`) and a caret button with `aria-haspopup="menu"` and `aria-expanded={open}`.
- Caret icon: reuse `IconCaret` from `SplitPane/icons.tsx`, which points **down**. Closed → CSS `rotate(180deg)` (points up, US-2.2); open → no rotation (points down, US-2.4). Clicking the caret toggles the menu (US-2.5).
- Menu, portalled to `document.body`, `role="menu"`, classes `surface-tab-menu surface-tab-menu--up`:
  1. one `menuitem` button per layout: `layout.name.trim() || t('sidebar.layoutMenu.untitled', 'Untitled layout')`;
  2. or, if the list is empty, a non-interactive hint `t('sidebar.layoutMenu.empty', 'No saved layouts yet')` (US-4.2);
  3. `surface-tab-menu__sep`;
  4. `t('palette.saveCurrentLayout', 'Save current layout as new preset')` — reuses the existing key;
  5. `t('sidebar.layoutMenu.manage', 'Manage layouts…')`.
- **Save current layout**: calls `saveCurrentLayoutAsPreset(t('settings.workspacePanel.newLayoutName', 'Layout {n}')…)`. On `null` it fires the notification with the existing `palette.saveCurrentLayoutFailed` key, as `CommandPalette` does (US-3.2/3.3). The six duplicated lines are accepted rather than extracting a helper for two call sites.
- Close behaviour mirrors `SurfaceTabBar` (outside mousedown ignoring menu + caret, Escape, window resize, capture-phase scroll), **with one change**: a scroll event whose target is inside the menu is ignored. Otherwise the menu's own internal scroll (US-2.6) would close it.

#### C7. `upwardMenuPosition` — pure helper, exported from `NewWorkspaceButton.tsx`

```ts
export function upwardMenuPosition(anchor: DOMRect, viewportHeight: number, gap = 4, margin = 8):
  { left: number; bottom: number; minWidth: number; maxHeight: number }
// left = anchor.left; minWidth = anchor.width
// bottom = viewportHeight - anchor.top + gap        → menu's bottom edge sits just above the split-button
// maxHeight = max(0, anchor.top - gap - margin)     → never past the top of the window (US-2.6)
```

The anchor is the whole split-button group, not the caret alone, so the menu lines up with `+ │ ▴`.

#### C8. `Sidebar.tsx` (modify)

- New props `onCreateFromLayout` and `onManageLayouts`, passed through from `App`.
- Replace the `<button className="sidebar__new-btn">` with `<NewWorkspaceButton … />`.

#### C9. Styles

- `sidebar.css`: `.sidebar__new-group` (flex row, shared border and radius), `.sidebar__new-caret`, `.sidebar__new-caret--closed svg { transform: rotate(180deg) }`.
- `splitpane.css`: `.surface-tab-menu--up { overflow-y: auto; }` (max-height comes inline from C7); `.surface-tab-menu__hint` for the empty-state row (muted, no hover).

#### C10. i18n — `src/renderer/i18n/locales/en.ts`

Add `sidebar.newWorkspaceFromLayout` ("New workspace from layout…", caret tooltip), `sidebar.layoutMenu.empty`, `sidebar.layoutMenu.untitled`, `sidebar.layoutMenu.manage`. English only, which matches repo practice (`en` has 733 keys, most locales 517); others fall back to English.

### 4.4 Data Models

No new persisted data. Everything is read from existing state:

| Data | Source | Change |
|---|---|---|
| `SavedLayout { id, name, splitTree, createdAt }` | `settings-slice.savedLayouts` | none |
| `WorkspaceInfo.title` | `workspace-slice` | value of a new workspace changes (US-5); type unchanged |
| Menu open state, anchor position | `NewWorkspaceButton` local state | new, not persisted |
| Settings initial tab | `App` local state | new, not persisted |

### 4.5 Decisions

#### D1. Where the title logic lives
**Context:** The label rules must match `getSurfaceLabel` and share its private helpers (`cwdFolderName`, `getShellLabel`).
**Options:**
1. In `surface-label.ts`, imported by `workspace-slice.ts` — Pros: one file owns every label rule, so they cannot drift; reuses the private helpers. / Cons: first import from `store/` into `components/` (the module is pure, no React).
2. New `store/workspace-title.ts` importing `getShellLabel` — Pros: keeps `store/` free of component imports. / Cons: still imports from `components/`, and `cwdFolderName` would need exporting or duplicating.
**Decision:** Option 1.
**Rationale:** Both options add the same dependency edge. Option 1 also keeps the rules in one place.

#### D2. Split-button vs. a menu on the whole `+`
**Decision:** Split-button (`+ │ ▴`), approved in Phase 1. It mirrors `SurfaceTabBar`, so users already know how it works.

#### D3. New component vs. inline in `Sidebar.tsx`
**Decision:** New `NewWorkspaceButton.tsx`.
**Rationale:** `Sidebar.tsx` is already large. The menu brings its own refs, effects and portal, which is exactly what the tab bar needed ~40 lines for. A separate file also isolates the pure `upwardMenuPosition` for tests.

#### D4. Title for a workspace built from the standard shape — **OPEN**
**Context:** Without a default layout, `+` builds N bare terminal panes with no shell and no cwd. Following US-5.4, those are labelled `Terminal`, so the sidebar fills with identical `Terminal + Terminal + Terminal` rows where today it shows `Session 4`, `Session 5`. `terminalPrefs.defaultShell` is `''` by default (main auto-detects), so it does not help.
**Options:**
1. **Accept it** — Pros: one rule everywhere, as approved. / Cons: indistinguishable rows for users without saved layouts, who are most users.
2. **Keep `Session N` / `Workspace N` when no tab has a real name** (every label is a bare type label) — Pros: no regression for users without layouts; layout-based workspaces still get tab titles. / Cons: one more rule.
3. **Append a number on collision** (`Terminal + Terminal + Terminal 2`) — Pros: distinguishable. / Cons: long and ugly; numbering is derived from live titles, so it is fragile after renames.
**Decision:** Option 2 — fall back to `Workspace {n}` when no tab is `named` (US-5.9).
**Rationale:** No regression for users without saved layouts, while every workspace with at least one real name (directory, file, shell, custom title) still gets a tab-derived title. `Workspace {n}` rather than `Session {n}`, because it is the fallback `createWorkspace` already owns and the `Session` keys are removed (C3).

### 4.6 Error Handling

| Scenario | Handling |
|---|---|
| Layout deleted after the menu rendered, before the click | Menu re-renders from the store, so the row disappears. If the race is still hit, C4 finds nothing and returns; the menu closes. |
| "Save current layout" with no active workspace | Existing notification `palette.saveCurrentLayoutFailed`; no layout created (US-3.3). |
| Menu taller than the space above | `maxHeight` from C7; list scrolls; internal scroll does not close it. |
| Window resized / sidebar collapsed while open | Resize closes the menu. Collapsing unmounts the component and with it the portal. |
| Saved layout with blank name | `Untitled layout` placeholder (US-2.9). |
| Derived title empty (no surfaces, or no named surface) | Fallback `Workspace {n}` (US-5.9, D4). |
| `--title ""` from the CLI | Kept as given (`??`, not `\|\|`), as today. |

### 4.7 Testing Strategy

The repo has no component-rendering tests (no Testing Library). Logic is covered by pure unit tests, and the UI by a manual checklist in `npm run dev`.

**Unit — `tests/unit/workspace-title.test.ts` (new)**
- Tree order: horizontal and vertical branches, nested; multiple tabs per pane.
- Duplicates kept.
- `customTitle` wins for every surface type.
- Terminal: surface `cwd` > workspace cwd > surface shell > workspace shell > `Terminal`; Windows and POSIX paths, trailing slash.
- Markdown and code: file name, no `•` even when `markdownDirty`.
- Browser, diff and prompts use type labels; a stub `t` proves translation goes through.
- D4: all tabs bare (`Terminal`, `Browser`, `Prompts`, …) → `''`; one named tab among bare ones → full joined title, bare labels included.
- Empty tree → `''`.

**Unit — extend `tests/unit/workspace-defaults.test.ts`**
- `createWorkspace()` with no title and the bare standard shape → `Workspace {n}` (D4).
- `createWorkspace({ cwd: 'C:\\src\\api' })` with no title → `api + api + api`.
- `createWorkspace({ title: 'X' })` → `'X'`; `{ title: '' }` → `''`.
- `createWorkspace({ splitTree: instantiateLayout(saved) })` → title from the saved layout's tabs.
- `replaceAllWorkspaces` with titled configs → titles unchanged.

**Unit — `upwardMenuPosition`**
- `bottom`, `left`, `minWidth` from a given rect; `maxHeight` clamps to `0` when the anchor is near the top.

**Unit — i18n:** existing `i18n.test.ts` must stay green after removing the two keys everywhere.

**Manual checklist (`npm run dev`)**
1. `+` creates and selects a workspace; no menu opens. Without a default layout it is titled `Workspace {n}`; with one, tab-derived.
2. Caret points up; click → menu above the button, caret points down; click again → closes.
3. Menu lists layouts in Settings order; clicking one creates it with the tab-derived title.
4. Outside click, Escape, window resize → menu closes. Scrolling inside a long menu → stays open.
5. No layouts → hint plus both actions. "Save current layout" → layout appears in the list next time the menu opens.
6. "Manage layouts…" → Settings opens on Workspace. The titlebar gear still opens on Terminal.
7. Rename a layout in Settings while the menu is open → the row updates.
8. `wmux new-workspace` → derived title; `wmux new-workspace --title Foo` → `Foo`.
9. Restore a saved session → original titles.
10. Light and dark theme; narrow sidebar width.

## 5. Tasks (Phase 3)

Sequencing: **foundation-first inside each slice, slice A before slice B.** Slice A changes behaviour on its own and is verifiable without any UI. Slice B then only has to create workspaces, and their titles come out right automatically. Each task ends green on `npm test` and `npm run lint`. Tests for a task are written before its code.

### Slice A — tab-derived title

- [x] **1. Title derivation (pure)**
  - [x] 1.1 Write `tests/unit/workspace-title.test.ts` with every case from §4.7 "Unit — workspace-title", all failing.
  - [x] 1.2 In `src/renderer/components/SplitPane/surface-label.ts`, add a private `getInitialSurfaceLabel` returning `{ label, named }` (table in C1) and export `deriveWorkspaceTitle(tree, workspaceCwd, workspaceShell, t)`. Reuse `cwdFolderName` / `getShellLabel`; leave `getSurfaceLabel` untouched.
  - **Verify:** the new test file passes; `tests/unit/surface-label.test.ts` still passes unchanged.
  - _Requirements: US-5.1, 5.2, 5.3, 5.4, 5.9 · Design: C1, D1, D4_

- [x] **2. Use it in `createWorkspace`**
  - [x] 2.1 Extend `tests/unit/workspace-defaults.test.ts` with the `createWorkspace` / `replaceAllWorkspaces` cases from §4.7, all failing.
  - [x] 2.2 In `src/renderer/store/workspace-slice.ts` `createWorkspace`: compute `splitTree` first, then `title = options.title ?? (deriveWorkspaceTitle(splitTree, options.cwd, options.shell, t) || 'Workspace {n}')`. Do not touch `replaceAllWorkspaces`.
  - **Verify:** the new cases pass, including the explicit `''` title and restore keeping its titles; the full `npm test` is green.
  - _Requirements: US-5.5, 5.6, 5.7, 5.8, 5.9 · Design: C2_

- [x] **3. Callers and i18n cleanup**
  - [x] 3.1 `src/renderer/App.tsx`: `handleCreateWorkspace` → `createWorkspace(undefined, t)`. First launch → `createWorkspace(undefined, t)`.
  - [x] 3.2 `src/renderer/components/CommandPalette/CommandPalette.tsx`: the `New Workspace: {name}` action passes `t` to `createWorkspace`.
  - [x] 3.3 Remove `app.sessionTitle` and `app.firstSessionTitle` from all 18 files in `src/renderer/i18n/locales/`.
  - **Verify:** `grep -rn "app.sessionTitle\|app.firstSessionTitle" src` returns nothing; `tests/unit/i18n.test.ts` is green; `npm run dev` passes manual checklist items 1 (title part), 8 and 9.
  - _Requirements: US-5.7, A1 · Design: C3_

- [x] **4. Docs for slice A**
  - [x] 4.1 `docs/config.md`, section "New workspace shape": add a short paragraph on how an untitled workspace is named (tab-derived, `Workspace N` fallback, `--title` wins).
  - **Verify:** the text matches US-5.7–5.9 and D4.
  - _Requirements: US-5 · Design: §6 CLI row_

> **Checkpoint A:** slice A is shippable on its own. Stop here if review of the title behaviour is wanted before the UI work.

### Slice B — layout picker

- [x] **5. Upward menu position (pure)**
  - [x] 5.1 Tests for `upwardMenuPosition` in `tests/unit/new-workspace-button.test.ts` (normal rect; anchor near the top clamps `maxHeight` to `0`).
  - [x] 5.2 Export `upwardMenuPosition` from the new `src/renderer/components/Sidebar/NewWorkspaceButton.tsx` (the file holds only the helper at this point).
  - **Verify:** tests pass. The test imports only the helper, so no React rendering is needed.
  - _Requirements: US-2.3, 2.6 · Design: C7_

- [x] **6. Split-button and menu**
  - [x] 6.1 Build `NewWorkspaceButton` in the same file: `+` button, caret button (`IconCaret`, rotated when closed, `aria-haspopup`, `aria-expanded`, tooltip `sidebar.newWorkspaceFromLayout`), portalled menu positioned with `upwardMenuPosition` on the group element.
  - [x] 6.2 Menu content: layout rows from `useStore(savedLayouts)` with the `Untitled layout` placeholder; empty-state hint; separator; **Save current layout as preset** (store action with the `Layout {n}` name and failure notification, as in `CommandPalette`); **Manage layouts…**.
  - [x] 6.3 Close behaviour copied from `SurfaceTabBar`: outside mousedown (ignore menu and caret), Escape, resize, capture-phase scroll **ignoring scroll events inside the menu**. Caret click toggles.
  - [x] 6.4 i18n: add `sidebar.newWorkspaceFromLayout`, `sidebar.layoutMenu.empty`, `sidebar.layoutMenu.untitled`, `sidebar.layoutMenu.manage` to `en.ts`.
  - [x] 6.5 Styles: `.sidebar__new-group`, `.sidebar__new-caret` (+ rotation) in `sidebar.css`; `.surface-tab-menu--up`, `.surface-tab-menu__hint` in `splitpane.css`.
  - **Verify:** `npm run lint`, `npm test` green. The component is not mounted yet, so there is no visible change.
  - _Requirements: US-2.1–2.7, 2.9–2.13, US-3.1–3.3, US-4 · Design: C6, C9, C10, D2, D3_

- [x] **7. Wire into Sidebar, App and Settings**
  - [x] 7.1 `SettingsWindow.tsx`: optional `initialTab` prop as the `useState` initial value.
  - [x] 7.2 `App.tsx`: `settingsTab` state; existing openers reset it to `undefined`; `handleManageLayouts` sets `'Workspace'` and opens Settings; new `handleCreateWorkspaceFromLayout` (C4).
  - [x] 7.3 `Sidebar.tsx`: props `onCreateFromLayout`, `onManageLayouts`; replace `sidebar__new-btn` with `<NewWorkspaceButton>`. `App.tsx` passes both callbacks.
  - **Verify:** `npm run dev` passes manual checklist items 1–7 and 10.
  - _Requirements: US-1, US-2.8, US-3.4 · Design: C4, C5, C8_

- [ ] **8. Final verification**
  - [ ] 8.1 Full manual checklist (§4.7, items 1–10) in `npm run dev`.
  - [x] 8.2 `npm test`, `npm run lint`, `npm run build:main`, `npm run build:renderer` all green.
  - [ ] 8.3 Re-read §3 and tick every acceptance criterion against the running app. Update this spec if the implementation diverged.
  - [ ] 8.4 Screenshot of both caret states and the empty state for the PR.
  - _Requirements: all_

### Tasks Checklist

- [x] Every design component has a task (C1→1, C2→2, C3→3, C4/C5/C8→7, C6/C9/C10→6, C7→5)
- [x] Tasks ordered to respect dependencies (title before picker; helper before component; component before wiring)
- [x] Each task produces tested or manually verifiable output
- [x] Requirement references on every task
- [x] Scope ~1–4 h per task

## 6. Impact

| Area | Touched | Risk | Notes |
|---|---|---|---|
| Renderer — sidebar | yes | low | New component; the `+` click path is unchanged. |
| Renderer — workspace store | yes | **medium** | `createWorkspace` title changes for every untitled creation path (Ctrl+N, `+`, palette, first launch, CLI). |
| CLI / pipe API | behaviour only | **medium** | `wmux new-workspace` without `--title` yields a tab-derived title when a default layout is set or `--cwd`/`--shell` is given (e.g. `--cwd C:\src\api` → `api + api + api`), and `Workspace N` otherwise (D4). `list-workspaces` output changes accordingly (A3). No protocol or flag changes. |
| Settings | yes | low | Optional `initialTab` prop; the default opener behaviour is unchanged. |
| Session save / restore | no | none | `replaceAllWorkspaces` untouched; persisted format unchanged. |
| Main process, PTY, shell integration | no | none | — |
| i18n | yes | low | 4 keys added (en), 2 removed (all locales). |
| Agent integrations / orchestrator plugin | no | low | Only if an agent matches workspace titles by `Workspace N`, same as the CLI note. |

**Egress:** none — no new external hosts.
