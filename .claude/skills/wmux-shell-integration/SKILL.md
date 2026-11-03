---
name: wmux-shell-integration
description: Rules for editing wmux's shell integration scripts (bash/zsh, PowerShell, cmd) in src/shell-integration/ and their resources/shell-integration/ mirror. Use when changing prompt hooks, OSC 133 prompt marks, or the cwd, git branch, shell-state or port reports those scripts send.
---

# wmux shell integration

Scripts in `src/shell-integration/` (deployed to `resources/shell-integration/`):

| Script | Reports |
|--------|---------|
| `wmux-powershell-integration.ps1` | cwd, git branch/dirty, shell state, PR polling (45s), OSC 133 A/B/C/D |
| `wmux-bash-integration.sh` | cwd, git branch/dirty, shell state, ports, OSC 133 A/B/C/D (bash + zsh) |
| `wmux-cmd-integration.cmd` | Basic OSC 9 escape sequences, OSC 133 A/B (no C/D — cmd has no preexec seam, so they are not representable and are deliberately not faked) |

**Who loads the bash script.** Git Bash gets it from `pty-manager.ts` as `--init-file`
(#427), so the script's prologue reads the user's rc or login files itself. WSL panes
only get `WMUX_BASH_SCRIPT` for a line in the distro's `~/.bashrc` (#428): wsl.exe
starts the distro's own shell. Native reports go through Windows node running
`wmux raw-v1` (bash cannot open the pipe; the old `/mnt/c/.../Temp/wmux/messages`
drop was never read by anything), so in WSL they depend on `WSL_ENV_PASSTHROUGH`
carrying `WMUX_PIPE` and the token back out. Git Bash reports its cwd as a Windows
path (`pwd -W`): `/c/...` reads as POSIX to `isPosixPath` and is never restored.

**WSL's explorer cwd is OSC 7.** A WSL shell reports its cwd in-band with OSC 7 (#378): the
user adds a `PROMPT_COMMAND`/`precmd` one-liner (`docs/wsl-explorer.md`) that prints
`file://localhost/<wslpath -w $PWD>`. The renderer forwards the raw payload to main
(`explorer:report-osc7`) and `src/shared/osc7.ts` admits only local drives and
`\\wsl.localhost\<distro>` / `\\wsl$\<distro>` — any other UNC host would make Windows try
SMB auth when main realpaths it. Change that allow-list only with that in mind.

`resources/shell-integration/` is a checked-in **byte-identical mirror**, enforced by
`tests/unit/resources-sync.test.ts` (#168/#169) — editing a script without copying it
there fails `npm test` AND ships the old file.

**OSC 133 (#207)** carries the prompt boundaries the prompt log needs in-band, which a
pipe message arriving milliseconds later cannot: the consumer is the xterm parser, and it
needs the boundary at an exact byte offset in the stream. Two traps, both load-bearing:

- **bash needs a DOUBLED backslash for the ST terminator inside `\[ \]`.** bash decodes
  the contents of the ignore region, so ST's trailing `\` pairs with the `\` of the
  closing `\]`: the end marker is destroyed, a stray `]` leaks into the visible prompt,
  readline mis-measures the prompt width and long command lines wrap wrong. Verify with
  `printf '%s' "${PS1@P}" | od -c`, never by reading. zsh's `%{ %}` expansion is
  `%`-based and passes backslashes through, so there the plain form is the correct one.
- **PowerShell: `$?` decides, `$LASTEXITCODE` only refines.** They answer different
  questions — `$LASTEXITCODE` is the last *native* process's code, says nothing about a
  failed cmdlet, and is sticky. Using it alone reports every failed cmdlet as a success.
  Both must be captured as the first two statements of `prompt`; almost anything clobbers
  them, which is how the `interrupted` shell state sat dead for years (`Report-GitBranch`
  ran `git` before the check read `$LASTEXITCODE`).

`B`/`C` come from `PSConsoleHostReadLine`, not the PSReadLine Enter handler: that handler
runs *before* `AcceptLine` echoes the newline, so a `C` there lands on the input row and
every consumer is one row out. It also keeps the marks out of the prompt string, so
PSReadLine never has to width-count escapes — the PowerShell analogue of the `\[ \]`
problem, sidestepped rather than solved.

**The git report is one spawn, off the prompt thread.** `prompt` used to cost 55 ms per
Enter, 50 ms of it two git processes (`rev-parse --abbrev-ref HEAD`, then
`status --porcelain`). It is now a single `git --no-optional-locks status --porcelain=v2
--branch` — branch AND dirtiness in one process, `--no-optional-locks` so a status running
behind the user's back never leaves `.git/index.lock` in front of their `git commit` —
resolved once at init to `mingw64\bin\git.exe` rather than the `cmd\git.exe` launcher
(8 ms per spawn), and run in an in-process **runspace** (never `Start-Job`, which is a whole
pwsh.exe): `prompt` measures 1.4 ms, the report lands ~30 ms later. Wire text is
byte-identical to the old two-spawn form for every case in
`tests/unit/git-branch-report.test.ts` — including an unborn repo, which v2 reports as
`branch.oid (initial)` with exit 0 and which must still CLEAR, because `rev-parse` exited
128 there. The worker drains a `pending` cwd under a lock, so two Enters 47 ms apart both
report and `BeginInvoke` is never called on a pipeline still running; the cwd it is handed
is `CurrentFileSystemLocation.ProviderPath`, not `$PWD` (empty under `cd Env:`). bash mirrors
the single-spawn shape; the `\[ \]` prompt string is untouched.
