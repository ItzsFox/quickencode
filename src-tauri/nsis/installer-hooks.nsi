; installer-hooks.nsi
; Tauri NSIS installer hooks.
; Tauri calls these macros automatically at install / uninstall time.

!include "context-menu.nsh"

; Called by Tauri after all app files are installed.
Macro customInstall
    Call RegisterContextMenu
MacroEnd

; Called by Tauri before app files are removed on uninstall.
Macro customUnInstall
    Call UnRegisterContextMenu
MacroEnd
