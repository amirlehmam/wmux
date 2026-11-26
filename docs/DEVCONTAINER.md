# Driving wmux from a devcontainer

wmux runs on Windows, but a Claude Code session often does not: it runs in a
Linux devcontainer on top of WSL2 + Docker. Nothing in that container can open
`\\.\pipe\wmux`, so the `wmux` CLI, the Claude Code hooks and the shell
integration all fail silently — panes show no cwd or git branch, the sidebar
never leaves "Running", and `wmux agent spawn` cannot reach the app at all.

This guide sets up a path from the container to that pipe. It needs no extra
feature, no vendor tooling and no code you have to write: one binary, one
long-running command, and two environment variables.

## How it fits together

```
  Devcontainer (Linux)                WSL2 distro                     Windows
 ┌──────────────────────┐   TCP    ┌────────────────────┐  interop  ┌─────────┐
 │ claude               │ ───────► │ wmux bridge --wsl  │ ────────► │ wmux    │
 │  wmux CLI            │  :9787   │  listens 0.0.0.0   │           │         │
 │  wmux-hook.js        │          │  npiperelay.exe ×N │ ═════════ │ \\.\pipe│
 │  bash integration    │ ◄─────── │  (warm pool)       │ ◄──────── │  \wmux  │
 └──────────────────────┘          └────────────────────┘           └─────────┘
   WMUX_REMOTE=                      wmux bridge is a byte relay:
   host.docker.internal:9787         no parsing, no auth of its own
```

Three hops, one protocol. The container speaks the same JSON-RPC (V2) and
line (V1) protocol it would speak to a local pipe; only the socket underneath
changes. Auth is unchanged end to end — every request still carries the wmux
instance's pipe token, which `wmux bridge` forwards without inspecting.

The bridge deliberately runs **inside WSL2**, not on Windows. Under WSL2's
default **NAT** networking, `0.0.0.0` there is the distro's own network
namespace, which the container reaches through the Docker host gateway and the
LAN does not. A Windows-side bind would expose the pipe to the corporate network
and need a firewall rule; this needs neither.

