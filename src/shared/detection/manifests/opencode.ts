/**
 * OpenCode.
 *
 * Authored from a live `opencode` 1.17 pane in wmux
 * (tests/fixtures/detection/opencode-idle.txt).
 *
 * Same caveat as codex.ts: the capture session's configured provider (a local
 * Ollama) was not running, so OpenCode never reached a working turn and no
 * `working` screen was observed. Only the shapes that were actually seen are
 * encoded; a running turn reads as `unknown` rather than as a guess.
 *
 * OpenCode is also one of the three agents that DOES report declared state, via
 * the wmux plugin — so for most users this manifest never decides anything.
 * Detection sits strictly below the declared layer; this exists for the pane
 * where the plugin is not installed.
 */
import { Manifest } from '../types';

export const opencodeManifest: Manifest = {
  agent: 'opencode',
  version: 1,

  signatures: [
    // The status bar: `<cwd>:<branch>  ⊙ N MCP /status        <version>`.
    { kind: 'contains', value: 'MCP /status' },
    // The composer hint row.
    { kind: 'contains', value: 'ctrl+p commands' },
    { kind: 'contains', value: 'Ask anything...' },
  ],

  rules: [
    /**
     * Idle — the empty composer, still showing its placeholder.
     *
     * The placeholder is drawn only when the input is empty, which is a
     * stronger idle signal than the hint row (that stays up mid-turn).
     */
    {
      id: 'opencode.idle.placeholder',
      state: 'idle',
      priority: 100,
      region: { id: 'bottom_non_empty_lines', count: 12 },
      all: [{ kind: 'contains', value: 'Ask anything...' }],
    },
  ],
};
