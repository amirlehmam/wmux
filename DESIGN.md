---
name: "wmux Desktop"
description: "Dense, distinct working surfaces for persistent terminal work."
colors:
  accent: "#0091ff"
  accent-light: "#0067c0"
  accent-contrast: "#ffffff"
  bg-0: "#14171e"
  bg-1: "#191d26"
  bg-2: "#202530"
  bg-3: "#272e3a"
  bg-4: "#303947"
  bg-5: "#3a4555"
  border: "#343e4e"
  border-strong: "#56647a"
  text-primary: "#e8edf5"
  text-secondary: "#bac5d5"
  text-muted: "#96a3b7"
  bg-0-light: "#e8edf4"
  bg-1-light: "#f2f5f9"
  bg-2-light: "#ffffff"
  bg-3-light: "#e8eef6"
  bg-4-light: "#dce5f0"
  bg-5-light: "#ced9e8"
  border-light: "#c8d2e0"
  border-strong-light: "#93a3b9"
  text-primary-light: "#202b3b"
  text-secondary-light: "#46556b"
  text-muted-light: "#5f6e83"
  agent-blocked: "#b388ff"
  agent-blocked-light: "#6a3ab8"
  agent-question: "#4fb3d9"
  agent-question-light: "#006b87"
  danger: "#b3261e"
  trace-bus: "#7a4f27"
  trace-bus-dim: "#56381c"
  trace-current: "#ffc078"
  trace-current-hot: "#fff0d6"
  trace-ingest: "#37c3d6"
  trace-mutate: "#db6bd0"
  trace-exec: "#a6d93b"
  trace-delegate: "#7a9bff"
  trace-blocked: "#ff5c5c"
  trace-bus-light: "#a86a32"
  trace-bus-dim-light: "#cbb59d"
  trace-current-light: "#c2560d"
  trace-current-hot-light: "#8a3c06"
  trace-ingest-light: "#0e7f8f"
  trace-mutate-light: "#a4308f"
  trace-exec-light: "#4f7c14"
  trace-delegate-light: "#3355c9"
  trace-blocked-light: "#c62828"
typography:
  title:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    letterSpacing: "0.01em"
  workspace-title:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "12px"
  label:
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "11px"
    lineHeight: 1.3
  context:
    fontFamily: "'Cascadia Mono', 'Consolas', monospace"
    fontSize: "10.5px"
    lineHeight: 1.4
rounded:
  tab: "5px"
  control: "6px"
  pane: "8px"
  settings: "10px"
spacing:
  micro: "2px"
  tight: "4px"
  workspace: "6px"
  small: "8px"
  control: "10px"
  medium: "12px"
  section: "16px"
  large: "24px"
components:
  button-primary:
    backgroundColor: "color-mix(in srgb, var(--ui-accent) 20%, transparent)"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.tab}"
    padding: "5px 14px"
  button-secondary:
    backgroundColor: "rgba(var(--ui-overlay-rgb), 0.08)"
    textColor: "rgba(var(--ui-overlay-rgb), 0.75)"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  input:
    backgroundColor: "{colors.bg-4}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
    padding: "5px 10px"
  workspace-row:
    rounded: "{rounded.pane}"
    padding: "8px 10px 8px 14px"
    typography: "{typography.workspace-title}"
  surface-tab:
    rounded: "{rounded.tab}"
    height: "24px"
    padding: "0 8px"
    typography: "{typography.body}"
  pane:
    rounded: "{rounded.pane}"
  surface-menu:
    backgroundColor: "{colors.bg-1}"
    rounded: "{rounded.pane}"
    padding: "5px"
  worktree-badge:
    backgroundColor: "color-mix(in srgb, var(--ui-accent) 15%, transparent)"
    textColor: "{colors.accent}"
    padding: "1px 4px"
---

# Design System: wmux Desktop

## Overview

**Creative North Star: "Modular Swiss technical publishing"**

A restrained slate shell holds dense, distinct working surfaces. Small inset tabs and soft rectangular frames separate concurrent tasks while keeping terminal content dominant. Familiar controls and stable labels support long working sessions.

The shared shell uses system sans labels, monochrome SVG controls, and precise selection marks. Cool white surfaces reuse the geometry in light mode. Classic and TRACE are existing sidebar presentations within this desktop system; terminal fonts, colors, backgrounds, and opacity remain independently configured.

**Key Characteristics:**
- Dense working surfaces with visible perimeter and split gutters.
- Matching accent treatment on the focused pane and its selected tab.
- Semantic agent attention remains distinct from navigation selection.
- Independent terminal themes; shared desktop chrome tokens.

