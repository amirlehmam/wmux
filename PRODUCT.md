# wmux

<!-- impeccable:product-schema 1 -->

## Platform

web

Electron desktop application for Windows. The desktop renderer uses React and CSS; this record concerns the desktop workspace, not the marketing site or phone Remote Console.

## Users

Developers running several terminal sessions and coding agents concurrently. The owner uses a dense split workspace and wants a more carefully designed daily working environment.

## Product Purpose

Keep terminal sessions, agent activity, project files, browser tools, and Git review together in a persistent workspace. Users should identify the active task and agents needing attention without losing their place.

## Operating Context

Long working sessions with multiple projects, split panes and tabs, live terminal output, keyboard shortcuts, and optional file and browser panels.

## Capabilities and Constraints

- Preserve terminal content, keyboard input, split resizing, tab dragging, keep-alive terminals, and session persistence.
- Preserve user terminal color schemes, transparency preferences, independent UI themes, and status color meanings.
- Retain almost all existing information density; the owner confirmed this tradeoff and delegated remaining design decisions.
- Keep the Windows window controls and drag regions functional.
- The renderer uses React 19, Zustand and xterm.js. Browser surfaces use Electron webviews.
- The requested work changes desktop workspace chrome; the Remote Console and website remain separate surfaces.

## Brand Commitments

Keep the wmux name and existing logo. Product interface text and source documentation use English; localized strings continue through the existing translation system.

## Product Principles

- Let work occupy most of the window.
- Make focus, selection, and agent attention distinguishable.
- Preserve familiar keyboard and pointer interactions.
- Improve separation and hierarchy without turning each pane into a spacious dashboard card.

## Evidence on Hand

The owner's October 31, 2026 screenshot shows a dense dark workspace with three terminals and a narrow Git pane. Existing desktop components and styles are implementation evidence, not an approved visual redesign.
