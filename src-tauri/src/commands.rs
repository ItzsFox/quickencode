use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use base64::{Engine, engine::general_purpose::STANDARD};
use tauri::Emitter;

/// Resolve a sidecar binary path.
/// - Debug: looks in src-tauri/binaries/ with the target triple suffix (dev workflow)
/// - Release: looks next to the running .exe using the plain name (Tauri strips the suffix on install)
pub fn resolve_bin(_app: &tauri::AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let triple = option_env!("TAURI_TARGET_TRIPLE").unwrap_or("x86_64-pc-windows-msvc");
        let filename = format!("{name}-{triple}.exe");
        let bin = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(&filename);
        if bin.exists() { return Ok(bin); }
        return Err(format!("[dev] Binary not found at: {}", bin.display()));
    }

    #[cfg(not(debug_assertions))]
    {
        // Tauri strips the triple suffix when installing sidecars, so the file is just e.g. ffmpeg.exe
        let filename = format!("{name}.exe");
        let exe = std::env::current_exe()
            .map_err(|e| format!("Could not resolve current exe: {e}"))?;
        let bin = exe.parent()
            .ok_or("Could not get exe directory")?
            .join(&filename);
        if bin.exists() { return Ok(bin); }
        Err(format!(
            "[release] Binary not found at: {}\nMake sure '{}' is listed under bundle.externalBin in tauri.conf.json",
            bin.display(), name
        ))
    }
}

/// Video file extensions we recognize.
const VIDEO_EXTS: &[&str] = &["mp4","mkv","avi","mov","webm","m4v","wmv","flv","ts","mts"];

fn is_video(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Walk a directory recursively, collecting all video file paths.
fn walk_videos(dir: &std::path::Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return; };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            walk_videos(&p, out);
        } else if p.is_file() && is_video(&p) {
            if let Some(s) = p.to_str() {
                out.push(s.to_string());
            }
        }
    }
}

/// Scan a folder recursively for video files.
/// Returns a sorted Vec of absolute paths (empty if no videos found).
#[tauri::command]
pub fn scan_folder_for_videos(folder: String) -> Vec<String> {
    let p = std::path::Path::new(&folder);
    if !p.is_dir() { return vec![]; }
    let mut videos = Vec::new();
    walk_videos(p, &mut videos);
    videos.sort();
    videos
}

/// Returns the file size in MB for a given path.
#[tauri::command]
pub fn get_file_size_mb(path: String) -> Result<f64, String> {
    let meta = std::fs::metadata(&path)
        .map_err(|e| format!("Could not read file metadata: {e}"))?;
    Ok(meta.len() as f64 / (1024.0 * 1024.0))
}

/// Opens the file's parent folder in the system file explorer and selects the file.
#[tauri::command]
pub fn show_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Opens a folder directly in the system file explorer (no file selection).
/// Used for batch output — we want to open the folder itself, not a parent.
#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(serde::Serialize, Clone)]
pub struct VideoInfo {
    pub duration_secs: f64,
    pub size_mb: f64,
    pub bitrate_kbps: f64,
    pub width: u32,
    pub height: u32,
}

#[derive(serde::Serialize, Clone)]
pub struct EncodeProgress {
    pub percent: f64,
    pub eta_secs: f64,
    pub pass: u8,
}

#[tauri::command]
pub fn get_video_info(app: tauri::AppHandle, input: String) -> Result<VideoInfo, String> {
    let ffprobe = resolve_bin(&app, "ffprobe")?;

    let fmt_out = Command::new(&ffprobe)
        .args(["-v", "quiet", "-print_format", "json", "-show_format", &input])
        .output().map_err(|e| e.to_string())?;
    let fmt_json: serde_json::Value =
        serde_json::from_slice(&fmt_out.stdout).map_err(|e| e.to_string())?;
    let fmt = &fmt_json["format"];

    let duration_secs = fmt["duration"]
        .as_str().and_then(|s| s.parse::<f64>().ok())
        .ok_or("Could not read duration")?;
    let size_mb = fmt["size"]
        .as_str().and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0) / (1024.0 * 1024.0);
    let bitrate_kbps = fmt["bit_rate"]
        .as_str().and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0) / 1000.0;

    let stream_out = Command::new(&ffprobe)
        .args(["-v", "quiet", "-print_format", "json",
               "-show_streams", "-select_streams", "v:0", &input])
        .output().map_err(|e| e.to_string())?;
    let stream_json: serde_json::Value =
        serde_json::from_slice(&stream_out.stdout).map_err(|e| e.to_string())?;
    let stream = &stream_json["streams"][0];

    let raw_w = stream["width"].as_u64().unwrap_or(1920) as u32;
    let raw_h = stream["height"].as_u64().unwrap_or(1080) as u32;
    let rotation = stream["tags"]["rotate"]
        .as_str().and_then(|s| s.parse::<i32>().ok()).unwrap_or(0);
    let (width, height) = if rotation == 90 || rotation == 270 || rotation == -90 {
        (raw_h, raw_w)
    } else {
        (raw_w, raw_h)
    };

    Ok(VideoInfo { duration_secs, size_mb, bitrate_kbps, width, height })
}

