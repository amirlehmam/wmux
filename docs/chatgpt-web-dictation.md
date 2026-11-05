# ChatGPT Web dictation

The titlebar microphone, immediately before Keep Computer Awake, uses dictation
on the actual ChatGPT website. It requires a signed-in ChatGPT account and does
not use an OpenAI API key. Availability and transcription are controlled by the
website; this is a website-dependent integration, not a stable transcription API.

## Setup

1. Open **Settings → Voice → Sign in to ChatGPT**.
2. Sign in manually in the dedicated account window. Its persistent browser
   profile is separate from ordinary wmux browser tabs. Authentication redirects
   and HTTPS sign-in popups stay within that isolated profile.
3. Return to Voice and click **Check connection**. A confirmed connected account
   is required. A signed-out or unverifiable session blocks the first microphone
   click and offers sign-in guidance before recording.
4. Optionally click **Allow microphone and refresh devices** and choose an input.
   Refresh briefly requests microphone access to obtain device labels, then
   stops that stream. The selection is saved in wmux settings.

The dedicated website has no wmux preload or terminal bridge. Only the owned
ChatGPT document receives audio permission during an explicit capture action;
video and unrelated origins are denied. Passwords are entered on the website,
not in wmux settings. Ordinary browser cookies are not copied.

## Dictate into a terminal

Select a terminal, click the microphone, speak, then click **Stop**. You can also
use **Ctrl+Shift+S**, rebind **Start or stop dictation** in **Settings → Shortcuts**,
or use the command palette. Press once to start and again to stop; holding the
keys does not repeatedly toggle recording. The button
turns red and shows a stop icon while recording. After Stop, it becomes an X
with animated dots cycling from one to three. Click that X to cancel a pending
transcription. Normal recording and processing do not open a status panel;
sign-in guidance and errors still appear when needed.

Stop asks the website to finish transcription. Once its dictation controls return
and Send is enabled, wmux pastes the transcript into the terminal selected when
recording started. It never clicks ChatGPT Send or sends Enter to the terminal.
This works through terminal input rather than an agent-specific integration.

Each subsequent microphone/Stop cycle inserts another segment at the terminal's
current cursor, with a trailing space separating successive segments. Keep the
cursor at the end of your draft for continuous append behavior. Pauses in speech
do not insert text or restart recording automatically.

Changing pane focus during a recording does not redirect its result. Broadcast
input does not fan the transcript out to other panes. If the original terminal
closes or is replaced, the transcript is shown for manual copy and recovery.
Newlines are flattened and terminal control characters are rejected.

## Troubleshooting and limits

- **Sign in required:** sign in again in the dedicated window, then retry. A
  session expiring during an operation also blocks transcript delivery.
- **Existing draft:** open the dedicated ChatGPT window and clear its draft
  yourself. Starting dictation never overwrites an existing draft.
- **Microphone unavailable:** check Windows microphone privacy settings and the
  selected device in Voice. wmux does not silently choose another physical
  device when a specifically selected device is missing.
- **Website changed or timed out:** open ChatGPT and check its state. Unknown or
  ambiguous controls fail closed. Navigation during capture invalidates the
  operation rather than reading a different conversation's draft.
- **Transcription failed:** check the signed-in website and microphone. Website
  account limits or service errors can still prevent transcription.

The adapter recognizes English, Portuguese and French website controls. The
wmux UI includes these translations and uses its existing English fallback for
other languages. Website experiments and markup changes may require adapter
updates. Transcripts, audio and credentials are not added to diagnostic logs.

Development verification includes DOM fixtures, lifecycle cancellation races,
navigation, completion gating and targeted terminal delivery. Real microphone,
device enforcement and Codex/Claude behavior must also be checked in the running
app; synthetic tests alone do not establish end-to-end compatibility.
