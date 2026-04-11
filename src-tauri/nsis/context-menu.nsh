; context-menu.nsh
; NSIS include: registers / unregisters the Windows shell context menu
; entry for QuickEncode "Encode for Discord" on .mp4 files.
;
; Usage in your main .nsi script:
;   !include "context-menu.nsh"
;   Call RegisterContextMenu   ; in Section (install)
;   Call UnRegisterContextMenu ; in Section (uninstall)

!ifndef QUICKENCODE_NSH_INCLUDED
!define QUICKENCODE_NSH_INCLUDED

; ---------------------------------------------------------------------------
; RegisterContextMenu
; Writes the registry keys that add "Encode for Discord" to the right-click
; menu of .mp4 files for the current user (HKCU — no admin needed).
; ---------------------------------------------------------------------------
Function RegisterContextMenu
    ; Root key for .mp4 shell extensions (per-user, no elevation required)
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode.Discord" \
        "" \
        "Encode for Discord"

    ; Icon: show the app icon next to the menu entry
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode.Discord" \
        "Icon" \
        '"$INSTDIR\quickencode.exe",0'

    ; Command: launch QuickEncode with --file "<selected file>"
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode.Discord\command" \
        "" \
        '"$INSTDIR\quickencode.exe" --file "%1"'
FunctionEnd

; ---------------------------------------------------------------------------
; UnRegisterContextMenu
; Removes the registry keys added above.
; ---------------------------------------------------------------------------
Function UnRegisterContextMenu
    DeleteRegKey HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode.Discord"
FunctionEnd

!endif ; QUICKENCODE_NSH_INCLUDED
