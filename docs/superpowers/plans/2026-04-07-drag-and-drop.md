# Drag & Drop Tab Reordering and Pane Splitting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unified drag-and-drop for terminal tabs — reorder within a pane, move between panes, and split panes by dropping on edges with VS Code-style drop zones.

**Architecture:** Extend existing HTML5 drag API already in SurfaceTabBar.tsx. Add edge drop zones to PaneWrapper. Add `reorderSurface()` and `splitAndMoveSurface()` to the Zustand surface slice. All visual feedback via CSS classes toggled by drag state.

**Tech Stack:** React 19, Zustand, HTML5 Drag and Drop API, CSS transitions

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/renderer/store/surface-slice.ts` | Add `reorderSurface()` and `splitAndMoveSurface()` store methods |
| `src/renderer/components/SplitPane/SurfaceTabBar.tsx` | Tab reorder logic, insertion marker, drag source styling |
| `src/renderer/components/SplitPane/PaneWrapper.tsx` | Edge drop zones (4 edges + center), zone hit detection, split on drop |
| `src/renderer/styles/splitpane.css` | All drag visual feedback styles |

---

## Task 1: Add `reorderSurface()` to the store

**Files:**
- Modify: `src/renderer/store/surface-slice.ts`

- [ ] **Step 1: Add `reorderSurface` to the `SurfaceSlice` interface**

In `src/renderer/store/surface-slice.ts`, add the new method signature to the `SurfaceSlice` interface (after `moveSurface` at line 30):

```typescript
  /** Reorder a surface within the same pane (drag to new tab position) */
  reorderSurface: (workspaceId: WorkspaceId, paneId: PaneId, surfaceId: SurfaceId, newIndex: number) => void;
```

- [ ] **Step 2: Implement `reorderSurface`**

Add the implementation inside `createSurfaceSlice` (after the `selectSurface` method, before the closing `});`):

```typescript
  reorderSurface(workspaceId, paneId, surfaceId, newIndex) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    const leaf = findLeaf(ws.splitTree, paneId);
    if (!leaf) return;

    const currentIndex = leaf.surfaces.findIndex((s) => s.id === surfaceId);
    if (currentIndex === -1 || currentIndex === newIndex) return;

    const newSurfaces = [...leaf.surfaces];
    const [moved] = newSurfaces.splice(currentIndex, 1);
    newSurfaces.splice(newIndex, 0, moved);

    // Keep the moved surface active
    const updatedTree = patchLeaf(ws.splitTree, paneId, {
      surfaces: newSurfaces,
      activeSurfaceIndex: newIndex,
    });

    updateSplitTree(workspaceId, updatedTree);
  },
```

- [ ] **Step 3: Build to verify**

```bash
npm run build:main
```
Expected: No TypeScript errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store/surface-slice.ts
git commit -m "feat: add reorderSurface() for tab drag reordering within a pane"
```

---

## Task 2: Add `splitAndMoveSurface()` to the store

**Files:**
- Modify: `src/renderer/store/surface-slice.ts`

- [ ] **Step 1: Add `splitAndMoveSurface` to the `SurfaceSlice` interface**

Add after the `reorderSurface` signature:

```typescript
  /** Split a pane and move a surface into the new pane (drag to edge) */
  splitAndMoveSurface: (
    workspaceId: WorkspaceId,
    targetPaneId: PaneId,
    sourcePaneId: PaneId,
    surfaceId: SurfaceId,
    direction: 'left' | 'right' | 'up' | 'down',
  ) => void;
```

- [ ] **Step 2: Add the `splitNode` import**

At the top of `surface-slice.ts`, update the import from `split-utils` (line 4):

```typescript
import { findLeaf, removeLeaf, splitNode } from './split-utils';
```

- [ ] **Step 3: Implement `splitAndMoveSurface`**

Add the implementation after `reorderSurface`:

