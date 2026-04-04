use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use std::collections::HashMap;
use base64::{Engine, engine::general_purpose::STANDARD};
use tauri::Emitter;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}
impl NoWindow for Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(target_os = "windows")]
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}

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

// ── probe_av1_encoder ─────────────────────────────────────────────────────────
// Returns "libsvtav1" if available, otherwise "libaom-av1".
fn probe_av1_encoder(ffmpeg: &std::path::Path) -> &'static str {
    let out = Command::new(ffmpeg)
        .args(["-encoders", "-v", "quiet"])
        .no_window()
        .output();
    if let Ok(o) = out {
        let stdout = String::from_utf8_lossy(&o.stdout);
        if stdout.contains("libsvtav1") {
            return "libsvtav1";
        }
    }
    "libaom-av1"
}

const VIDEO_EXTS: &[&str] = &["mp4","mkv","avi","mov","webm","m4v","wmv","flv","ts","mts"];
fn is_video(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}
fn walk_videos(dir: &std::path::Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return; };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() { walk_videos(&p, out); }
        else if p.is_file() && is_video(&p) {
            if let Some(s) = p.to_str() { out.push(s.to_string()); }
        }
    }
}

#[tauri::command]
pub fn scan_folder_for_videos(folder: String) -> Vec<String> {
    let p = std::path::Path::new(&folder);
    if !p.is_dir() { return vec![]; }
    let mut videos = Vec::new();
    walk_videos(p, &mut videos);
    videos.sort();
    videos
}

#[tauri::command]
pub fn get_file_size_mb(path: String) -> Result<f64, String> {
    let meta = std::fs::metadata(&path)
        .map_err(|e| format!("Could not read file metadata: {e}"))?;
    Ok(meta.len() as f64 / (1024.0 * 1024.0))
}

#[tauri::command]
pub fn show_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    Command::new("explorer").args(["/select,", &path]).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    Command::new("open").args(["-R", &path]).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    if let Some(parent) = std::path::Path::new(&path).parent() {
        Command::new("xdg-open").arg(parent).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    Command::new("explorer").arg(&path).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    Command::new("open").arg(&path).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    Command::new("xdg-open").arg(&path).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

// ── Structs ──────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct AudioTrackInfo {
    pub index:    usize,
    pub label:    String,
    pub language: String,
}

#[derive(serde::Serialize, Clone)]
pub struct VideoInfo {
    pub duration_secs: f64,
    pub size_mb:       f64,
    pub bitrate_kbps:  f64,
    pub width:         u32,
    pub height:        u32,
    pub audio_tracks:  Vec<AudioTrackInfo>,
}

#[derive(serde::Serialize, Clone)]
pub struct EncodeProgress {
    pub percent:  f64,
    pub eta_secs: f64,
    pub pass:     u8,
}

// ── audio_label ──────────────────────────────────────────────────────────────────

fn audio_label(stream: &serde_json::Value, one_based_index: usize) -> String {
    let tags = &stream["tags"];

    let valid = |s: &str| -> Option<String> {
        let t = s.trim();
        if t.is_empty()
            || t.eq_ignore_ascii_case("und")
            || t.chars().all(|c| c == '\0')
        {
            None
        } else {
            Some(t.to_string())
        }
    };

    let is_generic_handler = |v: &str| -> bool {
        let lo = v.to_lowercase();
        let compact: String = lo.chars().filter(|c| !c.is_whitespace()).collect();
        compact == "soundhandler"
            || compact == "soundhandle"
            || compact == "videohandler"
            || compact == "videohandle"
            || lo == "iso media file produced by google inc."
            || lo == "iso media"
            || lo.starts_with("mp4a")
            || lo.starts_with("mpeg")
            || lo == "aac"
            || lo == "vorbis"
            || lo == "opus"
    };

    if let Some(v) = tags["title"].as_str().and_then(|s| valid(s)) { return v; }
    if let Some(v) = tags["name"].as_str().and_then(|s| valid(s))  { return v; }
    if let Some(v) = tags["handler_name"].as_str().and_then(|s| valid(s)) {
        if !is_generic_handler(&v) { return v; }
    }
    if let Some(v) = tags["language"].as_str().and_then(|s| valid(s)) { return v; }
    format!("Track {}", one_based_index)
}

