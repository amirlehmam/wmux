# Reporting a wmux crash

**Short version: run `wmux crash-report`, paste the output, and do not send a
crash dump unless someone asks for one by name.**

```console
$ wmux crash-report
```

It needs no running wmux — which is the point, since you run it after wmux
died. It reads the Windows Event Log and wmux's own process-lifecycle log, and
prints a fingerprint that is enough to tell a known crash from a new one.

---

## Why there is a page about this

A maintainer asking "can you send a crash dump?" sounds like a small request.
On Windows it is not.

**A Windows minidump contains the process environment block.** User-scope
environment variables are inherited by every process on the machine, so a dump
taken from a developer's machine carries every secret that machine keeps in its
environment, in cleartext, in a file the reporter is about to hand to a
stranger — and usually attach to a public issue.

This is not hypothetical. It is [issue #174][174], filed by the reporter of
[#150][150] after they checked the eight dumps they had been asked to upload.
Every one carried live credentials. The worst held eleven, including a
production API key/secret/passphrase set and a bot token. They found that only
because they stopped to look.

**wmux's users are the worst possible population for this.** wmux is a terminal
multiplexer. Its users keep credentials in the environment precisely so the
shells wmux spawns can see them. That is not a misconfiguration, it is the
normal setup — so the overlap between "people who hit a crash in wmux" and
"people whose environment is full of live keys" is close to total.

## What to send instead

Everything needed to answer "is this the crash we already know about, or a new
one?" is in the Windows Event Log, and none of it is memory:

| Field | Why it matters |
|---|---|
| Faulting module name | Which component died |
| Exception code | The kind of failure |
| Fault offset | The signature — identical offset means identical crash |
| Additional parameter | For `0xc0000409`, distinguishes a deliberate `__fastfail` from memory corruption |

`wmux crash-report` collects all four, plus the tail of
`%APPDATA%\wmux\logs\main.log` (wmux 1.1.1+), which records process lifecycle
only: start, teardown, PTY counts. No pane contents, no working directories, no
command lines, no environment.

In #150, that Event Log line alone turned out to be sufficient to answer the
question the dumps were originally wanted for.

### Reading it by hand

If the CLI is unavailable: **Event Viewer → Windows Logs → Application**, filter
by source `Application Error` (and `Windows Error Reporting` for the additional
parameter).

## If a dump really is needed

Sometimes it is. When that happens, the request should say what the file
contains so you can decide. Before you send one:

1. **Do not hand-scrub it.** Rewriting byte ranges inside a minidump's
   `MemoryList` to blank out secrets risks producing a file that opens cleanly
   and analyses wrong. A subtly corrupted dump is worse than no dump, because it
   costs the maintainer time on a fake stack. If a dump cannot be shared safely,
   the answer is not to sanitise it.

2. **Removing the variables is not enough on its own.** A process receives a
   *copy* of the environment block at launch and keeps it for its whole life. A
   wmux that has been running since yesterday still carries the values you
   deleted this morning. Rotating or moving your secrets only makes future dumps
   clean, and only after every affected process has been **restarted**.

   > This one caught the reporter of #174, who already knew about the problem:
   > they migrated eleven credentials out of their environment, took a dump
   > hours later, and found all eleven still in it.

3. **Verify, do not reason.** Scan the file for the values before you say it is
   clean.

4. **A full dump is worse.** `DumpType = 2` adds the process heap to the
   environment block, so it carries secrets a minidump would have missed — API
   responses, tokens read from files, anything the app touched. `wmux
   crash-report` tells you if this machine is configured to write one.

5. **Or reproduce under a clean profile** with a stripped environment, and send
   that dump instead.

## Enabling local dumps

Only do this if asked, and read the section above first.

```
HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\wmux.exe
  DumpType = 1   (minidump)
  DumpType = 2   (full dump — environment block AND heap)
```

`wmux crash-report` will warn you, on every run, for as long as this is set.

---

*This page exists because [Ray0483][174] made the argument and supplied the
case. The warning is theirs; any errors in the wording are ours.*

[150]: https://github.com/amirlehmam/wmux/issues/150
[174]: https://github.com/amirlehmam/wmux/issues/174
