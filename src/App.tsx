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
  id:               string;
  label:            string;
  supported_codecs: string[];
}

/** Payload emitted by the Rust backend for the open-file event */
interface OpenFilePayload {
  path:   string;
  preset: string | null;
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

// ─────────────────────────────────────────────────────────
// ENCODER INFO DATA
// ─────────────────────────────────────────────────────────
interface EncoderInfo {
  name:    string;
  tagline: string;
  pros:    string[];
  cons:    string[];
  bestFor: string;
}
const ENCODER_INFO: Record<string, EncoderInfo> = {
  h264: {
    name:    "H.264 (AVC)",
    tagline: "The universal standard — works everywhere.",
    pros: [
      "Plays on literally every device, TV, phone, browser and platform",
      "Fastest to encode — great for quick exports",
      "Hardware acceleration available on virtually all GPUs",
      "Smallest compatibility risk — if in doubt, use this",
    ],
    cons: [
      "Larger file sizes compared to H.265 and AV1 at the same quality",
      "Older technology — not as efficient with high-res video (4K+)",
    ],
    bestFor: "Sharing clips, Discord, social media, anything that needs to play anywhere without issues.",
  },
  h265: {
    name:    "H.265 (HEVC)",
    tagline: "Half the size of H.264 at the same quality.",
    pros: [
      "~40–50% smaller files than H.264 at equivalent quality",
      "Excellent for 4K and high-resolution video",
      "Wide GPU hardware acceleration support (NVENC, AMF, VideoToolbox)",
      "Supported on most modern devices made after ~2016",
    ],
    cons: [
      "Slower to encode on CPU compared to H.264",
      "Some older browsers (Firefox) and devices may not play it natively",
      "Slightly less universal than H.264",
    ],
    bestFor: "Archiving footage, high-quality exports, saving storage space while keeping great visuals.",
  },
  av1: {
    name:    "AV1",
    tagline: "The future of compression — tiny files, stunning quality.",
    pros: [
      "Best compression of the three — smaller files than H.265 at the same quality",
      "Royalty-free and open standard (used by YouTube, Netflix, Discord)",
      "Excellent quality at very low bitrates",
    ],
    cons: [
      "Very slow to encode on CPU — can be 10–20× slower than H.264",
      "GPU hardware support is newer; older cards (pre-2022) may fall back to CPU",
      "Some devices and players still don't support it natively",
    ],
    bestFor: "Web streaming, archiving at maximum efficiency, or when you have time to spare and want the smallest possible file.",
  },
};

const ENCODER_ORDER = ["h264", "h265", "av1"] as const;

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
function discordBr(dur: number, activeAudioTracks = 1) {
  const totalAudioKbps = DISCORD_AUDIO * activeAudioTracks;
  return Math.max(Math.floor((DISCORD_TARGET * 8 * 1024) / dur) - totalAudioKbps, 80);
}
function frameTs(i: number, duration: number) {
  return duration * (i + 0.5) / FRAME_COUNT;
}
function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }
function isVideo(p: string) {
  return VIDEO_EXTS.has((p.split(".").pop() ?? "").toLowerCase());
}

function gpuShortLabel(codec: string, gpuEncoder: string): string {
  const codecLabel = codec === "av1" ? "AV1" : codec === "h265" ? "H.265" : "H.264";
  switch (gpuEncoder) {
    case "nvenc":         return `${codecLabel}·NVENC`;
    case "qsv":          return `${codecLabel}·QSV`;
    case "amf":          return codec === "av1" ? "HEVC·AMF" : `${codecLabel}·AMF`;
    case "videotoolbox": return codec === "av1" ? "HEVC·VT"  : `${codecLabel}·VT`;
    default:             return codec !== "h264" ? `${codecLabel}·CPU` : "";
  }
}

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

const EditIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);

const InfoIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="16" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12.01" y2="8" />
  </svg>
);

type Screen = "drop" | "loading" | "editor" | "batch" | "done" | "batch-done" | "direct-encode";

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

