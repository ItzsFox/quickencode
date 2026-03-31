import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";

// ── Types ────────────────────────────────────────────────────────────────────
interface VideoInfo {
  duration_secs: number;
  size_mb: number;
  bitrate_kbps: number;
  width: number;
  height: number;
}
interface EncodeProgress {
  percent: number;
  eta_secs: number;
  pass: number;
}

const FRAME_COUNT     = 10;
const DISCORD_TARGET  = 9;
const DISCORD_AUDIO   = 96;
const RES_BITRATES: Record<string, number> = {
  "1080p": 5000, "720p": 2500, "480p": 1000,
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtTime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
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
function sliderBg(val: number, min: number, max: number) {
  const pct = ((val - min) / (max - min)) * 100;
  return `linear-gradient(to right, #748cab ${pct}%, rgba(13,19,33,0.8) ${pct}%)`;
}
function qualityInfo(q: number) {
  if (q >= 85) return { label: "Near Lossless", cls: "c4" };
  if (q >= 65) return { label: "High Quality",  cls: "c3" };
  if (q >= 40) return { label: "Balanced",       cls: "c2" };
  if (q >= 20) return { label: "Low Quality",    cls: "c1" };
  return             { label: "Very Low",         cls: "c0" };
}
function basename(p: string) { return p.split(/[\\/]/).pop() ?? p; }
function discordBr(dur: number) {
  return Math.max(Math.floor((DISCORD_TARGET * 8 * 1024) / dur) - DISCORD_AUDIO, 80);
}
function frameTs(i: number, duration: number) {
  return duration * (i + 0.5) / FRAME_COUNT;
}

// ── App ──────────────────────────────────────────────────────────────────────
type Screen = "drop" | "loading" | "editor";

export default function App() {
  const [screen, setScreen]            = useState<Screen>("drop");
  const [filePath, setFilePath]        = useState("");
  const [info, setInfo]                = useState<VideoInfo | null>(null);
  const [dragOver, setDragOver]        = useState(false);

  const [origFrames, setOrigFrames]    = useState<string[]>([]);
  const [encFrames, setEncFrames]      = useState<Record<number, string>>({});
  const [encLoading, setEncLoading]    = useState(false);
  const [frameIdx, setFrameIdx]        = useState(0);

  const [resolution, setRes]           = useState("original");
  const [format, setFmt]               = useState("mp4");
  const [quality, setQuality]          = useState(75);
  const [audio, setAudio]              = useState(128);
  const [fps, setFps]                  = useState("original");

  const [encoding, setEncoding]        = useState(false);
  const [progress, setProgress]        = useState<EncodeProgress | null>(null);

  const [fsImage, setFsImage]          = useState<{src: string; label: string} | null>(null);
  const [status, setStatus]            = useState("");

  // Track preview container height so images fill it properly
  const previewRef = useRef<HTMLDivElement>(null);

  const encDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Derived ────────────────────────────────────────────────────────────────
  const base    = resolution === "original"
    ? (info?.bitrate_kbps ?? 5000)
    : RES_BITRATES[resolution];
  const videoBr = Math.max(Math.round(base * (quality / 100)), 80);
  const estMb   = info ? ((videoBr + audio) * info.duration_secs) / 8 / 1024 : 0;
  const estLow  = estMb * 0.85;
  const estHigh = estMb * 1.15;
  const reduction = info ? Math.round((1 - estMb / info.size_mb) * 100) : 0;
  const sizeClass =
    reduction < 0  ? "better" :
    reduction < 40 ? "good"   :
    reduction < 70 ? "med"    : "bad";

  // ── Load encoded frame (debounced) ─────────────────────────────────────────
  const loadEncodedFrame = useCallback((idx: number, vbr: number, res: string, f: string) => {
    if (!filePath || !info) return;
    if (encDebounce.current) clearTimeout(encDebounce.current);
    setEncLoading(true);
    encDebounce.current = setTimeout(async () => {
      const ts = frameTs(idx, info.duration_secs);
      try {
        const result = await invoke<string>("get_encoded_frame", {
          input: filePath,
          timestamp: ts,
          resolution: res,
          videoBitrateKbps: vbr,
          fps: f,
        });
        setEncFrames(prev => ({ ...prev, [idx]: result }));
      } catch (e) {
        setStatus(`⚠️ Preview failed: ${e}`);
      } finally {
        setEncLoading(false);
      }
    }, 600);
  }, [filePath, info]);

  useEffect(() => {
    if (screen !== "editor" || !info) return;
    setEncFrames({});
    loadEncodedFrame(frameIdx, videoBr, resolution, fps);
  }, [videoBr, resolution, fps, screen]);

  useEffect(() => {
    if (screen !== "editor" || !info) return;
    if (!encFrames[frameIdx]) {
      loadEncodedFrame(frameIdx, videoBr, resolution, fps);
    }
  }, [frameIdx]);

  // ── Load file ──────────────────────────────────────────────────────────────
  const loadFile = useCallback(async (path: string) => {
    setScreen("loading");
    setFilePath(path);
    setOrigFrames([]);
    setEncFrames({});
    setFrameIdx(0);
    setStatus("");
    try {
      const [videoInfo, frames] = await Promise.all([
        invoke<VideoInfo>("get_video_info", { input: path }),
        invoke<string[]>("get_video_frames", { input: path, count: FRAME_COUNT }),
      ]);
      setInfo(videoInfo);
      setOrigFrames(frames);
      setScreen("editor");
      const b = resolution === "original"
        ? videoInfo.bitrate_kbps
        : RES_BITRATES[resolution] ?? videoInfo.bitrate_kbps;
      const vbr = Math.max(Math.round(b * (quality / 100)), 80);
      loadEncodedFrame(0, vbr, resolution, fps);
    } catch (e) {
      setStatus(`❌ ${e}`);
      setScreen("drop");
    }
  }, [resolution, quality, fps]);

  // ── Drag & drop ────────────────────────────────────────────────────────────
  useEffect(() => {
    let off: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent((ev) => {
      const t = ev.payload.type;
      if (t === "over")  setDragOver(true);
      if (t === "leave") setDragOver(false);
      if (t === "drop") {
        setDragOver(false);
        const paths = (ev.payload as any).paths as string[];
        if (paths?.[0]) loadFile(paths[0]);
      }
    }).then(fn => { off = fn; });
    return () => off?.();
  }, [loadFile]);

  // ── Encode progress events ─────────────────────────────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<EncodeProgress>("encode-progress", (ev) => {
      setProgress(ev.payload);
    }).then(fn => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  // ── Pick file dialog ───────────────────────────────────────────────────────
  const pickFile = async () => {
    const p = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4","mkv","avi","mov","webm","m4v"] }],
    });
    if (p) loadFile(p as string);
  };

  const goFrame = (delta: number) => {
    const next = Math.max(0, Math.min(FRAME_COUNT - 1, frameIdx + delta));
    setFrameIdx(next);
  };

  // ── Encode ─────────────────────────────────────────────────────────────────
  const runEncode = async (
    vbr: number, abr: number, res: string, f: string, outPath?: string
  ) => {
    if (!filePath || !info) return;
    const out = outPath ?? await save({
      filters: [{ name: "Output", extensions: [format] }],
    });
    if (!out) return;
    setEncoding(true);
    setProgress({ percent: 0, eta_secs: 0, pass: 1 });
    try {
      await invoke("encode_video_with_progress", {
        input: filePath, output: out,
        resolution: res,
        videoBitrateKbps: vbr,
        audioBitrateKbps: abr,
        fps: f,
        durationSecs: info.duration_secs,
      });
    } catch (e) {
      setStatus(`❌ ${e}`);
    } finally {
      setTimeout(() => {
        setEncoding(false);
        setProgress(null);
      }, 1800);
    }
  };

  const handleEncode = () => runEncode(videoBr, audio, resolution, fps);

  const handleDiscord = async () => {
    if (!info) return;
    if (info.size_mb <= 10) {
      setStatus("✅ Already under 10MB — no compression needed!");
      return;
    }
    const vbr = discordBr(info.duration_secs);
    const defaultName = basename(filePath).replace(/\.[^.]+$/, "") + "_discord.mp4";
    const out = await save({
      defaultPath: defaultName,
      filters: [{ name: "MP4", extensions: ["mp4"] }],
    });
    if (!out) return;
    runEncode(vbr, DISCORD_AUDIO, "original", "original", out);
  };

  // ── Reset ──────────────────────────────────────────────────────────────────
  const reset = () => {
    setScreen("drop");
    setFilePath("");
    setInfo(null);
    setOrigFrames([]);
    setEncFrames({});
    setFrameIdx(0);
    setStatus("");
    setProgress(null);
    setEncoding(false);
  };

  const ql = qualityInfo(quality);
  const currentOrig = origFrames[frameIdx];
  const currentEnc  = encFrames[frameIdx];

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app">

      {/* ── DROP SCREEN ── */}
      {screen === "drop" && (
        <div
          className={`drop-screen${dragOver ? " drag-over" : ""}`}
          onClick={pickFile}
        >
          <div className="drop-logo">
            <div className="drop-logo-icon">⚡</div>
            <h1>QuickEncode <span>video compressor</span></h1>
          </div>
          <div className="drop-hint">
            <p>{dragOver ? "Drop to load" : "Drop a video file anywhere"}</p>
            <small>MP4 · MKV · AVI · MOV · WebM · M4V</small>
          </div>
          <button className="drop-browse" onClick={e => { e.stopPropagation(); pickFile(); }}>
            Browse files
          </button>
          {status && <div className="status-bar">{status}</div>}
        </div>
      )}

      {/* ── LOADING SCREEN ── */}
      {screen === "loading" && (
        <div className="loading-screen">
          <div className="loading-logo">
            <div className="loading-logo-icon">⚡</div>
            <h2>QuickEncode</h2>
          </div>
          <div className="loading-bar-wrap">
            <div className="loading-bar-bg">
              <div className="loading-bar-fill" />
            </div>
            <div className="loading-label">
              Reading file &amp; extracting frames...
            </div>
          </div>
        </div>
      )}

      {/* ── EDITOR ── */}
      {screen === "editor" && info && (
        <div className="editor">

          {/* Top bar */}
          <div className="topbar">
            <div className="topbar-left">
              <div className="topbar-icon">⚡</div>
              <h1>QuickEncode <span>video compressor</span></h1>
            </div>
            <div className="topbar-right">
              <div className="file-chip" onClick={reset}>
                <span>{basename(filePath)}</span>
                <span className="file-chip-x">✕</span>
              </div>
              <span className="version-badge">v2.0</span>
            </div>
          </div>

          {/* Video info strip */}
          <div className="video-info-strip">
            <div className="info-pill">
              <span className="info-pill-label">Duration</span>
              <span className="info-pill-val">{fmtTime(info.duration_secs)}</span>
            </div>
            <div className="info-pill">
              <span className="info-pill-label">Size</span>
              <span className="info-pill-val">{fmtMb(info.size_mb)}</span>
            </div>
            <div className="info-pill">
              <span className="info-pill-label">Resolution</span>
              <span className="info-pill-val">{info.width}×{info.height}</span>
            </div>
            <div className="info-pill">
              <span className="info-pill-label">Bitrate</span>
              <span className="info-pill-val">{(info.bitrate_kbps / 1000).toFixed(1)} Mbps</span>
            </div>
            <div className="info-pill">
              <span className="info-pill-label">Aspect</span>
              <span className="info-pill-val">
                {(() => {
                  const g = (a: number, b: number): number => b === 0 ? a : g(b, a % b);
                  const d = g(info.width, info.height);
                  return `${info.width/d}:${info.height/d}`;
                })()}
              </span>
            </div>
          </div>

          {/* Preview + frame nav — fills all remaining space */}
          <div className="preview-section" ref={previewRef}>
            <div className="preview-grid">
              {/* Original */}
              <div
                className="preview-side"
                onClick={() => currentOrig && setFsImage({ src: currentOrig, label: "Original" })}
              >
                {currentOrig ? (
                  <img src={`data:image/jpeg;base64,${currentOrig}`} alt="Original frame" />
                ) : (
                  <div className="preview-loading">
                    <div className="spin" /><span>Loading...</span>
                  </div>
                )}
                <span className="preview-tag">Original</span>
                {currentOrig && (
                  <button
                    className="preview-fullscreen-btn"
                    onClick={e => { e.stopPropagation(); setFsImage({ src: currentOrig, label: "Original" }); }}
                  >⛶</button>
                )}
              </div>

              {/* Encoded */}
              <div
                className="preview-side"
                onClick={() => currentEnc && !encLoading && setFsImage({ src: currentEnc, label: "Output" })}
              >
                {encLoading ? (
                  <div className="preview-loading">
                    <div className="spin" /><span>Rendering...</span>
                  </div>
                ) : currentEnc ? (
                  <img src={`data:image/jpeg;base64,${currentEnc}`} alt="Encoded frame" />
                ) : (
                  <div className="preview-loading">
                    <div className="spin" /><span>Loading...</span>
                  </div>
                )}
                <span className="preview-tag">Output</span>
                {currentEnc && !encLoading && (
                  <button
                    className="preview-fullscreen-btn"
                    onClick={e => { e.stopPropagation(); setFsImage({ src: currentEnc, label: "Output" }); }}
                  >⛶</button>
                )}
              </div>
            </div>

            {/* Frame navigation */}
            <div className="frame-nav">
              <button
                className="frame-nav-btn"
                onClick={() => goFrame(-1)}
                disabled={frameIdx === 0}
              >‹</button>

              <div className="frame-dots">
                {Array.from({ length: FRAME_COUNT }, (_, i) => (
                  <button
                    key={i}
                    className={`frame-dot${i === frameIdx ? " active" : ""}`}
                    onClick={() => setFrameIdx(i)}
                  />
                ))}
              </div>

              <button
                className="frame-nav-btn"
                onClick={() => goFrame(1)}
                disabled={frameIdx === FRAME_COUNT - 1}
              >›</button>

              <span className="frame-label">
                Frame {frameIdx + 1} / {FRAME_COUNT}
                {info && ` · ${fmtTime(frameTs(frameIdx, info.duration_secs))}`}
              </span>
            </div>
          </div>

          {/* Quality + Settings */}
          <div className="settings-row">
            <div className="quality-col">
              <div className="quality-header">
                <span className="section-label">Quality</span>
                <div className="quality-values">
                  <span className={`q-badge ${ql.cls}`}>{ql.label}</span>
                  <span className="q-pct">{quality}%</span>
                  <span className="q-est">≈ {fmtMb(estLow)}–{fmtMb(estHigh)}</span>
                </div>
              </div>
              <input
                type="range" min={5} max={100} value={quality}
                style={{ background: sliderBg(quality, 5, 100) }}
                onChange={e => setQuality(Number(e.target.value))}
              />
              <div className="range-labels"><span>Smallest</span><span>Best</span></div>
            </div>

            <div className="settings-divider" />

            <div className="options-col">
              <span className="section-label">Settings</span>
              <div className="options-grid">
                <div className="setting">
                  <label>Resolution</label>
                  <select value={resolution} onChange={e => setRes(e.target.value)}>
                    <option value="original">Original</option>
                    <option value="1080p">1080p</option>
                    <option value="720p">720p</option>
                    <option value="480p">480p</option>
                  </select>
                </div>
                <div className="setting">
                  <label>Format</label>
                  <select value={format} onChange={e => setFmt(e.target.value)}>
                    <option value="mp4">MP4</option>
                    <option value="mkv">MKV</option>
                    <option value="webm">WebM</option>
                  </select>
                </div>
                <div className="setting">
                  <label>Audio</label>
                  <select value={audio} onChange={e => setAudio(Number(e.target.value))}>
                    <option value={64}>64 kbps</option>
                    <option value={128}>128 kbps</option>
                    <option value={192}>192 kbps</option>
                    <option value={256}>256 kbps</option>
                  </select>
                </div>
                <div className="setting">
                  <label>FPS</label>
                  <select value={fps} onChange={e => setFps(e.target.value)}>
                    <option value="original">Original</option>
                    <option value="60">60 fps</option>
                    <option value="30">30 fps</option>
                    <option value="24">24 fps</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom bar */}
          <div className="bottom-bar">
            <div className={`size-box ${sizeClass}`}>
              <span className="size-lbl">Estimated output</span>
              <div className="size-right">
                <span className="size-val">{fmtMb(estLow)} – {fmtMb(estHigh)}</span>
                {reduction !== 0 && (
                  <span className="size-diff">
                    {reduction > 0 ? `−${reduction}%` : `+${Math.abs(reduction)}%`}
                  </span>
                )}
              </div>
            </div>

            <button
              className="preset-btn"
              onClick={handleDiscord}
              disabled={encoding}
              title={`Targets ${DISCORD_TARGET}MB — ${discordBr(info.duration_secs)}kbps video, ${DISCORD_AUDIO}kbps audio`}
            >
              <span className="preset-icon">🎮</span>
              Discord Ready
              <span className="preset-size">≤10MB</span>
            </button>

            <button className="btn-encode" onClick={handleEncode} disabled={encoding}>
              {encoding
                ? <span className="btn-inner"><div className="spin" />Encoding...</span>
                : "Start Encode"}
            </button>
          </div>

          <div className="status-bar">{status}</div>
        </div>
      )}

      {/* ── PROGRESS OVERLAY ── */}
      {encoding && progress && (
        <div className="progress-overlay">
          <div className="progress-card">
            <div className="progress-icon">
              {progress.percent >= 100 ? "✅" : "⚙️"}
            </div>
            <div className="progress-title">
              {progress.percent >= 100 ? "Encoding complete!" : "Encoding video..."}
            </div>
            <div className="progress-pass">
              {progress.percent < 50
                ? "Pass 1 / 2 — Analyzing"
                : progress.percent < 100
                  ? "Pass 2 / 2 — Encoding"
                  : "Finalizing..."}
            </div>
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
                  {progress.percent >= 100
                    ? <span className="progress-done-msg">Done!</span>
                    : progress.percent >= 50 && progress.eta_secs > 0
                      ? `ETA ${fmtEta(progress.eta_secs)}`
                      : "Calculating..."}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── FULLSCREEN MODAL ── */}
      {fsImage && (
        <div className="fullscreen-overlay" onClick={() => setFsImage(null)}>
          <span className="fullscreen-label">{fsImage.label}</span>
          <img
            src={`data:image/jpeg;base64,${fsImage.src}`}
            alt={fsImage.label}
            onClick={e => e.stopPropagation()}
          />
          <div className="fullscreen-close" onClick={() => setFsImage(null)}>✕</div>
        </div>
      )}

    </div>
  );
}