```typescript
  splitAndMoveSurface(workspaceId, targetPaneId, sourcePaneId, surfaceId, direction) {
    const { workspaces, updateSplitTree } = get();
    const ws = workspaces.find((w) => w.id === workspaceId);
    if (!ws) return;

    // Map direction to split-utils direction and child order
    const splitDirection = (direction === 'left' || direction === 'right') ? 'horizontal' : 'vertical';

    // Create the new pane via split
    const newPaneId = `pane-${uuid()}` as PaneId;
    let tree = splitNode(ws.splitTree, targetPaneId, newPaneId, 'terminal', splitDirection);

    // splitNode always puts the new leaf as the SECOND child (right/bottom).
    // For 'left' or 'up', we need to swap: the new pane should be first.
    if (direction === 'left' || direction === 'up') {
      tree = swapSplitChildren(tree, targetPaneId, newPaneId);
    }

    // Remove the surface from the source pane
    const sourceLeaf = findLeaf(tree, sourcePaneId);
    if (!sourceLeaf) return;

    const surfaceIndex = sourceLeaf.surfaces.findIndex((s) => s.id === surfaceId);
    if (surfaceIndex === -1) return;
    const surface = sourceLeaf.surfaces[surfaceIndex];

    const newSourceSurfaces = sourceLeaf.surfaces.filter((s) => s.id !== surfaceId);

    if (newSourceSurfaces.length === 0) {
      // Source pane is now empty — remove it
      tree = removeLeaf(tree, sourcePaneId) ?? tree;
    } else {
      tree = patchLeaf(tree, sourcePaneId, {
        surfaces: newSourceSurfaces,
        activeSurfaceIndex: Math.min(sourceLeaf.activeSurfaceIndex, newSourceSurfaces.length - 1),
      });
    }

    // Replace the new pane's auto-created surface with the dragged one
    tree = patchLeaf(tree, newPaneId, {
      surfaces: [surface],
      activeSurfaceIndex: 0,
    });

    updateSplitTree(workspaceId, tree);
  },
```

- [ ] **Step 4: Add `swapSplitChildren` helper**

Add this helper function at the bottom of `surface-slice.ts` (after `patchLeaf`):

```typescript
/** Swap the children of the branch that contains both paneIds as direct children */
function swapSplitChildren(tree: SplitNode, paneIdA: PaneId, paneIdB: PaneId): SplitNode {
  if (tree.type === 'leaf') return tree;

  const [left, right] = tree.children;

  // Check if this branch directly contains both panes
  const leftHasA = containsPane(left, paneIdA);
  const rightHasB = containsPane(right, paneIdB);

  if (leftHasA && rightHasB) {
    return { ...tree, children: [right, left] };
  }

  // Recurse
  const newLeft = swapSplitChildren(left, paneIdA, paneIdB);
  const newRight = swapSplitChildren(right, paneIdA, paneIdB);
  if (newLeft === left && newRight === right) return tree;
  return { ...tree, children: [newLeft, newRight] };
}

function containsPane(node: SplitNode, paneId: PaneId): boolean {
  if (node.type === 'leaf') return node.paneId === paneId;
  return containsPane(node.children[0], paneId) || containsPane(node.children[1], paneId);
}
```

- [ ] **Step 5: Build to verify**

```bash
npm run build:main
```
Expected: No TypeScript errors

- [ ] **Step 6: Commit**

```bash
git add src/renderer/store/surface-slice.ts
git commit -m "feat: add splitAndMoveSurface() for drag-to-edge pane splitting"
```

---

## Task 3: Add drag CSS styles

**Files:**
- Modify: `src/renderer/styles/splitpane.css`

- [ ] **Step 1: Add all drag-and-drop CSS**

Append the following to the end of `src/renderer/styles/splitpane.css`:

