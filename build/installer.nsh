; wmux NSIS customisations.
;
; Icon cache (issue #137)
; ----------------------
; wmux installs to the same path on every update, and Windows caches shell
; icons per path in %LocalAppData%\Microsoft\Windows\Explorer\iconcache_*.db.
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