// ── get_video_info ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_video_info(app: tauri::AppHandle, input: String) -> Result<VideoInfo, String> {
    let ffprobe = resolve_bin(&app, "ffprobe")?;

    let fmt_out = Command::new(&ffprobe)
        .args(["-v", "quiet", "-print_format", "json", "-show_format", &input])
        .no_window().output().map_err(|e| e.to_string())?;
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
        .no_window().output().map_err(|e| e.to_string())?;
    let stream_json: serde_json::Value =
        serde_json::from_slice(&stream_out.stdout).map_err(|e| e.to_string())?;
    let stream = &stream_json["streams"][0];
    let raw_w = stream["width"].as_u64().unwrap_or(1920) as u32;
    let raw_h = stream["height"].as_u64().unwrap_or(1080) as u32;
    let rotation = stream["tags"]["rotate"]
        .as_str().and_then(|s| s.parse::<i32>().ok()).unwrap_or(0);
    let (width, height) = if rotation == 90 || rotation == 270 || rotation == -90 {
        (raw_h, raw_w)
    } else { (raw_w, raw_h) };

    let audio_out = Command::new(&ffprobe)
        .args([
            "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            "-select_streams", "a",
            &input,
        ])
        .no_window().output().map_err(|e| e.to_string())?;
    let audio_json: serde_json::Value =
        serde_json::from_slice(&audio_out.stdout).map_err(|e| e.to_string())?;
    let audio_streams = audio_json["streams"].as_array();
    let audio_tracks: Vec<AudioTrackInfo> = audio_streams
        .map(|arr| arr.iter().enumerate().map(|(i, s)| {
            let lang  = s["tags"]["language"].as_str().unwrap_or("").to_string();
            let label = audio_label(s, i + 1);
            AudioTrackInfo { index: i, label, language: lang }
        }).collect())
        .unwrap_or_default();

    Ok(VideoInfo { duration_secs, size_mb, bitrate_kbps, width, height, audio_tracks })
}

// ── extract_audio_track ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn extract_audio_track(
    app: tauri::AppHandle,
    input: String,
    audio_stream_index: usize,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg = resolve_bin(&app, "ffmpeg")?;

        let out_path = std::env::temp_dir()
            .join(format!("qe_preview_track_{}.mp4", audio_stream_index));
        let out_str = out_path.to_str().unwrap().to_string();

        if out_path.exists() {
            return Ok(out_str);
        }

        let status = Command::new(&ffmpeg)
            .args([
                "-y",
                "-i", &input,
                "-map", "0:v:0",
                "-map", &format!("0:a:{audio_stream_index}"),
                "-c", "copy",
                "-movflags", "+faststart",
                &out_str,
            ])
            .no_window()
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;

        if !status.success() {
            return Err(format!(
                "ffmpeg failed to extract audio stream {audio_stream_index}"
            ));
        }
        Ok(out_str)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── clear_preview_track_cache ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn clear_preview_track_cache() {
    let tmp = std::env::temp_dir();
    if let Ok(entries) = std::fs::read_dir(&tmp) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let s    = name.to_string_lossy();
            if s.starts_with("qe_preview_track_") && s.ends_with(".mp4") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

// ── get_video_frames ──────────────────────────────────────────────────────────────────

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
            .no_window().output().map_err(|e| e.to_string())?;
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
                .no_window().output().map_err(|e| e.to_string())?;
            let bytes = std::fs::read(&out_path)
                .map_err(|e| format!("Frame {} read error: {}", i, e))?;
            frames.push(STANDARD.encode(bytes));
        }
        Ok(frames)
    })
    .await.map_err(|e| e.to_string())?
}

