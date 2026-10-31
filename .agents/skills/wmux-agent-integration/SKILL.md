---
name: wmux-agent-integration
description: How to add or change wmux's integration with a coding agent (Claude Code, Codex, OpenCode, Kiro, Grok, omp, pi, agy, Qwen) - the consent gate, instruction blocks, hooks and plugins with their version markers, and restoring sessions on restart. Use when editing a src/main/*-context.ts or *-resume.ts file, agent-integration.ts, codex-launcher.ts, src/cli/wmux-hook.ts, resources/opencode-plugin or resources/pi-extension, or adding support for a new agent.
---

# wmux agent integrations

A `*-context.ts` file writes what an agent needs into that agent's own config. A `*-resume.ts` file reopens the agent's session when wmux restores a pane. Read the module's header first: each one records what was checked against which version of that agent. Check new behaviour against the real CLI and record the version there.

## Writing outside wmux's directory

- **Consent gate.** Every write outside `%APPDATA%\wmux` goes through `agent-integration.ts` (#132). Add your `ensureX` and `removeX` to `applyFeature`, never to startup, and add the exact paths to `INTEGRATION_CONSENT_DETAIL` and the `pathHint` in `AgentIntegrationSettings.tsx` so both stay true.
- **Choose the feature carefully.** The features are `instructions`, `hooks`, `orchestrator` and `browserMcp`. Don't move an existing writer to another feature: that silently re-enables it for anyone who switched it off under the old one.
- **Removal is complete.** A declined or switched-off feature takes back what it wrote on every launch, including from any other home an earlier launch may have used (`QWEN_HOME`).
- **Don't create an agent's home.** Gate every write on the directory existing, so a machine that never ran the agent gets nothing. Honour a home override from the environment only when it is absolute.
- **Leave the user's content alone.** In a shared file, write between markers (`injectWmuxBlock`, `stripWmuxBlock`) and keep their keys. A file without wmux's marker isn't ours to delete, even at wmux's usual path.
- **Instruction text has one source:** `resources/claude-instructions.md`, rendered by `agent-instructions.ts`.

## Hooks and plugins

- **Hook command bytes come from `claude-context.ts`** (`applyWmuxHooks`, `wmuxEventHookCommand`). Grok dedupes handlers on the exact command, so a respelled string runs every hook twice.
- **Tag a Claude-shaped payload with its provider.** Qwen's hooks pass `--provider qwen`, or `wmux-hook.js` would record its session as Claude's and a restore would type `claude --resume <qwen-id>`.
- **Bump the version marker on any plugin change.** Installing is gated on the marker (`// wmux-plugin-version:` in the OpenCode plugin; pi and agy have their own), so without a bump the change reaches nobody.
- **OpenCode's plugin file has export rules** that break loading if ignored. They're in the `opencode-context.ts` header.
- **Assume old copies.** Hook scripts and plugins are copied into the user's home and can outlive an upgrade, so main and the renderer validate what they receive rather than trusting the sender's version.
- **`resources/` holds checked-in copies.** `resources/cli/*.js` is built from `src/cli/`, and `npm run verify:resources` fails on drift. For regenerating them or shipping a new file, see the `wmux-release` skill.

## Restoring sessions

A provider's session handle goes from the agent's report, to `agent-state.ts`, to `session.json`, to a restored pane's launch command. Adding a provider touches:

| Area | Files |
|------|-------|
| Main | `<agent>-resume.ts` (validator, stamp, prune), `agent-session-persistence.ts`, `agent-state.ts`, `agent-state-rpc.ts`, `index.ts` (startup prune, quit refusal) |
| Shared | The `<agent>SessionId` field in `src/shared/types.ts` |
| Pane | `store/split-utils.ts` (`applyMintedIds` drops the handle from a copied surface), `PaneWrapper.tsx`, `TerminalPane.tsx`, `hooks/useTerminal.ts` |
| Launch | `hooks/claude-resume-command.ts`, `hooks/agent-launcher.ts` |
| Setting | `workspacePrefs.restore<Agent>Sessions` in `store/settings-slice.ts`, `WorkspaceSettings.tsx`, `i18n/locales/` |

Rules every provider follows:

- **Off by default, and off costs nothing.** With Codex restore off there is no PATH shim and no `where codex.exe`.
- **The handle gets typed into a shell, so validate it strictly** where it is reported and again in the renderer. Reject what isn't this pane's main session: a Qwen subagent's id, an OpenCode shared-server session.
- **Keep or release.** A PTY exit or crash keeps the handle, since the conversation still exists. A deliberate exit releases it. A release that arrives while wmux quits is refused, so add the method to that check in `routeSpecialV2`.
- **Late reports.** Reports from a previous session can land after a release. If your agent can do this, gate on a sequence number as `PiSeqGate` does.
- **Prune what can't be reopened.** `pi --session` on a missing or empty file silently starts a new session, so `pruneDead<Agent>Sessions` drops those handles at startup.
- **Respect the user's launcher.** A launcher already in the pane's startup commands keeps its args, and one that means something else (`--no-session`) is left alone. See `mergePiResume`.

## Tests

Follow `tests/unit/qwen-context.test.ts`, `qwen-resume.test.ts` and `wmux-hook-qwen.test.ts`. Cover install, removal and the gate on the agent's home, plus every rejected id shape.
