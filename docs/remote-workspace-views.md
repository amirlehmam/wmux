# Remote workspace views: ssh targets and WSL folders

Two kinds of workspace pay a `wsl.exe` start for every call a view makes, and share one layer that
keeps that cost down:

- an **ssh workspace**: its session runs on a remote host and an external script or integration told
  wmux so (`wmux set-ssh-target`, see `DEVCONTAINER.md`). The folder view, code and markdown viewers, Diff tab, Git view and the
  sidebar's branch marker are served from that host;
- a **WSL folder**: the workspace's folder is on a WSL share (`\\wsl.localhost\<distro>\...`), where git
  runs inside the distro.

The route of one call: the caller builds the per-call command (`wsl.exe -d <distro> --exec ssh <options>
<destination> <command>` for a host, `wsl.exe -d <distro> --exec sh -c <script>` for a distro), holds a slot
of the gate (`exec-gate.ts`), and the routed runner (`exec-worker-routed.ts`) hands it to a persistent worker
(`exec-worker.ts`) or, when it cannot, spawns it. Independent git commands of one request are one
script (`exec-git-batch.ts`), and polls are answered from a shared snapshot (`exec-snapshot.ts`).
`exec-location.ts` says which of the two places a call is for (`GitContext`: its lane, its location, its
directory and its word for the trace), so there is one copy of each module.

The cost of an action is the number of sequential spawns it makes times the cost of one start.
`tests/unit/ssh-spawn-counts.test.ts` and `tests/unit/wsl-spawn-counts.test.ts` state that number for each
action: **a change that raises one is a regression.**

## Behaviour contract

- **A click goes first.** Every spawn is `fg` (a person is waiting: the folder view, opening or saving a
  file, a Git view request a click made) or `bg` (a poll nobody waits on). Per host or distro the gate
  allows three spawns at once, a waiting `fg` starts before any waiting `bg`, and a `bg` never takes the last
  free slot. Anything that does not say is `fg`. The renderer marks a request `poll` only for a timer's
  own pass; the first request of a view, a new file, a pane shown again, Refresh and an agent's edit are
  asked as a person asks.
- **A request a person made never reads the poll cache,** and drops the entry it would have used. A click
  that asks for the same view as a poll in flight does not join the poll's run.
- **Snapshot and fingerprint.** A poll first asks for the location's fingerprint, one small spawn shared
  by every consumer for 1.75 s and while it runs. If it equals the one the last answer was computed
  under, that answer is served; otherwise the consumer's own code runs and the result is kept. A file's
  diff is fetched again only when that file's own key changed. A failed fingerprint or answer is never
  stored, and an unreachable host is an error, never "no changes".
- **The fingerprint** is the top level, every ref with its object, and for every worktree `git status
  --porcelain=v2 --branch -z -unormal` plus the size and nanosecond mtime of every modified or untracked
  file. The remote side hashes it and prints digests (per-file keys up to 100 files per worktree, then one
  key for the worktree). It is unusable, and polls run in full, where the
  host has no hash tool, `awk`, `mktemp -d` or `stat -c`, or more than 2000 files in a worktree are
  modified or untracked; an unusable host is not asked again for five minutes.
- **Back-off.** While the fingerprint stays equal and nobody has used the location for 30 s, each further
  unchanged fingerprint doubles how long the next one is held back, up to 30 s, and polls inside the window
  are answered with no spawn. It starts over on a different fingerprint, any `fg` spawn on the location, a
  write through wmux (which also invalidates the snapshot) and an agent hook edit signal. Hidden panes do
  not poll.
- **What the fingerprint cannot see** makes it miss a change, never invent one: a file rewritten with
  the same size and a deliberately restored mtime (`touch -r`, `rsync -t`), a file name with a newline,
  ignored files, and a change inside the 1.75 s after it was taken.

## The persistent worker

`wsl.exe -d <distro> --exec ssh <the call's options> <destination> <bootstrap>` (or `wsl.exe -d <distro>
--exec sh -c <bootstrap>` for a distro) starts one long-lived `sh` loop that serves calls over stdin and
stdout, so a call after the first costs the remote work plus a round trip. **Correctness never depends on
it:** any problem ends in the per-call spawn for that request, and the worker is torn down and not started
again for a while. `WMUX_SSH_WORKER=0` switches it off for both places; it is on only on Windows.

The bootstrap and the loop are constants. The command line holds no user-controlled byte; everything else
is base64 inside a request:

    Q <nonce>           start a request; nonce = 16 random bytes as hex, made per request
    C <base64 line>     the command: the very base64 the per-call route sends
    I <base64 line>     the bytes for the script's stdin (a save's content)
    G <nonce>           go

The loop runs the decoded command in a fresh subshell with `set -f`, its stdin a file and its stdout and
stderr two files, so what a script prints cannot reach the worker's own stdout. The answer:

    <nonce> BEGIN
    O <base64 line>     stdout
    E <base64 line>     stderr
    S <status> <stdout bytes> <stderr bytes>
    <nonce> END