This record covers the desktop renderer only. The website and phone Remote Console have separate visual systems. Source evidence: `src/renderer/styles/{theme-vars,global,splitpane,sidebar,titlebar,trace,settings,git,terminal}.css`, `components/SplitPane/{SurfaceTabBar,icons}.tsx`, and `hooks/usePaneFill.ts`. The surface contract is `.impeccable/surfaces/src-renderer-app-tsx.md`; the implemented source owns all values below.

## Colors

Slate neutrals separate shell, working surfaces, and elevated controls; theme-aware blue connects focus and selection.

### Primary

- **Focus blue:** `accent` and `accent-light` track the UI theme. Use the live `--ui-accent` variable; the light-suffixed frontmatter entries describe theme substitutions, not extra simultaneous accents.
- **Contrast white:** text on controls that explicitly use accent contrast.

### Neutral

- **Recess through control:** `bg-0` through `bg-5` describe the reused elevation ramp. Titlebar and sidebar use the deepest recess; the workspace ground uses the next step; pane headers use the working-surface step. Controls use higher steps.
- **Hairline and strong border:** separate frames and dialog edges without heavy rules.
- **Primary, secondary, muted text:** distinguish task names, supporting controls, and metadata. Their light-theme counterparts replace the same roles. Overlay RGB switches from white to black when light mode is selected.

### Semantic states

- **Needs you:** classic uses the violet blocked tokens; ordinary questions use cyan question tokens. Both have light-theme substitutions. Working remains amber, done/idle dots green, interrupted red; these are state meanings, not new decorative accents.
- **TRACE:** copper bus and dim copper mark topology; warm current shows traffic. Ingest, mutate, execute, and delegate use separate channel tokens. TRACE rebinds the shared blocked token to its own red, including the light variant, so the sidebar, roster, and tabs agree.
- **Danger:** reserved for destructive confirmation and warnings.

**The State Before Decoration Rule.** Selection must preserve readable agent state. The default workspace selection uses an accent rail, a slight tint, and an inset hairline; the user-selected solid-fill presentation remains supported.

The sidecar's eight-step tonal ramps are generated swatch previews, not additional runtime colors. Legacy fixed working/done/interrupted colors are deliberately not promoted into new theme tokens: their light-theme contrast needs a separate review.

## Typography

**Body and labels:** the frontmatter's system sans stack. **Context and technical metadata:** Cascadia Mono with Consolas and monospace fallbacks. Terminal typography is independently configured and is outside this record.

### Hierarchy

- **Title:** settings dialog heading; a modest interface title, with no desktop display or hero role.
- **Workspace title:** semibold project name; sidebar text scaling multiplies the recorded base size. Classic leading is recorded in frontmatter; TRACE tightens it to (1.2).
- **Body:** tabs, Git view, common controls, and confirmation copy. Titlebar text uses the same size at medium weight (500).
- **Label:** status and supporting information; TRACE tightens status leading to (1.2).
- **Context:** branches and paths, with ellipsis and slightly looser classic leading. TRACE tightens context leading to (1.25).

Legacy TRACE tool labels and odometers remain small technical metadata. Their existing sizes are not a recommended lower bound for new readable interface text. New headings do not inherit metadata styling.

## Layout

The desktop fills the window. A fixed titlebar (38px) sits above a resizable sidebar and the persistent split workspace. It preserves a window-control region (140px) and separate drag/no-drag areas for the native window behavior. There is no centered page container or marketing grid.

Workspace perimeter and split dividers share the workspace spacing token. Pane headers are fixed (32px); tabs are inset within them. The tab strip uses a small gap (2px), leaves controls reachable, scrolls horizontally with wheel input, and reveals the selected tab without scrolling the workspace. Labels ellipsize rather than increasing the header height.

At pane container widths of (300px) or less, the dedicated split shortcut disappears, tab horizontal padding tightens to (5px), and the tab gap tightens to (4px). Both split actions remain in the layout dropdown; New and Close remain available. This is a pane-container change, not a mobile-page breakpoint. The desktop retains its split topology at compact window sizes.

The sidebar list uses (6px 8px) padding and (4px) gaps. Classic workspace rows use the recorded row padding; TRACE uses (4px) vertical padding and an (18px) left inset for its bus. Titles truncate by default; the user's wrap preference permits two lines. Sidebar text scaling changes type independently of icons and sidebar width.

**The Working Surface Rule.** Separate panes with the existing workspace inset and split gutters. Preserve dense headers and terminal area instead of adding dashboard padding.

## Elevation & Depth

Workspace depth comes from the neutral ramp, one-pixel frames, and selection tints. Panes have no resting drop shadow. Portalled menus and modal dialogs use soft black shadows so they read above live content; rounded panes are structural working surfaces rather than elevated dashboard cards.

### Shadow Vocabulary

