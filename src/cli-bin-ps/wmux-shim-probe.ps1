# Proof that PowerShell will actually run wmux.ps1 on this machine.
#
# A .ps1 blocked by execution policy — Restricted (the Windows PowerShell 5.1
# default), or RemoteSigned against a file still carrying the Mark of the Web
# from a downloaded zip — is a HARD error, and PowerShell does not fall back to
# wmux.cmd when it refuses one. Putting the shim on PATH unconditionally would
# therefore trade issue #154's silent wrong result for a `wmux` that does not run
# at all.
#
# So wmux runs this file first, in the same directory and with the same origin as
# the shim, from a probe process with any inherited -ExecutionPolicy Bypass
# cleared (see src/main/powershell-shim.ts). If it prints its marker, the shim dir
# is prepended to PATH; if anything stops it, the dir is left off and PowerShell
# keeps resolving wmux.cmd exactly as it does today.
Write-Output 'wmux-shim-ok'
