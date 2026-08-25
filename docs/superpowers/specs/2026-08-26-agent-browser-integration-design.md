# agent-browser in wmux — design

Integrate [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) as a second
**engine** behind wmux's existing browser surface. The Electron webview stays the default. A user
can flip any browser tab to agent mode, at which point that tab renders agent-browser's own
observability dashboard — live viewport + activity feed — scoped to that pane's session.

---

## 1. What agent-browser actually is

Not a library. A **native Rust CLI + a persistent daemon** driving a real Chrome over CDP.

Three facts drive the whole design:

| Fact | Consequence for wmux |
|---|---|
| `agent-browser dashboard start` serves a static SPA on `:4848` over plain HTTP, with live viewport, activity feed, console, network, storage | wmux needs **zero** new rendering code — the existing `<webview>` loads it |
| Dashboard reads `?port=<streamPort>` into `activePortAtom` (`packages/dashboard/src/store/sessions.ts:12`) | Each pane deep-links to **its own** session, not a global list |
| `--session <id>` isolates browser/cookies/history/tabs; `--pin-tab` binds a session to one CDP target id | `surfaceId` → session name is a 1:1 map. Concurrent agents never collide |

Rejected: having agent-browser drive wmux's *existing* webview through the CDP proxy on `:9222`.
`cdp-proxy.ts:120` advertises one hardcoded page target and forwards page-level commands only —
agent-browser's `Target.*` / `tab new` / `--pin-tab` work has nothing to talk to. And it would show
the page but never the **activity**, which is the actual ask.

---

## 2. Surface model

`browser` stays one `SurfaceType`. It gains an engine:

```ts
// src/shared/types.ts
export type BrowserEngine = 'web' | 'agent';   // 'web' is the default, always

interface Surface {
  type: SurfaceType;
  browserUrl?: string;
  browserEngine?: BrowserEngine;   // undefined ⇒ 'web'
}
```

**Not** a new `SurfaceType`. Keeping `type: 'browser'` means the split tree, keep-alive tabs,
session persistence, `list-surfaces` and every existing consumer keep working untouched. A new
surface type would have meant touching all of them for no gain.

Persistence: `browserEngine` is additive and optional, so it satisfies the superset rule from
`session-persistence.ts` — an older backup restores as `'web'`, which is correct by construction.

---

## 3. Main-process components

Four new files, each with one job.

### `agent-browser-cli.ts` — where is the binary, and does it run
Resolve `agent-browser` once and memoise, the way `node-runtime.ts` memoises `WMUX_NODE`. Must not
assume it is on `PATH`: wmux panes get a curated PATH, and npm's global bin on Windows is a
`.cmd` shim — the exact trap documented in `powershell-shim.ts`. Resolution order: explicit setting
→ npm global prefix → `PATH` probe → not found. Every invocation goes through one `run()` that
shells the absolute path with `--json` and parses the result.

### `agent-browser-daemon.ts` — the dashboard process
Owns `dashboard start` / `dashboard stop`, ref-counted by the number of live agent-mode surfaces.
Drops to zero → stop. Two rules:

- **Adopt, never fight.** If `:4848` already answers, a human started it. Use it, and do not stop
  it on teardown — wmux did not start it, so stopping it is not wmux's to do.
- **Register with the orphan reaper.** `will-quit` is not the only teardown path; a crash must not
  leak a Chrome. This is the `#139` lesson, and a detached Rust daemon is exactly the shape that
  leaks.

### `agent-browser-session.ts` — surfaceId → session
Maps a surface to `{ sessionName, streamPort, dashboardUrl }`. Session name is derived from
`surfaceId` so it is stable across daemon restarts. **wmux allocates the stream port itself** and
passes `AGENT_BROWSER_STREAM_PORT`, because the dashboard deep-link keys on port — discovering an
OS-assigned port after the fact is a race. Sessions are created lazily. The daemon's 1h idle
timeout is expected, not an error: a command against a reaped session re-creates it.

**Sessions are ephemeral** (§3a).

