import { execSync } from "child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "fs";
import { join } from "path";

const TRIPLE = "x86_64-pc-windows-msvc";
const OUT = join("src-tauri", "binaries");
const FF  = join(OUT, `ffmpeg-${TRIPLE}.exe`);
const FFP = join(OUT, `ffprobe-${TRIPLE}.exe`);

if (existsSync(FF) && existsSync(FFP)) {
  console.log("ffmpeg/ffprobe already present, skipping download.");
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });

const ZIP = "ffmpeg.zip";
const EXTRACTED = "ffmpeg-master-latest-win64-gpl";

console.log("Downloading ffmpeg (this may take a moment)...");
execSync(
  `curl -L "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" -o ${ZIP}`,
  { stdio: "inherit" }
);

console.log("Extracting...");
execSync(`tar -xf ${ZIP}`, { stdio: "inherit" });

renameSync(join(EXTRACTED, "bin", "ffmpeg.exe"),  FF);
renameSync(join(EXTRACTED, "bin", "ffprobe.exe"), FFP);

rmSync(EXTRACTED, { recursive: true, force: true });
rmSync(ZIP);

console.log(`Done! Binaries placed in ${OUT}`);