```css
/* ─── Drag and drop ──────────────────────────────────────────────────────── */

/* Source tab while being dragged */
.surface-tab--dragging {
  opacity: 0.3;
  border: 1px dashed #6c7086;
}

/* Tab insertion marker (reorder within same pane) */
.surface-tab--insert-before::before {
  content: '';
  position: absolute;
  left: -1px;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: #89b4fa;
  border-radius: 1px;
  z-index: 10;
}

.surface-tab--insert-after::after {
  content: '';
  position: absolute;
  right: -1px;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: #89b4fa;
  border-radius: 1px;
  z-index: 10;
}

/* Make tabs position:relative for the insertion markers */
.surface-tab {
  position: relative;
}

/* Pane drop zone overlay (covers the pane content area) */
.pane-wrapper__drop-zones {
  position: absolute;
  inset: 0;
  z-index: 20;
  pointer-events: none;
  display: none;
}

/* Show drop zones when a drag is active */
.pane-wrapper--drag-active .pane-wrapper__drop-zones {
  display: block;
  pointer-events: auto;
}

/* Individual drop zone areas */
.pane-drop-zone {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.1s ease, border-color 0.1s ease;
  border: 2px solid transparent;
}

.pane-drop-zone--left {
  top: 0; left: 0; bottom: 0;
  width: 25%;
}
.pane-drop-zone--right {
  top: 0; right: 0; bottom: 0;
  width: 25%;
}
.pane-drop-zone--top {
  top: 0; left: 25%; right: 25%;
  height: 25%;
}
.pane-drop-zone--bottom {
  bottom: 0; left: 25%; right: 25%;
  height: 25%;
}
.pane-drop-zone--center {
  top: 25%; left: 25%; right: 25%; bottom: 25%;
}

/* Edge zones: blue on hover */
.pane-drop-zone--left:hover,
.pane-drop-zone--right:hover,
.pane-drop-zone--top:hover,
.pane-drop-zone--bottom:hover {
  background: rgba(137, 180, 250, 0.15);
}
.pane-drop-zone--left:hover   { border-right-color: #89b4fa; }
.pane-drop-zone--right:hover  { border-left-color: #89b4fa; }
.pane-drop-zone--top:hover    { border-bottom-color: #89b4fa; }
.pane-drop-zone--bottom:hover { border-top-color: #89b4fa; }

/* Center zone: green on hover */
.pane-drop-zone--center:hover {
  background: rgba(166, 227, 161, 0.12);
  border-color: #a6e3a1;
}

/* Grabbing cursor on body during drag */
body.wmux-dragging,
body.wmux-dragging * {
  cursor: grabbing !important;
}
```

- [ ] **Step 2: Build renderer to verify CSS compiles**

```bash
npx vite build 2>&1 | tail -5
```
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/renderer/styles/splitpane.css
git commit -m "feat: add drag-and-drop CSS for drop zones, insertion markers, and feedback"
```

---

## Task 4: Implement tab reorder in SurfaceTabBar

**Files:**
- Modify: `src/renderer/components/SplitPane/SurfaceTabBar.tsx`

- [ ] **Step 1: Add reorder props and state**

Update the `SurfaceTabBarProps` interface (line 5) — add new props:

```typescript
interface SurfaceTabBarProps {
  paneId: PaneId;
  surfaces: SurfaceRef[];
  activeSurfaceIndex: number;
  onSelect: (index: number) => void;
  onClose: (surfaceId: SurfaceId) => void;
  onNew: () => void;
  onClosePane?: () => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onDropSurface?: (sourcePaneId: PaneId, surfaceId: SurfaceId, targetPaneId: PaneId) => void;
  onReorderSurface?: (surfaceId: SurfaceId, newIndex: number) => void;
  isDragActive?: boolean;
}
```

Update the function signature to accept the new props:

```typescript
export default function SurfaceTabBar({
  paneId,
  surfaces,
  activeSurfaceIndex,
  onSelect,
  onClose,
  onNew,
  onClosePane,
  onSplitRight,
  onSplitDown,
  onDropSurface,
  onReorderSurface,
  isDragActive,
}: SurfaceTabBarProps) {
```

- [ ] **Step 2: Add drag state tracking**

Replace the existing `dragOverIndex` state (line 52) with richer drag state:

```typescript
  const [draggingSurfaceId, setDraggingSurfaceId] = useState<SurfaceId | null>(null);
  const [insertIndex, setInsertIndex] = useState<number | null>(null);
```

- [ ] **Step 3: Update onDragStart to track which tab is being dragged**

Replace the existing `onDragStart` handler on each tab (lines 98-104):

```typescript
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  'application/wmux-surface',
                  JSON.stringify({ sourcePaneId: paneId, surfaceId: surface.id })
                );
                e.dataTransfer.effectAllowed = 'move';
                setDraggingSurfaceId(surface.id);
                document.body.classList.add('wmux-dragging');
              }}
              onDragEnd={() => {
                setDraggingSurfaceId(null);
                setInsertIndex(null);
                document.body.classList.remove('wmux-dragging');
              }}
