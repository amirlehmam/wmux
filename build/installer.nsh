; wmux NSIS customisations.
;
; Install scope on update (issues #158, #167)
; ------------------------------------------
; An update must land in the installation it is replacing. Until 1.3.0 it did
; not have to: with `oneClick: false`, `allowToChangeInstallationDirectory:
; true` and no `perMachine` pin, the assisted installer re-offered the SCOPE
; page mid-update, so a user who picked "All Users" over a per-user install
; moved the root from %LOCALAPPDATA%\Programs\wmux to C:\Program Files\wmux and
; the old directory was removed under them. Anything holding an absolute path
; to the old root — a hand-added PATH entry, a script — was silently
; invalidated, and #167 is the sharper consequence: the relocated install is
; one the running process cannot write, so in-app updates from then on need
; rights it does not hold.
;
; The asymmetry that allowed it is in electron-builder's own templates. In
; `assistedInstaller.nsh` the DIRECTORY page is wrapped in `skipPageIfUpdated`
; and the INSTALL MODE page immediately above it is not — and `initMultiUser`
; has ALREADY read the existing scope out of the registry and selected it
; (assistedInstaller.nsh, `HKLM`/`HKCU` … `InstallLocation`) before either page
; renders. The page was never asking a question the installer needed answered;
; it was offering a chance to overwrite an answer it already had right.
;
; `customInstallMode` is the documented seam for this: `multiUserUi.nsh` zeroes
; both force flags and inserts this macro immediately afterwards, then aborts
; the page when either is set. Setting them from the registry probe therefore
; pins the scope to whatever is already on disk, and the page is skipped.
;
; Deliberately narrow:
;   - Only when EXACTLY ONE of the two exists. A first install (neither) still
;     gets the choice, and a machine carrying both still gets it, because
;     picking one on the user's behalf there would be a guess.
;   - `/allusers` and `/currentuser` keep working as the deliberate way to move
;     an install between scopes: `initMultiUser` folds them into the same two
;     variables this reads, so an explicit switch forces itself.
;   - Installer only. The uninstaller already skips the page when there is a
;     single installation (the `BUILD_UNINSTALLER` branch in the same function),
;     and its variables are populated on a different path.
;
; The directory page is untouched: it is guarded on update already, and
; relocating within a scope is a thing the user is choosing on purpose.
;
; This does NOT make the install path an invariant, and nothing in wmux may
; treat it as one — a user can still relocate deliberately. The agent-context
; block handles that by interpolating `process.resourcesPath` fresh on every
; startup rather than recording it once (see src/main/agent-instructions.ts).

!ifndef BUILD_UNINSTALLER
  !macro customInstallMode
    ${if} $hasPerMachineInstallation == "1"
    ${andIf} $hasPerUserInstallation == "0"
      StrCpy $isForceMachineInstall "1"
    ${elseIf} $hasPerUserInstallation == "1"
    ${andIf} $hasPerMachineInstallation == "0"
      StrCpy $isForceCurrentInstall "1"
    ${endIf}
  !macroend
!endif

; Icon cache (issue #137)
; ----------------------
; wmux installs to the same path on every update — now actually true for the
; scope, per the block above — and Windows caches shell icons per path in
; %LocalAppData%\Microsoft\Windows\Explorer\iconcache_*.db.
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
