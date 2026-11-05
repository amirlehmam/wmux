# ChatGPT Web Dictation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Click a window-level microphone, dictate through ChatGPT Web, then click Stop to append the transcript to the originating terminal without submitting it.

**Architecture:** An owned, isolated ChatGPT browser guest performs website dictation; an Electron coordinator manages lifecycle and permissions. The React titlebar and Voice settings consume a narrow typed preload API. A per-recording token pins terminal delivery independently of focus and broadcast input.

**Tech Stack:** Existing Electron 43, TypeScript, React 19, Zustand, xterm.js, Vitest. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-05-chatgpt-web-dictation-design.md`

## Global Constraints

- Work on `feat/chatgpt-web-dictation`, based on `master`; follow `AGENTS.md`.
- Website automation only: no OpenAI API key, private transcription endpoint, browser cookie copying, or challenge bypass.
- Recording starts on explicit Microphone click and finishes on explicit Stop click; no silence detection or automatic recording restart.
- One control in the main titlebar immediately left of Keep Computer Awake; a Voice settings section; localized English, French and Portuguese copy, with existing English fallback for other locales.
- Insert into the originally selected terminal without submitting, replacing prior prompt text, redirecting to another terminal, or broadcasting.
- Use `WMUX_INSTANCE=chatgpt-dictation-dev` for all runtime trials. Do not replace the installed app, push tags, publish releases, or submit an upstream PR.
- Never log transcript text, audio, or credentials. Use `IPC_CHANNELS`, retain browser hardening, and scope microphone permission to the owned guest/partition.

## Review Focus

- User clicks Stop while a Start operation is pending: no second capture and no stranded microphone.
- Target closes or changes process during transcription: do not deliver into a replacement shell.
- Selected microphone disappears: show an error and never silently switch mid-recording.
- Website changes language or returns partial/ambiguous text: do not deliver a stale or incomplete draft.
- User changes pane while processing or enables broadcast input: only the captured live terminal can receive the result.

---

### Task 1: Verify browser feasibility and baseline

**Files:** Existing `src/shared/instance.ts`, `src/main/webview-prefs.ts`, `src/renderer/components/Browser/BrowserPane.tsx`; add results to the spec's feasibility section.

**Interfaces:** Establish actual ChatGPT DOM controls, microphone behavior and login viability; no invented selectors. Inputs are the existing browser guest and isolated development profile; output is recorded evidence and the adapter contract for Task 2.

- [ ] Install locked dependencies with `npm ci`; run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build:main`, `npm run build:renderer`; record baseline failures.
- [ ] Run existing wmux in an isolated development instance, open ChatGPT in its browser, and verify whether login and dictation are available. Ask user to sign in manually if necessary; do not inspect stored secrets.
- [ ] Inspect actual empty composer, dictation, cancel, finish and processing controls and their supported localized labels. Verify that the selected input device can be applied to the actual website microphone track.
- [ ] If login/embedding, permission or device selection fails, stop dependent work and report the measured blocker. If user login/audio is pending, leave that gate explicit; synthetic tests cannot substitute for this evidence.

### Task 2: Website adapter and recording lifecycle

**Files:** Create `src/main/chatgpt-dictation.ts`, `src/main/chatgpt-dictation-page.ts`, `src/shared/dictation.ts`; tests `tests/unit/chatgpt-dictation.test.ts`, `tests/unit/chatgpt-dictation-page.test.ts`.

**Interfaces:** Shared `DictationState` includes phase (`idle|starting|recording|processing|error`), session id, target surface, device id and error code. `DictationCoordinator.start(target, deviceId)`, `.stop()`, `.cancel()`, `.getState()`, `.dispose()` return typed state/operations; use injected browser/timer dependencies for tests. Page operations are fixed `inspect|start|stop|cancel|takeTranscript|devices|selectDevice` commands, never arbitrary renderer-supplied scripts.

- [ ] Write and run failing tests for start/stop, cancel during start, duplicate completion, timeout, off-origin navigation, guest destruction and microphone disconnect. Expect failures from absent implementation.
- [ ] Implement the coordinator with one operation per window and generation invalidation. Require an empty dedicated composer at start; accept only the transcript produced by that generation and confirmed website completion.
- [ ] Write failing DOM fixture tests for the actual controls observed in Task 1: supported languages, missing or duplicate controls, empty transcript and stale composer; ensure no Send button is clicked.
- [ ] Implement the page adapter using the verified DOM. Bound text size and processing duration; make failures actionable. Apply selected audio-device constraints to website capture and verify the actual track settings.
- [ ] Implement the dedicated persistent partition and audio-only permission checks for the owned ChatGPT document during an explicit capture request; cleanup on cancellation, error and window teardown.
- [ ] Run `npx vitest run tests/unit/chatgpt-dictation.test.ts tests/unit/chatgpt-dictation-page.test.ts` and typecheck; expect PASS. Commit `feat(dictation): add ChatGPT Web recording lifecycle`.

### Task 3: Typed bridge and targeted terminal delivery

**Files:** Modify `src/shared/types.ts`, `src/preload/index.ts`, `src/main/ipc-handlers.ts`, `src/main/index.ts`, `src/renderer/hooks/useTerminal.ts`; create `src/renderer/utils/dictation-delivery.ts`; test `tests/unit/dictation-delivery.test.ts` and coordinator tests.

**Interfaces:** `window.wmux.dictation` exposes typed state subscription plus `start(surfaceId, deviceId)`, `stop()`, `cancel()`, `openAccount()`, device enumeration and microphone preference. Main validates the sender's window and the live target. Delivery events include the recording id and captured surface/PTY generation. `prepareDictationText(text, append)` returns safe normalized text or an error; `deliverDictation` accepts a matching live terminal only.

