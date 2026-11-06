; One Key — extra uninstall steps for the NSIS installer.
;
; The Chrome bridge registration lives outside the install folder (registry plus
; a manifest under LocalAppData/ProgramData), so the default uninstaller leaves it
; behind, pointing at an executable that no longer exists. Remove it here.
;
; The vault is deliberately NOT touched. It is the only copy of the user's
; passwords, there is no recovery path, and reinstalling to upgrade must not
; destroy it. tools\purge-data.ps1 exists for people who do want it gone.

!macro customUnInstall
  DetailPrint "Removing Chrome bridge registration..."

  ; Per-user registration. Always ours to remove.
  SetShellVarContext current
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.onekey.host"
  Delete "$LOCALAPPDATA\One Key\com.onekey.host.json"
  Delete "$LOCALAPPDATA\One Key\app-path.txt"
  ; RMDir without /r only removes the folder when it is already empty, so
  ; nothing unexpected is taken along with it.
  RMDir "$LOCALAPPDATA\One Key"

  ; Machine-level registration, used when policy blocks user-level hosts. NSIS
  ; has no $PROGRAMDATA; under the all-users shell context $APPDATA resolves to
  ; C:\ProgramData, which is where the machine manifest lives.
  ;
  ; This only succeeds when the uninstaller runs elevated. If it does not, the
  ; failure is silent and tools\purge-data.ps1 -Force clears it from an admin
  ; prompt instead.
  SetShellVarContext all
  DeleteRegKey HKLM "SOFTWARE\Google\Chrome\NativeMessagingHosts\com.onekey.host"
  Delete "$APPDATA\One Key\com.onekey.host.json"
  Delete "$APPDATA\One Key\app-path.txt"
  RMDir "$APPDATA\One Key"

  SetShellVarContext current
!macroend
