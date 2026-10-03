# Codex session restore

Turn on **Settings -> Workspace -> Resume Codex sessions on restore**, then launch `codex` in a new wmux terminal. Claude has its own independent checkbox. Both default to off. Existing Codex processes must be relaunched once so wmux can identify their conversation.

On restore, each tab runs `codex resume <conversation-id>` in its saved directory. Two tabs in the same directory keep their own conversations. An orderly `/quit` removes that tab's recovery handle; a crash or closing wmux retains it. Codex owns the conversation history; wmux stores only its ID and provider alongside the layout.

## Compatibility

Verified with native Windows Codex CLI 0.159.2, PowerShell 5.1, and wmux 2.16.0. Node.js must be installed and the native `codex.exe` must be on PATH. If wmux cannot resolve a native Node runtime, it leaves Codex unchanged. This first implementation covers PowerShell and Command Prompt terminals; WSL, Git Bash, remote Codex servers, and npm installations exposing only `codex.cmd` are not automatically integrated. Full executable paths and user aliases can bypass the wmux shim.

Noninteractive commands (`exec`, `login`, `app-server`, etc.), help/version, explicit `--remote`, and invocations using profiles, managed worktrees or local model providers pass through to the native CLI. These invocations do not record a restore handle. Older CLIs without `--remote-auth-token-env` also run normally and show a notice that automatic recording is unavailable. Deleted or archived conversations remain subject to Codex's normal resume behavior.

The integration uses Codex's experimental app-server transport. Compatibility should be checked when updating Codex. It does not modify Codex configuration, install hooks, or change hook trust, approval policies, or sandbox permissions.

## Implementation

Private PATH shims inside wmux launch a helper with its resolved Node runtime. There is no global PATH change. Electron-as-Node is deliberately excluded because its GUI executable does not preserve a Windows console input handle for the native TUI. The helper asks the authenticated wmux pipe whether recording is enabled; when disabled, it runs native Codex unchanged.

When enabled, the helper connects the native TUI through a relay bound to `127.0.0.1` on an ephemeral port. A random 256-bit bearer token is passed through the TUI's environment. The relay rejects browser origins and incorrect tokens. It accepts additional authenticated connections because Codex's startup picker and `/resume` use auxiliary clients. Each connection gets a private stdio app-server and request tracker, so reused JSON-RPC IDs cannot cross between the picker and the conversation. Disconnecting one client retires only its backend; closing the relay retires them all. No credentials are copied and no transcript traffic is logged or saved by wmux.

Only successful responses to that TUI's `thread/start`, `thread/resume`, and `thread/fork` requests update the saved ID. Ephemeral threads, child threads, unpaired responses, and background notifications are ignored. This matters because current Codex creates temporary internal threads during ordinary conversation use. Neither the working directory nor the newest history file is used to infer identity.

The helper, TUI, and app-server stay under the terminal process tree, covered by wmux's existing shutdown and orphan cleanup. Normal CLI exit releases only the matching Codex ID; a delayed exit cannot clear a newer conversation. Saving is requested promptly when an ID changes, and both automatic and named session saves stamp provider-specific IDs. Reusable layouts discard conversation IDs.

## Verification

Unit/integration coverage includes exact ID round trips for two tabs sharing a directory, independent Claude/Codex switches, unsafe ID rejection, internal ephemeral threads, response correlation, fork/resume changes, stale exit handling, authenticated transport, browser-origin rejection, and command-line passthrough. A native Windows test restored two distinct Codex conversations in one directory and nine existing Claude conversations to their original surfaces after both a normal close and a forced main-process crash. Each Codex pane displayed its own prior reply, no wmux hooks were configured, and the old Codex helper/TUI/app-server processes were gone after crash recovery. With Codex restore disabled, both Codex panes reopened as shells while all nine Claude IDs still matched. A normal Codex `/quit` removed its live and saved restore handle.

Protocol reference: [OpenAI Codex app-server](https://learn.chatgpt.com/docs/app-server).