- **Menu:** `0 8px 24px rgba(0,0,0,0.6)` for surface action dropdowns.
- **Confirmation:** `0 8px 32px rgba(0,0,0,0.5)` for confirmation dialogs.
- **Settings:** `0 24px 64px rgba(0,0,0,0.7)` for the settings window.
- **Workspace selection:** inset hairline derived from the row accent and normal border; it is an outline, not lift.

**The Perimeter Paint Rule.** In transparent windows, paint the workspace perimeter and dividers without adding a second translucent background beneath terminals. Keep the titlebar and sidebar opaque.

The transparent root layers stop painting. The workspace substitutes a border for ordinary padding, filled with `--wmux-pane-gutter` and falling back to the working-surface color. Dividers match terminal opacity below the pane headers and remain opaque alongside headers. Focus uses `--wmux-pane-ring`, an opaque mix of terminal background and accent, when resolvable. Ordinary opaque frames mix accent (55%) with the standard border. Keep these rendering paths separate so transparency does not create bright seams or double-composite the terminal.

## Shapes

Soft rectangular frames use the pane radius. Pane header and content clipping follow the frame's inner radius, one pixel smaller. Inset tabs use the tab radius; common controls and fields use the control radius; the settings window uses the larger settings radius. One-pixel outlines and narrow gutters provide separation without increasing the workspace's density substantially.

Circular state dots are functional signals. TRACE's copper rails and connected vias are native to its existing circuit-board presentation; do not forbid those devices globally when extending the publishing-based shell.

## Components

### Buttons

Compact controls use transparent or softly tinted backgrounds, modest rounding, and monochrome SVGs. Header controls are (24px) high, with normal minimum width (26px); titlebar controls are (28px) square. Hover lifts the surface and text. New, Layout, and Close retain their existing contextual hover cues. Keyboard focus uses the shared accent outline (2px) with inset offset (-2px), except components with an explicit local focus rule.

Primary confirmation buttons use an accent tint rather than a large solid call-to-action. Settings secondary buttons use the overlay tint. Disabled controls retain their existing opacity treatment; do not introduce a new button hierarchy from the settings class name alone.

### Inputs / Fields

Settings fields use the raised control background, a quiet one-pixel border, compact padding, and the control radius. Focus changes the border to the shared accent. Dialog text fields use the recessed background and a one-pixel accent outline. Technical command editors use monospace; ordinary project names use the UI sans stack.

### Navigation

Workspace rows preserve hierarchy between semibold name, colored status, and muted monospace context. Active rows use a slight accent mix (8%), an inset hairline, and the narrow selection rail; custom workspace colors substitute the row accent. Solid fill remains an explicit user preference rather than the default treatment.

### Pane frame and surface tabs

The focused frame and selected tab share the accent. Focused tabs use accent-tinted raised fill (14%) and mixed outline (38%); selected tabs in unfocused panes use the neutral control background. Surface-type and menu icons share the same inline SVG stroke vocabulary. Close controls reveal on hover, active tab, and focus within. Menus portal outside pane clipping.

### Worktree badges

Small inline technical badges use monospace, accent text, a faint accent fill, a fine mixed border, and compact rounding. They annotate an existing name rather than becoming a second heading.

### Classic and TRACE agent activity

Classic uses text, state dots, and a selection rail. TRACE adds copper topology, channel-colored tool labels, event-triggered via pings, and activity-driven current. Blocked outranks working in both presentations. Reduced motion retains frozen current marks, static tool rings, and a dashed blocked rail. Visibility pausing stops hidden TRACE animation.

**The Signal Motion Rule.** TRACE motion follows actual activity. Idle rows do not animate; reduced motion retains static state information.

## Do's and Don'ts

### Do:
- **Do** use shared UI variables for shell backgrounds, text, borders, and theme-aware accent colors.
- **Do** join the focused pane frame and selected tab through the existing accent mixes.
- **Do** preserve terminal color schemes, geometry measurement, keep-alive rendering, and user density preferences.
- **Do** use inline SVG for new chrome controls and preserve visible keyboard focus.
- **Do** retain classic and TRACE state meanings and reduced-motion equivalents.

### Don't:
- **Don't** paint another translucent layer beneath terminals when adding workspace spacing.
- **Don't** use navigation selection to erase default agent state colors.
- **Don't** turn pane frames into floating cards with permanent drop shadows.
- **Don't** inherit legacy glyph icons, fixed light-mode status colors, or small metadata sizes as a new display style.

Not canonized or repaired: inherited Unicode icon/odometer markers outside the updated tab controls, fixed state colors without light-theme substitutions, and very small legacy metadata remain existing craft debt. This documentation pass owns the recorded system, not repairs to unrelated components.
