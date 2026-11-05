# ChatGPT Web dictation for terminal prompts

Status: accepted direction, updated with the user's titlebar/settings requirements
and explicit confirmation that each segment is inserted by clicking Stop.

## Intent

Let a Windows wmux user dictate a Codex, Claude Code, or other terminal prompt using the dictation UI at
https://chatgpt.com, without manually switching applications or copying text.
Use the signed-in website, without an OpenAI API key or direct calls to private
ChatGPT endpoints. Transcription still happens through ChatGPT's online service.

## Approaches

1. **Automate the signed-in ChatGPT page inside wmux (selected direction).**
   Preserves the requested transcription service and can place its result into
   the originating terminal. Depends on website controls, embedded-browser login,
   and microphone access. This direction was presented and accepted in the conversation.
2. **Use desktop/CLI voice features.** Official voice features exist, but the
   fetched documentation does not establish a supported way to insert exactly
   this Web dictation result into an arbitrary wmux terminal. Voice conversation
   is a different interaction from editing a dictated prompt.
3. **Local transcription or a public transcription API.** Easier to own as an
   integration, but does not meet the user's requirement to use ChatGPT Web
   dictation without an API key.

## Proposed experience

- A microphone button in the main window titlebar, immediately to the left of
  Keep Computer Awake. This is a window control, not a terminal-tab control, so
  splitting panes does not duplicate it. The button becomes Stop while recording,
  has a distinct processing state, and has localized tooltips/accessibility labels.
  Keep the action accessible from the command palette and a rebindable shortcut.
  Proposed default: Ctrl+Alt+V, subject to existing conflict rules.
- Add a Voice settings section alongside Prompts, Browser and Notifications.
  Include Connect/Manage ChatGPT account (manual login in the dedicated page),
  selected microphone, and permission/device availability feedback. Use the
  repository's existing locale system for every user-facing string. Persist the
  selected device, handle hotplug/default-device changes, and do not switch
  microphones silently during a recording. A microphone chooser must actually
  constrain the microphone used by the website; selecting a device in wmux alone
  is not sufficient. Verify this in the feasibility test.
- Capture the active terminal surface and window when starting; reject actions
  from non-terminal surfaces. One pending dictation per window.
- On first use, open a dedicated ChatGPT page for the user to sign in manually
  and allow the microphone. Reuse that page/session on later attempts. Never
  copy browser cookies, read auth tokens, or ask for a password in wmux UI.
- Show a compact panel containing status, Start/Stop or Finish, Cancel, and a
  way to show the ChatGPT page. Keep recording and processing visible to the user.
- The shortcut starts a recording when ready and finishes it while recording.
  During processing it cannot start another recording. Esc/Cancel discards the
  pending insertion and attempts to stop the website recording.
- Read only the dedicated page's prompt composer after the current dictation
  completes. Require an empty composer before starting so a previous draft is
  never mistaken for a new transcript or overwritten.
- Insert a successfully completed result once into the original terminal prompt
  for review. Never click ChatGPT Send and never press Enter in the terminal.
- Support successive short dictations into the same prompt. Each completed
  segment is appended at the terminal input cursor without clearing or replacing
  the previous segment. Insert a separating space between successive segments
  where appropriate, never a submission newline. Do not send synthetic cursor
  movement keys: manual editing/cursor changes remain under the user's control.
- Each segment ends only when the user clicks Stop. Silence never automatically
  commits text or restarts recording. The user explicitly confirmed this matches
  the ChatGPT website interaction. A subsequent click on Microphone starts a new
  segment, targeted to the terminal focused at that new click.
- Switching panes never redirects the result. If the target terminal disappears,
  preserve the result in the panel for explicit copy; do not choose another target.
- On login expiry, missing controls, denied microphone, navigation, guest crash,
  ambiguous result or timeout, show an actionable error and offer the page.
  Do not silently fall back to another transcription engine.

## Implementation boundaries

- Keep the existing Electron/React/TypeScript architecture and dependencies.
  Add a small dictation host/coordinator and a separately testable page adapter.
- Use an owned browser guest and its existing hardened preferences. Use DOM
  interaction/executeJavaScript, not an iframe or reverse-engineered endpoints.
  Inspect and validate actual ChatGPT controls during feasibility testing;
  selectors in tests alone do not establish website compatibility.
- Limit adapter operations to the exact HTTPS chatgpt.com origin, top-level
  document and the owned guest. Navigation invalidates the current operation.
  Login pages remain available for manual interaction, without adapter execution.
