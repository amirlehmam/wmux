# Explorer diff stats + editable code surface

Design record for the follow-up to #210. Two features, one release.

1. Per-file and per-folder `+55/-22` counts in the explorer tree, with a marker on
   the files an agent touched.
2. The `code` surface stops being read-only, and a file opened from the tree can be
   saved in place.

---

## 1. Diff stats in the tree

### Where the numbers come from

`src/main/diff-provider.ts` already answers exactly this question and already returns
`{ path, status, additions, deletions }`. It has two backends and picks between them
itself:

| Root is | Baseline | Meaning |
|---|---|---|
| a git repo | `git diff HEAD --numstat` + `git status --porcelain` | every uncommitted change |
| not a repo | a content snapshot taken on first call | changed since the session started |

This feature adds **no diff engine**. It adds a caller. That is the whole point: the
`DiffPane` and the explorer must never be able to disagree about what changed, and two
providers would eventually disagree.

It also inherits the issue #141 hardening for free — every git spawn is coalesced per
cwd, and the repo probe is TTL-cached. A burst of refreshes collapses into one pass
rather than one `git.exe` per caller.

### How the renderer asks

New channel `explorer:diff-stats`, taking a **surfaceId** — never a cwd.

`diff:get-files` already exists and takes an absolute cwd from the renderer. It is not
reused here, and that is deliberate: it predates #210 and carries the pattern #210
exists to reject. The new channel goes through `explorerRootFor`, the gate #210 wrote
once and shared across five handlers, so the explorer's diff view is bounded by the
same ownership + ssh + root checks as its listing. One gate, six callers.

### Rolling files up into folders

`src/renderer/components/Explorer/explorer-diff.ts`, pure.

Input is the flat `ChangedFile[]`. Output is `Map<relPath, { additions, deletions }>`
containing an entry for every changed file **and for every ancestor directory of one**,
so a collapsed `src/` shows the sum of everything beneath it.

Pure, in the renderer, and kept out of the component for the same reason
`explorer-state.ts` and `explorer-keynav.ts` are: it is testable with no git, no fs and
no DOM.

Path spelling is the trap. `ChangedFile.path` is POSIX-separated (git's output, and the
snapshot walk normalises to match), and `listDir` already returns POSIX on the wire. The
rollup keys on that one spelling and never on `path.sep`.

### Attribution

The renderer already receives every Claude Code hook event via `hook.onEvent`, and
`wmux-hook.js` already extracts `tool_input.file_path` into `params.file`. Nothing new
has to be installed, sent or parsed.

A `PostToolUse` for `Edit` / `Write` / `MultiEdit` / `NotebookEdit` puts that path into a
bounded per-root `Set`. Rows in that set get an accent dot. The dot is **additive
information on top of the numbers**, never a filter on them: with no agent running, no
hooks installed, or an agent that does not fire hooks, there are simply no dots and
every number still works. This is the same "degrade to honest silence" rule the prompt
log (#207) follows — wmux does not guess at agent state.

The set is session-scoped and bounded (512 paths, per root). It is not persisted: "what
did the agent touch" is a question about the run you are watching.

### Refreshing

Three triggers, no timer that can run at render speed (#141):

- the panel's existing ↻ button
- a hook event naming a file under the root
- a slow poll (4 s) that runs **only** while the panel is open and the window is focused

### Rendering

`+N` in the theme's add colour, `-N` in the remove colour, right-aligned in the row.
Zero is not rendered — an unchanged file shows nothing rather than `+0/-0`, so the eye
lands only on what moved.

---

## 2. Editing

### What this reverses, and why it is written down

#210 refused a jailed markdown read that mints a write grant, on the grounds that
"jailed to a pane root" is not consent and the native Save As dialog is. That reasoning
was right for the feature it was reasoning about — an automatic grant, minted as a side
effect of a read the user did not ask for, over the folder the user's real work lives in.

This is a different transaction. The user clicks a row in a tree, types into the buffer,
and presses Ctrl+S. The grant records **that** gesture. The rule it establishes:

> A write lands only on a path that was opened into a live pane in this window, in this
> session, through the jail — and only if the file has not changed on disk since it was
> read.

Narrower than "anything under the root", wider than "only what a dialog returned". The
reversal is recorded in the module header so a later reader finds the reasoning rather
than rediscovering the argument.

### One grant set, not two

`markdown-grants.ts` is already a generic `Map<webContentsId, Set<canonicalPath>>`; only
its name is markdown-specific. It becomes **`file-grants.ts`** — mechanical rename, same
behaviour, same window-scoped lifetime — and both `markdown:save-file` and the new
`code:write-file` check it.

Two grant sets would be two answers to "may this be written", and the failure mode of
that drift is a silent write to a file one of them would have refused.

### Minting

- `code:read-file` mints on success. It is already jailed by `resolveInRoot`.
- `explorer:read-markdown` is **new**, and is the handler #210 deleted — reinstated
  deliberately, with the consequence #210 declined. Jail (`resolveInRoot`) **and** the
  markdown extension whitelist (`readMarkdownFile`) **and** the mint. `open-preview.ts`
  switches its markdown branch onto it, so a `.md` opened from the tree becomes
  saveable, which is the second half of "whatever file it is".
- `markdown:read-file` (the unjailed, absolute-path form) still mints **nothing**. It is
  reachable with a renderer-supplied path and that has not changed.

### The write

`code:write-file` — `resolveInRoot('file')`, then the grant check, then
`expectedMtimeMs`.

The mtime guard is not defensive padding here, it is the core of the feature. The
premise of this whole release is an agent editing files in the same folder the user is
reading. Without it, whoever saves last wins and the other's work vanishes with no
message. `writeMarkdownFile` already takes `expectedMtimeMs` and refuses a stale write;
`writeCodeFile` mirrors it exactly rather than inventing a second conflict rule.

A refused write surfaces as a reload prompt in the pane. It never resolves itself by
picking a winner.

### The editor

A plain `<textarea>` sharing the pane with the existing line-number gutter. Explicitly
**not** CodeMirror or Monaco: the renderer bundle is already 1.83 MB, and an editor
dependency roughly doubles it to serve "edit a thing or two in a file", which is the
request. Tab inserts a tab, Ctrl+S saves, Esc reverts to the last saved buffer.

`CodePane`'s header currently states that read-only is a property of the component's
shape rather than a flag. That stops being true and the header is rewritten to say what
is now true, rather than left to mislead.

Dirty state shows on the surface tab, reusing the marker `markdownDirty` already
established.

---

## Testing

Pure modules carry the load, as in #210:

- `explorer-diff.ts` — rollup, ancestor sums, POSIX/`path.sep` spelling, empty input,
  deep nesting, a changed file at the root
- attribution set — bounded, per root, tool filtering, path relativisation
- `writeCodeFile` — jail, grant refusal, mtime conflict, size cap, symlink refusal
- `file-grants.ts` — rename does not change behaviour; existing markdown grant tests
  must pass untouched
- the write IPC handler — refuses an ungranted path even when the jail would accept it

## Out of scope

Syntax highlighting, multi-file save, undo history beyond the textarea's own, and any
form of `.gitignore` parsing for the tree.
