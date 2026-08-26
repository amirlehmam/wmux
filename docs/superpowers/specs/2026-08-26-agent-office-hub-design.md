# Agent Office Hub (easter-egg overlay) - Design

Date: 2026-08-26
Status: approved (design), pending implementation plan

## Summary

A full-window overlay that renders every detected/declared agent in this wmux
window as a pixel-art character working in a tiny office. One desk table per
workspace; characters walk in, type while working, show a "!" speech bubble
while blocked on the user, take a break when idle, and walk out when their pane
closes. Hovering a character shows its model and stats; clicking it jumps to
its pane; clicking a "!" bubble shows the agent's declared answer choices as
buttons and answers through the existing back-channel.

Build-vs-connect decision: build our own. The pixel-agents project
(github.com/pixel-agents-hq/pixel-agents, MIT) was evaluated; its standalone
CLI detects Claude Code sessions only (hooks into `~/.claude/settings.json`
plus transcript scanning), maps offices to workspace folders rather than wmux
workspaces, and cannot reach wmux's interactivity (focus pane, answer
choices). wmux already owns the hard 80% - the agent-agnostic declared state
feed (issue #128) - so only the rendering layer is new. We borrow pixel-agents'
proven shape (Canvas 2D, tile grid, per-character state machines) and nothing
else.

## Decisions taken (with the user, 2026-08-26)

1. Build our own inside wmux, no pixel-agents connector.
2. Mounting: full-window overlay (Agent Navigator pattern), not a surface
   type, not a dock.
3. Interactivity: watch + jump + answer (all three).
4. Art: original hand-authored sprites, CC0 assets (e.g. Kenney) allowed as
   base/inspiration. No third-party sprite files shipped.
5. Handoff animation: fake it heuristically (no real signal exists).

## 1. Mounting and opening

- New component `HubView`, mounted as a conditional sibling in `App.tsx`'s
  root, exactly like `AgentNavigator` (backdrop, `role="dialog"`, Escape to
  close, own stylesheet `src/renderer/styles/hub.css`).
- Open paths:
  - Keyboard shortcut, default `Ctrl+Shift+O`, registered in
    `settings-slice.ts` and labeled in `KeyboardSettings.tsx`.
  - Command Palette entry ("Open Agent Office").
  - CLI: `wmux hub`, following the `diff.refresh` pattern: one `SPECS` entry
    (`hub.open`) in `src/main/v2-bridge.ts` whose js calls
    `window.__wmux_openHub?.()`; `pipe-bridge.ts` defines that global to
    dispatch a `wmux:open-hub` CustomEvent; `App.tsx` listens and opens.
    CLI side: `COMMAND_SPECS` entry + handler + usage text in
    `src/cli/wmux.ts`.
- Closed means unmounted: no timers, no rAF, no canvas, no sim state. This is
  the performance guarantee - the hub costs nothing while not visible.

## 2. Data layer

No new state sources. The hub consumes existing store data:

- `rollupAgents(workspaces, agentStates, now, agentIdentities,
  agentDetections)` from `src/renderer/store/agent-rollup.ts` provides the
  roster (one entry per agent surface, in workspace order), per-workspace
  counts, blocked list, `state` (blocked/working/idle/unknown),
  `blockedReason`, declared `choices`, `answerPending`, `dwellMs`, `kind`,
  labels.
- `workspaces` from the store: workspace list, titles, order. A new workspace
  appears as a new table on the next recompute; a removed one disappears.
- Typed change (type-only): `DeclaredAgentSnapshot` in `agent-rollup.ts`
  gains the `metadata` fields already present in the stored payload at
  runtime (`model?`, `tokens?`, `contextPct?`, `expiresAt?`), and
  `AgentRosterEntry` carries them through for the hover tooltip. Respect the
  existing TTL semantics (stale metadata is dropped main-side).
- Recompute cadence: on store change (Zustand subscription) plus a 1 s tick
  while the overlay is open (for dwell times and metadata expiry), mirroring
  `AgentRosterBanner`.
- Jump-to-pane reuses `focusAgentTarget(ops, target)` from
  `src/renderer/store/focus-agent.ts`.
- Answering reuses `window.wmux.agentState.answer(surfaceId, choiceId)`.
  Per the issue #128 contract, answering does NOT clear blocked; the UI shows
  an "answered, waiting" bubble until the agent reports unblocked
  (`answerPending` / state change).

Out of scope: `claudeActivity` / `hookActivity` detail (lives in App.tsx local
state, not the store). The hub does not need per-tool animation fidelity in
v1; the roster states are enough. If finer animation is wanted later, those
two belong in a slice first.

## 3. Rendering

- One `<canvas>` element filling the overlay, `image-rendering: pixelated`,
  sized to the window with a devicePixelRatio-aware backing store.
- Canvas 2D only. No new dependencies (no PixiJS/WebGL); the workload is a
  few dozen 16x16 sprites.
- Sprites are code, not binary assets: characters, furniture, and floor tiles
  are string-encoded pixel maps plus palettes in
  `src/renderer/components/Hub/sprites.ts`, rasterized once at mount into
  offscreen canvases. Consequences:
  - No changes to the release process (everything is inside the Vite
    renderer bundle; the release staging steps are untouched).
  - Diffable in code review; adding a character variant is adding a string
    block.
  - Original artwork, CC0-inspired; no license exposure.
- Render loop: `requestAnimationFrame` while mounted, drawing at display
  rate; sim runs on a fixed timestep (see 5) accumulated inside the rAF
  callback. When the document is hidden, rAF throttles naturally; no extra
  work needed.

## 4. Office model

- Layout is procedurally generated by `office-layout.ts` (pure function):
  input `(workspaces, roster)`, output a tile map, desk assignments
  (surfaceId -> desk tile + chair orientation), walk waypoints, break room
  and door positions.
- One table per workspace, labeled with the workspace title. Desks per table
  scale with that workspace's agent count. Tables flow into a grid that grows
  row by row as workspaces are added.
- Fixed fixtures: entrance door (bottom), break room (couch + coffee
  machine) in a reserved corner.
- Corridors between tables are generated at least 2 tiles wide and aligned,
  so all walks are L-shaped (at most one corner) along corridors: no
  pathfinding algorithm needed.
- Scaling: the whole office renders at the largest integer pixel scale that
  fits the window; below scale 1 it falls back to fractional scaling. No
  scrolling in v1.
- Character identity: variant (human/animal) and palette chosen by a stable
  hash of surfaceId, so an agent keeps its appearance across openings. Agent
  `kind` (claude/opencode/kiro/...) is shown as a small colored badge on the
  character and in the tooltip.

## 5. Character simulation

`office-sim.ts` (pure, fixed 10 Hz timestep, deterministic given inputs +
seeded RNG). Per-character state machine:

- `arriving`: spawns at the door, walks to its assigned desk.
- `working`: sits, typing animation (2-3 frames).
- `blocked`: typing stops, "!" speech bubble; bubble pulse rate increases
  with `dwellMs` thresholds (e.g. >1 min, >5 min).
- `answered-waiting`: after the user answers from the hub, an hourglass
  bubble until the agent confirms unblocked.
- `idle`: stands up, walks to the break room, loops a coffee/rest animation.
- `leaving`: roster entry disappeared (pane closed): walks to the door and
  despawns.
- Reconciliation: each sim tick diffs the roster against live characters -
  new surfaceIds spawn as `arriving`, missing ones transition to `leaving`,
  state changes retarget the state machine. Desk reassignment (layout grew)
  walks the character to the new desk.
- Handoff heuristic (cosmetic, explicitly allowed to be wrong): when agent A
  transitions working->idle and agent B in the same workspace transitions
  idle/unknown->working within 5 s, A first walks to B, both play a short
  chat animation with a speech bubble, then A continues to the break room.
- Caps for sanity: if more than 64 agents exist, excess roster entries are
  represented by a counter sign near the door instead of characters (keeps
  layout and sim bounded; realistically unreachable).

## 6. Interactivity

- Hit testing: pointer position against character bounding rects (canvas
  coordinates); no per-character DOM.
- Hover: DOM tooltip absolutely positioned over the canvas showing label,
  kind, state + duration (formatDwell), model, tokens, context-%.
- Click character: `focusAgentTarget` + close overlay.
- Click "!" bubble (or blocked character): DOM popover listing
  `blockedReason` and the declared choices as buttons; a click calls
  `agentState.answer`. Refusal (stale/not blocked) falls back to focusing
  the pane, same as `WorkspaceRow.answerSession`.
- Escape closes popover first, then the overlay. Backdrop click closes.

## 7. File plan and testing

New:

- `src/renderer/components/Hub/HubView.tsx` - overlay shell, canvas, rAF,
  tooltip/popover DOM, store subscriptions.
- `src/renderer/components/Hub/office-layout.ts` - pure layout generator.
- `src/renderer/components/Hub/office-sim.ts` - pure simulation.
- `src/renderer/components/Hub/sprites.ts` - pixel data + rasterizer.
- `src/renderer/styles/hub.css`
- `tests/unit/office-layout.test.ts`, `tests/unit/office-sim.test.ts`
  (Vitest; TDD for layout and sim: growth, reconciliation, handoff
  heuristic, walk paths, caps).

Modified:

- `src/renderer/App.tsx` - mount + `wmux:open-hub` listener + open state.
- `src/renderer/hooks/useKeyboardShortcuts.ts`,
  `src/renderer/store/settings-slice.ts`,
  `src/renderer/components/Settings/KeyboardSettings.tsx` - shortcut.
- `src/renderer/components/CommandPalette/CommandPalette.tsx` - entry.
- `src/renderer/store/agent-rollup.ts` - metadata typing passthrough.
- `src/renderer/pipe-bridge.ts`, `src/main/v2-bridge.ts`,
  `src/cli/wmux.ts` - `wmux hub`.
- `src/renderer/i18n/locales/en.ts` - strings (other locales fall back).

Rendering itself (HubView drawing code) is covered by manual testing; all
behavioral logic lives in the pure modules under unit test.

## 8. Known limitations and growth paths

- Only detected/declared agents appear; a plain shell pane has no character.
  Correct by design: the office reflects the roster, not raw panes.
- "Walk home and disappear" maps to pane-closed only; an idle-but-open agent
  rests in the break room. The office never shows less than reality.
- The handoff animation is a heuristic and can misfire; it is cosmetic only.
- Not built now, path kept open: real handoff signal
  (`wmux report-agent --handoff <surface>` + state field), pets/decorations,
  sound effects, layout persistence/editor, per-tool animations (needs
  claudeActivity/hookActivity moved into a store slice), scrolling/panning
  for very large offices.
