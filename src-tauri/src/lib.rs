mod commands;

use serde::Serialize;
use tauri::{Emitter, Manager};

/// Emitted to the frontend when the app is launched via the right-click
/// context menu. Carries both the file path and the chosen preset.
pub const OPEN_FILE_EVENT: &str = "open-file";

#[derive(Serialize, Clone)]
pub struct OpenFilePayload {
    pub path: String,
    /// Optional preset name passed via --preset <name>.
    /// e.g. "discord", "discord-av1"
    /// None means the file was opened with no preset (plain import).
    pub preset: Option<String>,
}

/// Parse a named flag value from an argv slice, e.g. --file <value>
fn parse_arg(args: &[String], flag: &str) -> Option<String> {
    args.windows(2)
        .find(|w| w[0] == flag)
        .map(|w| w[1].clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let file_arg   = parse_arg(&args, "--file");
    let preset_arg = parse_arg(&args, "--preset");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Second instance launched — bring existing window to focus
            // and forward the file + preset.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
            if let Some(path) = parse_arg(&argv, "--file") {
                let preset = parse_arg(&argv, "--preset");
                let _ = app.emit(OPEN_FILE_EVENT, OpenFilePayload { path, preset });
            }
        }))
        .setup(move |app| {
            if let Some(path) = file_arg {
                let handle = app.handle().clone();
                let preset = preset_arg.clone();
                // Delay so the webview finishes mounting before we emit.
                // 1200 ms is conservative but safe — the GPU probe and React
                // mount both need to settle before the listener is ready.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1200));
                    let _ = handle.emit(OPEN_FILE_EVENT, OpenFilePayload { path, preset });
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
