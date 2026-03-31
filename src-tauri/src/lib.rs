mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_video_info,
            commands::get_video_frames,
            commands::get_encoded_frame,
            commands::encode_video_with_progress,
        ])
        .run(tauri::generate_context!())
        .expect("error running app");
}
