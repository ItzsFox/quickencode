mod commands;

use tauri::{Emitter, Manager};

/// Emitted to the frontend when the app is launched/focused with a file path
/// via the right-click "Encode for Discord" context menu entry.
pub const OPEN_FILE_EVENT: &str = "open-file";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Collect CLI args: look for --file <path> passed by the shell handler
    let file_arg: Option<String> = {
        let args: Vec<String> = std::env::args().collect();
        args.windows(2)
            .find(|w| w[0] == "--file")
            .map(|w| w[1].clone())
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Called when a second instance is launched (e.g. user right-clicks
            // another file while QuickEncode is already open).
            // We bring the existing window to focus and forward the file path.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
            // Parse --file from the new instance's args
            if let Some(path) = argv.windows(2)
                .find(|w| w[0] == "--file")
                .map(|w| w[1].clone())
            {
                let _ = app.emit(OPEN_FILE_EVENT, path);
            }
        }))
        .setup(move |app| {
            // If this first instance was launched with --file, emit the event
            // after the window is ready.
            if let Some(path) = file_arg {
                let handle = app.handle().clone();
                // Small delay so the webview has time to mount its listener
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(800));
                    let _ = handle.emit(OPEN_FILE_EVENT, path);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_video_info,
            commands::get_video_frames,
            commands::get_encoded_frame,
            commands::encode_video_with_progress,
            commands::cancel_encode,
            commands::scan_folder_for_videos,
            commands::get_file_size_mb,
            commands::show_in_folder,
            commands::open_folder,
            commands::extract_audio_track,
            commands::clear_preview_track_cache,
            commands::probe_gpu_encoders,
        ])
        .run(tauri::generate_context!())
        .expect("error running app");
}