// ── Encoder Info Modal ──
interface EncoderInfoModalProps {
  onClose: () => void;
}
function EncoderInfoModal({ onClose }: EncoderInfoModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="enc-info-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Encoder information">
      <div className="enc-info-modal" onClick={e => e.stopPropagation()}>
        <div className="enc-info-modal-header">
          <span className="enc-info-modal-title">Encoder Guide</span>
          <button className="enc-info-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="enc-info-list-scroll">
          {ENCODER_ORDER.map((key, idx) => {
            const info = ENCODER_INFO[key];
            return (
              <div key={key}>
                {idx > 0 && <div className="enc-info-divider" />}
                <div className="enc-info-card">
                  <div className="enc-info-card-header">
                    <div>
                      <div className="enc-info-name">{info.name}</div>
                      <div className="enc-info-tagline">{info.tagline}</div>
                    </div>
                  </div>
                  <div className="enc-info-section">
                    <div className="enc-info-section-title enc-info-pro">✓ Strengths</div>
                    <ul className="enc-info-items">
                      {info.pros.map((p, i) => <li key={i}>{p}</li>)}
                    </ul>
                  </div>
                  <div className="enc-info-section">
                    <div className="enc-info-section-title enc-info-con">✕ Limitations</div>
                    <ul className="enc-info-items">
                      {info.cons.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  </div>
                  <div className="enc-info-best">
                    <span className="enc-info-best-label">Best for</span>
                    <span>{info.bestFor}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface AccelOption { id: string; label: string; }

interface QualitySettingsProps {
  quality:           number;
  resolution:        string;
  format:            string;
  audio:             number;
  fps:               string;
  codec:             string;
  gpuEncoder:        string;
  accelOptions:      AccelOption[];
  theme:             "light" | "dark";
  onQuality:         (v: number) => void;
  onRes:             (v: string) => void;
  onFmt:             (v: string) => void;
  onAudio:           (v: number) => void;
  onFps:             (v: string) => void;
  onCodec:           (v: string) => void;
  onGpuEncoder:      (v: string) => void;
  onOpenEncoderInfo: () => void;
}
function QualitySettings({
  quality, resolution, format, audio, fps, codec, gpuEncoder, accelOptions, theme,
  onQuality, onRes, onFmt, onAudio, onFps, onCodec, onGpuEncoder, onOpenEncoderInfo,
}: QualitySettingsProps) {
  const ql    = qualityInfo(quality);
  const isDark = theme === "dark";
  const bg = (val: number, min: number, max: number) =>
    sliderBg(val, min, max, isDark ? "#888888" : "#555555", isDark ? "#333336" : "#d0d0d0");

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
        <div className="range-labels"><span>Smallest</span><span>Best</span></div>
      </div>
      <div className="settings-divider" />
      <div className="options-col">
        <div className="options-grid">
          <div className="setting"><label>Resolution</label>
            <select value={resolution} onChange={e => onRes(e.target.value)}>
              <option value="original">Original</option>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
            </select>
          </div>
          <div className="setting"><label>Format</label>
            <select value={format} onChange={e => onFmt(e.target.value)}>
              <option value="mp4">MP4</option>
              <option value="mkv">MKV</option>
              <option value="webm">WebM</option>
            </select>
          </div>
          <div className="setting"><label>Audio</label>
            <select value={audio} onChange={e => onAudio(Number(e.target.value))}>
              <option value={64}>64 kbps</option>
              <option value={128}>128 kbps</option>
              <option value={192}>192 kbps</option>
              <option value={256}>256 kbps</option>
            </select>
          </div>
          <div className="setting"><label>FPS</label>
            <select value={fps} onChange={e => onFps(e.target.value)}>
              <option value="original">Original</option>
              <option value="60">60 fps</option>
              <option value="30">30 fps</option>
              <option value="24">24 fps</option>
            </select>
          </div>
          <div className="setting">
            <div className="setting-label-row">
              <span>Encoder</span>
              <button
                className="enc-info-btn"
                onClick={e => { e.preventDefault(); e.stopPropagation(); onOpenEncoderInfo(); }}
                title="Learn about encoders"
                aria-label="Encoder information"
              >
                <InfoIcon />
              </button>
            </div>
            <select value={codec} onChange={e => onCodec(e.target.value)}>
              <option value="h264">H.264</option>
              <option value="h265">H.265 (HEVC)</option>
              <option value="av1">AV1</option>
            </select>
          </div>
          <div className="setting"><label>Hardware Accel</label>
            <select
              value={gpuEncoder}
              onChange={e => onGpuEncoder(e.target.value)}
              title="GPU acceleration backend."
            >
              {accelOptions.map(o => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </>
  );
}

const CancelIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// ─────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────
export default function App() {
  const initTheme = (): "light" | "dark" => {
    try { return (localStorage.getItem("qe_theme") as "light" | "dark") ?? "light"; }
    catch { return "light"; }
  };
  const [theme, setThemeState] = useState<"light" | "dark">(initTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("qe_theme", theme); } catch {}
  }, [theme]);
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); }, []);

  const toggleTheme = (e: React.MouseEvent) => {
    e.stopPropagation();
    setThemeState(t => t === "light" ? "dark" : "light");
  };

  const [screen, setScreen]         = useState<Screen>("drop");
  const [filePath, setFilePath]     = useState("");
  const [info, setInfo]             = useState<VideoInfo | null>(null);
  const [dragOver, setDragOver]     = useState(false);
  const [origFrames, setOrigFrames] = useState<string[]>([]);
  const [encFrames, setEncFrames]   = useState<Record<number, string>>({});
  const [encLoading, setEncLoading] = useState(false);
  const [frameIdx, setFrameIdx]     = useState(0);
  const [resolution, setRes]        = useState("original");
  const [format, setFmt]            = useState("mp4");
  const [quality, setQuality]       = useState(75);
  const [audio, setAudio]           = useState(128);
  const [fps, setFps]               = useState("original");
  const [codec, setCodec]           = useState<string>("h264");
  const [gpuEncoder, setGpuEncoder] = useState("cpu");
  const [accelOptions, setAccelOptions] = useState<AccelOption[]>([{ id: "cpu", label: "Software (CPU)" }]);
  const [gpuOptions, setGpuOptions] = useState<GpuEncoderInfo[]>([]);
  const [encoding, setEncoding]     = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress]     = useState<EncodeProgress | null>(null);
  const [fsImage, setFsImage]       = useState<{src: string; label: string} | null>(null);
  const [status, setStatus]         = useState("");
  const [doneResult, setDoneResult] = useState<DoneResult | null>(null);

  const [encoderInfoOpen, setEncoderInfoOpen] = useState(false);

  const [showEditor, setShowEditor] = useState(false);
  const [videoEdits, setVideoEdits] = useState<VideoEdits | null>(null);

  const [batchFiles, setBatchFiles]           = useState<BatchFile[]>([]);
  const [batchProgress, setBatchProgress]     = useState<{idx: number; enc: EncodeProgress; currentFile: string} | null>(null);
  const [batchRunning, setBatchRunning]       = useState(false);
  const [batchDoneResult, setBatchDoneResult] = useState<BatchDoneResult | null>(null);

  const [editingBatchIdx, setEditingBatchIdx] = useState<number>(-1);
  const [batchEditInfo, setBatchEditInfo]     = useState<VideoInfo | null>(null);

  // State for the direct-encode screen (context menu Discord Ready shortcut)
  const [directFile, setDirectFile]         = useState("");
  const [directPreset, setDirectPreset]     = useState("");
  const [directStatus, setDirectStatus]     = useState<"idle" | "probing" | "saving" | "encoding" | "done" | "error">("idle");
  const [directError, setDirectError]       = useState("");

  const encDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (encDebounce.current) clearTimeout(encDebounce.current);
    };
  }, []);

  // Probe available GPU encoders on mount
  useEffect(() => {
    invoke<GpuEncoderInfo[]>("probe_gpu_encoders")
      .then(detected => {
        if (!mountedRef.current) return;
        setGpuOptions(detected);
      })
      .catch(() => {});
  }, []);

  // Recompute accel options whenever codec or detected GPUs change
  useEffect(() => {
    const gpuOpts: AccelOption[] = [];
    for (const gpu of gpuOptions) {
      if (gpu.supported_codecs.includes(codec)) {
        gpuOpts.push({ id: gpu.id, label: gpu.label });
      } else if (codec === "av1" && (gpu.id === "amf" || gpu.id === "videotoolbox")) {
        gpuOpts.push({ id: gpu.id, label: `${gpu.label} (HEVC fallback)` });
      }
    }
    if (gpuOpts.length > 0) {
      gpuOpts[0] = { ...gpuOpts[0], label: `${gpuOpts[0].label} · Recommended` };
    }
    const opts: AccelOption[] = [...gpuOpts, { id: "cpu", label: "Software (CPU)" }];
    setAccelOptions(opts);
    setGpuEncoder(prev => {
      if (prev === "cpu") return "cpu";
      const stillValid = opts.some(o => o.id === prev && o.id !== "cpu");
      return stillValid ? prev : "cpu";
    });
  }, [codec, gpuOptions]);

  const base    = resolution === "original" ? (info?.bitrate_kbps ?? 5000) : RES_BITRATES[resolution];
  const videoBr = Math.max(Math.round(base * (quality / 100)), 80);
  const trimRatio = (info && videoEdits)
    ? (videoEdits.trimEnd - videoEdits.trimStart) / info.duration_secs
    : 1;
  const estMb   = info ? ((videoBr + audio) * info.duration_secs) / 8 / 1024 * trimRatio : 0;
  const estLow  = estMb * 0.85;
  const estHigh = estMb * 1.15;
  const reduction = info ? Math.round((1 - estMb / (info.size_mb * trimRatio + 0.001)) * 100) : 0;

  const loadEncodedFrame = useCallback((
    idx: number, vbr: number, res: string, f: string, codecArg: string, gpu: string
  ) => {
    if (!filePath || !info) return;
    if (encDebounce.current) clearTimeout(encDebounce.current);
    setEncLoading(true);
    encDebounce.current = setTimeout(async () => {
      const ts = frameTs(idx, info.duration_secs);
      try {
        const result = await invoke<string>("get_encoded_frame", {
          input: filePath, timestamp: ts, resolution: res,
          videoBitrateKbps: vbr, fps: f, codec: codecArg, gpuEncoder: gpu,
        });
        if (mountedRef.current) setEncFrames(prev => ({ ...prev, [idx]: result }));
      } catch (e) {
        if (mountedRef.current) setStatus(`Preview failed: ${e}`);
      } finally {
        if (mountedRef.current) setEncLoading(false);
      }
    }, 600);
  }, [filePath, info]);

  useEffect(() => {
    if (screen !== "editor" || !info) return;
    setEncFrames({});
    loadEncodedFrame(frameIdx, videoBr, resolution, fps, codec, gpuEncoder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoBr, resolution, fps, codec, gpuEncoder, screen]);

  useEffect(() => {
    if (screen !== "editor" || !info) return;
    if (!encFrames[frameIdx]) loadEncodedFrame(frameIdx, videoBr, resolution, fps, codec, gpuEncoder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameIdx]);

  const loadFile = useCallback(async (path: string) => {
    setScreen("loading");
    setFilePath(path);
    setOrigFrames([]);
    setEncFrames({});
    setFrameIdx(0);
    setStatus("");
    setDoneResult(null);
    setVideoEdits(null);
    try {
      const [videoInfo, frames] = await Promise.all([
        invoke<VideoInfo>("get_video_info", { input: path }),
        invoke<string[]>("get_video_frames", { input: path, count: FRAME_COUNT }),
      ]);
      setInfo(videoInfo);
      setOrigFrames(frames);
      setScreen("editor");
      const b = resolution === "original" ? videoInfo.bitrate_kbps : (RES_BITRATES[resolution] ?? videoInfo.bitrate_kbps);
      const vbr = Math.max(Math.round(b * (quality / 100)), 80);
      loadEncodedFrame(0, vbr, resolution, fps, codec, gpuEncoder);
    } catch (e) {
      setStatus(`❌ ${e}`);
      setScreen("drop");
    }
  }, [resolution, quality, fps, codec, gpuEncoder, loadEncodedFrame]);

  // ── Direct-encode: runs immediately for context-menu Discord presets ──────
  // Skips frame extraction entirely. Flow: probe info → save dialog → encode.
  const runDirectEncode = useCallback(async (path: string, preset: string) => {
    setDirectFile(path);
    setDirectPreset(preset);
    setScreen("direct-encode");
    setDirectStatus("probing");
    setDirectError("");
    setProgress(null);
    setDoneResult(null);

    let videoInfo: VideoInfo;
    try {
      videoInfo = await invoke<VideoInfo>("get_video_info", { input: path });
    } catch (e) {
      setDirectStatus("error");
      setDirectError(`Could not read file: ${e}`);
      return;
    }

    const discordCodec = preset === "discord-av1" ? "av1" : "h264";
    const activeTracks = Math.max(videoInfo.audio_tracks?.length ?? 1, 1);
    const vbr = discordBr(videoInfo.duration_secs, activeTracks);
    const totalAudioKbps = DISCORD_AUDIO * activeTracks;
    const defaultName = basename(path).replace(/\.[^.]+$/, "") + "_discord.mp4";

    setDirectStatus("saving");
    let out: string | null = null;
    try {
      out = await save({ defaultPath: defaultName, filters: [{ name: "MP4", extensions: ["mp4"] }] }) as string | null;
    } catch {
      out = null;
    }

    if (!out) {
      // User cancelled the save dialog — go back to drop screen
      setScreen("drop");
      return;
    }

    setDirectStatus("encoding");
    setEncoding(true);
    setCancelling(false);
    setProgress({ percent: 0, eta_secs: 0, pass: 1 });

    try {
      await invoke("encode_video_with_progress", {
        input:            path,
        output:           out,
        resolution:       "original",
        videoBitrateKbps: vbr,
        audioBitrateKbps: totalAudioKbps,
        fps:              "original",
        durationSecs:     videoInfo.duration_secs,
        trimStart:        null,
        trimEnd:          null,
        deletedTracks:    [],
        volumeMap:        {},
        totalAudioTracks: videoInfo.audio_tracks?.length ?? 1,
        mergeAudioTracks: false,
        codec:            discordCodec,
        gpuEncoder:       "cpu",
      });
      let finalMb = 0;
      try { finalMb = await invoke<number>("get_file_size_mb", { path: out }); } catch {}
      setDoneResult({ outputPath: out, originalMb: videoInfo.size_mb, finalMb });
      setDirectStatus("done");
      setScreen("done");
    } catch (e) {
      const msg = String(e);
      if (msg === "cancelled") {
        setScreen("drop");
      } else {
        setDirectStatus("error");
        setDirectError(msg);
      }
    } finally {
      setEncoding(false);
      setCancelling(false);
      setProgress(null);
    }
  }, []);

  const resolveDroppedPaths = useCallback(async (paths: string[]): Promise<string[]> => {
    const videos: string[] = [];
    for (const p of paths) {
      if (isVideo(p)) {
        videos.push(p);
      } else {
        try {
          const found = await invoke<string[]>("scan_folder_for_videos", { folder: p });
          videos.push(...found);
        } catch { /* skip */ }
      }
    }
    return videos;
  }, []);

  useEffect(() => {
    let off: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent(async (ev) => {
      const t = ev.payload.type;
      if (t === "over")  setDragOver(true);
      if (t === "leave") setDragOver(false);
      if (t === "drop") {
        setDragOver(false);
        const dropPayload = ev.payload as { type: "drop"; paths: string[] };
        const raw = dropPayload.paths;
        if (!raw?.length) return;
        const resolved = await resolveDroppedPaths(raw);
        if (!resolved.length) {
          setStatus("No video files found in dropped items.");
          return;
        }
        if (resolved.length === 1) {
          loadFile(resolved[0]);
        } else {
          setBatchFiles(resolved.map(p => ({ path: p, status: "pending", edits: null })));
          setScreen("batch");
        }
      }
    }).then(fn => { off = fn; });
    return () => off?.();
  }, [loadFile, resolveDroppedPaths]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<EncodeProgress>("encode-progress", (ev) => {
      setProgress(ev.payload);
    }).then(fn => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  // ── Stable open-file listener — never torn down, uses refs for callbacks ──
  // Using refs avoids the race condition where the listener is re-registered
  // mid-flight (while the 800ms backend delay is counting down) every time
  // loadFile changes due to codec/quality/etc. state updates.
  const loadFileRef        = useRef(loadFile);
  const runDirectEncodeRef = useRef(runDirectEncode);
  useEffect(() => { loadFileRef.current        = loadFile;        }, [loadFile]);
  useEffect(() => { runDirectEncodeRef.current = runDirectEncode; }, [runDirectEncode]);

  useEffect(() => {
    // Mounted once, never torn down — always calls the latest version via ref.
    let unlisten: (() => void) | undefined;
    listen<OpenFilePayload>("open-file", (ev) => {
      const { path, preset } = ev.payload;
      if (!path) return;
      if (preset === "discord" || preset === "discord-av1") {
        runDirectEncodeRef.current(path, preset);
      } else {
        loadFileRef.current(path);
      }
    }).then(fn => { unlisten = fn; });
    return () => unlisten?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // empty deps — intentionally stable

  const pickFiles = async () => {
    const result = await open({
      multiple: true,
      filters: [{ name: "Video", extensions: ["mp4","mkv","avi","mov","webm","m4v","wmv","flv","ts","mts"] }],
    }) as string[] | string | null;
    if (!result) return;
    const paths = Array.isArray(result) ? result : [result];
    if (paths.length === 0) return;
    if (paths.length === 1) { loadFile(paths[0]); return; }
    setBatchFiles(paths.map(p => ({ path: p, status: "pending" as const, edits: null })));
    setScreen("batch");
  };

  const goFrame = (delta: number) =>
    setFrameIdx(i => Math.max(0, Math.min(FRAME_COUNT - 1, i + delta)));

  const runEncode = async (
    vbr: number, abr: number, res: string, f: string,
    outPath?: string, codecOverride?: string, gpuOverride?: string
  ) => {
    if (!filePath || !info) return;
    const out = outPath ?? await save({ filters: [{ name: "Output", extensions: [format] }] });
    if (!out) return;
    const encodeCodec = codecOverride ?? codec;
    const encodeWithGpu = gpuOverride ?? gpuEncoder;
    setEncoding(true);
    setCancelling(false);
    setProgress({ percent: 0, eta_secs: 0, pass: 1 });
    try {
      const trimStartArg = (videoEdits && videoEdits.trimStart > 0)                ? videoEdits.trimStart : null;
      const trimEndArg   = (videoEdits && videoEdits.trimEnd < info.duration_secs) ? videoEdits.trimEnd   : null;
      const deletedTracks  = videoEdits?.audioTracks.filter(t => t.deleted).map(t => t.index) ?? [];
      const volumeMap      = videoEdits?.audioTracks
        .filter(t => !t.deleted && t.volume !== 100)
        .reduce<Record<number, number>>((acc, t) => { acc[t.index] = t.volume; return acc; }, {}) ?? {};
      const totalAudioTracks  = info.audio_tracks?.length ?? 1;
      const mergeAudioTracks  = videoEdits?.mergeAudioTracks ?? false;

      await invoke("encode_video_with_progress", {
        input:            filePath,
        output:           out,
        resolution:       res,
        videoBitrateKbps: vbr,
        audioBitrateKbps: abr,
        fps:              f,
        durationSecs:     videoEdits ? (videoEdits.trimEnd - videoEdits.trimStart) : info.duration_secs,
        trimStart:        trimStartArg,
        trimEnd:          trimEndArg,
        deletedTracks,
        volumeMap,
        totalAudioTracks,
        mergeAudioTracks,
        codec:            encodeCodec,
        gpuEncoder:       encodeWithGpu,
      });
      let finalMb = estMb;
      try { finalMb = await invoke<number>("get_file_size_mb", { path: out }); } catch {}
      setDoneResult({ outputPath: out, originalMb: info.size_mb, finalMb });
      setScreen("done");
    } catch (e) {
      const msg = String(e);
      if (msg !== "cancelled") setStatus(`❌ ${msg}`);
    } finally {
      setEncoding(false);
      setCancelling(false);
      setProgress(null);
    }
  };

  const handleEncode  = () => runEncode(videoBr, audio, resolution, fps);
  const handleDiscord = async () => {
    if (!info) return;
    const effectiveDuration = videoEdits
      ? videoEdits.trimEnd - videoEdits.trimStart
      : info.duration_secs;
    const totalTracks   = info.audio_tracks?.length ?? 1;
    const deletedCount  = videoEdits?.audioTracks.filter(t => t.deleted).length ?? 0;
    const activeTracks  = Math.max(totalTracks - deletedCount, 1);
    const vbr = discordBr(effectiveDuration, activeTracks);
    const totalAudioKbps = DISCORD_AUDIO * activeTracks;
    const defaultName = basename(filePath).replace(/\.[^.]+$/, "") + "_discord.mp4";
    const out = await save({ defaultPath: defaultName, filters: [{ name: "MP4", extensions: ["mp4"] }] });
    if (!out) return;
    runEncode(vbr, totalAudioKbps, resolution, fps, out, codec, gpuEncoder);
  };

  const handleCancelEncode = async () => {
    setCancelling(true);
    try { await invoke("cancel_encode"); } catch {}
  };

  const openBatchClipEditor = async (idx: number) => {
    const file = batchFiles[idx];
    if (!file) return;
    try {
      const clipInfo = await invoke<VideoInfo>("get_video_info", { input: file.path });
      setBatchEditInfo(clipInfo);
      setEditingBatchIdx(idx);
    } catch (e) {
      setStatus(`❌ Could not load clip info: ${e}`);
    }
  };

  const saveBatchClipEdits = (edits: VideoEdits) => {
    setBatchFiles(prev =>
      prev.map((f, i) => i === editingBatchIdx ? { ...f, edits } : f)
    );
    setEditingBatchIdx(-1);
    setBatchEditInfo(null);
  };

  const cancelBatchClipEditor = () => {
    setEditingBatchIdx(-1);
    setBatchEditInfo(null);
  };

  const runBatch = async (outputDir: string, discordMode: boolean) => {
    setBatchRunning(true);
    setProgress({ percent: 0, eta_secs: 0, pass: 1 });
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < batchFiles.length; i++) {
      const file = batchFiles[i];
      setBatchFiles(prev => prev.map((f, idx) => idx === i ? { ...f, status: "active" } : f));
      setBatchProgress({ idx: i, enc: { percent: 0, eta_secs: 0, pass: 1 }, currentFile: basename(file.path) });
      setProgress({ percent: 0, eta_secs: 0, pass: 1 });
      const inName  = basename(file.path).replace(/\.[^.]+$/, "");
      const suffix  = discordMode ? "_discord" : "_encoded";
      const outFile = `${outputDir}/${inName}${suffix}.mp4`;
      try {
        const infoRaw = await invoke<VideoInfo>("get_video_info", { input: file.path });
        const clipEdits = file.edits;
        let vbr: number, abr: number, res: string, f: string;
        if (discordMode) {
          const effectiveDur  = clipEdits ? clipEdits.trimEnd - clipEdits.trimStart : infoRaw.duration_secs;
          const totalTracks   = infoRaw.audio_tracks?.length ?? 1;
          const deletedCount  = clipEdits?.audioTracks.filter(t => t.deleted).length ?? 0;
          const activeTracks  = Math.max(totalTracks - deletedCount, 1);
          vbr = discordBr(effectiveDur, activeTracks);
          abr = DISCORD_AUDIO * activeTracks;
          res = resolution;
          f = fps;
        } else {
          const b = resolution === "original" ? infoRaw.bitrate_kbps : (RES_BITRATES[resolution] ?? infoRaw.bitrate_kbps);
          vbr = Math.max(Math.round(b * (quality / 100)), 80); abr = audio; res = resolution; f = fps;
        }
        const trimStartArg      = clipEdits && clipEdits.trimStart > 0                  ? clipEdits.trimStart : null;
        const trimEndArg        = clipEdits && clipEdits.trimEnd < infoRaw.duration_secs ? clipEdits.trimEnd   : null;
        const deletedTracks     = clipEdits?.audioTracks.filter(t => t.deleted).map(t => t.index) ?? [];
        const volumeMap         = clipEdits?.audioTracks
          .filter(t => !t.deleted && t.volume !== 100)
          .reduce<Record<number, number>>((acc, t) => { acc[t.index] = t.volume; return acc; }, {}) ?? {};
        const durationSecs      = clipEdits ? (clipEdits.trimEnd - clipEdits.trimStart) : infoRaw.duration_secs;
        const mergeAudioTracks  = clipEdits?.mergeAudioTracks ?? false;

        await invoke("encode_video_with_progress", {
          input: file.path, output: outFile,
          resolution: res, videoBitrateKbps: vbr,
          audioBitrateKbps: abr, fps: f,
          durationSecs, trimStart: trimStartArg, trimEnd: trimEndArg,
          deletedTracks, volumeMap,
          totalAudioTracks: infoRaw.audio_tracks?.length ?? 1,
          mergeAudioTracks, codec, gpuEncoder,
        });
        setBatchFiles(prev => prev.map((bf, idx) => idx === i ? { ...bf, status: "done" } : bf));
        succeeded++;
      } catch (e) {
        const msg = String(e);
        if (msg === "cancelled") {
          setBatchFiles(prev => prev.map((bf, idx) => idx === i ? { ...bf, status: "error", msg: "Cancelled" } : bf));
          setBatchRunning(false); setBatchProgress(null); setCancelling(false); setProgress(null);
          return;
        }
        setBatchFiles(prev => prev.map((bf, idx) => idx === i ? { ...bf, status: "error", msg: String(e) } : bf));
        failed++;
      }
    }
    setBatchRunning(false); setBatchProgress(null); setProgress(null);
    setBatchDoneResult({ total: batchFiles.length, succeeded, failed, outputDir });
    setScreen("batch-done");
  };

  const startBatch = async (discordMode = false) => {
    const dir = await open({ directory: true, multiple: false }) as string | null;
    if (!dir) return;
    runBatch(dir, discordMode);
  };

  const removeBatchFile = (idx: number) =>
    setBatchFiles(prev => prev.filter((_, i) => i !== idx));

  const addMoreFiles = async () => {
    const result = await open({
      multiple: true,
      filters: [{ name: "Video", extensions: ["mp4","mkv","avi","mov","webm","m4v","wmv","flv","ts","mts"] }],
    }) as string[] | null;
    if (!result?.length) return;
    setBatchFiles(prev => [...prev, ...result.map(p => ({ path: p, status: "pending" as const, edits: null }))]);
  };

  const reset = () => {
    setScreen("drop"); setFilePath(""); setInfo(null);
    setOrigFrames([]); setEncFrames({}); setFrameIdx(0);
    setStatus(""); setProgress(null); setEncoding(false); setCancelling(false);
    setBatchFiles([]); setBatchRunning(false); setBatchProgress(null);
    setDoneResult(null); setBatchDoneResult(null);
    setVideoEdits(null); setShowEditor(false);
    setEditingBatchIdx(-1); setBatchEditInfo(null);
    setDirectFile(""); setDirectPreset(""); setDirectStatus("idle"); setDirectError("");
  };

  const currentOrig = origFrames[frameIdx];
  const currentEnc  = encFrames[frameIdx];
  const previewAspect = info ? info.width / info.height : 16 / 9;

  const editsBadge = videoEdits
    ? (() => {
        const parts: string[] = [];
        if (videoEdits.trimStart > 0 || (info && videoEdits.trimEnd < info.duration_secs))
          parts.push(fmtTime(videoEdits.trimEnd - videoEdits.trimStart));
        const del = videoEdits.audioTracks.filter(t => t.deleted).length;
        if (del) parts.push(`−${del} audio`);
        const activeTracks = videoEdits.audioTracks.filter(t => !t.deleted).length;
        if (videoEdits.mergeAudioTracks && activeTracks > 1) parts.push("merged");
        return parts.join(" · ");
      })()
    : null;

  const passLabel = (() => {
    if (!progress) return "";
    if (progress.percent >= 100) return "Finalizing";
    const isGpu    = gpuEncoder !== "cpu";
    const gpuLabel = gpuOptions.find(g => g.id === gpuEncoder)?.label ?? gpuEncoder.toUpperCase();
    const codecLabel = codec === "av1" ? "AV1" : codec === "h265" ? "H.265" : "H.264";
    if (codec === "av1") {
      const enc = isGpu ? `${gpuLabel} (HEVC fallback)` : "CPU · SVT-AV1";
      return `Pass 1 / 1 — ${enc}`;
    }
    if (isGpu) return `Pass 1 / 1 — ${gpuLabel} · ${codecLabel}`;
    if (progress.pass === 1) return "Pass 1 / 2 — Analyzing";
    return "Pass 2 / 2 — Encoding";
  })();

  const previewTagExtra = gpuShortLabel(codec, gpuEncoder);
  const gpuSelected = gpuEncoder !== "cpu";

  return (
    <div className="app">

      {/* ── ENCODER INFO MODAL ── */}
      {encoderInfoOpen && (
        <EncoderInfoModal onClose={() => setEncoderInfoOpen(false)} />
      )}

      {/* ── BATCH PER-CLIP EDITOR OVERLAY ── */}
      {editingBatchIdx >= 0 && batchEditInfo && (() => {
        const clipFile = batchFiles[editingBatchIdx];
        return (
          <VideoEditor
            filePath={clipFile.path}
            info={batchEditInfo}
            theme={theme}
            initialEdits={clipFile.edits}
            onConfirm={saveBatchClipEdits}
            onCancel={cancelBatchClipEditor}
          />
        );
      })()}

      {/* ── VIDEO EDITOR OVERLAY (single-clip) ── */}
      {showEditor && filePath && info && (
        <VideoEditor
          filePath={filePath}
          info={info}
          theme={theme}
          initialEdits={videoEdits}
          onConfirm={(edits) => { setVideoEdits(edits); setShowEditor(false); }}
          onCancel={() => setShowEditor(false)}
        />
      )}

      {/* ── DROP ── */}
      {screen === "drop" && (
        <div className={`drop-screen${dragOver ? " drag-over" : ""}`} onClick={pickFiles}>
          <div className="drop-theme-btn"><ThemeBtn theme={theme} onToggle={toggleTheme} /></div>
          <div className="drop-wordmark">
            <QELogo size={36} />
            <h1>quick encode<em>.</em></h1>
            <small>video compressor</small>
          </div>
          <div className="drop-hint-text">
            <p>{dragOver ? "Drop to load" : "Drop files or folders here"}</p>
            <small>MP4 · MKV · AVI · MOV · WebM · M4V · select multiple for batch</small>
          </div>
          <div className="drop-actions">
            <button className="drop-browse" onClick={e => { e.stopPropagation(); pickFiles(); }}>Browse files</button>
          </div>
          {status && <div className="status-bar">{status}</div>}
        </div>
      )}

      {/* ── LOADING ── */}
      {screen === "loading" && (
        <div className="loading-screen">
          <div className="loading-content">
            <div className="loading-wordmark">
              <QELogo size={18} />
              <span>quick encode<em>.</em></span>
            </div>
            <div className="loading-bar-wrap">
              <div className="loading-bar-bg"><div className="loading-bar-fill" /></div>
              <div className="loading-label">Reading file &amp; extracting frames&hellip;</div>
            </div>
          </div>
        </div>
      )}

      {/* ── DIRECT ENCODE (context menu Discord Ready shortcut) ── */}
      {screen === "direct-encode" && (
        <div className="loading-screen">
          <div className="loading-content">
            <div className="loading-wordmark">
              <QELogo size={18} />
              <span>quick encode<em>.</em></span>
            </div>
            {directStatus === "probing" && (
              <div className="loading-bar-wrap">
                <div className="loading-bar-bg"><div className="loading-bar-fill" /></div>
                <div className="loading-label">Reading file info&hellip;</div>
              </div>
            )}
            {directStatus === "saving" && (
              <div className="loading-label" style={{ marginTop: 12 }}>Choose where to save&hellip;</div>
            )}
            {directStatus === "error" && (
              <>
                <div className="loading-label" style={{ marginTop: 12, color: "var(--color-error)" }}>
                  ❌ {directError}
                </div>
                <button className="drop-browse" style={{ marginTop: 16 }} onClick={reset}>Back</button>
              </>
            )}
            {directStatus !== "error" && (
              <div className="loading-label" style={{ marginTop: 8, opacity: 0.5, fontSize: "0.75rem" }}>
                {basename(directFile)}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── DONE (single) ── */}
      {screen === "done" && doneResult && (() => {
        const { outputPath, originalMb, finalMb } = doneResult;
        const saved = Math.round((1 - finalMb / originalMb) * 100);
        const grew  = finalMb > originalMb;
        return (
          <div className="done-screen">
            <div className="done-theme-btn"><ThemeBtn theme={theme} onToggle={toggleTheme} /></div>
            <div className="done-card">
              <div className="done-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div className="done-title">Encode complete</div>
              <div className="done-stats">
                <div className="done-stat">
                  <span className="done-stat-label">Output</span>
                  <span className="done-stat-val">{fmtMb(finalMb)}</span>
                </div>
                <div className="done-stat-divider" />
                <div className="done-stat">
                  <span className="done-stat-label">Original</span>
                  <span className="done-stat-val done-stat-muted">{fmtMb(originalMb)}</span>
                </div>
                <div className="done-stat-divider" />
                <div className="done-stat">
                  <span className="done-stat-label">Saved</span>
                  <span className={`done-stat-val ${grew ? "done-stat-warn" : "done-stat-green"}`}>
                    {grew ? `+${Math.abs(saved)}%` : `-${saved}%`}
                  </span>
                </div>
              </div>
              <div className="done-filename">{basename(outputPath)}</div>
              <div className="done-actions">
                <button className="done-btn-reveal" onClick={() => invoke("show_in_folder", { path: outputPath })}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                  </svg>
                  Show in folder
                </button>
                <button className="done-btn-new" onClick={reset}>Import new file</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── BATCH DONE ── */}
      {screen === "batch-done" && batchDoneResult && (
        <div className="done-screen">
          <div className="done-theme-btn"><ThemeBtn theme={theme} onToggle={toggleTheme} /></div>
          <div className="done-card">
            <div className="done-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div className="done-title">Encode complete</div>
            <div className="done-stats">
              <div className="done-stat">
                <span className="done-stat-label">Total</span>
                <span className="done-stat-val">{batchDoneResult.total}</span>
              </div>
              <div className="done-stat-divider" />
              <div className="done-stat">
                <span className="done-stat-label">Done</span>
                <span className="done-stat-val done-stat-green">{batchDoneResult.succeeded}</span>
              </div>
              {batchDoneResult.failed > 0 && (
                <>
                  <div className="done-stat-divider" />
                  <div className="done-stat">
                    <span className="done-stat-label">Failed</span>
                    <span className="done-stat-val done-stat-warn">{batchDoneResult.failed}</span>
                  </div>
                </>
              )}
            </div>
            <div className="done-filename">{batchDoneResult.outputDir}</div>
            <div className="done-actions">
              <button className="done-btn-reveal" onClick={() => invoke("open_folder", { path: batchDoneResult.outputDir })}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                Show in folder
              </button>
              <button className="done-btn-new" onClick={reset}>Import new file</button>
            </div>
          </div>
        </div>
      )}

      {/* ── BATCH SCREEN ── */}
      {screen === "batch" && (
        <div className="batch-screen">
          <div className="batch-topbar">
            <Wordmark size="sm" />
            <div className="batch-topbar-right">
              <span className="batch-count">{batchFiles.length} file{batchFiles.length !== 1 ? "s" : ""}</span>
              <ThemeBtn theme={theme} onToggle={toggleTheme} />
              <button className="batch-add-btn batch-add-btn--sm" onClick={reset}>
                <CancelIcon />
                Clear all
              </button>
            </div>
          </div>

          <div className="batch-file-list">
            {batchFiles.map((f, i) => {
              const badge = editsBadgeForClip(f.edits, 0);
              return (
                <div key={f.path} className="batch-file-row">
                  {!batchRunning && f.status !== "active" ? (
                    <button
                      className="batch-file-edit-btn"
                      onClick={() => openBatchClipEditor(i)}
                      title="Edit this clip"
                      aria-label="Edit clip"
                    >
                      <EditIcon />
                    </button>
                  ) : (
                    <span className="batch-file-edit-spacer" aria-hidden="true" />
                  )}
                  <span className="batch-file-name" title={f.path}>{basename(f.path)}</span>
                  {badge && <span className="batch-file-edits-badge">{badge}</span>}
                  <span className={`batch-file-status ${f.status}`}>
                    {f.status === "pending" ? "Pending"
                      : f.status === "active" ? "Encoding…"
                      : f.status === "done"   ? "✓ Done"
                      : "✕ Error"}
                  </span>
                  {!batchRunning && f.status !== "active" && (
                    <button className="batch-file-remove" onClick={() => removeBatchFile(i)}>&times;</button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="batch-bottom">
            <div className="batch-settings-row settings-row">
              <QualitySettings
                quality={quality} resolution={resolution} format={format} audio={audio} fps={fps}
                codec={codec} gpuEncoder={gpuEncoder} accelOptions={accelOptions} theme={theme}
                onQuality={setQuality} onRes={setRes} onFmt={setFmt} onAudio={setAudio} onFps={setFps}
                onCodec={setCodec} onGpuEncoder={setGpuEncoder}
                onOpenEncoderInfo={() => setEncoderInfoOpen(true)}
              />
            </div>
            <div className="batch-actions">
              <button className="batch-add-btn" onClick={addMoreFiles} disabled={batchRunning}>+ Add more</button>
              <div style={{ flex: 1 }} />
              <span
                className={gpuSelected ? "preset-btn-wrapper preset-btn-wrapper--disabled" : undefined}
                title={gpuSelected ? "Unreliable with GPU encoding — switch to Software (CPU) for accurate file size targeting" : undefined}
              >
                <button
                  className="preset-btn"
                  onClick={() => startBatch(true)}
                  disabled={batchRunning || gpuSelected}
                >
                  <DiscordIcon />
                  Discord Ready
                  <span className="preset-size">≤10 MB each</span>
                </button>
              </span>
              <button className="btn-encode" onClick={() => startBatch(false)} disabled={batchRunning}>
                {batchRunning
                  ? <span className="btn-inner"><div className="spin" />Encoding…</span>
                  : `Encode All (${batchFiles.length})`}
              </button>
            </div>
            <div className="status-bar">{status}</div>
          </div>
        </div>
      )}

      {/* ── EDITOR ── */}
      {screen === "editor" && info && (
        <div className="editor">
          <div className="topbar">
            <div className="topbar-left"><Wordmark size="sm" /></div>
            <div className="topbar-right">
              <div className="file-chip" onClick={reset}>
                <span>{basename(filePath)}</span>
                <span className="file-chip-x">&times;</span>
              </div>
              <ThemeBtn theme={theme} onToggle={toggleTheme} />
              <span className="version-badge">v2.1</span>
            </div>
          </div>

          <div className="video-meta">
            {(() => {
              const d = gcd(info.width, info.height);
              const items = [
                { label: "Duration", val: fmtTime(info.duration_secs) },
                { label: "Size",     val: fmtMb(info.size_mb) },
                { label: "Res",      val: `${info.width}×${info.height}` },
                { label: "Bitrate",  val: `${(info.bitrate_kbps/1000).toFixed(1)} Mbps` },
                { label: "Aspect",   val: `${info.width/d}:${info.height/d}` },
              ];
              return items.map(({ label, val }) => (
                <div key={label} className="meta-item">
                  <span className="meta-label">{label}</span>
                  <span className="meta-val">{val}</span>
                </div>
              ));
            })()}
          </div>

          <div className="preview-section">
            <div className="preview-scaler">
              <div className="preview-grid">
                <div
                  className="preview-side"
                  style={{ aspectRatio: previewAspect }}
                  onClick={() => currentOrig && setFsImage({ src: currentOrig, label: "Original" })}
                >
                  {currentOrig ? (
                    <img src={`data:image/jpeg;base64,${currentOrig}`} alt="Original" />
                  ) : (
                    <div className="preview-loading"><div className="spin" /><span>Loading</span></div>
                  )}
                  <span className="preview-tag">Original</span>
                  {currentOrig && (
                    <button className="preview-fullscreen-btn" onClick={e => { e.stopPropagation(); setFsImage({ src: currentOrig, label: "Original" }); }}>&#x26F6;</button>
                  )}
                </div>
                <div
                  className="preview-side"
                  style={{ aspectRatio: previewAspect }}
                  onClick={() => currentEnc && !encLoading && setFsImage({ src: currentEnc, label: "Output" })}
                >
                  {encLoading ? (
                    <div className="preview-loading"><div className="spin" /><span>Rendering</span></div>
                  ) : currentEnc ? (
                    <img src={`data:image/jpeg;base64,${currentEnc}`} alt="Output" />
                  ) : (
                    <div className="preview-loading"><div className="spin" /><span>Loading</span></div>
                  )}
                  <span className="preview-tag">
                    Output
                    {previewTagExtra && <span className="preview-tag-av1">{previewTagExtra}</span>}
                  </span>
                  {currentEnc && !encLoading && (
                    <button className="preview-fullscreen-btn" onClick={e => { e.stopPropagation(); setFsImage({ src: currentEnc, label: "Output" }); }}>&#x26F6;</button>
                  )}
                </div>
              </div>
              <div className="frame-nav">
                <button className="frame-nav-btn" onClick={() => goFrame(-1)} disabled={frameIdx === 0}>‹</button>
                <div className="frame-dots">
                  {Array.from({ length: FRAME_COUNT }, (_, i) => (
                    <button key={i} className={`frame-dot${i === frameIdx ? " active" : ""}`} onClick={() => setFrameIdx(i)} />
                  ))}
                </div>
                <button className="frame-nav-btn" onClick={() => goFrame(1)} disabled={frameIdx === FRAME_COUNT - 1}>›</button>
                <span className="frame-label">{frameIdx + 1} / {FRAME_COUNT} · {fmtTime(frameTs(frameIdx, info.duration_secs))}</span>
              </div>
            </div>
          </div>

          <div className="settings-row">
            <QualitySettings
              quality={quality} resolution={resolution} format={format} audio={audio} fps={fps}
              codec={codec} gpuEncoder={gpuEncoder} accelOptions={accelOptions} theme={theme}
              onQuality={setQuality} onRes={setRes} onFmt={setFmt} onAudio={setAudio} onFps={setFps}
              onCodec={setCodec} onGpuEncoder={setGpuEncoder}
              onOpenEncoderInfo={() => setEncoderInfoOpen(true)}
            />
          </div>

          <div className="bottom-bar">
            <div className="est-inline">
              <span className="est-val">{fmtMb(estLow)} – {fmtMb(estHigh)}</span>
              {reduction !== 0 && (
                <span className="est-diff">{reduction > 0 ? `−${reduction}%` : `+${Math.abs(reduction)}%`}</span>
              )}
            </div>
            <button
              className="preset-btn"
              onClick={() => setShowEditor(true)}
              disabled={encoding}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              Edit
              {editsBadge && <span className="preset-size">{editsBadge}</span>}
            </button>
            <span
              className={gpuSelected ? "preset-btn-wrapper preset-btn-wrapper--disabled" : undefined}
              title={gpuSelected ? "Unreliable with GPU encoding — switch to Software (CPU) for accurate file size targeting" : undefined}
            >
              <button
                className="preset-btn"
                onClick={handleDiscord}
                disabled={encoding || gpuSelected}
              >
                <DiscordIcon />
                Discord Ready
                <span className="preset-size">≤10 MB</span>
              </button>
            </span>
            <button className="btn-encode" onClick={handleEncode} disabled={encoding}>
              {encoding ? <span className="btn-inner"><div className="spin" />Encoding…</span> : "Start Encode"}
            </button>
          </div>

          <div className="status-bar">{status}</div>
        </div>
      )}

      {/* ── PROGRESS OVERLAY ── */}
      {(encoding || batchRunning) && progress && (
        <div className="progress-overlay">
          <div className="progress-card">
            <div className="progress-title">
              {cancelling ? "Cancelling…" : progress.percent >= 100 ? "Done" : "Encoding…"}
            </div>
            {batchRunning && batchProgress && (
              <div className="progress-pass">
                File {batchProgress.idx + 1} / {batchFiles.length} — {batchProgress.currentFile}
              </div>
            )}
            <div className="progress-pass">{passLabel}</div>
            <div className="progress-bar-wrap">
              <div className="progress-bar-bg">
                <div
                  className={`progress-bar-fill${progress.percent >= 100 ? " done" : ""}`}
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              <div className="progress-numbers">
                <span className="progress-pct">{Math.round(progress.percent)}%</span>
                <span>
                  {cancelling
                    ? <span className="progress-done-msg">Stopping…</span>
                    : progress.percent >= 100
                      ? <span className="progress-done-msg">Complete</span>
                      : progress.eta_secs > 0
                        ? `ETA ${fmtEta(progress.eta_secs)}`
                        : "Calculating…"}
                </span>
              </div>
            </div>
            {batchRunning && batchProgress && (
              <div className="progress-numbers" style={{ marginTop: -8 }}>
                <span className="progress-file-label">Overall: {batchProgress.idx + 1} / {batchFiles.length}</span>
              </div>
            )}
            {!cancelling && (
              <button
                className="progress-cancel-btn"
                onClick={handleCancelEncode}
                aria-label="Cancel encode"
              >
                <CancelIcon />
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── FULLSCREEN ── */}
      {fsImage && (
        <div className="fullscreen-overlay" onClick={() => setFsImage(null)}>
          <span className="fullscreen-label">{fsImage.label}</span>
          <img src={`data:image/jpeg;base64,${fsImage.src}`} alt={fsImage.label} onClick={e => e.stopPropagation()} />
          <div className="fullscreen-close" onClick={() => setFsImage(null)}>&times;</div>
        </div>
      )}
    </div>
  );
}
