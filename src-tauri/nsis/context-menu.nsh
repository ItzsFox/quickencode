; context-menu.nsh
; NSIS include: registers / unregisters the Windows shell context menu
; for QuickEncode on .mp4 files.
;
; Right-clicking an .mp4 shows:
;
;   [icon] Quick Encode                    ►
;               Add to Quick Encode
;               --------------------------------
;               Encode with Discord Ready
;               Encode with Discord Ready (AV1)
;
; Usage:
;   !include "context-menu.nsh"
;   Call RegisterContextMenu   ; in install Section
;   Call UnRegisterContextMenu ; in uninstall Section

!ifndef QUICKENCODE_NSH_INCLUDED
!define QUICKENCODE_NSH_INCLUDED

; ---------------------------------------------------------------------------
; RegisterContextMenu
; ---------------------------------------------------------------------------
Function RegisterContextMenu

    ; ---- Parent submenu (the "Quick Encode" flyout header) ----------------
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode" \
        "MUIVerb" "quick encode."

    ; Empty SubCommands = Windows renders this as a submenu, not a direct action
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode" \
        "SubCommands" ""

    ; App icon shown next to the parent entry
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode" \
        "Icon" '"$INSTDIR\quick encode.exe",0'

    ; ---- Submenu shell container ------------------------------------------
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode\shell" \
        "" ""

    ; ---- 1. Add to Quick Encode (plain import, no preset) -----------------
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode\shell\01_Import" \
        "" "Add to quick encode."
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode\shell\01_Import\command" \
        "" '"$INSTDIR\quick encode.exe" --file "%1"'

    ; ---- Separator --------------------------------------------------------
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode\shell\02_Sep" \
        "CommandFlags" "0x40"

    ; ---- 2. Encode with Discord Ready (H.264) -----------------------------
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode\shell\03_Discord" \
        "" "Encode with Discord Ready"
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode\shell\03_Discord\command" \
        "" '"$INSTDIR\quick encode.exe" --file "%1" --preset discord'

    ; ---- 3. Encode with Discord Ready (AV1) --------------------------------
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode\shell\04_DiscordAV1" \
        "" "Encode with Discord Ready (AV1)"
    WriteRegStr HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode\shell\04_DiscordAV1\command" \
        "" '"$INSTDIR\quick encode.exe" --file "%1" --preset discord-av1'

FunctionEnd

; ---------------------------------------------------------------------------
; UnRegisterContextMenu
; Removes the entire QuickEncode key tree on uninstall.
; ---------------------------------------------------------------------------
Function UnRegisterContextMenu
    DeleteRegKey HKCU \
        "Software\Classes\SystemFileAssociations\.mp4\shell\QuickEncode"
FunctionEnd

!endif ; QUICKENCODE_NSH_INCLUDED
