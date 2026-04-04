<div align="center">
  <img src="src-tauri/icons/icon.png" width="72" height="72" alt="quick encode logo" />
  <h1>quick encode.</h1>
  <p>A fast, minimal video compressor built with Tauri + React.</p>
  <p>
    <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-blue?style=flat-square" />
    <img alt="Built with Tauri" src="https://img.shields.io/badge/built_with-Tauri_v2-24C8D8?style=flat-square" />
    <img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=flat-square" />
  </p>
</div>

---

## What it does

quick encode is a desktop app that compresses video files using FFmpeg's 2-pass H.264 encoding. You get a real before/after frame preview so you can see quality vs. size trade-offs before committing to an encode.

**Key features:**
- 🎞️ **Side-by-side preview** — scrub through 10 frames comparing original and output quality live
- 🎚️ **Quality slider** — simple percentage control that maps to bitrate automatically
- 📦 **Batch encode** — drop a folder or select multiple files, encode them all at once
- 💬 **Discord preset** — one click to target ≤9 MB (ideal for Discord uploads)
- 🌙 **Light / dark mode**
- ✂️ **Video Editor** — Trim your clip before encoding.
- ✅ **Encode complete screen** — shows real output size, compression %, and a shortcut to open the output folder

---

## How it works

1. **Drop** a video file (or folder) onto the app, or click **Browse files**
2. **Preview** frames side-by-side and adjust quality, resolution, audio bitrate, and FPS
3. **Start Encode** — FFmpeg runs a 2-pass encode in the background with a live progress bar
4. When done, the **Encode complete** screen shows the real file size, how much was saved, and lets you open the file directly

---

## Supported formats

| Input | Output |
|---|---|
| MP4, MKV, AVI, MOV, WebM, M4V, WMV, FLV, TS, MTS | MP4, MKV, WebM |

---

## Development setup

**Prerequisites:** Node.js 18+, Rust (stable), Tauri CLI v2

```bash
# Install dependencies
npm install

# Place FFmpeg + FFprobe binaries in src-tauri/binaries/
# (named ffmpeg-x86_64-pc-windows-msvc.exe etc.)

# Run in dev mode
npm run tauri dev

# Build for production
npm run tauri build
```

Binaries must be placed in `src-tauri/binaries/` and listed under `bundle.externalBin` in `tauri.conf.json`. The app resolves them via `resolve_bin()` in `commands.rs`.

---

## Tech stack

| Layer | Technology |
|---|---|
| Shell / native | Rust + Tauri v2 |
| UI | React 18 + TypeScript |
| Bundler | Vite |
| Video processing | FFmpeg (sidecar binary) |
| Styling | Plain CSS with CSS variables |