// ── get_encoded_frame ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_encoded_frame(
    app: tauri::AppHandle,
    input: String,
    timestamp: f64,
    resolution: String,
    video_bitrate_kbps: u32,
    fps: String,
    use_av1: bool,
    use_gpu: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg  = resolve_bin(&app, "ffmpeg")?;
        let clip    = std::env::temp_dir().join("qe_enc_preview.mp4");
        let frame   = std::env::temp_dir().join("qe_enc_frame.jpg");
        let clip_s  = clip.to_str().unwrap().to_string();
        let frame_s = frame.to_str().unwrap().to_string();
        let ts_str  = format!("{:.3}", timestamp);
        let bv      = format!("{}k", video_bitrate_kbps);
        let maxrate = format!("{}k", video_bitrate_kbps);
        let bufsize = format!("{}k", video_bitrate_kbps);

        let mut vf_parts: Vec<String> = vec![];
        match resolution.as_str() {
            "1080p" => vf_parts.push("scale=-2:1080".into()),
            "720p"  => vf_parts.push("scale=-2:720".into()),
            "480p"  => vf_parts.push("scale=-2:480".into()),
            _       => {}
        }
        if fps != "original" { vf_parts.push(format!("fps={}", fps)); }

        let mut args: Vec<String> = vec![
            "-y".into(), "-ss".into(), ts_str, "-i".into(), input, "-t".into(), "2".into(),
        ];
        if !vf_parts.is_empty() { args.extend(["-vf".into(), vf_parts.join(",")]); }

        if use_av1 {
            if use_gpu {
                args.extend([
                    "-c:v".into(), "av1_nvenc".into(),
                    "-preset".into(), "p4".into(),
                    "-cq".into(), "28".into(),
                    "-b:v".into(), bv,
                    "-maxrate".into(), maxrate,
                    "-bufsize".into(), bufsize,
                    "-an".into(), clip_s.clone(),
                ]);
            } else {
                let av1_enc = probe_av1_encoder(&ffmpeg);
                if av1_enc == "libsvtav1" {
                    // SVT-AV1 CRF preview: must pair -crf with -b:v 0
                    args.extend([
                        "-c:v".into(), "libsvtav1".into(),
                        "-preset".into(), "12".into(),
                        "-crf".into(), "35".into(),
                        "-b:v".into(), "0".into(),
                        "-an".into(), clip_s.clone(),
                    ]);
                } else {
                    args.extend([
                        "-c:v".into(), "libaom-av1".into(),
                        "-cpu-used".into(), "8".into(),
                        "-crf".into(), "35".into(),
                        "-b:v".into(), "0".into(),
                        "-an".into(), clip_s.clone(),
                    ]);
                }
            }
        } else {
            args.extend([
                "-c:v".into(), "libx264".into(),
                "-b:v".into(), bv,
                "-bufsize".into(), format!("{}k", video_bitrate_kbps * 2),
                "-preset".into(), "ultrafast".into(),
                "-an".into(), clip_s.clone(),
            ]);
        }

        Command::new(&ffmpeg).args(&args).no_window().output().map_err(|e| e.to_string())?;
        Command::new(&ffmpeg)
            .args(["-y", "-i", &clip_s, "-vframes", "1", "-q:v", "3", &frame_s])
            .no_window().output().map_err(|e| e.to_string())?;

        if !frame.exists() || std::fs::metadata(&frame).map(|m| m.len()).unwrap_or(0) == 0 {
            return Err("Could not extract encoded frame".into());
        }
        let bytes = std::fs::read(&frame).map_err(|e| e.to_string())?;
        Ok(STANDARD.encode(bytes))
    })
    .await.map_err(|e| e.to_string())?
}