That holds for NAT and not for **mirrored** networking, where the distro shares
the Windows host's interfaces rather than having a namespace of its own — see
[Mirrored networking](#mirrored-networking) below. `wmux bridge --wsl` reads the
mode with `wslinfo --networking-mode` and only picks `0.0.0.0` once it has
confirmed NAT.

The WSL2 → Windows hop is [npiperelay.exe](https://github.com/albertony/npiperelay),
a ~2 MB MIT-licensed binary that forwards a named pipe to its own stdin/stdout.
WSL2 runs Windows executables via interop, so the bridge spawns it and treats
its stdio as the socket. AF_VSOCK, a TCP listener on the Windows side and
cross-boundary Unix sockets were all tried first: HCS-managed WSL2 VMs ignore
`GuestCommunicationServices`, gateway IPs and firewall policy are unreliable on
managed networks, and 9P does not forward `AF_UNIX`.

## Setup

### 1. Install npiperelay in the WSL2 distro

Once per distro. The download is SHA-256 pinned against the release's own
checksums file, and re-running is a no-op:

```bash
bash scripts/install-npiperelay.sh     # → ~/.local/bin/npiperelay.exe
```

The CLI also finds it on `PATH`, in `/usr/local/bin` or in `/usr/bin`, if you
prefer to install it yourself.

### 2. Start the bridge in WSL2

Run this in the WSL2 distro that hosts your Docker daemon, with wmux already
running on Windows. It stays in the foreground:

```bash
wmux bridge --wsl --port 9787
```

`--wsl` binds `0.0.0.0` instead of `127.0.0.1`, after checking that this really
is a WSL distro and that it runs NAT networking. If it refuses, read
[Mirrored networking](#mirrored-networking), or skip the port altogether with a
[Unix socket](#unix-socket-instead-of-a-port). If `wmux` is not on your `PATH`
inside WSL2, invoke the shipped CLI directly — any wmux pane exports `WMUX_CLI`
for exactly this:

```bash
node "$WMUX_CLI" bridge --wsl --port 9787
```

#### Mirrored networking

WSL 2.0+ on Windows 11 can run `networkingMode=mirrored` in `.wslconfig`. A
mirrored distro has **no network namespace of its own** — it shares the Windows
host's interfaces, including the physical LAN adapter and any VPN adapter. So
`0.0.0.0` inside it is not the private 172.x this guide describes; it is the
corporate network. Inbound traffic is filtered by the **Hyper-V firewall**
rather than the ordinary Windows Firewall profile, and the widely-copied "make
WSL reachable" recipe turns that filter off:

```powershell
Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow
```

Mirrored mode **plus** that setting puts wmux's control pipe on the LAN. The
pipe token still authenticates every request, so this is exposure rather than an
open door — but it is not a default anything should pick for you, so `--wsl`
refuses under mirrored mode and tells you to name an address:

```bash
wmux bridge --host <addr-the-container-reaches> --port 9787
```

`--host 0.0.0.0` is still honoured — with the warning upgraded to say the bind
is on the host's real interfaces. Check which mode you are in with:

```bash
wslinfo --networking-mode      # nat | mirrored | consomme; needs WSL 2.0.5+
```

On WSL too old to answer, `--wsl` also refuses rather than assuming NAT, and
`--host` is required.

### 3. Read the instance token

On Windows, or in any WSL2 shell that can reach the pipe:

```bash
wmux token
```

This is the running instance's pipe token. It changes when wmux restarts.

### 4. Point the container at the bridge

Two variables. Add them to your `devcontainer.json`:

```jsonc
{
  "containerEnv": {
    "WMUX_REMOTE": "host.docker.internal:9787",
    "WMUX_REMOTE_TOKEN": "${localEnv:WMUX_REMOTE_TOKEN}"
  },
  // Docker Desktop resolves host.docker.internal already; plain Docker on
  // Linux/WSL2 does not, so map it to the gateway explicitly.
  "runArgs": ["--add-host=host.docker.internal:host-gateway"]
}
```

Export `WMUX_REMOTE_TOKEN` on the host before launching, so the token is not
committed to the repo. The equivalent for a hand-rolled `docker run`:

```bash
docker run --add-host=host.docker.internal:host-gateway \
  -e WMUX_REMOTE=host.docker.internal:9787 \
  -e WMUX_REMOTE_TOKEN="$(wmux token)" \
  …
```

### 5. Get the CLI and the plugin into the container

Outside a container wmux installs both for you. Inside one it cannot: wmux is
not running there, so `ensureOrchestratorPlugin()` never executes. This is the
one step the native case gets for free.

Mount them read-only from the wmux install directory (`resources/` next to
`wmux.exe`, or the repo checkout):

```jsonc
"mounts": [
  "source=${localEnv:WMUX_RESOURCES}/cli,target=/opt/wmux/cli,type=bind,readonly",
  "source=${localEnv:WMUX_RESOURCES}/wmux-orchestrator,target=/home/vscode/.claude/plugins/wmux-orchestrator,type=bind,readonly"
],
"containerEnv": {
  "WMUX_CLI": "/opt/wmux/cli/wmux.js"
}
```

Then give the container a `wmux` command and let the shell integration report
to it, in the image or in `postCreateCommand`:

```bash
printf 'wmux() { node "$WMUX_CLI" "$@"; }\nexport -f wmux\n' >> ~/.bashrc
```

Copying instead of mounting works equally well and survives the host path
moving; mounting keeps the container in step when wmux updates.

### 6. Verify

```bash
wmux ping           # → pong
wmux list-workspaces
```

`pong` means all three hops are up. A hang or `ECONNREFUSED` means the bridge
is not listening or `host.docker.internal` does not resolve; `unauthorized`
means the token is stale — wmux was restarted, so re-read `wmux token`.

## Unix socket instead of a port

`wmux bridge --unix <path>` is the same bridge listening on a Unix domain socket
instead of a TCP port. No address is bound, so nothing on a network can reach it
and the WSL networking mode stops mattering: not `nat`, not `mirrored`, and not
`consomme` (the mode the [WSL docs](https://learn.microsoft.com/windows/wsl/wsl-config)
list for `networkingMode` and say used to be called `virtioproxy`), which
`--wsl` refuses by name: what a `0.0.0.0` listener exposes there is not
documented, so it is not assumed to be contained the way NAT is. It also avoids binding an explicit port
on a distro-only address such as the Docker bridge's, which fails in WSL 3.0.5
under `consomme` ([microsoft/WSL#42223](https://github.com/microsoft/WSL/issues/42223),
fixed by [#42230](https://github.com/microsoft/WSL/pull/42230)).

```bash
mkdir -p -m 700 "$HOME/.cache/wmux/sock"
wmux bridge --unix "$HOME/.cache/wmux/sock/wmux.sock"
```

The container gets the socket by bind-mounting its **directory** (not the file,
which would go stale whenever the bridge restarts) and two variables. The
clients need no change: the CLI and `wmux-hook.js` already dial a Unix socket
when `WMUX_PIPE` starts with `/`, and take the token from `WMUX_PIPE_TOKEN`.

```jsonc
{
  "mounts": ["source=${localEnv:HOME}/.cache/wmux/sock,target=/run/wmux,type=bind"],
  "containerEnv": {
    "WMUX_PIPE": "/run/wmux/wmux.sock",
    "WMUX_PIPE_TOKEN": "${localEnv:WMUX_PIPE_TOKEN}"
  }
}
```

Leave `WMUX_REMOTE` and `WMUX_REMOTE_TOKEN` out. `WMUX_REMOTE_TOKEN`, when it is
set, takes precedence over `WMUX_PIPE_TOKEN` even without `WMUX_REMOTE`, so a
leftover from the TCP setup would send the wrong token.

What the bridge enforces, so a misconfiguration fails at start instead of
leaving a socket someone else can use:

- `--unix` cannot be combined with `--host`, `--wsl` or `--port`: each describes
  a TCP listener, and silently opening a socket instead would leave a client
  pointing at a port nobody listens on.
- The path is absolute and at most 107 bytes (the `sockaddr_un` limit), and is
  not the pipe the bridge itself relays to.
- The directory exists and is not writable by group or others, sticky bit or not
  (so `/tmp` itself is refused). Another user who can write there could swap the
  socket for their own.
- The socket is created with mode `0600` (umask `077` around the bind, then an
  explicit chmod), so only your user can connect, on top of the token.
- A path under a Windows drive (`/mnt/c/...`) is refused: see below.
- A file already at the path is never replaced unless it is a socket nobody
  listens on (a connect gets `ECONNREFUSED`), which is what a killed bridge or a
  WSL shutdown leaves behind. A live listener, a regular file, or a probe that
  proves nothing makes the bridge exit instead.
- The socket file is removed on `SIGINT`/`SIGTERM`/exit, but only while it is
  still the bridge's own, so a newer bridge on the same path is not cut off.

### Why this is not the cross-boundary Unix socket from above

[How it fits together](#how-it-fits-together) says cross-boundary Unix sockets
were tried first and dropped because 9P does not forward `AF_UNIX`. That was a
socket on the Windows side reached from WSL2. Here the socket is created by a
process inside the distro, on the distro's own filesystem, and the container is
a process on the same Linux kernel: nothing crosses 9P. The Windows hop is still
npiperelay, unchanged, and a `--unix` path on a 9P mount is refused for the same
reason.

This assumes the container engine shares the distro's kernel and filesystem, as
Docker running inside the distro does. An engine that reaches the distro's files
through 9P instead is not covered, and this has not been tried on one.

## What now works

Everything routes through the same transport, with no per-tool configuration:

| In the container | Reaches wmux via |
|---|---|
| `wmux <any command>` | the CLI's `--remote` / `WMUX_REMOTE` support (issue #78) |
| `wmux-hook.js` (Claude Code hooks) | its own TCP branch on `WMUX_REMOTE` — this is what unsticks the sidebar |
| `wmux-bash-integration.sh` | `wmux raw-v1 <line>`, instead of the WSL temp-file drop it cannot write to |
| wmux-orchestrator | the `wmux` shim above; the plugin itself is unaware of any of this |

A tool in the container can also flag its workspace without renaming it:
`wmux set-indicator --text SSH --color '#f59e0b'` shows a small pill beside the
workspace name, and `wmux clear-indicator` removes it. The title stays under
wmux's own control. An older wmux rejects both commands as unknown, so callers
should treat a failure as "not supported" and carry on.

With `WMUX_REMOTE` unset, every one of these falls back to the local named
pipe exactly as before. The transport is additive.

## Telling wmux where the files really are: `set-ssh-target`

A pane that runs `ssh` shows a session whose files are on another machine. A script or integration that
starts or attaches such a session can tell wmux where it runs:

```
wmux set-ssh-target [--workspace <id>] --argv-json <json-array> --path <abs-path> [--wsl-distro <name>]
wmux clear-ssh-target [--workspace <id>]
```

- `--argv-json` is the ssh command as a JSON array of arguments (never a shell string), for example
  `'["ssh","-p","2222","dev@host"]'`, and `--path` the absolute checkout path on that host. `--workspace`
  defaults to the pane's own workspace.
- wmux then serves that workspace's folder view, code and markdown viewers, Diff tab, Git view and the
  sidebar's branch marker from the remote host, over ssh, and never from a local path of the same
  spelling. An unreachable host is reported as an error, not as "no changes".
- `clear-ssh-target`, or a set with an empty argv, forgets it. The target is held in memory only: it is not
  written to `session.json` or settings, so the caller sets it again after every launch, attach or wmux
  restart. A call that names an unknown workspace fails with a non-zero exit.
- The ssh keys and the `known_hosts` the argv names must live where the ssh runs. By default that is the
  host's own `ssh`; with `--wsl-distro <name>` it runs inside that WSL distro
  (`wsl.exe -d <name> --exec ssh`), for keys and a pinned `known_hosts` that live in WSL.
  `-F`, `-J`, `-i` and `-o UserKnownHostsFile=` in the argv are used as given, never translated. wmux runs
  ssh non-interactively, so a host that needs a password or a prompt is reported as unreachable.

Where the calls go and how their cost is kept down is in `remote-workspace-views.md`.

## Latency and the warm relay pool

Spawning `npiperelay.exe` is not free. On a corporate-managed host where AV/EDR
scans the binary on every exec, spawn + pipe attach measures up to ~7 seconds —
and a hook fires on every tool call, in every pane.

So `wmux bridge` keeps relays spawned and attached ahead of demand. A client
arriving gets one that is already live, and the bridge immediately starts
another to replace it. Tune with:

| Variable | Default | Effect |
|---|---|---|
| `WMUX_BRIDGE_WARM` | `2` | Relays kept warm. `0` restores spawn-per-connection. |
| `WMUX_BRIDGE_DRAIN_MS` | `15000` | How long a relay may keep draining after its client hangs up. |
| `WMUX_RPC_TIMEOUT_MS` | `30000` | CLI deadline floor on a remote/npiperelay transport. |

The pool is deliberately N exclusive relays rather than one multiplexed relay:
multiplexing would force the bridge to parse frames and rewrite JSON-RPC ids,
which V1 lines (`pong`, `ok`, `unauthorized`) carry no id to be rewritten by —
and would make every client a casualty of one relay dying.

The 30-second floor exists because the CLI's normal 5-second deadline sits
*below* that 7-second worst case: without it, a container reported `timed out`
for calls that had already succeeded.

## Session restore: `report_startup_command`

A restored pane is a fresh WSL shell on the Windows host. It has no idea it
used to be inside a container, so by default it comes back as a plain WSL
prompt and the container session is gone.

`report_startup_command` is how a shell says how to bring itself back. Report
it once, from inside the container, and wmux stores it on that surface and
replays it into the pane it restores:

```bash
_wmux_report "report_startup_command ${WMUX_SURFACE_ID} cd '/home/me/project' && ./relaunch.sh"
```

Or from anywhere with a CLI:

```bash
wmux raw-v1 "report_startup_command $WMUX_SURFACE_ID cd '/home/me/project' && ./relaunch.sh"
```

It is stored per surface, so two containers sharing one pane restore to two
different containers. Sending it with no command clears it.

> **The command must be cwd-independent.** This is a hard requirement, not a
> precaution.

wmux replays the command into a freshly spawned login shell, and makes no
promise about where that shell starts. `wsl.exe --cd <dir>` is applied *before*
the shell reads its rc files, so a distro whose `/etc/profile` or `~/.profile`
ends in `$HOME` — common on managed images — silently discards it:

```console
$ wsl --cd /tmp -- pwd     # non-interactive → /tmp   (--cd holds)
$ wsl --cd /tmp            # interactive login → ~    (the rc wins)
```

A relative `./relaunch.sh` therefore dies with "No such file or directory" and
the container is never re-entered. Lead with an absolute `cd`, as above.

Two details that bite:

- **Expand the path where you send the report**, not where it runs. The stored
  string must hold a literal host-side path; a `$WORKSPACE` in it would be
  expanded by the restored shell, which has never heard of it.
- **Single-quote the path.** It is replayed as a shell line, so an unquoted
  space splits it and an unquoted `$` expands.

The same asymmetry applies to `report_pwd`: `$(pwd)` inside a container is a
container path that means nothing to Windows or WSL. Report the host-side
workspace path instead.

## Security

- Under NAT networking the bridge binds inside the WSL2 network namespace: it is
  reachable from containers on that host and not from the LAN, and it needs no
  Windows firewall rule. **Under mirrored networking none of that is true** — the
  distro shares the Windows host's adapters, so `0.0.0.0` is the LAN and any VPN,
  gated only by the Hyper-V firewall's inbound policy. `wmux bridge --wsl` reads
  the mode and refuses to choose `0.0.0.0` unless it is NAT; see
  [Mirrored networking](#mirrored-networking). `--host` overrides the choice
  either way, and the CLI warns when the address is beyond loopback.
- `--unix` opens no network address at all: the socket is mode `0600` in a
  directory the bridge insists no one else can write, and the token is still
  required. Use it where the networking mode makes a TCP bind hard to reason
  about; see [Unix socket instead of a port](#unix-socket-instead-of-a-port).
- The bridge authenticates nothing and parses nothing — it copies bytes. wmux's
  own pipe server verifies the per-instance token on every request, V1
  (`auth <token> …`) and V2 (`token` field) alike, so the bridge grants no
  access that the token does not already grant.
- The token is per-instance and rotates on restart. Pass it through the
  environment; do not commit it.
- `npiperelay.exe` is fetched over HTTPS from a pinned release tag, and its
  SHA-256 is checked against a checksums file whose own hash is pinned in the
  install script.
