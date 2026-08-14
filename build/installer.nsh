; wmux NSIS customisations.
;
; Icon cache (issue #137)
; ----------------------
; wmux USUALLY installs to the same path on every update, and Windows caches
; shell icons per path in %LocalAppData%\Microsoft\Windows\Explorer\iconcache_*.db.
;
; "Usually" is deliberate, and was stated as an invariant here until issue #158
; showed it is not one. With `oneClick: false` and
; `allowToChangeInstallationDirectory: true` and no `perMachine` pin, the
; assisted installer re-offers both the scope and the directory MID-UPDATE — so
; a user who picks "All Users" on an update that replaces a per-user install
; moves the root from %LOCALAPPDATA%\Programs\wmux to C:\Program Files\wmux and
; the old directory is removed. Anything holding an absolute path to the old
; root (a hand-added PATH entry, a shortcut, a script) is silently invalidated.
;
; Nothing in wmux may therefore treat its own install path as stable across
; updates. The agent-context block handles this by interpolating
; `process.resourcesPath` fresh on every startup rather than recording it once
; (see src/main/agent-instructions.ts) — the writer is the running build, so it
; self-heals across exactly this relocation.
;
; Pinning the scope here would make the invariant true, but it changes upgrade
; behaviour for every existing install and cannot be verified without running a
; real installer, so it is deliberately NOT done as a side effect of #158.
; So after an update that changed the artwork, the taskbar button, the pinned
; shortcut, the desktop shortcut and the Start-menu entry can all keep drawing
; the icon of the version they replaced — while the app's own window icon and
; its notifications, which Electron loads from disk at runtime, update
; immediately. That split is exactly what #137 reported, and it makes the app
; look half-updated even though every shipped asset is correct.
;
; ie4uinit is the documented way to make the shell re-read them. `-show` is the
; Windows 10/11 spelling and `-ClearIconCache` the older one; an unrecognised
; flag is a no-op, so running both covers every supported host without a
; version check. nsExec runs them silently — ExecShell would flash a console.
; Failure is ignored on purpose: a stale icon must never fail an install.

!macro customInstall
  nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
  Pop $0
  nsExec::Exec '"$SYSDIR\ie4uinit.exe" -ClearIconCache'
  Pop $0
!macroend