```

- [ ] **Step 4: Update onDragOver on tabs for insertion index calculation**

Replace the existing `onDragOver` on each tab (lines 105-108):

```typescript
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // Calculate insertion index based on cursor position
                const rect = e.currentTarget.getBoundingClientRect();
                const midpoint = rect.left + rect.width / 2;
                const newInsertIndex = e.clientX < midpoint ? index : index + 1;
                setInsertIndex(newInsertIndex);
              }}
```

- [ ] **Step 5: Update the tab bar onDrop to handle reorder**

Replace the existing `onDrop` handler on the tab bar container (lines 65-77):

```typescript
      onDrop={(e) => {
        e.preventDefault();
        setInsertIndex(null);
        setDraggingSurfaceId(null);
        document.body.classList.remove('wmux-dragging');
        const data = e.dataTransfer.getData('application/wmux-surface');
        if (!data) return;
        try {
          const { sourcePaneId, surfaceId } = JSON.parse(data);
          if (sourcePaneId === paneId && onReorderSurface && insertIndex !== null) {
            // Reorder within same pane
            const currentIndex = surfaces.findIndex(s => s.id === surfaceId);
            // Adjust index: if moving forward, the removal shifts indices down
            const adjustedIndex = insertIndex > currentIndex ? insertIndex - 1 : insertIndex;
            if (adjustedIndex !== currentIndex) {
              onReorderSurface(surfaceId as SurfaceId, adjustedIndex);
            }
          } else if (sourcePaneId !== paneId && onDropSurface) {
            // Move to different pane
            onDropSurface(sourcePaneId as PaneId, surfaceId as SurfaceId, paneId);
          }
        } catch {}
      }}
      onDragLeave={() => setInsertIndex(null)}
```

- [ ] **Step 6: Update tab className to include drag states**

Update the tab's className (lines 88-93):

```typescript
              className={[
                'surface-tab',
                isActive ? 'surface-tab--active' : '',
                draggingSurfaceId === surface.id ? 'surface-tab--dragging' : '',
                insertIndex === index ? 'surface-tab--insert-before' : '',
                insertIndex === index + 1 && index === surfaces.length - 1 ? 'surface-tab--insert-after' : '',
                isAgent ? 'surface-tab--agent' : '',
              ].filter(Boolean).join(' ')}
```

- [ ] **Step 7: Build to verify**

```bash
npx vite build 2>&1 | tail -5
```
Expected: Build succeeds

- [ ] **Step 8: Commit**

```bash
git add src/renderer/components/SplitPane/SurfaceTabBar.tsx
git commit -m "feat: add tab reorder via drag within same pane with insertion marker"
```

---

## Task 5: Add edge drop zones to PaneWrapper

**Files:**
- Modify: `src/renderer/components/SplitPane/PaneWrapper.tsx`

- [ ] **Step 1: Add state and store imports**

Add `splitAndMoveSurface` and `reorderSurface` to the store subscriptions. After the existing store subscriptions (lines 28-33), add:

```typescript
  const splitAndMoveSurface = useStore((s) => s.splitAndMoveSurface);
  const reorderSurface = useStore((s) => s.reorderSurface);
