; Lumen Notes · install / uninstall policy
;
; An in-place UPGRADE (electron-builder passes --updated to the old
; uninstaller) must never ask and must never touch user data: the next launch
; keeps its vault config, recent files and drafts. A real uninstall from
; Control Panel or from the shipped uninstaller ASKS whether to keep them.
;
; electron-builder compiles the uninstaller with `SilentInstall silent`,
; which normally suppresses MessageBox. `SetSilent normal` re-enables the
; dialog at runtime; /SD IDYES is the safe default when a caller really does
; invoke the uninstaller with /S.
;
; If the full-wipe deletion fails (Chromium may still hold Local Storage
; open), a marker is written OUTSIDE the data folder. On the next launch the
; app honours it and resets its state, so "complete uninstall" can never
; silently degrade into a kept old configuration.
;
; A real uninstall that KEEPS personal data writes a ONE-SHOT marker inside
; the data folder. After reinstalling, the app reopens the start page so the
; "已有仓库" list is reachable, while keeping the vault config, recents and
; drafts. An in-place upgrade never writes it and goes straight to the notes.
;
; The .md files in the user-chosen vault are never touched here.
;
; electron-builder compiles the uninstaller with SilentInstall silent, so
; un.onInit runs its CHECK_APP_RUNNING probe (two PowerShell launches) before
; the uninstall section. That probe is what delayed the data dialog. We skip
; it here; our own taskkill already closes a running app on install/uninstall.
!macro customCheckAppRunning
  ; Deliberately empty: no PowerShell probe on startup.
!macroend

!macro _lumen_kill
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /T'
  Pop $0
  Pop $1
!macroend

!macro _lumen_log text
  FileOpen $R8 "$TEMP\lumen-installer.log" a
  ${If} $R8 != ""
    FileWrite $R8 "${text}$\r$\n"
    FileClose $R8
  ${EndIf}
!macroend

!macro _lumen_full_wipe
  SetShellVarContext current
  Delete "$APPDATA\lumen-notes\lumen-config.json"
  Delete "$APPDATA\lumen-notes\lumen-install.json"
  Delete "$APPDATA\lumen-notes\window-state.json"
  Delete "$APPDATA\lumen-notes\Local State"
  Delete "$APPDATA\lumen-notes\Preferences"
  Delete "$APPDATA\lumen-notes\SharedStorage"
  Delete "$APPDATA\lumen-notes\SharedStorage-wal"
  RMDir /r "$APPDATA\lumen-notes\Local Storage"
  RMDir /r "$APPDATA\lumen-notes\Session Storage"
  RMDir /r "$APPDATA\lumen-notes\IndexedDB"
  RMDir /r "$APPDATA\lumen-notes\Service Worker"
  RMDir /r "$APPDATA\lumen-notes\Cache"
  RMDir /r "$APPDATA\lumen-notes\Code Cache"
  RMDir /r "$APPDATA\lumen-notes\GPUCache"
  RMDir /r "$APPDATA\lumen-notes\DawnGraphiteCache"
  RMDir /r "$APPDATA\lumen-notes\DawnWebGPUCache"
  RMDir /r "$APPDATA\lumen-notes\Shared Dictionary"
  RMDir /r "$APPDATA\lumen-notes\blob_storage"
  RMDir /r "$APPDATA\lumen-notes\Network"
  RMDir /r "$APPDATA\lumen-notes\WebStorage"
  RMDir /r "$APPDATA\lumen-notes\vault"
  RMDir /r "$APPDATA\lumen-notes"

  ${If} ${FileExists} "$APPDATA\lumen-notes\lumen-config.json"
    FileOpen $R7 "$APPDATA\lumen-notes-wipe-request" w
    ${If} $R7 != ""
      FileWrite $R7 "full-uninstall-requested"
      FileClose $R7
    ${EndIf}
    !insertmacro _lumen_log "customUnInstall: WARN - locked files, wipe request written"
  ${Else}
    Delete "$APPDATA\lumen-notes-wipe-request"
    !insertmacro _lumen_log "customUnInstall: OK - all per-user state removed"
  ${EndIf}
!macroend

; .onInit runs before any file is replaced: stop the running app so the
; installer can overwrite the exe without hitting a busy-file error.
!macro customInit
  !insertmacro _lumen_kill
!macroend

!macro customInstall
  ; Never wipe user data on install. Upgrades and reinstalls must keep the
  ; vault config, recent files and drafts. Only drop the legacy archive.
  Delete "$INSTDIR\resources\app.asar"
  RMDir /r "$INSTDIR\resources\app.asar.unpacked"
  !insertmacro _lumen_log "customInstall: user data kept"
!macroend

; The dialog is the first thing the uninstall section does. The PowerShell
; probe above is skipped and taskkill runs only after the user answers, so
; nothing blocks before it appears. No cross-stage variable is needed.
!macro customUnInstall
  ${If} ${isUpdated}
    !insertmacro _lumen_kill
    !insertmacro _lumen_log "customUnInstall: in-place upgrade, user data kept"
  ${Else}
    SetSilent normal
    MessageBox MB_YESNO|MB_ICONQUESTION "是否保留个人数据" /SD IDYES IDYES _lumen_keep_data
    !insertmacro _lumen_kill
    !insertmacro _lumen_full_wipe
    Goto _lumen_uninstall_done
    _lumen_keep_data:
      !insertmacro _lumen_kill
      SetShellVarContext current
      CreateDirectory "$APPDATA\lumen-notes"
      FileOpen $R7 "$APPDATA\lumen-notes\lumen-welcome-request" w
      ${If} $R7 != ""
        FileWrite $R7 "show-welcome"
        FileClose $R7
      ${EndIf}
      !insertmacro _lumen_log "customUnInstall: user chose KEEP personal data (welcome requested)"
    _lumen_uninstall_done:
  ${EndIf}
!macroend
