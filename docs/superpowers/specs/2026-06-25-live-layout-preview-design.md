# Live Layout Preview for Surface Dragging

**Date:** 2026-06-25
**Status:** Approved

## Overview

When a user drags a Surface by its tab title, wmux should show a Live Layout Preview: the active workspace temporarily appears in the layout that would result from dropping the Surface at the current target. The preview must feel like live reflow, but it must not mutate the real split tree or move live terminal/browser content until drop.

This extends the existing drag-and-drop system from `2026-04-07-drag-and-drop-design.md`.

## Terminology

- **Surface**: a terminal, browser, markdown, or diff instance shown as a tab inside a pane.
- **Pane**: a rectangular leaf in the workspace split tree that contains one or more surfaces.
- **Live Layout Preview**: a temporary full-workspace visual projection of the post-drop layout shown during Surface drag.

## Current State

wmux already supports Surface dragging from `SurfaceTabBar.tsx`:

- Drag data uses `application/wmux-surface` with `{ sourcePaneId, surfaceId }`.
- Same-pane tab reorder uses an insertion marker and `reorderSurface()`.
- Center drop into another pane uses `moveSurface()`.
- Edge drop zones in `PaneWrapper.tsx` call `splitAndMoveSurface()`.
- `.pane-drop-zone` elements provide hit testing and hover feedback.

The missing behavior is full-workspace live preview before drop. Current edge-zone hover styles show only the target region, not the resulting layout.

## Design

### User Experience

Dragging starts from the Surface tab title. When the cursor enters a geometry-changing target, wmux renders a Live Layout Preview over the active workspace.

Geometry-changing targets are:

- Left/right/top/bottom edge zones.
- Center drop into another pane when the dragged Surface is the only Surface in its source pane and the source pane would collapse.

Dragging the only Surface in a pane onto an edge of that same pane is not a geometry-changing target. wmux does not model empty panes, so v1 treats that drop as a no-op and shows no Live Layout Preview.

Non-geometry targets keep existing feedback:

- Same-pane reorder keeps the insertion marker.
- Center drop into another pane keeps the center cue when the source pane will not collapse.
- Edge drop onto the source pane when it contains only the dragged Surface is a no-op.
- Invalid targets show no preview.

The preview reflows the whole workspace into the post-drop pane geometry. It includes source-pane collapse if the final drop would remove an empty source pane. The destination preview pane is subtly highlighted and shows the dragged Surface title in its tab bar.

The preview is speculative. Releasing outside a valid target or canceling the drag clears the preview with no split tree, PTY, webview, active tab, or focus change.

If pane zoom is active and a geometry-changing preview begins, the preview renders as if zoom is exited so the user can see the whole workspace consequence. If the drag is canceled, the previous zoom state is restored. After a successful geometry-changing drop, the workspace stays unzoomed.

### Rendering Model

Use a temporary preview split tree rendered by a lightweight overlay. The real `SplitContainer` remains mounted underneath so terminal and browser surfaces keep running exactly where they are.

The overlay renderer should not mount:

- `TerminalPane`
- `BrowserPane`
- `MarkdownPane`
- `DiffPane`

Instead it renders preview shells:

- Pane rectangle.
- Tab bar with representative Surface titles.
- Terminal-like placeholder lines.
- Destination highlight for the would-be landing pane.

This gives spatial fidelity without live DOM relocation.

### State And Data Flow

The real workspace `splitTree` remains the source of truth. Drag preview state is separate renderer state:

```ts
type SurfaceDragPreview =
  | null
  | {
      workspaceId: WorkspaceId;
      sourcePaneId: PaneId;
      surfaceId: SurfaceId;
      targetPaneId: PaneId;
      target: 'left' | 'right' | 'up' | 'down' | 'center';
      previewTree: SplitNode;
      destinationPaneId: PaneId;
      collapsesSourcePane: boolean;
    };
```

`previewTree` is derived from the current real split tree by pure helpers. Zustand workspace state is not updated during dragover.

On drop:

- Edge target: call existing `splitAndMoveSurface()`.
- Center target: call existing `moveSurface()`.
- Reorder target: call existing `reorderSurface()`.
- Cancel/invalid drop: clear preview only.

Preview updates should be throttled with `requestAnimationFrame`. The browser may fire many `dragover` events; React state should update at most once per animation frame.

