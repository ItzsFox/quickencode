; context-menu.nsh
; NSIS include: registers / unregisters the Windows shell context menu
; submenu for QuickEncode on .mp4 files.
;
; Right-clicking an .mp4 will show:
;   > Quick Encode
;       Encode for Discord Ready
;
; Usage in your main .nsi script:
;   !include "context-menu.nsh"
;   Call RegisterContextMenu   ; in Section (install)
;   Call UnRegisterContextMenu ; in Section (uninstall)

!ifndef QUICKENCODE_NSH_INCLUDED
!define QUICKENCODE_NSH_INCLUDED

; ---------------------------------------------------------------------------
; RegisterContextMenu
; Writes the registry keys that add a "Quick Encode" submenu to the
; right-click menu of .mp4 files (HKCU — no admin needed).
; ---------------------------------------------------------------------------
Function RegisterContextMenu

    ; --- Parent submenu entry ---
    ; MUIVerb = the label shown in the context menu
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode" \
        "MUIVerb" \
        "Quick Encode"

    ; SubCommands = empty string tells Windows this is a submenu container
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode" \
        "SubCommands" \
        ""

    ; Icon: show the app icon next to the parent menu entry
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode" \
        "Icon" \
        '"$INSTDIR\quickencode.exe",0'

    ; --- Submenu shell container key ---
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode\shell" \
        "" \
        ""

    ; --- Child: Encode for Discord Ready ---
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode\shell\DiscordReady" \
        "" \
        "Encode for Discord Ready"

    ; Command: launch QuickEncode with --file "<selected file>"
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode\shell\DiscordReady\command" \
        "" \
        '"$INSTDIR\quickencode.exe" --file "%1"'

FunctionEnd

; ---------------------------------------------------------------------------
; UnRegisterContextMenu
; Removes all registry keys added above (full subtree).
; ---------------------------------------------------------------------------
Function UnRegisterContextMenu
    DeleteRegKey HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode"
FunctionEnd

!endif ; QUICKENCODE_NSH_INCLUDED
