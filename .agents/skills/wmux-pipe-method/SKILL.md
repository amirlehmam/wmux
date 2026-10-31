---
name: wmux-pipe-method
description: How to add or change a wmux V2 pipe method or CLI verb - where the method routes, the pipe token, error codes, multi-window lookups, calling the renderer, and the CLI spec and flag parsing. Use when editing src/cli/wmux.ts, src/main/pipe-server.ts, src/main/v2-bridge.ts, routeSpecialV2 or the V2 switch in src/main/index.ts, or adding a window.__wmux_* global in src/renderer/pipe-bridge.ts.
---

# wmux pipe methods and CLI verbs

A verb runs from `src/cli/wmux.ts` over the named pipe to `pipeServer.on('v2')` in `src/main/index.ts`. The split tree lives only in the renderer's store, so most methods then ask a window through `executeJavaScript('window.__wmux_*(...)')`, which `src/renderer/pipe-bridge.ts` exposes.

## Where a method goes

`routeSpecialV2` runs first, in this order, and the main switch only sees what it declines:

1. Exact names with their own modules: `remote.status`, the workspace manifest methods, `browser.get_engine`, `browser.set_engine`.
2. Prefix routes: `browser.*` (`v2-browser.ts`) and `window.*`.
3. `pane.*` special cases, then `handleAgentStateV2` (`agent-state-rpc.ts`).
4. `handleBridgeV2`: the table in `v2-bridge.ts`.
5. The switch in `index.ts`.

- A plain forward to one renderer global belongs in the `v2-bridge.ts` table. Use its `validate`, `prepare`, `shape`, `requireResult`, `emptyOnNoWindow` and `callerScoped` fields rather than a new `case`.
- A name that shares a prefix with a route must be matched before that route, or it falls into the verb switch and comes back as `Unknown: browser.get_engine` (-32601).
- `remote.status` is the Remote Console's only pipe method (invariant I2). `tests/unit/remote-console-wiring.test.ts` fails on a second one.

## Auth

Every method needs the pipe token unless it is in `PUBLIC_V2_METHODS` (`pipe-server.ts`). That list is an allowlist of strictly read-only methods. Telemetry-style writes can spoof agent state, so they stay out of it (#72).

## Errors

| Code | Means |
|------|-------|
| -32602 | Bad params. Answer it in main, before looking up a window, so a renderer never has to guess at `count: null` |
| -32000 | The request was fine and could not be done: `No window`, an unknown surface, a thrown error |
| -32601 | Unknown method, from the pipe server or a verb switch |
| -32001 | Missing or wrong pipe token, from the pipe server only |

An empty result is an answer, not an error, when nothing is wrong with the request.

## More than one window

A workspace is not a window (#143), and `getAllWindows()[0]` knows nothing about a pane in the second window.

- Bridge methods get their window from `targetForCaller(params.caller)`. A method with no id of its own sets `callerScoped`, so it means the calling shell's workspace. An explicit `workspaceId` always wins.
- A method that takes a surface or pane id asks every window, skips destroyed ones, and decides what counts as an answer. `surface.read_text` takes the first window without an error. `surface.list_prompts` takes the first non-empty answer, because an unowned surface and an empty log both answer `[]`, and its untargeted form merges every window. `engineForSurface` takes the first affirmative answer.

## Calling the renderer

- The expression is source code, so every value goes through `JSON.stringify`. See `linkOpenJs` in `v2-bridge.ts`.
- Write `window.__wmux_x?.(...)` and handle a rejection. A reloading renderer or a destroyed webContents should mean "this window doesn't have it", not a failed command.
- Add a new global in `pipe-bridge.ts` as a store operation. Keep decisions that need main's knowledge in main.

## The CLI verb

- Add the handler to `COMMANDS` or a group table. Both are checked against `CommandName`, so the compiler reports a verb with no spec.
- Add a `COMMAND_SPECS` entry: `usage` is required, and it is what `--help` prints. `value` and `bool` list the flags. Add the verb to the `wmux help` text too.
- Parse with `parseFlagArgs`, or `flagsOrFail` in a command. A pairwise walk reads a flag that lost its value as the value of the flag before it (#247).
- `sendV2` adds `caller` from `$WMUX_SURFACE_ID`, so a verb needs no surface code to act on its own pane. Only pass `--surface` through when it is a real override.
- A method that can outlast the default deadline passes `timeoutMs` to `sendV2`. The transport adjusts it (`transport-deadline.ts`), so don't hard-code a remote value.
- Validate in the CLI for a good message and in main for correctness: other clients reach the pipe without going through this parser. `layoutAgentsParams` and `validateLayoutAgentsParams` are the pair to copy.
- A verb agents should use goes in `resources/claude-instructions.md`, which is what gets installed for them.
- A new `src/cli/` module has to ship outside the asar. See the `wmux-release` skill.

## Tests

Export the pure part (argv to params, params to an error message) and test that, as `browserRequest` and `layoutAgentsParams` do. The usual homes are `tests/unit/cli-subcommands.test.ts`, `cli-flag-parse.test.ts` and `pipe-server.test.ts`.