### 3a. Session lifetime

A session's process lifetime equals its surface's lifetime. Nothing is persisted.

| Event | Action |
|---|---|
| Agent-mode tab closed | `agent-browser --session <surfaceId> close` |
| Tab flipped `agent` → `web` | same — the session is torn down, not parked |
| Last agent-mode surface closes | daemon refcount hits 0 → `dashboard stop` (unless adopted) |
| wmux quits or crashes | orphan reaper closes all sessions + the daemon |

No `--profile` dir, no `--restore`, no `~/.agent-browser/sessions/` growth, and no stale auth on
disk. Reopening an agent tab gets a fresh, logged-out Chrome.

This makes orphan handling correct by construction rather than by heuristic: there is no such thing
as a legitimately-surviving wmux-owned session, so the reaper never has to distinguish "idle" from
"leaked" — any wmux-named session with no live surface is garbage. That is the property the
`#139` post-mortem wanted and did not have.

Chrome runs **headless**. The point of agent mode is watching the browser inside the wmux pane; a
second real Chrome window appearing on the desktop would defeat it. `--headed` stays available as
an escape hatch via `agent-browser.json`, which is the user's file, not wmux's.

### `agent-browser-verbs.ts` — the translation table
A **pure** function `wmux verb + params → argv[]`. Pure so it is unit-testable with no daemon, no
Chrome, and no Electron. This is the piece most likely to drift, so it gets the most tests.

---

## 4. Command routing

`v2-browser.ts` is the single funnel — every `browser.*` method already passes through
`runBrowserCommand`. The change is to resolve a **target** instead of a bare `wcId`:

```ts
type BrowserTarget =
  | { kind: 'web';   wcId: number }
  | { kind: 'agent'; session: AgentSession };
```

`resolveBrowserTarget(caller)` keeps today's per-caller binding logic (`#62`) and additionally
reads the bound surface's `browserEngine`. `runBrowserCommand` switches once on `target.kind`.

Agents change **nothing**. The global CLAUDE.md keeps saying `wmux browser open <url>`; the engine
underneath is what changed. Kiro and OpenCode inherit it for free, because they read the same
verbs. No new context injection, so nothing new is written outside `%APPDATA%` — this integration
does not need a new `agent-integration.ts` consent gate.

### Verb mapping

| wmux | agent-browser | note |
|---|---|---|
| `browser.navigate` | `open <url>` | |
| `browser.snapshot` | `snapshot` | refs normalise `eN` ⇄ `@eN` |
| `browser.click` | `click @eN` | |
| `browser.type` | `type @eN <text>` | |
| `browser.fill` | `fill @eN <val>` | |
| `browser.get_text` | `get text @eN`, or `read` with no ref | wmux's no-ref form means whole page |
| `browser.screenshot` | `screenshot --full?` | returns base64 to match today's shape |
| `browser.eval` | `eval <js>` | |
| `browser.wait` | `wait <sel>` | |
| `browser.back` / `forward` / `reload` | `back` / `forward` / `reload` | **see §5** |

---

## 5. A bug this uncovered

`wmux browser back|forward|reload` are documented in the global CLAUDE.md that wmux writes to every
machine, and the CLI does send `browser.back` / `browser.forward` / `browser.reload` — but
`runBrowserCommand`'s switch has no case for them, so they hit `default:` and throw. Verified live:

```
$ wmux browser back     → Error: Unknown: browser.back
$ wmux browser reload   → Error: Unknown: browser.reload
```

Three documented verbs have never worked. Mapping them in agent mode only would make them work in
one engine and throw in the other, which is worse than the status quo. So this work adds
`goBack` / `goForward` / `reload` to `cdp-bridge.ts` and the three cases to `runBrowserCommand`,
fixing both engines together.

---

## 6. Renderer

`BrowserPane` takes `engine` and branches:

- **`web`** — exactly today's behaviour. Unchanged.
- **`agent`** — `loadURL(dashboardUrl)`. **Never** re-point `src`: the comment at
  `BrowserPane.tsx:14-18` records that binding `src` to mutable state double-loads and produces
  spurious `ERR_ABORTED`. An engine switch is precisely the mutation that comment warns about.
