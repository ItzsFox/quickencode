import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import VideoEditor from "./VideoEditor";
import { VideoEdits } from "./types";

interface VideoInfo {
  duration_secs: number;
  size_mb:       number;
  bitrate_kbps:  number;
  width:         number;
  height:        number;
  audio_tracks?: AudioTrackInfo[];
}
interface AudioTrackInfo {
  index:    number;
  label:    string;
  language: string;
}
interface EncodeProgress {
  percent:  number;
  eta_secs: number;
  pass:     number;
}
interface BatchFile {
  path:   string;
  status: "pending" | "active" | "done" | "error";
  msg?:   string;
  edits:  VideoEdits | null;
}
interface DoneResult {
  outputPath: string;
  originalMb: number;
  finalMb:    number;
}
interface BatchDoneResult {
  total:     number;
  succeeded: number;
  failed:    number;
  outputDir: string;
}
interface GpuEncoderInfo {
  id:    string;   // "nvenc" | "qsv" | "amf" | "videotoolbox"
  label: string;   // e.g. "NVIDIA NVENC"
}

/** Re-export so App internal code can still use VideoEdits without importing types directly */
export type { VideoEdits };

const FRAME_COUNT    = 10;
const DISCORD_TARGET = 9;
const DISCORD_AUDIO  = 96;
const VIDEO_EXTS     = new Set(["mp4","mkv","avi","mov","webm","m4v","wmv","flv","ts","mts"]);
const RES_BITRATES: Record<string, number> = {
  "1080p": 5000, "720p": 2500, "480p": 1000,
};

function fmtTime(s: number) {
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`
    : `${m}:${String(sec).padStart(2,"0")}`;
}
function fmtMb(mb: number) {
  return mb >= 1024 ? `${(mb/1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}
function fmtEta(s: number) {
  if (s <= 0) return "—";
  if (s < 60) return `${Math.ceil(s)}s`;
  return `${Math.floor(s/60)}m ${Math.ceil(s%60)}s`;
}
function sliderBg(val: number, min: number, max: number, fill: string, empty: string) {
  const pct = ((val - min) / (max - min)) * 100;
  return `linear-gradient(to right, ${fill} ${pct}%, ${empty} ${pct}%)`;
}
function qualityInfo(q: number) {
  if (q >= 85) return { label: "Near Lossless", cls: "c4" };
  if (q >= 65) return { label: "High Quality",  cls: "c3" };
  if (q >= 40) return { label: "Balanced",       cls: "c2" };
  if (q >= 20) return { label: "Low Quality",    cls: "c1" };
  return             { label: "Very Low",         cls: "c0" };
}
function basename(p: string) { return p.split(/[\\\/]/).pop() ?? p; }
function discordBr(dur: number) {
  return Math.max(Math.floor((DISCORD_TARGET * 8 * 1024) / dur) - DISCORD_AUDIO, 80);
}
function frameTs(i: number, duration: number) {
  return duration * (i + 0.5) / FRAME_COUNT;
}
function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }
function isVideo(p: string) {
  return VIDEO_EXTS.has((p.split(".").pop() ?? "").toLowerCase());
}

/** Human-readable short label for the active GPU encoder shown in the preview tag */
function gpuShortLabel(gpuEncoder: string, useAv1: boolean): string {
  const codec = useAv1 ? "AV1" : "H.264";
  switch (gpuEncoder) {
    case "nvenc":        return `${codec}·NVENC`;
    case "qsv":         return `${codec}·QSV`;
    case "amf":         return useAv1 ? "HEVC·AMF" : `${codec}·AMF`;
    case "videotoolbox": return useAv1 ? "HEVC·VT" : `${codec}·VT`;
    default:            return useAv1 ? "AV1·CPU" : "";
  }
}

/** Build a short badge string for a clip's edits, e.g. "0:12 · −1 audio · merged" */
function editsBadgeForClip(edits: VideoEdits | null, duration: number): string | null {
  if (!edits) return null;
  const parts: string[] = [];
  if (edits.trimStart > 0 || edits.trimEnd < duration)
    parts.push(fmtTime(edits.trimEnd - edits.trimStart));
  const del = edits.audioTracks.filter(t => t.deleted).length;
  if (del) parts.push(`−${del} audio`);
  const activeTracks = edits.audioTracks.filter(t => !t.deleted).length;
  if (edits.mergeAudioTracks && activeTracks > 1) parts.push("merged");
  return parts.length > 0 ? parts.join(" · ") : null;
}

const QELogo = ({ size = 20 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 85 85" fill="currentColor" aria-label="quick encode logo" style={{ flexShrink: 0, display: "block" }}>
    <path d="M80 30C82.7614 30 85 32.2386 85 35V80C85 82.7614 82.7614 85 80 85H35C32.2386 85 30 82.7614 30 80V69H65C67.2091 69 69 67.2091 69 65V30H80ZM65 16C67.2091 16 69 17.7909 69 20V30H55V50C55 52.7614 52.7614 55 50 55H30V69H20C17.7909 69 16 67.2091 16 65V55H30V35C30 32.2386 32.2386 30 35 30H55V16H65ZM50 0C52.7614 0 55 2.23858 55 5V16H20C17.7909 16 16 17.7909 16 20V55H5C2.23858 55 0 52.7614 0 50V5C0 2.23858 2.23858 0 5 0H50Z" />
  </svg>
);

const DiscordIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057.1 18.08.114 18.1.131 18.111a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
  </svg>
);

/** Pencil edit icon */
const EditIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);