- Keep login storage in an explicitly dedicated persistent browser partition.
  Any microphone permission handler applies only to that partition and allows
  audio only after an explicit user recording action, for the owned ChatGPT
  document. Do not change permissions on ordinary browser panes.
- Use IPC_CHANNELS for any new IPC and narrow, validated preload methods. No
  arbitrary JavaScript evaluation or unvalidated terminal-write bridge is exposed
  to the remote page. Retain nodeIntegration=false and contextIsolation=true.
- Use existing shortcut dispatch/claimsKeyEvent and the command palette action
  path. Add user-facing text through the existing i18n mechanism.
- Delivery uses the original live xterm instance and bracketed paste, with a
  targeted delivery path that does not fan text out through broadcast-input.
  Normalize line endings and reject terminal control sequences before delivery.
- A session/generation identifier invalidates late async completions after cancel,
  navigation, retry, target loss, or window teardown. A result is delivered once.
- Keep transcripts in memory; do not log audio, prompt text, or credentials.
  Website/account storage and ordinary terminal history retain their normal roles.
  Do not persist dictation sessions into wmux's saved workspace layout.
- Cancel/teardown must release the recording/page resources and listeners. Avoid
  destroying an actively recording guest without first attempting cancellation;
  destroy the owned guest on teardown as the final resource-release guarantee.

## Feasibility gate

### Development findings (2026-11-05)

- A separate Electron 43 wmux instance loads the real ChatGPT page successfully.
  The observed Portuguese dictation button is `Iniciar ditado`; the public
  mobile composer is a textarea with id `mobile-composer-prompt`. These are
  observations, not a guarantee about the signed-in desktop composer.
- The user tried dictation and received `Não foi possível transcrever. Tente
  novamente.` The test page remains signed out (login buttons are present).
  Read-only diagnostics show microphone permission `granted` and audio inputs
  available. Network observation returned HTTP 401 on anonymous-session
  preparation requests; no audio payload, authentication headers, or prompt
  text was recorded. These observations do not yet identify the transcription
  failure's cause. Signed-in validation is pending the user's manual login.
- Baseline before product changes: typecheck, main build and renderer build pass;
  lint reports 8 errors and 13 warnings; tests report 6 failed, 6481 passed and
  95 skipped. Retain the original failures separately from feature validation.
- A development CLI must set `WMUX_PIPE` explicitly and clear inherited
  `WMUX_PIPE_TOKEN` and `WMUX_SURFACE_ID`: a parent wmux's pipe takes precedence
  over `WMUX_INSTANCE` in the CLI. The development instance uses its own pipe,
  profile and app-data directory.

Before building out all UI, validate login and microphone access against the
real ChatGPT page in a separate wmux development instance. The user performs
login and speaks a short sample if needed. Do not promise unattended background
operation before that test. If embedding or browser policy prevents this flow,
report the measured blocker and revisit the browser host instead of shipping
an adapter that has only passed synthetic tests. No fingerprint spoofing or
challenge bypass is part of this feature.

## Verification and contribution

- Work in this fresh checkout on feat/chatgpt-web-dictation, based on master.
  No required feature-branch naming convention, CONTRIBUTING file, or PR template
  was found. Existing commits use feat(scope): / fix(scope): style.
- Follow AGENTS.md and the module design comments; no release tags, version bump,
  publishing workflow, production install replacement, or upstream PR submission.
- Run the development build with WMUX_INSTANCE=chatgpt-dictation-dev to keep the
  installed wmux's sessions, named pipe, profile and Windows app identity separate.
- Test the page adapter against supported labels/states and malformed/absent
  controls; test navigation, recording cancellation, timeout, duplicate completion,
  dead targets, non-terminal targets, control-character handling and no broadcast.
- Run npm test, npm run typecheck, npm run lint, npm run build:main, and
  npm run build:renderer. Record any baseline failures separately.
- Real acceptance: sign in, dictate Portuguese, finish, observe the exact text
  in the original Codex composer with no submission. Repeat with a pane switch,
  cancellation, and target closure. Human audio is required for this last check.
- Document setup, account/site dependencies, selector fragility, and verified
  limitations. Prepare an English PR description with behavior and test evidence.

## Builder discretion

The implementer may choose module filenames, status wording, interval/deadline
values and the compact panel layout within the repository's existing patterns.
The proposed shortcut and dedicated partition are implementation choices, not
preferences explicitly stated by the user. Keep the first version scoped to
desktop Windows terminal input, usable with Codex and other prompt-based TUIs.
