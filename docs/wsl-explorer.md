# Explorer follows a WSL shell

The explorer panel shows the folder of the focused terminal. A PowerShell, cmd or
Git Bash pane tells wmux where it is through wmux's shell integration. A WSL shell
does not load that integration by itself (see "wmux's bash integration in WSL"
below), so out of
the box the explorer stays on the Windows folder the pane started in, even after
`wsl` and a few `cd`s.

Since 2.45.0 wmux reads **OSC 7**, the standard "this is my working directory"
escape sequence, from every pane. Have your WSL shell print it at each prompt and
the explorer follows, whether the pane was opened as WSL or you typed `wsl` inside
a PowerShell or cmd pane. Nothing to install on the Windows side.

The report also updates the directory shown in the workspace sidebar. A pane
configured as WSL saves the reported folder and uses it as its starting directory
on session restore. Shell startup files may change it afterward.

## bash

Add to `~/.bashrc` inside the distro:

```bash
# wmux: let the explorer follow this shell's directory
[ -n "$WSL_DISTRO_NAME" ] && PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }"'printf "\e]7;file://localhost/%s\e\\" "$(wslpath -w "$PWD")"'
```

## zsh

Add to `~/.zshrc`:

```zsh
# wmux: let the explorer follow this shell's directory
if [[ -n "$WSL_DISTRO_NAME" ]]; then
  _wmux_osc7() { printf '\e]7;file://localhost/%s\e\\' "$(wslpath -w "$PWD")" }
  precmd_functions+=(_wmux_osc7)
fi
```

## fish

Add to `~/.config/fish/config.fish`:

```fish
if set -q WSL_DISTRO_NAME
    function __wmux_osc7 --on-event fish_prompt
        set -l cwd (wslpath -w "$PWD")
        printf '\e]7;file://localhost/%s\a' (string escape --style=url -- "$cwd")
    end
end
```

`wslpath -w` does the translation: `/home/me/code` becomes
`\\wsl.localhost\Ubuntu\home\me\code`, and `/mnt/d/src` becomes `D:\src`, so wmux
needs no distro lookup. Open a new shell (or `source` the file) and `cd` somewhere.

When you `exit` back to PowerShell, its own report takes over at the next prompt.

## wmux's bash integration in WSL

Git Bash panes load wmux's shell integration on their own. A WSL pane cannot: `wsl.exe`
starts your distro's login shell, and wmux would have to replace that shell or edit
your distro's home to load anything into it. One line in `~/.bashrc` (or `~/.zshrc`)
inside the distro does it:

```bash
# wmux: shell integration (cwd for session restore, git branch, prompt marks)
[ -n "$WMUX_BASH_SCRIPT" ] && . "$WMUX_BASH_SCRIPT"
```

wmux sets `WMUX_BASH_SCRIPT` in every WSL pane it opens, already translated to its
`/mnt/...` path, so the line keeps working when wmux moves or updates. The
integration reports through Windows `node.exe` (the runtime wmux found for its own
CLI), so nothing has to be installed in the distro. With it, a `cd` in the pane is
saved and a restored WSL pane starts there, which is also where `claude --resume`
looks for its session.

## Claude Code inside WSL

Claude Code running inside the distro reads the distro's own `~/.claude/settings.json`,
not the Windows one. wmux writes its status hooks there too, so Claude in a
WSL pane shows its state in the sidebar and its session comes back with
`claude --resume` when wmux restores the pane (with the bash integration line above, so
the pane also restores its folder).

It is the **Status hooks** feature of the agent integration (Settings → General), with
the same consent: nothing is written until you allow it, and switching it off or choosing
"Never" takes the hooks back out. Your own hooks and settings stay as they are.

wmux never starts a stopped distro to do this. It only looks at distros that are already
running, when it starts or when you change the setting, and a few seconds after you open a
WSL pane. A distro that was stopped when you changed the setting is updated the next time
wmux sees it running. Nothing is written to a distro where Claude Code has no
`~/.claude/settings.json` yet, or where that file is a link to the Windows one. Docker
Desktop's own distros are skipped.

Each hook command looks like this:

```sh
[ ! -f "${WMUX_BASH_SCRIPT%/*}/wmux-hook-wsl.sh" ] || sh "${WMUX_BASH_SCRIPT%/*}/wmux-hook-wsl.sh" --event Stop
```

Outside a wmux WSL pane it does nothing. Inside one, `wmux-hook-wsl.sh` runs wmux's hook
script with Windows `node.exe` through WSL interop, as the bash integration does for its
reports, so nothing has to be installed in the distro. The command names no install path,
so it keeps working when wmux moves or updates.

If you added wmux's hooks to the distro by hand (the workaround from issue #428), wmux
replaces those entries with its own. Your other hooks are not touched.

## What wmux accepts

OSC 7 travels in the terminal output, so anything printed in a pane can send one,
including a file you `cat`. wmux therefore only acts on:

- a local drive path (`C:\…`), and
- a WSL root: `\\wsl.localhost\<distro>\…` or `\\wsl$\<distro>\…`.

Any other UNC path (`\\server\share`) is ignored: resolving it would make Windows
try to sign in to that server with your credentials. A URL naming another machine
(`file://build-box/…`), a POSIX path (`file:///home/me`, which is what most Linux
shells print by default), a `..` segment and a pane inside an ssh session are
ignored too.