- [ ] Write failing tests for pane switching, target destruction/replacement, duplicate event, cancel then late result, control sequences and ordered successive segments. Assert that broadcast mode receives no extra writes and no Enter is generated.
- [ ] Add narrow IPC channels/handlers and main-process shutdown integration; remote content must not obtain wmux's preload bridge. Validate payloads and ownership before accessing the coordinator or PTY.
- [ ] Wire delivery through the original xterm's bracketed-paste handling with an explicit path that bypasses broadcast fan-out. Insert spaces between successive dictation segments as needed; do not synthesize cursor movement or erase text.
- [ ] Preserve completed text for explicit recovery when the original target cannot receive it. Changing focus must never change the target of a pending segment.
- [ ] Run targeted tests and `npm run typecheck`; expect PASS. Commit `feat(dictation): deliver transcripts to the originating terminal`.

### Task 4: Titlebar controls, Voice settings and localization

**Files:** Create `src/renderer/components/Titlebar/DictationButton.tsx`, `src/renderer/components/Settings/VoiceSettings.tsx`, `src/renderer/hooks/useDictation.ts`; modify `Titlebar.tsx`, `SettingsWindow.tsx`, `src/renderer/store/settings-slice.ts`, `src/renderer/hooks/useKeyboardShortcuts.ts`, command-palette routing in `App.tsx`, titlebar styles and `i18n/locales/{en,fr,pt}.ts`. Tests `tests/unit/dictation-ui.test.tsx` and existing shortcut/i18n tests.

**Interfaces:** UI consumes the bridge/state from Task 3. `useDictation()` returns current state and explicit start/stop/cancel/account/device actions. Voice settings owns persisted selected microphone; each Start captures current focused terminal before the titlebar takes DOM focus.

- [ ] Write failing UI tests for one titlebar microphone across split panes, icon changing to Stop, disabled processing action, preserved target on click, account setup, selected/removed microphone, and localized labels.
- [ ] Add the Microphone/Stop button immediately before `<KeepAwakeMenu />`, accessible tooltips, visible recording/processing state, error/recovery panel, and explicit cancellation. Keep the existing titlebar dimensions and drag regions.
- [ ] Add Voice settings beside the other preference tabs, with ChatGPT account setup/status, microphone chooser and permission guidance. Account management opens the real website; no password fields or API key inputs.
- [ ] Add rebindable dictation action, proposed Ctrl+Alt+V, through the common shortcut dispatch and command-palette action path. Verify claim/dispatch agreement.
- [ ] Add English, French and Portuguese keys and preserve existing fallback behavior for other locales.
- [ ] Run UI/shortcut/i18n tests, typecheck and lint; expect PASS. Commit `feat(dictation): add titlebar controls and Voice settings`.

### Task 5: End-to-end validation and contribution handoff

**Files:** Add `docs/chatgpt-web-dictation.md`; update `README.md` with a concise feature/setup link. Keep an English PR draft in local handoff artifacts rather than publishing it.

**Interfaces:** Uses the complete feature in the isolated development instance. Output is test evidence and a reviewable feature branch, with any unverified human-microphone steps explicitly disclosed.

- [ ] Run all baseline commands again: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build:main`, `npm run build:renderer`; compare with baseline and inspect `git diff --check`.
- [ ] With user login and a real spoken sample, click Microphone/Stop twice and verify ordered Portuguese text in Codex without prompt submission. Repeat in Claude Code; verify pane switching, cancel, target close, selected microphone and broadcast isolation.
- [ ] Document website dependence, setup, exact button behavior, append-at-cursor behavior, supported languages, known verified limitations and diagnostics without sensitive content.
- [ ] Request one independent whole-branch review, resolve material findings with regression tests, and rerun affected checks.
- [ ] Commit docs and verified changes; report branch, checks, remaining real-world validation, and how to run the isolated build. Do not claim upstream acceptance or real microphone success without evidence.

## Execution notes

- Implemented on `feat/chatgpt-web-dictation`; the bridge uses a typed command union and state subscription rather than separate IPC methods. Device selection persists through the existing main settings store.
- Real Portuguese website controls were inspected. The user confirmed website dictation works signed-in, and later confirmed the integrated microphone/Stop flow works manually.
- Positive account verification is mandatory before capture. Recording hides the website header/composer, so an already verified session continues through that modal without mistaking unknown UI for sign-out. Explicit sign-out still rejects it.
- Authentication initially escaped to Chrome because the general desktop navigation lock also covered WebContentsView. Only the main-owned isolated Session is now exempt; desktop protection stays enabled.
- User requested icon-only normal states after the successful manual trial: Mic -> Stop -> clickable cancel X with animated 1/2/3 dots. No recording/processing popover; login/error/recovery guidance remains.
- Independent review findings were reproduced with failing regressions and fixed: navigation provenance, completion gating, stale capture errors, and operation-scoped permission cleanup.
- Typecheck, main build, renderer build and feature-module lint passed. Full suite before the final modal/UI regression: 6517 passed, 1 failed, 95 skipped; the remaining pwsh.exe resolution failure existed at baseline. Repository lint retains its baseline 8 errors and 13 warnings. New modal and compact UI regressions also pass.
- Non-default physical-device enforcement, Claude Code specifically, and the full multi-pane/manual matrix were not physically verified. They remain explicit validation limits, not claims of completion. No upstream PR, release, tag or installed-app replacement was performed.