#[tauri::command]
pub async fn get_video_frames(
    app: tauri::AppHandle,
    input: String,
    count: usize,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg  = resolve_bin(&app, "ffmpeg")?;
        let ffprobe = resolve_bin(&app, "ffprobe")?;

        let fmt_out = Command::new(&ffprobe)
            .args(["-v", "quiet", "-print_format", "json", "-show_format", &input])
            .output().map_err(|e| e.to_string())?;
        let fmt_json: serde_json::Value =
            serde_json::from_slice(&fmt_out.stdout).map_err(|e| e.to_string())?;
        let duration = fmt_json["format"]["duration"]
            .as_str().and_then(|s| s.parse::<f64>().ok())
            .ok_or("no duration")?;

        let mut frames: Vec<String> = Vec::with_capacity(count);
        for i in 0..count {
            let ts     = duration * (i as f64 + 0.5) / count as f64;
            let ts_str = format!("{:.3}", ts);
            let out_path = std::env::temp_dir().join(format!("qe_orig_frame_{}.jpg", i));
            let out_str  = out_path.to_str().unwrap().to_string();

            Command::new(&ffmpeg)
                .args(["-y", "-ss", &ts_str, "-i", &input,
                       "-vframes", "1", "-vf", "scale=1280:-2", "-q:v", "3", &out_str])
                .output().map_err(|e| e.to_string())?;

            let bytes = std::fs::read(&out_path)
                .map_err(|e| format!("Frame {} read error: {}", i, e))?;
            frames.push(STANDARD.encode(bytes));
        }
        Ok(frames)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_encoded_frame(
    app: tauri::AppHandle,
    input: String,
    timestamp: f64,
    resolution: String,
    video_bitrate_kbps: u32,
    fps: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg  = resolve_bin(&app, "ffmpeg")?;
        let clip    = std::env::temp_dir().join("qe_enc_preview.mp4");
        let frame   = std::env::temp_dir().join("qe_enc_frame.jpg");
        let clip_s  = clip.to_str().unwrap().to_string();
        let frame_s = frame.to_str().unwrap().to_string();
        let ts_str  = format!("{:.3}", timestamp);
        let bv      = format!("{}k", video_bitrate_kbps);

        let mut vf_parts: Vec<String> = vec![];
        match resolution.as_str() {
            "1080p" => vf_parts.push("scale=-2:1080".into()),
            "720p"  => vf_parts.push("scale=-2:720".into()),
            "480p"  => vf_parts.push("scale=-2:480".into()),
            _       => {}
        }
        if fps != "original" { vf_parts.push(format!("fps={}", fps)); }

        let mut args: Vec<String> = vec![
            "-y".into(), "-ss".into(), ts_str,
            "-i".into(), input, "-t".into(), "2".into(),
        ];
        if !vf_parts.is_empty() {
            args.extend(["-vf".into(), vf_parts.join(",")]);
        }
        args.extend([
            "-c:v".into(), "libx264".into(),
            "-b:v".into(), bv,
            "-bufsize".into(), format!("{}k", video_bitrate_kbps * 2),
            "-preset".into(), "ultrafast".into(),
            "-an".into(), clip_s.clone(),
        ]);
        Command::new(&ffmpeg).args(&args).output().map_err(|e| e.to_string())?;

        Command::new(&ffmpeg)
            .args(["-y", "-i", &clip_s, "-vframes", "1", "-q:v", "3", &frame_s])
            .output().map_err(|e| e.to_string())?;

        if !frame.exists() || std::fs::metadata(&frame).map(|m| m.len()).unwrap_or(0) == 0 {
            return Err("Could not extract encoded frame".into());
        }

        let bytes = std::fs::read(&frame).map_err(|e| e.to_string())?;
        Ok(STANDARD.encode(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn encode_video_with_progress(
    app: tauri::AppHandle,
    input: String,
    output: String,
    resolution: String,
    video_bitrate_kbps: u32,
    audio_bitrate_kbps: u32,
    fps: String,
    duration_secs: f64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg      = resolve_bin(&app, "ffmpeg")?;
        let video_bv    = format!("{}k", video_bitrate_kbps);
        let audio_ba    = format!("{}k", audio_bitrate_kbps);
        let passlog     = std::env::temp_dir().join("qe_passlog");
        let passlog_str = passlog.to_str().unwrap().to_string();

        let mut vf_parts: Vec<String> = vec![];
        match resolution.as_str() {
            "1080p" => vf_parts.push("scale=-2:1080".into()),
            "720p"  => vf_parts.push("scale=-2:720".into()),
            "480p"  => vf_parts.push("scale=-2:480".into()),
            _       => {}
        }
        if fps != "original" { vf_parts.push(format!("fps={}", fps)); }

        let vf_arg: Vec<String> = if !vf_parts.is_empty() {
            vec!["-vf".into(), vf_parts.join(",")]
        } else { vec![] };

        let _ = app.emit("encode-progress", EncodeProgress {
            percent: 0.0, eta_secs: 0.0, pass: 1,
        });

        let mut pass1: Vec<String> = vec!["-y".into(), "-i".into(), input.clone()];
        pass1.extend(vf_arg.clone());
        pass1.extend([
            "-c:v".into(), "libx264".into(),
            "-b:v".into(), video_bv.clone(),
            "-pass".into(), "1".into(),
            "-passlogfile".into(), passlog_str.clone(),
            "-an".into(), "-f".into(), "null".into(), "NUL".into(),
        ]);
        let s1 = Command::new(&ffmpeg).args(&pass1)
            .stderr(Stdio::null())
            .status().map_err(|e| e.to_string())?;
        if !s1.success() { return Err("FFmpeg pass 1 failed".into()); }

        let _ = app.emit("encode-progress", EncodeProgress {
            percent: 50.0, eta_secs: 0.0, pass: 2,
        });

        let mut pass2: Vec<String> = vec![
            "-y".into(), "-i".into(), input,
            "-progress".into(), "pipe:1".into(),
            "-nostats".into(),
        ];
        pass2.extend(vf_arg);
        pass2.extend([
            "-map".into(), "0:v:0".into(),
            "-map".into(), "0:a".into(),
            "-c:v".into(), "libx264".into(),
            "-b:v".into(), video_bv,
            "-pass".into(), "2".into(),
            "-passlogfile".into(), passlog_str,
            "-c:a".into(), "aac".into(),
            "-b:a".into(), audio_ba,
            output,
        ]);

        let mut child = Command::new(&ffmpeg)
            .args(&pass2)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;

        let stdout    = child.stdout.take().unwrap();
        let reader    = BufReader::new(stdout);
        let start     = std::time::Instant::now();
        let mut last_pct = 50.0f64;

        for line in reader.lines().flatten() {
            if let Some(rest) = line.strip_prefix("out_time_ms=") {
                if let Ok(ms) = rest.trim().parse::<f64>() {
                    if ms <= 0.0 { continue; }
                    let secs_done   = ms / 1_000_000.0;
                    let pct         = 50.0 + (secs_done / duration_secs).min(1.0) * 50.0;
                    let elapsed     = start.elapsed().as_secs_f64();
                    let p2_fraction = (pct - 50.0) / 50.0;
                    let eta = if p2_fraction > 0.02 {
                        (elapsed / p2_fraction) * (1.0 - p2_fraction)
                    } else { 0.0 };

                    if pct - last_pct >= 0.5 {
                        last_pct = pct;
                        let _ = app.emit("encode-progress", EncodeProgress {
                            percent: pct.min(99.0), eta_secs: eta, pass: 2,
                        });
                    }
                }
            }
        }

        child.wait().map_err(|e| e.to_string())?;
        let _ = app.emit("encode-progress", EncodeProgress {
            percent: 100.0, eta_secs: 0.0, pass: 2,
        });
        Ok("Done".into())
    })
    .await
    .map_err(|e| e.to_string())?
}
