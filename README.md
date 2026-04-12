<div align="center">
  <img src="src-tauri/icons/icon.png" width="72" height="72" alt="quick encode logo" />
  <h1>quick encode.</h1>
  <p>A fast, minimal video compressor.</p>
  <p>
    <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-blue?style=flat-square" />
    <img alt="Built with Tauri" src="https://img.shields.io/badge/built_with-Tauri_v2-24C8D8?style=flat-square" />
    <img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=flat-square" />
  </p>
</div>

---

## What it does

quick encode is a desktop app that compresses video files using FFmpeg encoding. You get a real before/after frame preview so you can see quality vs. size trade-offs before committing to an encode.

**Key features:**
- **Side-by-side preview** — scrub through 10 frames comparing original and output quality live
- **Quality slider** — simple percentage control that maps to bitrate automatically
- **Codec selector** — choose between H.264, H.265, and AV1
- **Hardware acceleration** — select from NVENC, QuickSync, AMF, VideoToolbox, or CPU; compatible options are detected automatically per codec
- **Batch encode** — drop a folder or select multiple files, encode them all at once with per-clip edit support
- **Discord preset** — one click to target ≤10 MB (ideal for Discord uploads)
- **Right-click context menu** — encode directly from Windows Explorer via a submenu on any .mp4 file, with a Discord-ready option that skips the preview entirely
- **Video editor** — trim your clip before encoding, adjust audio track volume, and merge multiple audio tracks into one
- **Light / dark mode**
- **Encode complete screen** — shows real output size, compression %, a shortcut to open the output folder, and a button to re-encode the same clip

---

## How it works

1. **Drop** a video file (or folder) onto the app, or click **Browse files**
2. **Preview** frames side-by-side and adjust quality, resolution, codec, hardware acceleration, audio bitrate, and FPS
3. **Start Encode** — FFmpeg runs the encode in the background with a live progress bar; cancel at any time
4. When done, the **Encode complete** screen shows the real file size, how much was saved, and lets you open the file directly

---

## Supported formats

| Input | Output |
|---|---|
| MP4, MKV, AVI, MOV, WebM, M4V, WMV, FLV, TS, MTS | MP4, MKV, WebM |

---

## Tech stack

| Layer | Technology |
|---|---|
| Shell / native | Rust + Tauri v2 |
| UI | React 18 + TypeScript |
| Bundler | Vite |
| Video processing | FFmpeg (sidecar binary) |
| Styling | Plain CSS with CSS variables |