Cleanup should run on `drop`, `dragend`, and cancel/Escape paths where available. Cleanup clears preview state and removes body drag classes without touching workspace state.

### Preview Helpers

Add pure helper functions near `split-utils.ts`. They should mirror store behavior without mutating state or creating throwaway real PTY/browser surfaces.

Suggested helpers:

```ts
previewSplitAndMoveSurface(
  tree: SplitNode,
  targetPaneId: PaneId,
  sourcePaneId: PaneId,
  surfaceId: SurfaceId,
  direction: 'left' | 'right' | 'up' | 'down',
): {
  tree: SplitNode;
  destinationPaneId: PaneId;
  collapsesSourcePane: boolean;
} | null;

previewMoveSurface(
  tree: SplitNode,
  sourcePaneId: PaneId,
  surfaceId: SurfaceId,
  targetPaneId: PaneId,
): {
  tree: SplitNode;
  destinationPaneId: PaneId;
  collapsesSourcePane: boolean;
} | null;
```

The helpers must preserve all existing Surface IDs in the preview tree and must never kill or create PTYs. If they need a preview-only pane ID, it should be clearly branded as preview-only and never passed to main-process APIs.

### Component Shape

Keep the implementation at the renderer split-pane boundary:

- `App.tsx`: owns workspace-level preview state and renders the overlay above the active workspace.
- `SplitContainer.tsx`: passes preview callbacks down to pane leaves.
- `PaneWrapper.tsx`: edge and center drop zones update or clear preview state during dragover/drop.
- `SurfaceTabBar.tsx`: starts drag from tab titles and keeps same-pane reorder behavior.
- `SplitPreviewOverlay.tsx`: new lightweight recursive renderer for `previewTree`.
- `splitpane.css`: styles preview overlay, destination highlight, and suppresses visible edge-zone hover feedback while preview is active.

Keep `.pane-drop-zone` elements for hit testing. Replace their visible edge hover feedback with the overlay for geometry-changing targets.

### Scope

Included:

- Active workspace only.
- Surface drag that starts from a tab title.
- Edge split preview.
- Source-pane collapse preview.
- Center move preview only when geometry changes through source collapse.
- Zoom exit for geometry-changing preview/drop.

Excluded:

- Cross-workspace drag.
- Cross-window drag.
- Moving whole panes.
- Moving native OS console windows.
- Dragging by terminal content area.
- Live relocation of actual xterm/browser/markdown DOM during drag.
- Custom drag image beyond current browser drag behavior.

## Acceptance Criteria

- Dragging a Surface tab over a left/right/top/bottom edge shows a full-workspace Live Layout Preview matching the post-drop pane geometry.
- The destination preview pane is subtly highlighted and shows the dragged Surface title.
- The real layout, PTYs, browser surfaces, active tabs, and focused pane do not change until drop.
- Dropping commits the same result as today's edge drop behavior.
- Canceling or dropping outside a valid target clears the preview with no state change.
- Dragging the only Surface out of a pane previews source-pane collapse.
- Same-pane reorder remains insertion-marker only.
- Center drop remains the existing center cue unless source-pane collapse changes layout.
- If zoom is active, geometry-changing preview shows the full workspace; cancel restores zoom and successful geometry-changing drop remains unzoomed.
- Preview updates feel continuous and are internally animation-frame throttled.

## Testing Strategy

Unit test the pure preview helpers:

- Edge split right/left/down/up.
- Left/up child ordering.
- Dragging the only Surface out of a pane collapses the source pane in the preview.
- Center move with source collapse.
- Center move without source collapse returns `null` because it does not need a geometry preview.
- Invalid source/target/surface returns `null`.
- All original Surface IDs survive in the preview tree.

Manual verification:

- `npm run build:renderer`.
- `npm run dev`.
- Drag across multiple panes and edges.
- Drag last Surface out of a pane.
- Drag the only Surface onto its own pane edge and verify no preview/drop change.
- Cancel drag outside valid targets.
- Reorder tabs inside a pane.
- Center drop between panes.
- Drag while a pane is zoomed.

## ADR Decision

No ADR is needed. This is a localized extension of the existing drag-and-drop design, reversible, and unsurprising once the feature spec exists.
