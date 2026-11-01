---
title: 'wmux: A terminal multiplexer for supervising AI coding agents on Windows'
tags:
  - TypeScript
  - Electron
  - terminal multiplexer
  - large language models
  - AI coding agents
  - human-AI interaction
  - software engineering
authors:
  - name: Amir Lehmam
    affiliation: 1
affiliations:
  - name: Independent researcher
    index: 1
date: 2 November 2026
bibliography: paper.bib
---

# Summary

Command-line AI coding agents such as Claude Code [@claudecode], Codex CLI
[@codexcli] and OpenCode [@opencode] read a codebase, run commands and edit files
on a developer's behalf. They run inside a terminal, and a single person now
often runs several of them at once, each in its own terminal, on separate tasks.
Keeping track of which agent is working, which one is waiting for a decision and
what each one did is hard with ordinary terminal tools.

`wmux` is an open-source desktop application for Windows that gives these
agents and the person supervising them a shared workspace. It arranges many
terminals in split panes and tabs, groups them into workspaces, and adds a
built-in web browser and Markdown viewer next to them. Agents talk to `wmux`
through a small command-line interface (CLI): they can report that they are
working, idle or blocked on a question, open a page in the browser panel the
human is watching, or show a plan as a rendered document. The sidebar then shows
the human, at a glance, which agent needs attention, and lets them answer an
agent's question without switching to its terminal.

# Statement of need

Research on AI-assisted software engineering increasingly studies agents that
act through a terminal or a constrained computer interface
[@yang2024sweagent; @wang2024openhands]. In daily use, and in many experiments,
these agents run inside a terminal emulator that knows nothing about them. The
established multiplexers, GNU Screen [@screen], tmux [@tmux] and Zellij
[@zellij], were designed for long-running shell sessions on Unix-like systems.
They expose no notion of an agent's state, and tmux and Screen do not run
natively on Windows, where many developers and students work.

`wmux` targets three audiences: developers who run several coding agents in
parallel on Windows; researchers who study how people delegate work to, and
supervise, such agents; and authors of agent tools who need a stable, scriptable
surface in which to show progress, ask questions and display results. It
addresses the following problems:

1. **Agent state is guessed, not known.** Tools that infer whether an agent is
   busy by scraping its terminal output break whenever the agent's interface
   changes. `wmux` instead lets agents *declare* their state through hooks and
   the CLI, and treats a declared `blocked` state as authoritative until the
   agent itself clears it.
2. **Supervising many agents does not scale in plain terminals.** `wmux` gives
   each agent a pane, aggregates their states in one sidebar, and relays
   answers to blocked agents as exact keystrokes the agent declared in advance.
3. **Agents lack a visible browser and document surface.** Agents that browse
   the web usually do so in a headless browser the human cannot see. `wmux`
   embeds a browser panel that agents drive through its CLI and that is also
   exposed through a Chrome DevTools Protocol endpoint, so the human watches
   what the agent does.

# State of the field

Terminal multiplexers (Screen, tmux, Zellij) solve session persistence and
layout, but not agent awareness. Modern terminal emulators such as Windows
Terminal [@windowsterminal] provide tabs and panes on Windows, without a
programmable interface for agents. Agent research frameworks such as SWE-agent
[@yang2024sweagent] and OpenHands [@wang2024openhands] define their own
agent-computer interface and typically run agents in containers, which suits
benchmarks but not the interactive, multi-agent use of off-the-shelf
command-line agents.

Contributing these features to an existing multiplexer was considered and
rejected for two reasons. First, the browser panel, rendered Markdown and
per-pane agent state require a graphical host, which a text-only multiplexer
cannot provide. Second, Windows' pseudo-console (ConPTY) [@conpty] behaves
differently from Unix pseudo-terminals in ways that affect rendering and
process lifetime, so a Windows-first design was needed rather than a port.
`wmux` builds on existing components rather than reimplementing them: Electron
[@electron] for the application shell, xterm.js [@xtermjs] for terminal
rendering and node-pty [@nodepty] for pseudo-terminals.

# Software design

`wmux` is written in TypeScript, with a React user interface and a Zustand
store. Its main design decisions are:

- **A CLI over a named pipe, not a protocol server.** Agents control `wmux`
  with the `wmux` command, which sends one JSON-RPC request per connection over
  the Windows named pipe `\\.\pipe\wmux`. Every agent that can run a shell
  command can therefore use it, without a client library or a long-lived
  connection. The same pipe serves the shell-integration hooks that report the
  working directory and prompt boundaries.
- **Declared state with explicit precedence.** Agent state comes from hooks
  installed into each supported agent (Claude Code, Codex, OpenCode, Kiro, Qwen
  Code and others) and from `wmux report-agent`. Declared state overrides any
  heuristic; answering a blocked agent never clears its state, because only the
  agent knows whether the answer was accepted. `wmux` never invents a
  keystroke: it sends only the bytes an agent declared for each answer.
- **Consent before writing outside its own directory.** Integrating with an
  agent requires writing to that agent's configuration. Every such write goes
  through a single consent gate and has a recorded inverse, so a user can see
  and undo what `wmux` changed.
- **Terminals that survive layout changes.** Terminal instances are kept alive
  in a host component and moved between panes, so splitting or rearranging
  panes never restarts an agent or loses its scrollback.
- **Prompt boundaries from one producer.** Where a user prompt starts is taken
  either from an agent hook (with its text) or from OSC 133 shell marks (as a
  boundary only), never from heuristics. Highlighting, pinning and jumping
  between prompts all read this single log.
- **Jailed file access.** The file explorer, diff view and editors resolve every
  path inside a workspace root, and every write from the interface must target
  a file opened in a live pane and unchanged on disk since.

The project has about 390 unit test files run with Vitest, and every release is
built, tested and published by continuous integration from a version tag.

# Research impact statement

`wmux` has been developed in public since March 2026 and has had more than 200
tagged releases. As of November 2026 the repository has more than 430 stars,
more than 90 forks, 43 contributors and more than 170 pull requests from people
other than the maintainer, and it is distributed through its own installer,
Scoop and winget.

We are not yet aware of peer-reviewed publications that cite `wmux`. Its
research relevance is as an instrument: it records, per agent and over time,
declared states (working, idle, blocked), the questions agents ask and the
answers humans give, and prompt boundaries. This makes it a practical
environment for studying how people supervise several AI coding agents at once,
how often agents block on human input, and how reliable declared state is
compared with output scraping.

# AI usage disclosure

Generative AI was used extensively. Most of the source code, tests and
documentation of `wmux` were written with Claude Code [@claudecode] using
Anthropic Claude models, under the author's direction; the author chose the
problems, made the design decisions recorded above and reviewed changes before
release, and each change was checked with the unit test suite and by running
the application. This paper was drafted with Claude Code (Claude Opus 5.5)
from the repository and its design notes, and was reviewed and edited by the
author, who takes responsibility for its content.

# Acknowledgements

We thank the contributors who reported issues and submitted pull requests to
`wmux`. This work received no specific financial support.

# References
