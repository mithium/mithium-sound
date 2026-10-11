; Close Mithium Sound before install or uninstall.
; Closing the window only hides the app to the tray, and a normal installer
; cannot kill a copy that was started as administrator. The app watches
; quit-for-install under its userData folder and quits itself.
; userData is %APPDATA%\<app name>. Electron uses package.json "name"
; (mithium-sound) unless productName is set. Both folders are signaled so a
; future productName folder is covered too.

!macro customCheckAppRunning
  Push $R0
  Push $R1
  Push $R9

  nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop $R0
  ${if} $R0 != 0
    Goto mithium_done
  ${endIf}

  DetailPrint "Closing Mithium Sound..."
  CreateDirectory "$APPDATA\mithium-sound"
  FileOpen $R9 "$APPDATA\mithium-sound\quit-for-install" w
  IfErrors mithium_flag_product 0
    FileWrite $R9 "quit"
    FileClose $R9
  mithium_flag_product:
  CreateDirectory "$APPDATA\Mithium Sound"
  FileOpen $R9 "$APPDATA\Mithium Sound\quit-for-install" w
  IfErrors mithium_wait_start 0
    FileWrite $R9 "quit"
    FileClose $R9

  mithium_wait_start:
  StrCpy $R1 0
  mithium_wait:
    Sleep 400
    IntOp $R1 $R1 + 1
    nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $R0
    ${if} $R0 != 0
      Goto mithium_done
    ${endIf}
    ${if} $R1 < 12
      Goto mithium_wait
    ${endIf}

    nsExec::Exec `taskkill /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $R0
    Sleep 1000
    nsExec::Exec `taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $R0
    Sleep 800

    nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $R0
    ${if} $R0 == 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Mithium Sound is still running. Quit it from the tray icon. It may be running as administrator." /SD IDCANCEL IDRETRY mithium_retry
      Goto mithium_cancel
    ${endIf}
    Goto mithium_done

  mithium_retry:
    StrCpy $R1 0
    Goto mithium_wait

  mithium_done:
    Delete "$APPDATA\mithium-sound\quit-for-install"
    Delete "$APPDATA\Mithium Sound\quit-for-install"
    Goto mithium_end

  mithium_cancel:
    Delete "$APPDATA\mithium-sound\quit-for-install"
    Delete "$APPDATA\Mithium Sound\quit-for-install"
    Pop $R9
    Pop $R1
    Pop $R0
    SetErrorLevel 2
    Quit

  mithium_end:
    Pop $R9
    Pop $R1
    Pop $R0
!macroend