// ── encode_video_with_progress ──────────────────────────────────────────────────────────────────

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
    trim_start: Option<f64>,
    trim_end: Option<f64>,
    deleted_tracks: Vec<usize>,
    volume_map: HashMap<usize, u32>,
    total_audio_tracks: usize,
    use_av1: bool,
    use_gpu: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg      = resolve_bin(&app, "ffmpeg")?;
        let video_bv    = format!("{}k", video_bitrate_kbps);
        let audio_ba    = format!("{}k", audio_bitrate_kbps);
        let passlog     = std::env::temp_dir().join("qe_passlog");
        let passlog_str = passlog.to_str().unwrap().to_string();

        let ss_val: Option<f64> = trim_start.filter(|&v| v > 0.0);
        let clip_duration: Option<f64> = match (trim_start, trim_end) {
            (Some(ss), Some(te)) if te > ss => Some(te - ss),
            (None,     Some(te))            => Some(te),
            _                               => None,
        };

        let mut trim_args: Vec<String> = vec![];
        if let Some(ss) = ss_val {
            trim_args.extend(["-ss".into(), format!("{ss:.6}")]);
        }

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

        let real_track_count = if total_audio_tracks == 0 { 1 } else { total_audio_tracks };
        let active_audio: Vec<usize> = (0..real_track_count)
            .filter(|i| !deleted_tracks.contains(i))
            .collect();

        let has_volume_changes = active_audio.iter().any(|i| {
            volume_map.get(i).copied().unwrap_or(100) != 100
        });

        // ── AV1 single-pass path ──────────────────────────────────────────────────────
        if use_av1 {
            // Tight bitrate cap: maxrate = target, bufsize = target.
            // This keeps the output at/near video_bitrate_kbps, which is
            // critical for Discord Ready (target <= 9 MB total).
            let maxrate = video_bv.clone();
            let bufsize = video_bv.clone();

            let _ = app.emit("encode-progress", EncodeProgress {
                percent: 0.0, eta_secs: 0.0, pass: 1,
            });

            let mut av1_args: Vec<String> = trim_args;
            av1_args.extend(["-y".into(), "-i".into(), input]);
            if let Some(dur) = clip_duration {
                av1_args.extend(["-t".into(), format!("{dur:.6}")]);
            }
            av1_args.extend(vf_arg);
            av1_args.extend(["-map".into(), "0:v:0".into()]);

            if has_volume_changes {
                let mut filter_parts: Vec<String> = vec![];
                let mut out_labels: Vec<String> = vec![];
                for (out_idx, &ai) in active_audio.iter().enumerate() {
                    let vol_pct = volume_map.get(&ai).copied().unwrap_or(100);
                    let vol_f   = vol_pct as f64 / 100.0;
                    let label   = format!("a{out_idx}");
                    filter_parts.push(format!("[0:a:{ai}]volume={vol_f:.4}[{label}]"));
                    out_labels.push(format!("[{label}]"));
                }
                if !filter_parts.is_empty() {
                    av1_args.extend(["-filter_complex".into(), filter_parts.join(";")]);
                    for label in &out_labels {
                        av1_args.extend(["-map".into(), label.clone()]);
                    }
                }
            } else {
                for &ai in &active_audio {
                    av1_args.extend(["-map".into(), format!("0:a:{ai}?")]);
                }
            }

            if use_gpu {
                // NVIDIA hardware AV1 encoder — much faster than CPU encoders.
                av1_args.extend([
                    "-c:v".into(), "av1_nvenc".into(),
                    "-preset".into(), "p4".into(),
                    "-cq".into(), "28".into(),
                    "-b:v".into(), video_bv.clone(),
                    "-maxrate".into(), maxrate,
                    "-bufsize".into(), bufsize,
                ]);
            } else {
                let av1_enc = probe_av1_encoder(&ffmpeg);
                if av1_enc == "libsvtav1" {
                    av1_args.extend([
                        "-c:v".into(), "libsvtav1".into(),
                        "-preset".into(), "6".into(),
                        "-b:v".into(), video_bv.clone(),
                        "-maxrate".into(), maxrate,
                        "-bufsize".into(), bufsize,
                        "-svtav1-params".into(), "tune=0".into(),
                    ]);
                } else {
                    // libaom-av1 fallback
                    av1_args.extend([
                        "-c:v".into(), "libaom-av1".into(),
                        "-cpu-used".into(), "4".into(),
                        "-b:v".into(), video_bv.clone(),
                        "-maxrate".into(), maxrate,
                        "-bufsize".into(), bufsize,
                    ]);
                }
            }

            av1_args.extend([
                "-c:a".into(), "aac".into(),
                "-b:a".into(), audio_ba,
                "-progress".into(), "pipe:1".into(),
                "-nostats".into(),
                output.clone(),
            ]);

            let mut child = Command::new(&ffmpeg)
                .args(&av1_args)
                .no_window()
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn().map_err(|e| e.to_string())?;

            let stdout  = child.stdout.take().unwrap();
            let reader  = BufReader::new(stdout);
            let start   = std::time::Instant::now();
            let mut last_pct = 0.0f64;

            for line in reader.lines().flatten() {
                if let Some(rest) = line.strip_prefix("out_time_ms=") {
                    if let Ok(ms) = rest.trim().parse::<f64>() {
                        if ms <= 0.0 { continue; }
                        let secs_done = ms / 1_000_000.0;
                        let pct       = (secs_done / duration_secs).min(1.0) * 100.0;
                        let elapsed   = start.elapsed().as_secs_f64();
                        let fraction  = pct / 100.0;
                        let eta = if fraction > 0.02 {
                            (elapsed / fraction) * (1.0 - fraction)
                        } else { 0.0 };
                        if pct - last_pct >= 0.5 {
                            last_pct = pct;
                            let _ = app.emit("encode-progress", EncodeProgress {
                                percent: pct.min(99.0), eta_secs: eta, pass: 1,
                            });
                        }
                    }
                }
            }

            let status = child.wait().map_err(|e| e.to_string())?;
            if !status.success() {
                let enc_name = if use_gpu { "av1_nvenc" } else { probe_av1_encoder(&ffmpeg) };
                return Err(format!(
                    "FFmpeg AV1 encode failed (exit code {:?}) using {}.",
                    status.code(), enc_name
                ));
            }

            let out_size = std::fs::metadata(&output)
                .map(|m| m.len())
                .unwrap_or(0);
            if out_size == 0 {
                let enc_name = if use_gpu { "av1_nvenc" } else { probe_av1_encoder(&ffmpeg) };
                return Err(format!("AV1 encode ({enc_name}) produced an empty output file."));
            }

            let _ = app.emit("encode-progress", EncodeProgress {
                percent: 100.0, eta_secs: 0.0, pass: 1,
            });
            return Ok("Done".into());
        }

        // ── x264 2-pass path ──────────────────────────────────────────────────────
        let _ = app.emit("encode-progress", EncodeProgress {
            percent: 0.0, eta_secs: 0.0, pass: 1,
        });

        let mut pass1: Vec<String> = trim_args.clone();
        pass1.extend(["-y".into(), "-i".into(), input.clone()]);
        if let Some(dur) = clip_duration {
            pass1.extend(["-t".into(), format!("{dur:.6}")]);
        }
        pass1.extend(vf_arg.clone());
        pass1.extend([
            "-c:v".into(), "libx264".into(),
            "-b:v".into(), video_bv.clone(),
            "-pass".into(), "1".into(),
            "-passlogfile".into(), passlog_str.clone(),
            "-progress".into(), "pipe:1".into(),
            "-nostats".into(),
            "-an".into(), "-f".into(), "null".into(),
            #[cfg(target_os = "windows")] "NUL".into(),
            #[cfg(not(target_os = "windows"))] "/dev/null".into(),
        ]);

        let mut child1 = Command::new(&ffmpeg)
            .args(&pass1)
            .no_window()
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn().map_err(|e| e.to_string())?;

        let stdout1 = child1.stdout.take().unwrap();
        let reader1 = BufReader::new(stdout1);
        let start1  = std::time::Instant::now();
        let mut last_pct1 = 0.0f64;
        for line in reader1.lines().flatten() {
            if let Some(rest) = line.strip_prefix("out_time_ms=") {
                if let Ok(ms) = rest.trim().parse::<f64>() {
                    if ms <= 0.0 { continue; }
                    let secs_done = ms / 1_000_000.0;
                    let pct       = (secs_done / duration_secs).min(1.0) * 50.0;
                    let elapsed   = start1.elapsed().as_secs_f64();
                    let fraction  = pct / 50.0;
                    let eta = if fraction > 0.02 {
                        (elapsed / fraction) * (1.0 - fraction) + 1.0
                    } else { 0.0 };
                    if pct - last_pct1 >= 0.5 {
                        last_pct1 = pct;
                        let _ = app.emit("encode-progress", EncodeProgress {
                            percent: pct.min(49.0), eta_secs: eta, pass: 1,
                        });
                    }
                }
            }
        }
        let s1 = child1.wait().map_err(|e| e.to_string())?;
        if !s1.success() { return Err("FFmpeg pass 1 failed".into()); }

        let _ = app.emit("encode-progress", EncodeProgress {
            percent: 50.0, eta_secs: 0.0, pass: 2,
        });

        let mut pass2: Vec<String> = trim_args;
        pass2.extend([
            "-y".into(), "-i".into(), input,
            "-progress".into(), "pipe:1".into(),
            "-nostats".into(),
        ]);
        if let Some(dur) = clip_duration {
            pass2.extend(["-t".into(), format!("{dur:.6}")]);
        }
        pass2.extend(vf_arg);
        pass2.extend(["-map".into(), "0:v:0".into()]);

        if has_volume_changes {
            let mut filter_parts: Vec<String> = vec![];
            let mut out_labels: Vec<String> = vec![];
            for (out_idx, &ai) in active_audio.iter().enumerate() {
                let vol_pct = volume_map.get(&ai).copied().unwrap_or(100);
                let vol_f   = vol_pct as f64 / 100.0;
                let label   = format!("a{out_idx}");
                filter_parts.push(format!("[0:a:{ai}]volume={vol_f:.4}[{label}]"));
                out_labels.push(format!("[{label}]"));
            }
            if !filter_parts.is_empty() {
                pass2.extend(["-filter_complex".into(), filter_parts.join(";")]);
                for label in &out_labels {
                    pass2.extend(["-map".into(), label.clone()]);
                }
            }
        } else {
            for &ai in &active_audio {
                pass2.extend(["-map".into(), format!("0:a:{ai}?")]);
            }
        }

        pass2.extend([
            "-c:v".into(), "libx264".into(),
            "-b:v".into(), video_bv,
            "-pass".into(), "2".into(),
            "-passlogfile".into(), passlog_str,
            "-c:a".into(), "aac".into(),
            "-b:a".into(), audio_ba,
            output.clone(),
        ]);

        let mut child = Command::new(&ffmpeg)
            .args(&pass2)
            .no_window()
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn().map_err(|e| e.to_string())?;

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
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() { return Err("FFmpeg pass 2 failed".into()); }

        let out_size = std::fs::metadata(&output)
            .map(|m| m.len())
            .unwrap_or(0);
        if out_size == 0 {
            return Err("Encode produced an empty output file.".into());
        }

        let _ = app.emit("encode-progress", EncodeProgress {
            percent: 100.0, eta_secs: 0.0, pass: 2,
        });
        Ok("Done".into())
    })
    .await.map_err(|e| e.to_string())?
}