```

Add a state variable for tracking whether a global drag is active:

```typescript
  const [dragActive, setDragActive] = useState(false);
```

- [ ] **Step 2: Add global drag listeners**

Add a `useEffect` to listen for drag events on the document (after the existing keyboard shortcuts useEffect):

```typescript
  // Track global drag state for showing drop zones
  useEffect(() => {
    const handleDragStart = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('application/wmux-surface')) {
        setDragActive(true);
      }
    };
    const handleDragEnd = () => setDragActive(false);
    const handleDrop = () => setDragActive(false);

    document.addEventListener('dragstart', handleDragStart);
    document.addEventListener('dragend', handleDragEnd);
    document.addEventListener('drop', handleDrop);
    return () => {
      document.removeEventListener('dragstart', handleDragStart);
      document.removeEventListener('dragend', handleDragEnd);
      document.removeEventListener('drop', handleDrop);
    };
  }, []);
```

- [ ] **Step 3: Add edge drop handler**

Add a handler function for when a surface is dropped on an edge zone:

```typescript
  const handleEdgeDrop = (e: React.DragEvent, direction: 'left' | 'right' | 'up' | 'down') => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    document.body.classList.remove('wmux-dragging');
    const data = e.dataTransfer.getData('application/wmux-surface');
    if (!data || !activeWorkspaceId) return;
    try {
      const { sourcePaneId, surfaceId } = JSON.parse(data);
      splitAndMoveSurface(activeWorkspaceId, paneId, sourcePaneId as PaneId, surfaceId as SurfaceId, direction);
    } catch {}
  };

  const handleCenterDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    document.body.classList.remove('wmux-dragging');
    const data = e.dataTransfer.getData('application/wmux-surface');
    if (!data || !activeWorkspaceId) return;
    try {
      const { sourcePaneId, surfaceId } = JSON.parse(data);
      if (sourcePaneId !== paneId) {
        moveSurface(activeWorkspaceId, sourcePaneId as PaneId, surfaceId as SurfaceId, paneId);
      }
    } catch {}
  };

  const preventDragDefault = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
  };
```

- [ ] **Step 4: Add reorder handler**

```typescript
  const handleReorderSurface = (surfaceId: SurfaceId, newIndex: number) => {
    if (activeWorkspaceId) {
      reorderSurface(activeWorkspaceId, paneId, surfaceId, newIndex);
    }
  };
```

- [ ] **Step 5: Update the SurfaceTabBar props**

Update the `<SurfaceTabBar>` JSX (line 230-241) to pass the new props:

```typescript
      <SurfaceTabBar
        paneId={paneId}
        surfaces={surfaces}
        activeSurfaceIndex={activeSurfaceIndex}
        onSelect={handleSelectSurface}
        onClose={handleCloseSurface}
        onNew={handleNewSurface}
        onClosePane={handleClosePane}
        onSplitRight={handleSplitRight}
        onSplitDown={handleSplitDown}
        onDropSurface={handleDropSurface}
        onReorderSurface={handleReorderSurface}
        isDragActive={dragActive}
      />
