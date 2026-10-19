# Omp session restore

Turn on **Settings -> Workspace -> Resume omp sessions on restore**, then launch `omp` in a wmux terminal. Claude, Codex, OpenCode, and omp have independent toggle settings, all defaulting to off.

On restore, each tab runs `omp --resume <exact-session-path>` in its saved directory. Two tabs in the same directory keep their own exact conversation transcript. An orderly exit (e.g. `/quit` or closing the session) removes that tab's recovery handle; a crash or closing wmux retains it. omp owns the conversation history and transcript storage; wmux stores only the verified absolute session file path alongside the layout.

## How it works

1. **Exact transcript path tracking**: wmux's omp extension (`resources/omp-extension/wmux.js`, version 4) monitors session events (`session_start`, `turn_end`, `session_switch`, `session_branch`). When the session is verified on disk (`isSessionOnDisk()`), it reports the absolute path of the `.jsonl` session file via `report-session <path> --provider omp`.
2. **Dynamic session switching**: Switching sessions within omp via `/resume`, `/fork`, `/branch`, or `/new` updates the recorded session path immediately. If switched to an ephemeral/lazy session not yet written to disk, the previous handle is cleared to prevent resuming stale conversations.
3. **Shell-aware quoting**: Session paths containing spaces, ampersands, dollar signs, backticks, or quotes are quoted safely depending on the target shell:
   - **PowerShell** (`powershell.exe`, `pwsh`): Single quotes `'...'` with `''` escaping for single quotes, ensuring literal interpretation with zero variable (`$`) or backtick (`` ` ``) expansion.
   - **POSIX** (bash, zsh, WSL): Single quotes `'...'` with `'\''` escaping.
   - **Command Prompt** (`cmd.exe`): Double quotes `"..."` enclosing spaces and special characters (`&`, `^`, etc.). If a session path contains percent signs (`%`), `cmd.exe` cannot safely pass them without variable expansion; wmux safely skips resume for cmd panes with such paths rather than launching a corrupted path. The default PowerShell (and POSIX shells) fully supports percent signs, dollar signs, backticks, and single quotes verbatim without expansion.
4. **Preservation of profile and flags**: When a pane has startup commands launching omp (e.g. `omp --profile work --config "C:\my config\extra.yml"`), `--resume <path>` is merged into that launcher, preserving the profile and custom options while stripping conflicting flags (`--continue`, `-c`, and previous bare `--resume` / `-r` / `--session`).
5. **No auto-execution**: Restoring runs `omp --resume <path>`. `--restore` is strictly forbidden because `--restore` would auto-resume interrupted turns and subagents. If a pane's startup command explicitly specifies `--restore` or `--no-session`, session restore is bypassed.
6. **Missing session safety**: If a session file was deleted from disk between saves, `pruneDeadOmpSessions` prunes the dead handle before launch and reopens a clean shell rather than failing or creating a new empty session.