type Screen = "drop" | "loading" | "editor" | "batch" | "done" | "batch-done";

// ── Sub-components lifted outside App to prevent remount on every render ──

interface WordmarkProps { size?: "sm" | "base"; }
function Wordmark({ size = "base" }: WordmarkProps) {
  return (
    <div className={`wordmark wordmark-${size}`}>
      <QELogo size={size === "sm" ? 14 : 17} />
      <span>quick encode<em>.</em></span>
    </div>
  );
}

interface ThemeBtnProps { theme: "light" | "dark"; onToggle: (e: React.MouseEvent) => void; }
function ThemeBtn({ theme, onToggle }: ThemeBtnProps) {
  return (
    <button className="theme-toggle" onClick={onToggle} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`} aria-label="Toggle theme">
      {theme === "light" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5"/>
          <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
          <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
      )}
    </button>
  );
}

interface QualitySettingsProps {
  quality:     number;
  resolution:  string;
  format:      string;
  audio:       number;
  fps:         string;
  useAv1:      boolean;
  gpuEncoder:  string;
  gpuOptions:  GpuEncoderInfo[];
  theme:       "light" | "dark";
  onQuality:   (v: number) => void;
  onRes:       (v: string) => void;
  onFmt:       (v: string) => void;
  onAudio:     (v: number) => void;
  onFps:       (v: string) => void;
  onAv1:       (v: boolean) => void;
  onGpuEncoder:(v: string) => void;
}
function QualitySettings({
  quality, resolution, format, audio, fps, useAv1, gpuEncoder, gpuOptions, theme,
  onQuality, onRes, onFmt, onAudio, onFps, onAv1, onGpuEncoder,
}: QualitySettingsProps) {
  const ql    = qualityInfo(quality);
  const isDark = theme === "dark";
  const bg = (val: number, min: number, max: number) =>
    sliderBg(val, min, max, isDark ? "#888888" : "#555555", isDark ? "#333336" : "#d0d0d0");

  // GPU dropdown: always show "CPU" first, then detected GPU options.
  const gpuSelectOptions: { value: string; label: string }[] = [
    { value: "cpu", label: "CPU" },
    ...gpuOptions.map(g => ({ value: g.id, label: g.label })),
  ];

  return (
    <>
      <div className="quality-col">
        <div className="quality-header">
          <span className="section-label">Quality</span>
          <div className="quality-values">
            <span className={`q-badge ${ql.cls}`}>{ql.label}</span>
            <span className="q-pct">{quality}%</span>
          </div>
        </div>
        <input type="range" min={5} max={100} value={quality}
          style={{ background: bg(quality, 5, 100) }}
          onChange={e => onQuality(Number(e.target.value))}
        />
        <div className="range-labels"><span>Low</span><span>High</span></div>
      </div>

      <div className="options-col">
        <div className="options-grid">
          <div className="setting">
            <label>Resolution</label>
            <select value={resolution} onChange={e => onRes(e.target.value)}>
              <option>1080p</option>
              <option>720p</option>
              <option>480p</option>
              <option>Original</option>
            </select>
          </div>
          <div className="setting">
            <label>Format</label>
            <select value={format} onChange={e => onFmt(e.target.value)}>
              <option>mp4</option>
              <option>mkv</option>
              <option>webm</option>
            </select>
          </div>
          <div className="setting">
            <label>Audio kbps</label>
            <select value={audio} onChange={e => onAudio(Number(e.target.value))}>
              <option value={64}>64</option>
              <option value={96}>96</option>
              <option value={128}>128</option>
              <option value={192}>192</option>
              <option value={320}>320</option>
            </select>
          </div>
          <div className="setting">
            <label>Frame rate</label>
            <select value={fps} onChange={e => onFps(e.target.value)}>
              <option>Original</option>
              <option>60</option>
              <option>30</option>
              <option>24</option>
            </select>
          </div>
        </div>

        {/* AV1 toggle */}
        <div className="av1-toggle-row">
          <label
            className="av1-toggle"
            title="Uses SVT-AV1 encoder — better quality at the same file size, but slower to encode than H.264">
            <input
              type="checkbox"
              checked={useAv1}
              onChange={e => {
                onAv1(e.target.checked);
                // When disabling AV1, keep GPU selection as-is (H.264 GPU still works)
              }}
            />
            <span className="av1-toggle-label">AV1 encoder</span>
            {useAv1
              ? <span className="av1-slow-badge">slower encode</span>
              : <span className="av1-hint">better quality, longer encode</span>}
          </label>

          {/* GPU encoder selector — shown when any GPU option exists */}
          {gpuSelectOptions.length > 1 && (
            <div className="gpu-select-row">
              <span className="gpu-select-label">GPU</span>
              <select
                className="gpu-select"
                value={gpuEncoder}
                onChange={e => onGpuEncoder(e.target.value)}
              >
                {gpuSelectOptions.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <button className="gpu-info-btn" aria-label="GPU encoder info" tabIndex={0}>
                i
                <div className="gpu-tooltip">
                  <div className="gpu-tooltip-title">
                    {gpuEncoder === "cpu"           ? "CPU (Software)"
                    : gpuEncoder === "nvenc"        ? "NVIDIA NVENC"
                    : gpuEncoder === "qsv"          ? "Intel Quick Sync (QSV)"
                    : gpuEncoder === "amf"          ? "AMD AMF"
                    : gpuEncoder === "videotoolbox" ? "Apple VideoToolbox"
                    : (gpuOptions.find(g => g.id === gpuEncoder)?.label ?? gpuEncoder.toUpperCase())}
                  </div>
                  <div className="gpu-tooltip-desc">
                    {gpuEncoder === "cpu"
                      ? "Uses your processor to encode — most compatible and highest quality, but the slowest option."
                    : gpuEncoder === "nvenc"
                      ? "NVIDIA GPU hardware encoder. Very fast with low CPU usage, great for NVIDIA GeForce / RTX cards (Maxwell or newer)."
                    : gpuEncoder === "qsv"
                      ? "Intel Quick Sync Video — hardware encoder built into Intel CPUs and iGPUs. Fast and efficient."
                    : gpuEncoder === "amf"
                      ? "AMD Advanced Media Framework — hardware encoder on AMD Radeon GPUs. Fast with low CPU usage."
                    : gpuEncoder === "videotoolbox"
                      ? "Apple hardware encoder available on all Macs. Very fast with excellent efficiency on M-series chips."
                      : "Hardware-accelerated GPU encoder. Faster than CPU but may have slightly lower quality at the same bitrate."}
                  </div>
                  <div className="gpu-tooltip-note">
                    {gpuEncoder === "cpu"
                      ? "H.264: 2-pass encoding for best quality. AV1: single-pass SVT-AV1."
                      : "Single-pass encoding. GPU encoders are faster but CPU (2-pass) often produces slightly smaller files at the same quality."}
                  </div>
                </div>
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────
const CancelIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

export default function App() {
  const [screen, setScreen]           = useState<Screen>("drop");
  const [theme,  setTheme]            = useState<"light" | "dark">(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  );
  const [videoPath, setVideoPath]     = useState("");
  const [videoInfo, setVideoInfo]     = useState<VideoInfo | null>(null);
  const [quality,   setQuality]       = useState(75);
  const [resolution,setResolution]    = useState("Original");
  const [format,    setFormat]        = useState("mp4");
  const [audio,     setAudio]         = useState(128);
  const [fps,       setFps]           = useState("Original");
  const [useAv1,    setUseAv1]        = useState(false);
  // gpuEncoder: "cpu" = software, or "nvenc" / "qsv" / "amf" / "videotoolbox"
  const [gpuEncoder, setGpuEncoder]   = useState("cpu");
  // gpuOptions: populated on mount via probe_gpu_encoders
  const [gpuOptions, setGpuOptions]   = useState<GpuEncoderInfo[]>([]);
  const [encFrames,  setEncFrames]    = useState<Record<number, string>>({});
  const [origFrames, setOrigFrames]   = useState<Record<number, string>>({});
  const [frameIdx,   setFrameIdx]     = useState(0);
  const [progress,   setProgress]     = useState(0);
  const [eta,        setEta]          = useState(0);
  const [passNum,    setPassNum]      = useState(1);
  const [doneResult, setDoneResult]   = useState<DoneResult | null>(null);
  const [batchFiles, setBatchFiles]   = useState<BatchFile[]>([]);
  const [batchDone,  setBatchDone]    = useState<BatchDoneResult | null>(null);
  const [dragOver,   setDragOver]     = useState(false);
  const [edits,      setEdits]        = useState<VideoEdits | null>(null);
  const [showEditor, setShowEditor]   = useState(false);
  const [batchEditIdx, setBatchEditIdx] = useState<number | null>(null);
  const [fullscreenImg, setFullscreenImg] = useState<{ src: string; label: string } | null>(null);

  // ── Theme application ──────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // ── GPU encoder probe on mount ─────────────────────────
  useEffect(() => {
    invoke<GpuEncoderInfo[]>("probe_gpu_encoders")
      .then(gpus => {
        setGpuOptions(gpus);
        if (gpus.length > 0) {
          // Auto-select the first GPU found
          setGpuEncoder(gpus[0].id);
        }
      })
      .catch(() => { /* no GPU info — stay on cpu */ });
  }, []);

  // ── Frame loader ───────────────────────────────────────
  const loadEncodedFrame = useCallback(
    async (
      idx: number, vbr: number, res: string, f: string, av1: boolean, gpu: string
    ) => {
      try {
        const dataUrl = await invoke<string>("encode_preview_frame", {
          path: videoPath, timestamp: frameTs(idx, videoInfo?.duration_secs ?? 1),
          videoBitrateKbps: vbr, fps: f, useAv1: av1, gpuEncoder: gpu,
          resolution: res, format: f,
        });
        setEncFrames(prev => ({ ...prev, [idx]: dataUrl }));
      } catch { /* ignore */ }
    },
    [videoPath, videoInfo]
  );

  // Re-load current frame when settings change
  useEffect(() => {
    if (screen !== "editor" || !videoInfo) return;
    const vbr = resolution === "Original"
      ? Math.round(videoInfo.bitrate_kbps * (quality / 100))
      : Math.round((RES_BITRATES[resolution] ?? 2500) * (quality / 100));
    setEncFrames({});
    loadEncodedFrame(frameIdx, vbr, resolution, fps, useAv1, gpuEncoder);
  }, [resolution, quality, fps, useAv1, gpuEncoder, loadEncodedFrame]);

  // Pre-load adjacent frames on idle
  useEffect(() => {
    if (screen !== "editor" || !videoInfo) return;
    const vbr = resolution === "Original"
      ? Math.round(videoInfo.bitrate_kbps * (quality / 100))
      : Math.round((RES_BITRATES[resolution] ?? 2500) * (quality / 100));
    if (!encFrames[frameIdx]) loadEncodedFrame(frameIdx, vbr, resolution, fps, useAv1, gpuEncoder);
  }, [frameIdx]);

  const videoBr = videoInfo
    ? resolution === "Original"
      ? Math.round(videoInfo.bitrate_kbps * (quality / 100))
      : Math.round((RES_BITRATES[resolution] ?? 2500) * (quality / 100))
    : 0;

  // ── File open ──────────────────────────────────────────
  const openFile = useCallback(async (path?: string) => {
    const p = path ?? await open({ filters: [{ name: "Video", extensions: [...VIDEO_EXTS] }] });
    if (!p || typeof p !== "string") return;
    setScreen("loading");
    setVideoPath(p);
    setEncFrames({});
    setOrigFrames({});
    setEdits(null);
    try {
      const info = await invoke<VideoInfo>("get_video_info", { path: p });
      setVideoInfo(info);
      const vbr = resolution === "Original"
        ? Math.round(info.bitrate_kbps * (quality / 100))
        : Math.round((RES_BITRATES[resolution] ?? 2500) * (quality / 100));
      loadEncodedFrame(0, vbr, resolution, fps, useAv1, gpuEncoder);
      setScreen("editor");
    } catch (e) {
      alert(`Failed to load video: ${e}`);
      setScreen("drop");
    }
  }, [resolution, quality, fps, useAv1, gpuEncoder, loadEncodedFrame]);

  // ── Encode ─────────────────────────────────────────────
  const runEncode = useCallback(async (
    vbr: number, audioBr: number, res: string, f: string,
    outPath?: string, av1Override?: boolean, gpuOverride?: string
  ) => {
    const encodeWithAv1 = av1Override ?? useAv1;
    const encodeWithGpu = gpuOverride ?? gpuEncoder;
    const out = outPath ?? await save({
      defaultPath: videoPath.replace(/\.[^.]+$/, `_encoded.${format}`),
      filters: [{ name: "Video", extensions: [format] }],
    });
    if (!out) return;

    setProgress(0); setEta(0); setPassNum(1);
    setScreen("loading");

    const unlisten = await listen<EncodeProgress>("encode_progress", e => {
      setProgress(e.payload.percent);
      setEta(e.payload.eta_secs);
      setPassNum(e.payload.pass);
    });

    try {
      const result = await invoke<DoneResult>("encode_video", {
        path:             videoPath,
        outputPath:       out,
        videoBitrateKbps: vbr,
        audioBitrateKbps: audioBr,
        resolution:       res,
        format:           f,
        fps:              fps,
        useAv1:           encodeWithAv1,
        gpuEncoder:       encodeWithGpu,
        edits:            edits ?? undefined,
      });
      setDoneResult(result);
      setScreen("done");
    } catch (e) {
      if (`${e}`.includes("cancelled")) { setScreen("editor"); }
      else { alert(`Encode failed: ${e}`); setScreen("editor"); }
    } finally { unlisten(); }
  }, [videoPath, format, fps, useAv1, gpuEncoder, edits]);

  const handleEncode = useCallback(() => {
    runEncode(videoBr, audio, resolution, format);
  }, [videoBr, audio, resolution, format, runEncode]);

  const handleDiscordEncode = useCallback(() => {
    if (!videoInfo) return;
    runEncode(discordBr(videoInfo.duration_secs), DISCORD_AUDIO, resolution, fps, undefined, useAv1, gpuEncoder);
  }, [videoInfo, resolution, fps, useAv1, gpuEncoder, runEncode]);

  // ── Batch encode ───────────────────────────────────────
  const runBatchEncode = useCallback(async () => {
    if (batchFiles.length === 0) return;
    const dir = await save({ title: "Choose output folder name", defaultPath: "encoded_batch" });
    if (!dir) return;

    setScreen("loading");
    setProgress(0); setEta(0); setPassNum(1);

    const unlisten = await listen<EncodeProgress>("encode_progress", e => {
      setProgress(e.payload.percent);
      setEta(e.payload.eta_secs);
      setPassNum(e.payload.pass);
    });

    try {
      const result = await invoke<BatchDoneResult>("encode_batch", {
        files: batchFiles.map(f => ({
          path:  f.path,
          edits: f.edits ?? undefined,
        })),
        outputDir:        dir,
        videoBitrateKbps: videoBr,
        audioBitrateKbps: audio,
        resolution,
        format,
        fps,
        useAv1,
        gpuEncoder,
      });
      setBatchDone(result);
      setScreen("batch-done");
    } catch (e) {
      if (`${e}`.includes("cancelled")) { setScreen("batch"); }
      else { alert(`Batch encode failed: ${e}`); setScreen("batch"); }
    } finally { unlisten(); }
  }, [batchFiles, videoBr, audio, resolution, format, fps, useAv1, gpuEncoder]);

  // ── Drop / drag ────────────────────────────────────────
  useEffect(() => {
    const webview = getCurrentWebview();
    const unlisten = webview.onDragDropEvent(e => {
      if (e.payload.type === "over") { setDragOver(true); return; }
      setDragOver(false);
      if (e.payload.type !== "drop") return;
      const paths = (e.payload as { paths?: string[] }).paths ?? [];
      const videos = paths.filter(isVideo);
      if (videos.length === 0) return;
      if (videos.length === 1) {
        if (screen === "batch") {
          setBatchFiles(prev => {
            const existing = new Set(prev.map(f => f.path));
            const news = videos.filter(v => !existing.has(v));
            return [...prev, ...news.map(p => ({ path: p, status: "pending" as const, edits: null }))];
          });
        } else {
          openFile(videos[0]);
        }
      } else {
        // Multiple files → batch
        if (screen === "batch") {
          setBatchFiles(prev => {
            const existing = new Set(prev.map(f => f.path));
            const news = videos.filter(v => !existing.has(v));
            return [...prev, ...news.map(p => ({ path: p, status: "pending" as const, edits: null }))];
          });
        } else {
          setBatchFiles(videos.map(p => ({ path: p, status: "pending" as const, edits: null })));
          setScreen("batch");
        }
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, [screen, openFile]);

  // ── Progress pass label — now shows actual encoder name ──
  const progressPassLabel = (() => {
    if (screen !== "loading") return "";
    const isGpu     = gpuEncoder !== "cpu";
    const gpuLabel  = gpuOptions.find(g => g.id === gpuEncoder)?.label ?? gpuEncoder.toUpperCase();
    if (useAv1) {
      const enc = isGpu ? gpuLabel : "CPU · SVT-AV1";
      return `Pass 1 / 1 — ${enc}`;
    }
    if (isGpu) return `Pass 1 / 1 — ${gpuLabel}`;
    return passNum === 1 ? "Pass 1 / 2 — CPU · Analysis" : "Pass 2 / 2 — CPU · Encode";
  })();

  const previewTagExtra = gpuShortLabel(gpuEncoder, useAv1);

  // ── Render ─────────────────────────────────────────────
  if (screen === "drop") return (
    <div
      className={`drop-screen${dragOver ? " drag-over" : ""}`}
      onClick={() => openFile()}
      onKeyDown={e => e.key === "Enter" && openFile()}
      tabIndex={0}
      role="button"
      aria-label="Open video file"
    >
      <div className="drop-theme-btn" onClick={e => e.stopPropagation()}>
        <ThemeBtn theme={theme} onToggle={e => { e.stopPropagation(); setTheme(t => t === "light" ? "dark" : "light"); }} />
      </div>
      <div className="drop-wordmark">
        <QELogo size={36} />
        <h1>quick encode<em>.</em></h1>
        <small>fast video compression for Discord, web &amp; storage</small>
      </div>
      <div className="drop-hint-text">
        <p>Drop a video file here</p>
        <small>MP4 · MKV · MOV · AVI · WebM and more</small>
      </div>
      <div className="drop-actions" onClick={e => e.stopPropagation()}>
        <button className="drop-browse" onClick={() => openFile()}>Browse files</button>
        <button className="drop-browse" style={{ background: "none", color: "var(--text-muted)", border: "1px solid var(--border-2)" }}
          onClick={() => {
            setBatchFiles([]);
            setScreen("batch");
          }}>
          Batch mode
        </button>
      </div>
    </div>
  );

  if (screen === "loading") return (
    <div className="loading-screen">
      <div className="loading-content">
        <div className="loading-wordmark">
          <QELogo size={18} />
          <span>quick encode<em>.</em></span>
        </div>
        <div className="loading-bar-wrap">
          <div className="loading-bar-bg">
            <div
              className={`loading-bar-fill${progress > 0 ? "" : ""}`}
              style={progress > 0 ? { width: `${progress}%`, animation: "none" } : {}}
            />
          </div>
          <div className="loading-label">
            {progress > 0
              ? `${Math.round(progress)}% · ${fmtEta(eta)} remaining · ${progressPassLabel}`
              : "Loading…"}
          </div>
        </div>
      </div>
    </div>
  );

  if (screen === "done" && doneResult) {
    const saved = doneResult.originalMb - doneResult.finalMb;
    const savedPct = Math.round((saved / doneResult.originalMb) * 100);
    return (
      <div className="done-screen">
        <div className="done-theme-btn">
          <ThemeBtn theme={theme} onToggle={() => setTheme(t => t === "light" ? "dark" : "light")} />
        </div>
        <div className="done-card">
          <div className="done-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <div className="done-title">Done</div>
          <div className="done-stats">
            <div className="done-stat">
              <span className="done-stat-label">Original</span>
              <span className="done-stat-val done-stat-muted">{fmtMb(doneResult.originalMb)}</span>
            </div>
            <div className="done-stat-divider" />
            <div className="done-stat">
              <span className="done-stat-label">Output</span>
              <span className="done-stat-val">{fmtMb(doneResult.finalMb)}</span>
            </div>
            <div className="done-stat-divider" />
            <div className="done-stat">
              <span className="done-stat-label">Saved</span>
              <span className={`done-stat-val ${saved >= 0 ? "done-stat-green" : "done-stat-warn"}`}>
                {saved >= 0 ? `−${savedPct}%` : `+${Math.abs(savedPct)}%`}
              </span>
            </div>
          </div>
          <div className="done-filename">{basename(doneResult.outputPath)}</div>
          <div className="done-actions">
            <button className="done-btn-reveal" onClick={() => invoke("reveal_in_finder", { path: doneResult.outputPath })}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              Reveal in Finder
            </button>
            <button className="done-btn-new" onClick={() => { setScreen("drop"); setVideoPath(""); setVideoInfo(null); setEncFrames({}); setOrigFrames({}); setEdits(null); }}>
              Import new file
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "batch-done" && batchDone) {
    return (
      <div className="done-screen">
        <div className="done-theme-btn">
          <ThemeBtn theme={theme} onToggle={() => setTheme(t => t === "light" ? "dark" : "light")} />
        </div>
        <div className="done-card">
          <div className="done-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <div className="done-title">Batch Done</div>
          <div className="done-stats">
            <div className="done-stat">
              <span className="done-stat-label">Total</span>
              <span className="done-stat-val">{batchDone.total}</span>
            </div>
            <div className="done-stat-divider" />
            <div className="done-stat">
              <span className="done-stat-label">OK</span>
              <span className="done-stat-val done-stat-green">{batchDone.succeeded}</span>
            </div>
            {batchDone.failed > 0 && <>
              <div className="done-stat-divider" />
              <div className="done-stat">
                <span className="done-stat-label">Failed</span>
                <span className="done-stat-val done-stat-warn">{batchDone.failed}</span>
              </div>
            </>}
          </div>
          <div className="done-actions">
            <button className="done-btn-reveal" onClick={() => invoke("reveal_in_finder", { path: batchDone.outputDir })}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              Reveal output folder
            </button>
            <button className="done-btn-new" onClick={() => { setScreen("drop"); setBatchFiles([]); setBatchDone(null); }}>
              Start over
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (screen === "batch") {
    const isBusy = batchFiles.some(f => f.status === "active");
    return (
      <div className="batch-screen">
        {/* Top bar */}
        <div className="batch-topbar">
          <Wordmark size="sm" />
          <div className="batch-topbar-right">
            <span className="batch-count">{batchFiles.length} file{batchFiles.length !== 1 ? "s" : ""}</span>
            <ThemeBtn theme={theme} onToggle={() => setTheme(t => t === "light" ? "dark" : "light")} />
          </div>
        </div>

        {/* File list */}
        <div className="batch-file-list">
          {batchFiles.length === 0 && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-dim)", fontSize: 12, padding: 24 }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              <span>Drop video files here</span>
            </div>
          )}
          {batchFiles.map((f, i) => {
            const badge = editsBadgeForClip(f.edits, 0);
            return (
              <div key={f.path} className="batch-file-row">
                <span className="batch-file-name">{basename(f.path)}</span>
                {badge && <span className="batch-file-edits-badge">{badge}</span>}
                {f.status === "pending" ? (
                  <button
                    className="batch-file-edit-btn"
                    title="Edit trim / audio"
                    disabled={isBusy}
                    onClick={() => {
                      setVideoPath(f.path);
                      setBatchEditIdx(i);
                      setShowEditor(true);
                    }}
                  >
                    <EditIcon />
                  </button>
                ) : (
                  <span className="batch-file-edit-spacer" />
                )}
                <span className={`batch-file-status ${f.status}`}>
                  {f.status === "pending" ? "" : f.status === "active" ? "encoding…" : f.status === "done" ? "done" : f.msg ?? "error"}
                </span>
                {f.status === "pending" && (
                  <button className="batch-file-remove" onClick={() => setBatchFiles(prev => prev.filter((_, j) => j !== i))} title="Remove">
                    <CancelIcon />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Settings + actions */}
        <div className="batch-bottom">
          <QualitySettings
            quality={quality} resolution={resolution} format={format}
            audio={audio} fps={fps} useAv1={useAv1}
            gpuEncoder={gpuEncoder} gpuOptions={gpuOptions} theme={theme}
            onQuality={setQuality} onRes={setResolution} onFmt={setFormat}
            onAudio={setAudio} onFps={setFps} onAv1={setUseAv1}
            onGpuEncoder={setGpuEncoder}
          />
          <div className="batch-actions">
            <button
              className="batch-add-btn"
              disabled={isBusy}
              onClick={async () => {
                const files = await open({ multiple: true, filters: [{ name: "Video", extensions: [...VIDEO_EXTS] }] });
                if (!files) return;
                const arr = Array.isArray(files) ? files : [files];
                setBatchFiles(prev => {
                  const existing = new Set(prev.map(f => f.path));
                  return [...prev, ...arr.filter(p => !existing.has(p)).map(p => ({ path: p, status: "pending" as const, edits: null }))];
                });
              }}
            >
              + Add more
            </button>
            <div style={{ flex: 1 }} />
            <button className="preset-btn" disabled={isBusy || batchFiles.length === 0}
              onClick={() => { if (videoInfo) handleDiscordEncode(); }}>
              <DiscordIcon /><span>Discord Ready</span>
            </button>
            <button className="btn-encode" disabled={isBusy || batchFiles.length === 0} onClick={runBatchEncode}>
              <span className="btn-inner">Encode All</span>
            </button>
          </div>
        </div>

        {/* Back link */}
        <button style={{ background: "none", border: "none", color: "var(--text-dim)", fontSize: 11, cursor: "pointer", alignSelf: "flex-start", padding: 0 }}
          onClick={() => setScreen("drop")}>
          ← Back
        </button>

        {/* Batch clip editor overlay */}
        {showEditor && batchEditIdx !== null && (
          <VideoEditor
            videoPath={videoPath}
            initialEdits={batchFiles[batchEditIdx]?.edits ?? null}
            onConfirm={newEdits => {
              setBatchFiles(prev => prev.map((f, i) => i === batchEditIdx ? { ...f, edits: newEdits } : f));
              setShowEditor(false);
              setBatchEditIdx(null);
            }}
            onCancel={() => { setShowEditor(false); setBatchEditIdx(null); }}
          />
        )}
      </div>
    );
  }

  // ── Editor screen ──────────────────────────────────────
  const ar = videoInfo ? (() => { const g = gcd(videoInfo.width, videoInfo.height); return `${videoInfo.width/g}/${videoInfo.height/g}`; })() : "16/9";
  const fmtRes = videoInfo ? `${videoInfo.width}×${videoInfo.height}` : "—";
  const fmtDur = videoInfo ? fmtTime(videoInfo.duration_secs) : "—";
  const fmtSize = videoInfo ? fmtMb(videoInfo.size_mb) : "—";
  const fmtBr = videoInfo ? `${videoInfo.bitrate_kbps} kbps` : "—";
  const estFinalMb = videoInfo
    ? ((videoBr + audio) * videoInfo.duration_secs) / 8 / 1024
    : 0;
  const estDiff = videoInfo ? estFinalMb - videoInfo.size_mb : 0;

  return (
    <div className="editor">
      {/* Top bar */}
      <div className="topbar">
        <div className="topbar-left">
          <Wordmark size="sm" />
          <div className="file-chip" onClick={() => { setScreen("drop"); setVideoPath(""); setVideoInfo(null); setEncFrames({}); setOrigFrames({}); setEdits(null); }} title="Close file">
            <span>{basename(videoPath)}</span>
            <span className="file-chip-x">✕</span>
          </div>
        </div>
        <div className="topbar-right">
          <button className="preset-btn" onClick={() => setScreen("batch")} title="Switch to batch mode">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="7" width="20" height="4" rx="1"/><rect x="2" y="13" width="20" height="4" rx="1"/>
            </svg>
            Batch
          </button>
          <ThemeBtn theme={theme} onToggle={() => setTheme(t => t === "light" ? "dark" : "light")} />
        </div>
      </div>

      {/* Meta */}
      <div className="video-meta">
        {[
          { label: "Duration", val: fmtDur },
          { label: "Resolution", val: fmtRes },
          { label: "Size", val: fmtSize },
          { label: "Bitrate", val: fmtBr },
        ].map(m => (
          <div key={m.label} className="meta-item">
            <span className="meta-label">{m.label}</span>
            <span className="meta-val">{m.val}</span>
          </div>
        ))}
      </div>

      {/* Preview */}
      <div className="preview-section">
        <div className="preview-scaler">
          <div className="preview-grid" style={{ "--preview-aspect": ar } as React.CSSProperties}>
            {/* Original */}
            <div
              className="preview-side"
              onClick={() => {
                const src = origFrames[frameIdx];
                if (src) setFullscreenImg({ src, label: "Original" });
              }}
            >
              <div className="preview-tag">Original</div>
              <button
                className="preview-fullscreen-btn"
                title="Fullscreen"
                onClick={e => {
                  e.stopPropagation();
                  const src = origFrames[frameIdx];
                  if (src) setFullscreenImg({ src, label: "Original" });
                }}
              >⤢</button>
              {origFrames[frameIdx]
                ? <img src={origFrames[frameIdx]} alt="Original frame" />
                : (
                  <div className="preview-loading">
                    <div className="spin" />
                    <span>Loading…</span>
                  </div>
                )}
            </div>

            {/* Encoded */}
            <div
              className="preview-side"
              onClick={() => {
                const src = encFrames[frameIdx];
                if (src) setFullscreenImg({ src, label: "Encoded" });
              }}
            >
              <div className="preview-tag">
                Encoded
                {previewTagExtra && <span className="preview-tag-av1">{previewTagExtra}</span>}
              </div>
              <button
                className="preview-fullscreen-btn"
                title="Fullscreen"
                onClick={e => {
                  e.stopPropagation();
                  const src = encFrames[frameIdx];
                  if (src) setFullscreenImg({ src, label: "Encoded" });
                }}
              >⤢</button>
              {encFrames[frameIdx]
                ? <img src={encFrames[frameIdx]} alt="Encoded preview frame" />
                : (
                  <div className="preview-loading">
                    <div className="spin" />
                    <span>Encoding preview…</span>
                  </div>
                )}
            </div>
          </div>

          {/* Frame nav */}
          <div className="frame-nav">
            <button className="frame-nav-btn" onClick={() => setFrameIdx(i => Math.max(0, i - 1))} disabled={frameIdx === 0}>‹</button>
            <div className="frame-dots">
              {Array.from({ length: FRAME_COUNT }, (_, i) => (
                <button key={i} className={`frame-dot${i === frameIdx ? " active" : ""}`} onClick={() => setFrameIdx(i)} title={`Frame ${i + 1}`} />
              ))}
            </div>
            <button className="frame-nav-btn" onClick={() => setFrameIdx(i => Math.min(FRAME_COUNT - 1, i + 1))} disabled={frameIdx === FRAME_COUNT - 1}>›</button>
            <span className="frame-label">
              {videoInfo ? fmtTime(frameTs(frameIdx, videoInfo.duration_secs)) : "—"} / {fmtDur}
            </span>
          </div>
        </div>
      </div>

      {/* Settings */}
      <div className="settings-row">
        <QualitySettings
          quality={quality} resolution={resolution} format={format}
          audio={audio} fps={fps} useAv1={useAv1}
          gpuEncoder={gpuEncoder} gpuOptions={gpuOptions} theme={theme}
          onQuality={setQuality} onRes={setResolution} onFmt={setFormat}
          onAudio={setAudio} onFps={setFps} onAv1={setUseAv1}
          onGpuEncoder={setGpuEncoder}
        />
        <div className="settings-divider" />
      </div>

      {/* Bottom bar */}
      <div className="bottom-bar">
        <div className="est-inline">
          <span className="est-val">{fmtMb(estFinalMb)}</span>
          <span className="est-diff">{estDiff >= 0 ? `+${fmtMb(estDiff)}` : `−${fmtMb(-estDiff)}`}</span>
        </div>
        <button className="preset-btn" title="Trim or adjust audio tracks" onClick={() => setShowEditor(true)}>
          <EditIcon /> Edit clip
        </button>
        <button className="preset-btn" title="Encode to 10 MB for Discord" onClick={handleDiscordEncode}>
          <DiscordIcon /><span>Discord Ready</span>
          <span className="preset-size">10 MB</span>
        </button>
        <button className="btn-encode" onClick={handleEncode}>
          <span className="btn-inner">Encode</span>
        </button>
      </div>

      {/* Progress overlay */}
      {screen === "loading" && (
        <div className="progress-overlay">
          <div className="progress-card">
            <div className="progress-title">Encoding…</div>
            {progressPassLabel && <div className="progress-pass">{progressPassLabel}</div>}
            <div className="progress-bar-wrap">
              <div className="progress-bar-bg">
                <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
              </div>
              <div className="progress-numbers">
                <span>{fmtEta(eta)} remaining</span>
                <span className="progress-pct">{Math.round(progress)}%</span>
              </div>
            </div>
            <button className="progress-cancel-btn" onClick={() => invoke("cancel_encode")}>
              <CancelIcon /> Cancel
            </button>
          </div>
        </div>
      )}

      {/* Clip editor overlay */}
      {showEditor && (
        <VideoEditor
          videoPath={videoPath}
          initialEdits={edits}
          onConfirm={newEdits => { setEdits(newEdits); setShowEditor(false); }}
          onCancel={() => setShowEditor(false)}
        />
      )}

      {/* Fullscreen preview */}
      {fullscreenImg && (
        <div className="fullscreen-overlay" onClick={() => setFullscreenImg(null)}>
          <div className="fullscreen-label">{fullscreenImg.label}</div>
          <button className="fullscreen-close" onClick={() => setFullscreenImg(null)} aria-label="Close fullscreen">✕</button>
          <img
            src={fullscreenImg.src}
            alt={fullscreenImg.label}
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
