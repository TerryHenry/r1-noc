; R1 NOC Wall — per-user Windows installer (no administrator rights needed). Built by build-win.sh with makensis.
Unicode true
!define NAME "R1 NOC Wall"
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
Name "${NAME}"
OutFile "${OUTFILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\R1 NOC Wall"
InstallDirRegKey HKCU "Software\R1 NOC Wall" "InstallDir"
SetCompressor /SOLID lzma
Page components
Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "R1 NOC Wall (required)" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  File "${STAGE}\R1-NOC-Wall.exe"
  File "${STAGE}\README-Windows.txt"
  SetOutPath "$INSTDIR\app"
  File /r "${STAGE}\app\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\R1 NOC Wall" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\R1 NOC Wall" "DisplayName" "${NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\R1 NOC Wall" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\R1 NOC Wall" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\R1 NOC Wall" "InstallLocation" "$INSTDIR"
  CreateDirectory "$SMPROGRAMS\R1 NOC Wall"
  CreateShortcut "$SMPROGRAMS\R1 NOC Wall\R1 NOC Wall.lnk" "$INSTDIR\R1-NOC-Wall.exe" "--open" "$INSTDIR\R1-NOC-Wall.exe" 0
  CreateShortcut "$SMPROGRAMS\R1 NOC Wall\Uninstall R1 NOC Wall.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section /o "Start R1 NOC Wall when I sign in" SecAuto
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "R1 NOC Wall" '"$INSTDIR\R1-NOC-Wall.exe"'
SectionEnd

Section "Uninstall"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "R1 NOC Wall"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\R1 NOC Wall"
  DeleteRegKey HKCU "Software\R1 NOC Wall"
  Delete "$SMPROGRAMS\R1 NOC Wall\*.lnk"
  RMDir "$SMPROGRAMS\R1 NOC Wall"
  RMDir /r "$INSTDIR\app"
  Delete "$INSTDIR\R1-NOC-Wall.exe"
  Delete "$INSTDIR\README-Windows.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  ; your settings, screens and history in %LOCALAPPDATA%\R1 NOC Wall are kept
SectionEnd
