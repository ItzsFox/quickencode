import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Listens for the "open-file" event emitted by the Rust backend when
 * QuickEncode is launched (or focused) via the Windows right-click context
 * menu with a file path passed as --file <path>.
 *
 * When received, calls `onFile` with the path so the caller can immediately
 * load it — in Discord mode by default.
 */
export function useOpenFile(onFile: (path: string) => void) {
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<string>("open-file", (event) => {
      const path = event.payload;
      if (path && typeof path === "string" && path.trim() !== "") {
        onFile(path.trim());
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => unlisten?.();
  }, [onFile]);
}