```

- [ ] **Step 6: Add drop zone overlay to the content area**

Update the outer div className and add drop zones inside `pane-wrapper__content`. Replace the return statement (lines 228-252):

```typescript
  return (
    <div className={`pane-wrapper ${isFocused ? 'pane-wrapper--focused' : ''} ${dragActive ? 'pane-wrapper--drag-active' : ''}`}>
      <SurfaceTabBar
        paneId={paneId}
        surfaces={surfaces}
        activeSurfaceIndex={activeSurfaceIndex}
        onSelect={handleSelectSurface}
        onClose={handleCloseSurface}
        onNew={handleNewSurface}
        onClosePane={handleClosePane}
        onSplitRight={handleSplitRight}
        onSplitDown={handleSplitDown}
        onDropSurface={handleDropSurface}
        onReorderSurface={handleReorderSurface}
        isDragActive={dragActive}
      />
      <div className="pane-wrapper__content">
        {renderAllSurfaces()}
        <NotificationRing visible={hasUnread} flashing={justFired} />
        <div
          className="pane-wrapper__unfocused-overlay"
          style={{ opacity: isFocused ? 0 : 1 }}
        />
        <div className="pane-wrapper__drop-zones">
          <div className="pane-drop-zone pane-drop-zone--left" onDragOver={preventDragDefault} onDrop={(e) => handleEdgeDrop(e, 'left')} />
          <div className="pane-drop-zone pane-drop-zone--right" onDragOver={preventDragDefault} onDrop={(e) => handleEdgeDrop(e, 'right')} />
          <div className="pane-drop-zone pane-drop-zone--top" onDragOver={preventDragDefault} onDrop={(e) => handleEdgeDrop(e, 'up')} />
          <div className="pane-drop-zone pane-drop-zone--bottom" onDragOver={preventDragDefault} onDrop={(e) => handleEdgeDrop(e, 'down')} />
          <div className="pane-drop-zone pane-drop-zone--center" onDragOver={preventDragDefault} onDrop={handleCenterDrop} />
        </div>
      </div>
    </div>
  );
```

- [ ] **Step 7: Build both main and renderer**

```bash
npm run build:main && npx vite build 2>&1 | tail -5
```
Expected: Both builds succeed

- [ ] **Step 8: Commit**

```bash
git add src/renderer/components/SplitPane/PaneWrapper.tsx
git commit -m "feat: add VS Code-style edge drop zones for drag-to-split pane creation"
```

---

## Task 6: Manual testing and polish

**Files:** None (testing only)

- [ ] **Step 1: Start wmux in dev mode**

```bash
npm run dev
```

- [ ] **Step 2: Test tab reorder**

1. Open 3 tabs in one pane (Ctrl+T twice)
2. Drag the first tab to after the third tab
3. Verify: tabs reorder, blue insertion marker appears during drag

- [ ] **Step 3: Test move between panes**

1. Split right (Ctrl+D) to create a second pane
2. Drag a tab from the left pane to the center of the right pane
3. Verify: tab moves to the right pane, green center zone highlights on hover

- [ ] **Step 4: Test split by edge drop**

1. Drag a tab from the left pane to the RIGHT edge of the right pane
2. Verify: a third pane is created to the right with the dragged tab
3. Drag a tab to the BOTTOM edge of a pane
4. Verify: a new pane appears below

- [ ] **Step 5: Test last-tab edge case**

1. In a pane with only one tab, drag it to the edge of another pane
2. Verify: the source pane disappears (removed because empty), new pane created

- [ ] **Step 6: Test drop cancel**

1. Start dragging a tab, then drop it outside any valid zone (on the titlebar, sidebar, etc.)
2. Verify: nothing happens, tab returns to original state, no error in console

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "fix: polish drag-and-drop edge cases"
```

---

## Task Summary

| Task | Description | Dependencies |
|------|-------------|-------------|
| 1 | `reorderSurface()` in store | None |
| 2 | `splitAndMoveSurface()` in store | None |
| 3 | Drag CSS styles | None |
| 4 | Tab reorder in SurfaceTabBar | Tasks 1, 3 |
| 5 | Edge drop zones in PaneWrapper | Tasks 2, 3, 4 |
| 6 | Manual testing and polish | Task 5 |

**Parallelizable:** Tasks 1, 2, 3 can run in parallel. Task 4 depends on 1+3. Task 5 depends on all. Task 6 is manual testing.