Parsing is strict (`WorkerProcess.onLine`): lines before our `BEGIN` are dropped as noise (an sshd banner),
and afterwards a line out of order, with bad base64, with sizes that do not add up, or after `END` is a
worker failure. Content cannot forge a marker: it is base64 behind an `O ` or `E ` tag.

**Which calls are run again.** A request is *started* once its `G` line began to be written. After a
failure (the worker exited, hung to the timeout, or sent a malformed or truncated answer):

| | Only reads | May write |
| --- | --- | --- |
| never started | run per call | run per call |
| started | run per call | not run again: a timeout is a timeout, anything else is status 255 (`ssh-unreachable`) |

"Only reads" is stated by the caller (`idempotent: true`): listings, file reads, every git command. A save,
create, rename and delete are not, and a call that says nothing is not. For a WSL folder only an
`idempotent` call goes to the worker at all, and a single git call travels as a constant script with the
directory and every environment value as positional arguments.

**Lifecycle.** Started lazily by the first request of a host or distro (after a handshake), or ahead of it
for the workspace on screen (`exec-warm.ts`, at background priority). A failed handshake marks the host
unusable for five minutes; a later failure backs off 30 s, doubling to five minutes. A worker idle for as
long as the shared ssh connection persists (300 s) gets its stdin closed and is killed if it lingers. It
is killed on a timeout or protocol failure, when its workspace's target is cleared or changed, on quit and
on process exit. One request at a time per worker, up to two workers per host, a second only when a
request would wait; waiting requests start `fg` first.

## Trace

`WMUX_SSH_TRACE=1` in the environment wmux starts with writes one line per spawn and per worker start
and stop, to the console and `%APPDATA%\wmux\logs\main.log`:

    ssh-trace op=git:status loc=ssh prio=fg wait=0 ms=171 exit=0 out=1832 via=worker cold=1
    ssh-trace op=worker:start loc=ssh ms=612 workers=1 reason=first
    ssh-trace op=worker:stop loc=ssh reason=idle age_s=300

`loc=ssh|wsl` is where the call ran, `prio=fg|bg` who asked, `wait` the ms queued behind the cap, `via=worker|spawn`
which way it travelled (only where a worker is in play) and `cold=1` that it had to start, or wait for the
start of, a worker. `op` is from a fixed list (`list`, `read`, `write`, `create`, `rename`, `delete`,
`git:batch`, `git:fingerprint`, `git:<subcommand>`). A worker start's `reason` is `first`, `click`, `warm` or
`restart`; a stop's is `idle`, `timeout`, `protocol`, `clear`, `quit`, `exit` or `closed-by-peer`.

A line never holds a path, file name, content, host or distro name, argument vector or stderr, so it can
be pasted into an issue.

## WSL folders

A folder on `\\wsl.localhost\<distro>\...` goes through the same modules, keyed by the distro instead of
a host: one script batches its git commands (`wsl-local.ts` runs it as `wsl.exe -d <distro> --exec sh -c
<base64>`), the gate caps spawns per distro, the snapshot is keyed by distro and checkout, and one
persistent `wsl.exe` per distro serves the reads. It differs in a few places:

- there is no ssh and so no "unreachable": a batch, a fingerprint or a worker that does not answer is never
  an error of its own, and the caller's one-spawn-per-command `wsl.exe --exec git` says what is wrong;
- a distro that cannot run the batch (no `base64`, no `mktemp`) is left alone for five minutes;
- a Windows folder, a drive path, a worktree in another distro, an untracked file's diff and a folder that
  is not a repository do not use the batch;
- a save through wmux into the distro invalidates its snapshot (`noteWslWrite`).

The explorer's own listing and reading of a WSL folder is not on this layer; see `wsl-explorer.md`.

## Known limits, and what is not verified

Everything here was exercised against a local `sh` and a counting stand-in for `wsl.exe`. Not verified
without Windows: that `wsl.exe` relays a long-lived stdin and stdout byte for byte for large payloads in
both directions, that the whole `wsl.exe -> ssh -> sh` chain ends when wmux is killed, how a real sshd
banner and a real ControlMaster behave under it, and every timing.

The remote host needs `base64`, `mktemp`, `wc`, `sed` and a POSIX `sh` for the worker; one that lacks
any of them fails the handshake and stays on spawns. A request that hangs is detected only by the call's
own timeout. The worker keeps a temp directory under `$TMPDIR` or `/tmp` while it lives.

Behaviour is pinned by `tests/unit/exec-gate.test.ts`, `exec-snapshot.test.ts`, `exec-worker.test.ts`,
`exec-git-batch.test.ts`, `exec-trace.test.ts`, `ssh-poll-session.test.ts`, `wsl-worker.test.ts` and the two
spawn-count files above.