- **`agent`, binary missing** — the setup card (§7), no webview at all.

Two things agent mode must **not** do:

1. **Not call `claimCdp()`.** Registering the dashboard page as a CDP target would make
   `wmux browser` commands aimed at that surface drive the dashboard's own DOM. The engine check
   goes in `claimCdp`, not just at the call sites, so a future call site cannot reintroduce it.
2. **Not install the popup bridge.** It exists for `target="_blank"` on arbitrary sites (`#126`);
   the dashboard is a known SPA that does not need it.

The AddressBar gains an engine toggle (`web ▏✦agent`). In agent mode the URL field addresses the
*remote* browser: typing a URL runs `open <url>` in the session rather than navigating the webview.

Flipping engines carries the URL across in both directions, so the tab feels like one browser with
two backends rather than two unrelated tabs.

---

## 7. Install flow

wmux ships nothing. Zip size and the manual ASAR/rcedit release process are untouched.

Probe on first use. If absent, the agent-mode tab renders a setup card. **Install** opens a real
terminal surface running `npm i -g agent-browser && agent-browser install` — a visible terminal
rather than a spinner, so ~240 MB of npm and Chrome-for-Testing output is legible and its failures
are diagnosable. On success the pane flips itself to the dashboard.

Clicking Install *is* the consent. `agent-browser doctor --json` backs a "Diagnose" affordance when
something is off later.

---

## 8. CLI & settings

```bash
wmux browser engine                      # print this surface's engine
wmux browser engine agent [--surface id] # switch
wmux browser engine web   [--surface id]
```

Settings → Browser: default engine for new browser surfaces (ships `web`). Per the
`project_pref_default_rev` lesson, this is a *new* key, so it needs no rev-and-promote dance —
absent means `web`.

Deliberately out of scope: a `wmux browser -- <raw args>` passthrough to agent-browser's other
~50 verbs. One vocabulary, one ceiling. Revisit only if the mapped verbs prove insufficient.

---

## 9. Failure modes

| Situation | Behaviour |
|---|---|
| Binary missing | Setup card. Never a broken pane. |
| `:4848` taken by a user's own dashboard | Adopt it; do not stop it on teardown. |
| Daemon idle-timeout reaped the session | Re-create lazily on next command. Not an error. |
| Chrome not installed (`agent-browser install` not run) | Surface agent-browser's own message + a Diagnose button. |
| wmux crashes | Orphan reaper kills the daemon. No leaked Chrome. |
| Two panes in agent mode | Distinct sessions, distinct stream ports, `--pin-tab` so neither steals the other's tab. |

---

## 10. Testing

Unit (vitest, no Chrome, no Electron):
- `agent-browser-verbs` — every verb, both ref forms, no-ref `get_text`, quoting/escaping
- binary resolution — `.cmd` shim, absent, explicit-setting override
- port allocation — collision, exhaustion
- target resolution — engine `web` vs `agent` vs undefined-means-web
- **guard test**: agent mode never reaches `cdp.attach` (source-level, same shape as the
  `opencode-plugin` export-count pin)
- back/forward/reload reach `cdp-bridge` in web mode (regression pin for §5)

Live (manual, on this machine): install flow, both engines side by side in one workspace, engine
flip preserving URL, wmux quit leaving no orphan Chrome.

---

## 11. Order of work

1. `browserEngine` on the surface model + persistence
2. §5 bugfix — back/forward/reload in both `cdp-bridge` and `runBrowserCommand`
3. `agent-browser-cli.ts` (resolution + probe)
4. `agent-browser-verbs.ts` + tests
5. `agent-browser-daemon.ts` + `agent-browser-session.ts` + reaper registration
6. `v2-browser.ts` target routing
7. `BrowserPane` engine branch + AddressBar toggle
8. Setup card + install flow
9. CLI `browser engine` + settings
10. Full test pass, then live verification
