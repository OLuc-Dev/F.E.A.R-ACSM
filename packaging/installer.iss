; Inno Setup script for the F.E.A.R. Windows installer.
; Built by .github/workflows/desktop.yml: iscc /DAppVersion=x.y.z packaging\installer.iss
; Installs per user (no admin prompt) into %LOCALAPPDATA%\Programs\FEAR. The
; person's memory and settings live apart, in %LOCALAPPDATA%\FEAR, so updating
; or uninstalling never erases them.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{8C5A2E61-4F0B-4C55-9E7A-2B1F0D6C3E11}
AppName=F.E.A.R.
AppVersion={#AppVersion}
AppPublisher=F.E.A.R.
DefaultDirName={localappdata}\Programs\FEAR
DefaultGroupName=F.E.A.R.
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=FEAR-Setup-{#AppVersion}
SetupIconFile=fear.ico
UninstallDisplayIcon={app}\FEAR.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=force

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "startup"; Description: "Iniciar o F.E.A.R. junto com o Windows (minimizado)"
Name: "desktopicon"; Description: "Criar um atalho na Área de Trabalho"; Flags: unchecked

[Files]
Source: "..\dist\FEAR\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\F.E.A.R."; Filename: "{app}\FEAR.exe"
Name: "{userdesktop}\F.E.A.R."; Filename: "{app}\FEAR.exe"; Tasks: desktopicon

[Registry]
; The same entry the tray's "Iniciar com o Windows" toggles.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "F.E.A.R."; ValueData: """{app}\FEAR.exe"" --minimized"; Tasks: startup; Flags: uninsdeletevalue

[Run]
Filename: "{app}\FEAR.exe"; Description: "Abrir o F.E.A.R. agora"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "taskkill"; Parameters: "/F /IM FEAR.exe"; Flags: runhidden; RunOnceId: "StopFear"
